/**
 * 转换编排领域逻辑验证：不依赖浏览器，注入内存版 localStorage 后直接跑本地服务层。
 * 运行：npx esbuild 打包后由 node 执行（见 package 外的验证命令）。
 */
import { buildPlan } from '../src/data/orchestration/engine'
import {
  SEED_MONITOR_CONFIGS,
  SEED_NODES,
  SEED_QUALITY_RULES,
} from '../src/data/orchestration/seed'
import {
  advanceNode,
  confirmPlan,
  createPlan,
  failNode,
  getNode,
  listPlans,
  receiveCompletion,
  resumeShard,
  saveNode,
} from '../src/data/orchestration/store'
import type { TransformNode } from '../src/data/orchestration/types'

// ---- 内存版 localStorage，让纯前端持久化层可在 Node 中工作 ----
const memory = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
}
;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }

/** 每个独立场景前清空持久化，避免节点/计划相互污染。 */
function resetStorage(): void {
  memory.clear()
}

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// 1) 完整 DAG 的波次分层
{
  console.log('波次计算（完整选择）')
  const built = buildPlan(SEED_NODES, SEED_QUALITY_RULES, SEED_MONITOR_CONFIGS)
  const waveCodes = built.waves.map((wave) => wave.nodeCodes)
  check('第 1 波为三个无依赖贴源节点', JSON.stringify(waveCodes[0]) === JSON.stringify(['ods_order', 'ods_payment', 'ods_user']), JSON.stringify(waveCodes[0]))
  check('第 2 波为订单明细', JSON.stringify(waveCodes[1]) === JSON.stringify(['dwd_order_detail']))
  check('第 3 波为用户汇总', JSON.stringify(waveCodes[2]) === JSON.stringify(['dws_user_summary']))
  check('第 4 波为两个 ADS 节点并行', waveCodes[3]?.length === 2)
  check('无缺失依赖/自环/环阻断', built.blockers.every((b) => b.kind === 'quality-block' || b.kind === 'upstream-blocked'))
}

// 2) 质量阻断定位波次并向下游传播
{
  console.log('质量阻断与下游传播')
  const built = buildPlan(SEED_NODES, SEED_QUALITY_RULES, SEED_MONITOR_CONFIGS)
  const quality = built.blockers.filter((b) => b.kind === 'quality-block')
  check('QUAL-0001 阻断 dwd_order_detail', quality.some((b) => b.nodeCode === 'dwd_order_detail' && b.refCode === 'QUAL-0001' && b.wave === 1))
  const upstream = built.blockers.filter((b) => b.kind === 'upstream-blocked').map((b) => b.nodeCode)
  check('阻断传播到全部下游', ['dws_user_summary', 'ads_sales_dashboard', 'ads_finance_report'].every((code) => upstream.includes(code)))
  check('监控告警关联节点与波次', built.alarms.some((a) => a.nodeCode === 'dws_user_summary' && a.wave === 2 && a.level === 'P2'))
}

// 3) 缺失依赖
{
  console.log('缺失依赖')
  const picked = SEED_NODES.filter((n) => n.code === 'dwd_order_detail')
  const built = buildPlan(picked, [], [])
  check('报告两条缺失依赖', built.blockers.filter((b) => b.kind === 'missing-dependency').length === 2)
  check('缺依赖节点不进入波次', built.schedulable.size === 0)
}

// 4) 自环
{
  console.log('自环')
  resetStorage()
  const node: TransformNode = { ...SEED_NODES[0], code: 'loop_a', dependsOn: ['loop_a'] }
  const built = buildPlan([node], [], [])
  check('识别自环', built.blockers.some((b) => b.kind === 'self-loop' && b.nodeCode === 'loop_a'))
}

// 5) 相互等待（环）
{
  console.log('相互等待')
  resetStorage()
  const base = SEED_NODES[0]
  const a: TransformNode = { ...base, id: 101, code: 'cyc_a', outputTable: 't_a', dependsOn: ['cyc_b'] }
  const b: TransformNode = { ...base, id: 102, code: 'cyc_b', outputTable: 't_b', dependsOn: ['cyc_a'] }
  const built = buildPlan([a, b], [], [])
  check('识别相互等待环', built.blockers.some((bl) => bl.kind === 'cyclic-wait'))
  check('环上节点不可调度', built.schedulable.size === 0)
}

// 6) 计划确认拒绝硬阻断
{
  console.log('计划确认门禁')
  resetStorage()
  const picked = SEED_NODES.filter((n) => n.code === 'dwd_order_detail')
  const plan = createPlan('硬阻断计划', picked.map((n) => n.code), '操作员甲')
  let threw = false
  try {
    confirmPlan(plan.id, '操作员甲')
  } catch {
    threw = true
  }
  check('存在硬阻断时确认被拒绝', threw)
}

// 7) 正常计划确认、执行、失败策略、分片续跑
{
  console.log('执行与失败策略')
  resetStorage()
  const enabledCodes = SEED_NODES.filter((n) => n.enabled).map((n) => n.code)
  const plan = createPlan('销售链路', enabledCodes, '操作员甲')
  const confirmed = confirmPlan(plan.id, '操作员甲')
  check('确认后锁定节点版本', Object.keys(confirmed.confirmedVersions).length === enabledCodes.length)
  check('质量阻断不阻止确认但节点保持等待', confirmed.status === 'confirmed')

  // 第一波节点执行
  const running = advanceNode(confirmed.id, 'ods_order')
  const rt = running.runtimes.find((r) => r.code === 'ods_order')!
  check('推进后节点进入运行中并附带证据', rt.state === 'running' && rt.evidence?.code === 'ods_order' && rt.evidence.version === getNode('ods_order')!.version)
  const done = advanceNode(confirmed.id, 'ods_order')
  check('单分片节点再次推进即成功', done.runtimes.find((r) => r.code === 'ods_order')!.state === 'succeeded')

  // 分片续跑节点失败
  const failed = failNode(confirmed.id, 'dws_user_summary', '模拟失败')
  const dws = failed.runtimes.find((r) => r.code === 'dws_user_summary')!
  check('resume-shard 节点失败后为可续跑', dws.state === 'resumable')
  const resumed = resumeShard(confirmed.id, 'dws_user_summary')
  check('续跑后回到运行中', resumed.runtimes.find((r) => r.code === 'dws_user_summary')!.state === 'running')

  // 跳过继续策略：dwd_order_detail 失败后，其下游 ads_sales_dashboard 为 skip-continue
  const skipped = failNode(confirmed.id, 'dwd_order_detail', '模拟失败')
  check('skip-continue 下游被标记跳过', skipped.runtimes.some((r) => r.code === 'ads_sales_dashboard' && r.state === 'skipped'))
  // resume-shard 下游（dws_user_summary）保持可续跑并带说明
  check('resume-shard 下游带续跑说明', skipped.runtimes.some((r) => r.code === 'dws_user_summary' && r.message?.includes('续跑')))
}

// 8) 两代计划与陈旧消息隔离
{
  console.log('代数隔离（迟到完成消息）')
  resetStorage()
  const first = createPlan('并发演示', ['ods_order'], '操作员甲')
  confirmPlan(first.id, '操作员甲')
  const second = createPlan('并发演示', ['ods_order'], '操作员乙')
  check('同名再编排代数递增', second.generation === 2)
  check('旧一代被取代', listPlans().find((p) => p.id === first.id)!.status === 'superseded')
  const stale = receiveCompletion('并发演示', 1, 'ods_order', 'late')
  check('旧代数迟到消息被隔离', stale.accepted === false)
  const fresh = receiveCompletion('并发演示', 2, 'ods_order', 'on-time')
  check('当前代数消息被接受', fresh.accepted === true)
  const current = listPlans().find((p) => p.id === second.id)!
  check('被接受消息推进了当前计划节点', current.runtimes.find((r) => r.code === 'ods_order')!.state === 'succeeded')
}

// 9) 证据不可变：节点升版后旧计划快照不变
{
  console.log('执行证据不可变')
  resetStorage()
  const plan = createPlan('证据演示', ['ods_payment'], '操作员甲')
  const confirmed = confirmPlan(plan.id, '操作员甲')
  const before = confirmed.snapshots.find((s) => s.code === 'ods_payment')!
  const node = getNode('ods_payment')!
  saveNode(
    {
      code: node.code,
      name: node.name,
      inputTables: [...node.inputTables],
      outputTable: node.outputTable,
      expression: 'SELECT * FROM src_db.t_payment WHERE dt = ${bizdate} AND channel = \'online\'',
      order: node.order,
      dependsOn: [...node.dependsOn],
      failureStrategy: node.failureStrategy,
      schedule: node.schedule,
      shardCount: node.shardCount,
      enabled: node.enabled,
      updatedBy: '操作员乙',
    },
    node.id,
  )
  check('表达式变更后节点版本 +1', getNode('ods_payment')!.version === before.version + 1)
  const oldPlan = listPlans().find((p) => p.id === plan.id)!
  const snapshot = oldPlan.snapshots.find((s) => s.code === 'ods_payment')!
  check('旧计划证据保留当次表达式', snapshot.expression === before.expression)
  check('旧计划证据保留当次版本号', snapshot.version === before.version)
}

if (failures > 0) {
  console.error(`\n${failures} 项验证失败`)
  process.exit(1)
}
console.log('\n全部验证通过')
