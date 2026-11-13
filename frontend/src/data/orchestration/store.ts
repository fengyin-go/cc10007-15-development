import { buildPlan, parseList } from './engine'
import { SEED_MONITOR_CONFIGS, SEED_NODES, SEED_QUALITY_RULES } from './seed'
import type {
  AcceptanceItem,
  MonitorConfig,
  PlanStatus,
  QualityRule,
  StaleMessage,
  TransformNode,
  TransformPlan,
} from './types'

const NODES_KEY = 'data-layer-studio:orchestration:nodes'
const RULES_KEY = 'data-layer-studio:orchestration:rules'
const MONITORS_KEY = 'data-layer-studio:orchestration:monitors'
const PLANS_KEY = 'data-layer-studio:orchestration:plans'
const MESSAGES_KEY = 'data-layer-studio:orchestration:stale-messages'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return clone(fallback)
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return clone(fallback)
  }
}

function write<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

// ---------- 节点 ----------

export function listNodes(): TransformNode[] {
  return read<TransformNode[]>(NODES_KEY, SEED_NODES)
}

export function getNode(code: string): TransformNode | undefined {
  return listNodes().find((node) => node.code === code)
}

export type NodeDraft = Omit<TransformNode, 'id' | 'version' | 'updatedAt'>

/**
 * 保存节点（新增或修改）。
 * 表达式或依赖发生变化时版本 +1，用于计划确认时锁定、回看时核对。
 */
export function saveNode(draft: NodeDraft, existingId?: number): TransformNode {
  const nodes = listNodes()
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  if (existingId) {
    const index = nodes.findIndex((node) => node.id === existingId)
    if (index < 0) throw new Error('未找到要修改的转换节点')
    const before = nodes[index]
    const dependsOn = parseList(draft.dependsOn.join(','))
    const expressionChanged = before.expression !== draft.expression
    const dependencyChanged =
      JSON.stringify([...before.dependsOn].sort()) !== JSON.stringify([...dependsOn].sort()) ||
      JSON.stringify([...before.inputTables].sort()) !==
        JSON.stringify([...draft.inputTables].sort())
    const updated: TransformNode = {
      ...before,
      ...draft,
      dependsOn,
      version: before.version + (expressionChanged || dependencyChanged ? 1 : 0),
      updatedAt: now,
    }
    nodes[index] = updated
    write(NODES_KEY, nodes)
    return updated
  }
  const created: TransformNode = {
    ...draft,
    dependsOn: parseList(draft.dependsOn.join(',')),
    id: nodes.reduce((max, node) => Math.max(max, node.id), 0) + 1,
    version: 1,
    updatedAt: now,
  }
  nodes.push(created)
  write(NODES_KEY, nodes)
  return created
}

// ---------- 质量规则 / 监控配置 ----------

export function listRules(): QualityRule[] {
  return read<QualityRule[]>(RULES_KEY, SEED_QUALITY_RULES)
}

export function toggleRule(ruleCode: string, triggered: boolean): void {
  const rules = listRules()
  const index = rules.findIndex((rule) => rule.ruleCode === ruleCode)
  if (index >= 0) {
    rules[index] = { ...rules[index], triggered }
    write(RULES_KEY, rules)
  }
}

export function listMonitors(): MonitorConfig[] {
  return read<MonitorConfig[]>(MONITORS_KEY, SEED_MONITOR_CONFIGS)
}

export function toggleMonitor(configCode: string, alarming: boolean): void {
  const configs = listMonitors()
  const index = configs.findIndex((config) => config.configCode === configCode)
  if (index >= 0) {
    configs[index] = { ...configs[index], alarming }
    write(MONITORS_KEY, configs)
  }
}

// ---------- 计划 ----------

function readPlans(): TransformPlan[] {
  return read<TransformPlan[]>(PLANS_KEY, [])
}

function writePlans(plans: TransformPlan[]): void {
  write(PLANS_KEY, plans)
}

export function listPlans(): TransformPlan[] {
  return readPlans().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getPlan(planId: string): TransformPlan | undefined {
  return readPlans().find((plan) => plan.id === planId)
}

const DEFAULT_ACCEPTANCE: AcceptanceItem[] = [
  { key: 'dependency', label: '依赖检查', passed: false, detail: '待核对输入表、输出表与依赖节点是否齐备' },
  { key: 'build', label: '构建', passed: false, detail: '待确认转换表达式构建产物' },
  { key: 'deploy', label: '部署', passed: false, detail: '待确认节点配置已部署到调度环境' },
  { key: 'environment', label: '环境', passed: false, detail: '待确认执行环境与连接配置' },
  { key: 'database', label: '数据库版本', passed: false, detail: '待确认库表 schema 版本与节点要求一致' },
]

/**
 * 生成（或重新生成）一个计划草稿。重新生成会让 generation +1，
 * 旧一代计划标记为 superseded，其迟到完成消息将被隔离。
 */
export function createPlan(name: string, selectedNodeCodes: string[], operator: string): TransformPlan {
  const plans = readPlans()
  const nodes = listNodes().filter((node) => selectedNodeCodes.includes(node.code))
  const built = buildPlan(nodes, listRules(), listMonitors())
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  // 同名计划视为同一计划的再编排：代数递增，旧代数保留并标记为已被取代，供回看与消息隔离。
  const prior = plans
    .filter((plan) => plan.name === name)
    .sort((a, b) => b.generation - a.generation)[0]
  const generation = prior ? prior.generation + 1 : 1
  if (prior) {
    for (const old of plans) {
      if (old.name === name && (old.status === 'running' || old.status === 'confirmed' || old.status === 'draft')) {
        old.status = 'superseded'
      }
    }
  }

  const plan: TransformPlan = {
    id: `PLAN-${Date.now()}-${generation}`,
    name,
    generation,
    status: 'draft',
    selectedNodeCodes: nodes.map((node) => node.code),
    confirmedVersions: {},
    operator,
    createdAt: now,
    waves: built.waves,
    blockers: built.blockers,
    qualityBlocks: built.qualityBlocks,
    alarms: built.alarms,
    runtimes: built.runtimes,
    acceptance: clone(DEFAULT_ACCEPTANCE),
    snapshots: built.snapshots,
  }
  writePlans([...plans, plan])
  return plan
}

/**
 * 确认计划：锁定每个节点当前版本。
 * 若两个操作员同时修改同一依赖，这里只采用「当前已确认版本」——
 * 即读取节点最新已保存版本写入 confirmedVersions，旧计划携带的版本不再推进新计划。
 */
export function confirmPlan(planId: string, operator: string): TransformPlan {
  const plans = readPlans()
  const plan = plans.find((item) => item.id === planId)
  if (!plan) throw new Error('未找到转换计划')
  const hardBlocked = plan.blockers.some(
    (blocker) =>
      blocker.kind === 'missing-dependency' ||
      blocker.kind === 'self-loop' ||
      blocker.kind === 'cyclic-wait',
  )
  if (hardBlocked) {
    throw new Error('计划存在缺失依赖、自环或相互等待阻断，必须先修复才能确认')
  }
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const versions: Record<string, number> = {}
  for (const code of plan.selectedNodeCodes) {
    const node = getNode(code)
    if (node) versions[code] = node.version
  }
  plan.confirmedVersions = versions
  plan.status = 'confirmed'
  plan.confirmedAt = now
  plan.operator = operator
  // 确认时把当前快照版本对齐为已确认版本，证据即当次表达式与输入版本。
  plan.snapshots = plan.snapshots.map((snapshot) => {
    const node = getNode(snapshot.code)
    return node ? { ...snapshot, version: node.version, expression: node.expression, inputTables: [...node.inputTables] } : snapshot
  })
  writePlans(plans)
  return plan
}

/** 标记流程验收项。 */
export function updateAcceptance(
  planId: string,
  key: AcceptanceItem['key'],
  passed: boolean,
  detail: string,
  operator: string,
): TransformPlan {
  const plans = readPlans()
  const plan = plans.find((item) => item.id === planId)
  if (!plan) throw new Error('未找到转换计划')
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  plan.acceptance = plan.acceptance.map((item) =>
    item.key === key
      ? { ...item, passed, detail, checkedAt: now, checkedBy: operator }
      : item,
  )
  writePlans(plans)
  return plan
}

export function acceptanceAllPassed(plan: TransformPlan): boolean {
  return plan.acceptance.every((item) => item.passed)
}

/** 推进单个节点执行（演示用模拟），带分片进度，证据取自确认时快照。 */
export function advanceNode(planId: string, code: string): TransformPlan {
  const plans = readPlans()
  const plan = plans.find((item) => item.id === planId)
  if (!plan) throw new Error('未找到转换计划')
  if (plan.status !== 'confirmed' && plan.status !== 'running') {
    throw new Error('只有已确认或运行中的计划才能推进节点')
  }
  const runtime = plan.runtimes.find((item) => item.code === code)
  const snapshot = plan.snapshots.find((item) => item.code === code)
  if (!runtime || !snapshot) throw new Error('计划中不存在该节点')
  if (runtime.state === 'succeeded' || runtime.state === 'skipped') {
    throw new Error('该节点已结束，不能重复推进')
  }
  plan.status = 'running'
  if (runtime.state !== 'running') {
    runtime.state = 'running'
    runtime.evidence = { ...snapshot }
  } else {
    runtime.finishedShards = Math.min(runtime.finishedShards + 1, snapshot.shardCount)
    if (runtime.finishedShards >= snapshot.shardCount) {
      runtime.state = 'succeeded'
      // 同波次全部成功后，解锁下一波。
      unlockNextWave(plan)
    }
  }
  if (plan.runtimes.every((item) => terminalStates().includes(item.state))) {
    plan.status = plan.runtimes.some((item) => item.state === 'failed') ? 'failed' : 'finished'
  }
  writePlans(plans)
  return plan
}

/** 模拟节点失败，按失败策略写入下游状态。 */
export function failNode(planId: string, code: string, reason: string): TransformPlan {
  const plans = readPlans()
  const plan = plans.find((item) => item.id === planId)
  if (!plan) throw new Error('未找到转换计划')
  const runtime = plan.runtimes.find((item) => item.code === code)
  const node = getNode(code)
  if (!runtime || !node) throw new Error('计划中不存在该节点')
  runtime.state = node.failureStrategy === 'resume-shard' ? 'resumable' : 'failed'
  runtime.message = reason
  runtime.evidence = { ...(plan.snapshots.find((item) => item.code === code)!) }

  const downstream = downstreamOf(code, plan.selectedNodeCodes)
  for (const childCode of downstream) {
    const child = plan.runtimes.find((item) => item.code === childCode)!
    const childNode = getNode(childCode)!
    if (childNode.failureStrategy === 'skip-continue') {
      child.state = 'skipped'
      child.message = `上游「${code}」失败，按跳过继续策略跳过本节点`
    } else if (childNode.failureStrategy === 'resume-shard') {
      child.state = 'resumable'
      child.message = `上游「${code}」失败，本节点可从未完成分片 ${child.finishedShards}/${childNode.shardCount} 续跑`
    } else {
      child.message = `上游「${code}」失败，按阻断下游策略保持等待`
    }
  }
  plan.status = 'failed'
  writePlans(plans)
  return plan
}

/** 从断点分片续跑。 */
export function resumeShard(planId: string, code: string): TransformPlan {
  const plans = readPlans()
  const plan = plans.find((item) => item.id === planId)
  if (!plan) throw new Error('未找到转换计划')
  const runtime = plan.runtimes.find((item) => item.code === code)
  const snapshot = plan.snapshots.find((item) => item.code === code)
  if (!runtime || !snapshot) throw new Error('计划中不存在该节点')
  runtime.state = 'running'
  runtime.message = `从分片 ${runtime.finishedShards + 1}/${snapshot.shardCount} 继续执行`
  plan.status = 'running'
  writePlans(plans)
  return plan
}

function terminalStates(): Array<TransformPlan['runtimes'][number]['state']> {
  return ['succeeded', 'failed', 'skipped']
}

function unlockNextWave(plan: TransformPlan): void {
  for (const wave of plan.waves) {
    const allDone = wave.nodeCodes.every((code) => {
      const runtime = plan.runtimes.find((item) => item.code === code)
      return runtime && (runtime.state === 'succeeded' || runtime.state === 'skipped')
    })
    if (allDone) {
      const next = plan.waves.find((item) => item.index === wave.index + 1)
      next?.nodeCodes.forEach((code) => {
        const runtime = plan.runtimes.find((item) => item.code === code)
        if (runtime && runtime.state === 'pending') runtime.state = 'ready'
      })
    }
  }
}

function downstreamOf(code: string, allCodes: string[]): string[] {
  const nodes = listNodes().filter((node) => allCodes.includes(node.code))
  const result: string[] = []
  const walk = (current: string): void => {
    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !result.includes(node.code)) {
        result.push(node.code)
        walk(node.code)
      }
    }
  }
  walk(code)
  return result
}

// ---------- 陈旧消息隔离 ----------

function readMessages(): StaleMessage[] {
  return read<StaleMessage[]>(MESSAGES_KEY, [])
}

/**
 * 接收一条节点完成消息。
 * 仅当消息携带的 generation 与当前计划代数一致才被接受；
 * 旧计划迟到的完成消息不能推进新计划，只记录为被隔离的陈旧消息。
 */
export function receiveCompletion(
  planName: string,
  generation: number,
  nodeCode: string,
  payload: string,
): StaleMessage {
  const plans = readPlans()
  const current = plans
    .filter((plan) => plan.name === planName)
    .sort((a, b) => b.generation - a.generation)[0]
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const accepted = !!current && current.generation === generation && current.status !== 'superseded'
  const message: StaleMessage = {
    id: readMessages().reduce((max, item) => Math.max(max, item.id), 0) + 1,
    planId: current?.id ?? planName,
    generation,
    nodeCode,
    payload,
    receivedAt: now,
    accepted,
    reason: accepted
      ? '代数匹配，完成消息已接受'
      : `消息来自第 ${generation} 代计划，当前为第 ${current?.generation ?? '?'} 代，已隔离且不推进新计划`,
  }
  write(MESSAGES_KEY, [...readMessages(), message])

  if (accepted && current) {
    const runtime = current.runtimes.find((item) => item.code === nodeCode)
    const snapshot = current.snapshots.find((item) => item.code === nodeCode)
    if (runtime && snapshot && runtime.state !== 'succeeded' && runtime.state !== 'skipped') {
      runtime.state = 'succeeded'
      runtime.finishedShards = snapshot.shardCount
      runtime.evidence = { ...snapshot }
      unlockNextWave(current)
      writePlans(plans)
    }
  }
  return message
}

export function listMessages(): StaleMessage[] {
  return readMessages().sort((a, b) => b.id - a.id)
}

export function planStatusLabel(status: PlanStatus): string {
  const labels: Record<PlanStatus, string> = {
    draft: '草稿',
    confirmed: '已确认',
    running: '运行中',
    finished: '已完成',
    failed: '有失败',
    superseded: '已被新代数取代',
  }
  return labels[status]
}
