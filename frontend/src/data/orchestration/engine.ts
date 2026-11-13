import type {
  MonitorAlarm,
  MonitorConfig,
  NodeRunState,
  NodeSnapshot,
  PlanBlocker,
  PlanNodeRuntime,
  PlanWave,
  QualityBlock,
  QualityRule,
  TransformNode,
} from './types'

/** 节点编号 -> 节点 的索引。 */
export function indexByCode(nodes: TransformNode[]): Map<string, TransformNode> {
  return new Map(nodes.map((node) => [node.code, node]))
}

/** 解析「输入表名 / 依赖节点」字段里逗号分隔的写法。 */
export function parseList(value: string): string[] {
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function snapshotOf(node: TransformNode): NodeSnapshot {
  return {
    nodeId: node.id,
    code: node.code,
    version: node.version,
    expression: node.expression,
    inputTables: [...node.inputTables],
    outputTable: node.outputTable,
    failureStrategy: node.failureStrategy,
    shardCount: node.shardCount,
  }
}

export type BuildPlanResult = {
  waves: PlanWave[]
  blockers: PlanBlocker[]
  qualityBlocks: QualityBlock[]
  alarms: MonitorAlarm[]
  runtimes: PlanNodeRuntime[]
  snapshots: NodeSnapshot[]
  /** 可进入波次的节点编号（未被阻断）。 */
  schedulable: Set<string>
  blockedNodes: Set<string>
}

/**
 * 依据输入表、输出表、依赖节点与执行顺序计算可并行波次。
 * 同时给出缺失依赖、自环、相互等待（环）以及质量阻断。
 */
export function buildPlan(
  selected: TransformNode[],
  rules: QualityRule[],
  monitors: MonitorConfig[],
): BuildPlanResult {
  const blockers: PlanBlocker[] = []
  const byCode = indexByCode(selected)
  const selectedCodes = new Set(selected.map((node) => node.code))

  // 1) 缺失依赖：依赖的节点不在本次选择范围内（或根本不存在于节点表）。
  const missing = new Set<string>()
  for (const node of selected) {
    for (const dep of node.dependsOn) {
      if (!selectedCodes.has(dep)) {
        missing.add(node.code)
        blockers.push({
          kind: 'missing-dependency',
          nodeCode: node.code,
          refCode: dep,
          message: `节点「${node.code}」依赖的「${dep}」不在本次选择范围内，无法满足输入`,
        })
      }
    }
  }

  // 2) 自环与相互等待（环）。用 DFS 三色标记找环。
  const state = new Map<string, 0 | 1 | 2>()
  const cyclicNodes = new Set<string>()
  for (const node of selected) {
    state.set(node.code, 0)
  }

  const detectFrom = (code: string, stack: string[]): void => {
    state.set(code, 1)
    const node = byCode.get(code)
    if (!node) return
    for (const dep of node.dependsOn) {
      if (!selectedCodes.has(dep)) continue // 缺失依赖已单独报告
      if (dep === code) {
        cyclicNodes.add(code)
        blockers.push({
          kind: 'self-loop',
          nodeCode: code,
          refCode: dep,
          message: `节点「${code}」依赖自身，形成自环`,
        })
        continue
      }
      const depState = state.get(dep)
      if (depState === 1) {
        const cycleStart = stack.indexOf(dep)
        const cycle = [...stack.slice(cycleStart), dep]
        cycle.forEach((c) => cyclicNodes.add(c))
        blockers.push({
          kind: 'cyclic-wait',
          nodeCode: code,
          refCode: dep,
          message: `节点相互等待形成环：${cycle.join(' -> ')}，无法确定执行顺序`,
        })
      } else if (depState === 0) {
        detectFrom(dep, [...stack, dep])
      }
    }
    state.set(code, 2)
  }
  for (const node of selected) {
    if (state.get(node.code) === 0) {
      detectFrom(node.code, [node.code])
    }
  }

  // 可参与波次计算的节点：既不缺依赖也不在环上。
  const schedulable = new Set<string>()
  for (const node of selected) {
    if (!missing.has(node.code) && !cyclicNodes.has(node.code)) {
      schedulable.add(node.code)
    }
  }

  // 3) Kahn 分层波次：同层（同波）节点无依赖关系，可并行。
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const code of schedulable) {
    indegree.set(code, 0)
    dependents.set(code, [])
  }
  for (const code of schedulable) {
    const node = byCode.get(code)!
    for (const dep of node.dependsOn) {
      if (schedulable.has(dep)) {
        indegree.set(code, (indegree.get(code) ?? 0) + 1)
        dependents.get(dep)!.push(code)
      }
    }
  }

  const waves: PlanWave[] = []
  const waveOf = new Map<string, number>()
  let frontier = [...schedulable].filter((code) => (indegree.get(code) ?? 0) === 0)
  // 同波内按执行顺序排序，稳定可检查。
  const sortByOrder = (a: string, b: string) =>
    (byCode.get(a)?.order ?? 0) - (byCode.get(b)?.order ?? 0)
  frontier.sort(sortByOrder)

  let waveIndex = 0
  const scheduled = new Set<string>()
  while (frontier.length > 0) {
    const current = [...frontier].sort(sortByOrder)
    waves.push({ index: waveIndex, nodeCodes: current })
    current.forEach((code) => {
      waveOf.set(code, waveIndex)
      scheduled.add(code)
    })
    const next: string[] = []
    for (const code of current) {
      for (const child of dependents.get(code) ?? []) {
        indegree.set(child, (indegree.get(child) ?? 1) - 1)
        if ((indegree.get(child) ?? 0) === 0) {
          next.push(child)
        }
      }
    }
    frontier = next
    waveIndex += 1
  }

  // 理论上 schedulable 都应被排进波次；兜底再报一次环。
  for (const code of schedulable) {
    if (!scheduled.has(code) && !cyclicNodes.has(code)) {
      cyclicNodes.add(code)
      blockers.push({
        kind: 'cyclic-wait',
        nodeCode: code,
        message: `节点「${code}」依赖无法在有限波次内满足，存在相互等待`,
      })
      schedulable.delete(code)
    }
  }

  // 4) 质量阻断：block 级、已启用且触发的规则，按输出表定位节点与波次。
  const qualityBlocks: QualityBlock[] = []
  const qualityBlockedNodes = new Set<string>()
  for (const rule of rules) {
    if (!rule.enabled || !rule.triggered) continue
    const owner = selected.find((node) => node.outputTable === rule.table)
    const wave = owner ? waveOf.get(owner.code) : undefined
    const block: QualityBlock = {
      ruleCode: rule.ruleCode,
      table: rule.table,
      field: rule.field,
      level: rule.level,
      expression: rule.expression,
      blocking: rule.level === 'block',
      nodeCode: owner?.code,
      wave,
      message:
        rule.level === 'block'
          ? `规则 ${rule.ruleCode} 对 ${rule.table}.${rule.field} 的校验未通过（${rule.expression}），阻断该节点所在波次及下游`
          : `规则 ${rule.ruleCode} 对 ${rule.table}.${rule.field} 产生告警（${rule.expression}），仅提示不阻断`,
    }
    qualityBlocks.push(block)
    if (rule.level === 'block' && owner) {
      qualityBlockedNodes.add(owner.code)
      blockers.push({
        kind: 'quality-block',
        nodeCode: owner.code,
        refCode: rule.ruleCode,
        wave,
        message: block.message,
      })
    }
  }

  // 质量阻断向上传播：阻断节点的全部下游（在可调度集合内）。
  const blockedNodes = new Set<string>(qualityBlockedNodes)
  const propagate = (code: string): void => {
    for (const child of dependents.get(code) ?? []) {
      if (!blockedNodes.has(child)) {
        blockedNodes.add(child)
        blockers.push({
          kind: 'upstream-blocked',
          nodeCode: child,
          refCode: code,
          wave: waveOf.get(child),
          message: `上游节点「${code}」被质量规则阻断，节点「${child}」所在波次无法启动`,
        })
        propagate(child)
      }
    }
  }
  qualityBlockedNodes.forEach(propagate)

  // 5) 监控告警：按 refCode（节点编号）关联到节点与波次。
  const alarms: MonitorAlarm[] = []
  for (const config of monitors) {
    if (!config.enabled || !config.alarming) continue
    const owner = selected.find((node) => node.code === config.refCode)
    alarms.push({
      configCode: config.configCode,
      refCode: config.refCode,
      metric: config.metric,
      level: config.level,
      threshold: config.threshold,
      channel: config.channel,
      nodeCode: owner?.code ?? config.refCode,
      wave: owner ? waveOf.get(owner.code) : undefined,
      message: `${config.configCode} 监控「${config.metric}」触发阈值 ${config.threshold}，级别 ${config.level}，通知渠道：${config.channel}`,
    })
  }

  // 6) 组装运行态与不可变快照。
  const runtimes: PlanNodeRuntime[] = []
  const snapshots: NodeSnapshot[] = []
  for (const node of selected) {
    if (!schedulable.has(node.code)) {
      runtimes.push({ code: node.code, wave: -1, state: 'pending', finishedShards: 0 })
    } else {
      const wave = waveOf.get(node.code) ?? 0
      const isBlocked = blockedNodes.has(node.code)
      runtimes.push({
        code: node.code,
        wave,
        state: isBlocked ? 'pending' : wave === 0 ? 'ready' : 'pending',
        finishedShards: 0,
      })
    }
    snapshots.push(snapshotOf(node))
  }

  return {
    waves,
    blockers,
    qualityBlocks,
    alarms,
    runtimes,
    snapshots,
    schedulable,
    blockedNodes,
  }
}

/** 失败策略中文名。 */
export const FAILURE_STRATEGY_LABEL: Record<TransformNode['failureStrategy'], string> = {
  'block-downstream': '阻断下游',
  'skip-continue': '跳过继续',
  'resume-shard': '分片续跑',
}

export const BLOCKER_LABEL: Record<PlanBlocker['kind'], string> = {
  'missing-dependency': '缺失依赖',
  'self-loop': '自环',
  'cyclic-wait': '相互等待',
  'upstream-blocked': '上游阻断',
  'quality-block': '质量阻断',
}

/**
 * 模拟某个节点失败后，按失败策略推导下游影响。
 * 返回每个受影响节点的新状态与说明，供计划在执行前说明「谁会被跳过、谁可续跑」。
 */
export function simulateFailure(
  failedCode: string,
  nodes: TransformNode[],
  runtimes: PlanNodeRuntime[],
): Array<{ code: string; state: NodeRunState; message: string }> {
  const byCode = indexByCode(nodes)
  const runtimeByCode = new Map(runtimes.map((item) => [item.code, item]))
  const result: Array<{ code: string; state: NodeRunState; message: string }> = []
  const failed = byCode.get(failedCode)
  if (!failed) return result

  const walkDown = (code: string): void => {
    const node = byCode.get(code)
    if (!node) return
    for (const child of childrenOf(code, nodes)) {
      const childNode = byCode.get(child)!
      const state: NodeRunState =
        childNode.failureStrategy === 'skip-continue'
          ? 'skipped'
          : childNode.failureStrategy === 'resume-shard'
            ? 'resumable'
            : 'pending'
      const message =
        childNode.failureStrategy === 'skip-continue'
          ? `上游「${code}」失败，策略为跳过继续：该节点标记跳过，不阻断旁路`
          : childNode.failureStrategy === 'resume-shard'
            ? `上游「${code}」失败，策略为分片续跑：可从未完成分片（${
                runtimeByCode.get(child)?.finishedShards ?? 0
              }/${childNode.shardCount}）继续`
            : `上游「${code}」失败，策略为阻断下游：该节点保持等待`
      result.push({ code: child, state, message })
      walkDown(child)
    }
  }
  walkDown(failedCode)
  return result
}

function childrenOf(code: string, nodes: TransformNode[]): string[] {
  return nodes.filter((node) => node.dependsOn.includes(code)).map((node) => node.code)
}
