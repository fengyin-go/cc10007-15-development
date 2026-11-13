/**
 * 转换编排领域类型。
 * 与通用 EntryRow 不同，这里围绕「节点 -> 计划 -> 波次 -> 执行证据」组织，
 * 所有结构都可 JSON 序列化，便于直接落到 localStorage。
 */

/** 失败策略：阻断下游 / 跳过继续 / 分片续跑。 */
export type FailureStrategy = 'block-downstream' | 'skip-continue' | 'resume-shard'

/** 转换节点：依赖以节点编号（code）表达，版本随表达式或依赖变更递增。 */
export type TransformNode = {
  id: number
  code: string
  name: string
  inputTables: string[]
  outputTable: string
  expression: string
  order: number
  dependsOn: string[]
  failureStrategy: FailureStrategy
  schedule: string
  shardCount: number
  /** 节点配置版本，每次保存 +1，计划确认时锁定该版本。 */
  version: number
  enabled: boolean
  updatedAt: string
  updatedBy: string
}

/** 计划阻断类型：缺失依赖、自环、相互等待（环）、上游被阻断、质量阻断。 */
export type BlockerKind =
  | 'missing-dependency'
  | 'self-loop'
  | 'cyclic-wait'
  | 'upstream-blocked'
  | 'quality-block'

export type PlanBlocker = {
  kind: BlockerKind
  nodeCode: string
  /** 关联到的对象编号：缺失节点编号 / 质量规则编号等。 */
  refCode?: string
  message: string
  /** 阻断命中的波次（质量阻断在计划时已能定位波次）。 */
  wave?: number
}

/** 波次：同一波内的节点彼此无依赖，可并行执行。 */
export type PlanWave = {
  index: number
  nodeCodes: string[]
}

/** 计划内节点的执行态。 */
export type NodeRunState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'resumable'

/** 计划执行时锁定的节点快照：证据要求保留当次表达式与输入版本。 */
export type NodeSnapshot = {
  nodeId: number
  code: string
  version: number
  expression: string
  inputTables: string[]
  outputTable: string
  failureStrategy: FailureStrategy
  shardCount: number
}

export type PlanNodeRuntime = {
  code: string
  wave: number
  state: NodeRunState
  /** 已完成分片数（resume-shard 策略用于从未完成分片继续）。 */
  finishedShards: number
  message?: string
  /** 执行证据：实际使用的表达式与输入版本。 */
  evidence?: NodeSnapshot
}

/** 质量校验阻断结果，关联到具体输出表与波次。 */
export type QualityBlock = {
  ruleCode: string
  table: string
  field: string
  level: 'block' | 'warn'
  expression: string
  blocking: boolean
  nodeCode?: string
  wave?: number
  message: string
}

/** 任务监控告警，关联到节点与波次。 */
export type MonitorAlarm = {
  configCode: string
  refCode: string
  metric: string
  level: 'P1' | 'P2' | 'P3'
  threshold: string
  channel: string
  nodeCode?: string
  wave?: number
  message: string
}

export type PlanStatus = 'draft' | 'confirmed' | 'running' | 'finished' | 'failed' | 'superseded'

/** 流程验收维度：依赖、构建、部署、环境、数据库版本。 */
export type AcceptanceItem = {
  key: 'dependency' | 'build' | 'deploy' | 'environment' | 'database'
  label: string
  passed: boolean
  detail: string
  checkedAt?: string
  checkedBy?: string
}

export type TransformPlan = {
  id: string
  name: string
  /** 计划版本代号：同一计划被重新确认后 generation 递增，旧计划的迟到消息据此被隔离。 */
  generation: number
  status: PlanStatus
  selectedNodeCodes: string[]
  /** 确认时采用的节点版本：code -> version。 */
  confirmedVersions: Record<string, number>
  operator: string
  createdAt: string
  confirmedAt?: string
  waves: PlanWave[]
  blockers: PlanBlocker[]
  qualityBlocks: QualityBlock[]
  alarms: MonitorAlarm[]
  runtimes: PlanNodeRuntime[]
  acceptance: AcceptanceItem[]
  /** 该计划基于的节点快照，证据不可变。 */
  snapshots: NodeSnapshot[]
}

/** 质量规则（镜像质量校验模块中与编排相关的字段）。 */
export type QualityRule = {
  ruleCode: string
  table: string
  field: string
  expression: string
  level: 'block' | 'warn'
  enabled: boolean
  /** 演示用：当前是否触发阻断。 */
  triggered: boolean
}

/** 监控配置（镜像任务监控模块中与编排相关的字段）。 */
export type MonitorConfig = {
  configCode: string
  refCode: string
  metric: string
  threshold: string
  level: 'P1' | 'P2' | 'P3'
  channel: string
  enabled: boolean
  alarming: boolean
}

/** 迟到 / 陈旧的完成消息记录，用于演示版本隔离。 */
export type StaleMessage = {
  id: number
  planId: string
  generation: number
  nodeCode: string
  payload: string
  receivedAt: string
  accepted: boolean
  reason: string
}
