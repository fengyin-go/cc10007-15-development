<template>
  <div>
    <div class="toolbar">
      <h3 class="block-title">第一步：选择节点并计算可并行波次</h3>
      <div class="toolbar-actions">
        <button class="btn" type="button" @click="selectAll">全选启用节点</button>
        <button class="btn ghost" type="button" @click="selected = []">清空</button>
        <button class="btn primary" type="button" :disabled="!selected.length" @click="build">
          计算波次
        </button>
      </div>
    </div>

    <table class="data-table pick-table">
      <thead>
        <tr>
          <th style="width: 40px">选择</th>
          <th>节点编号</th>
          <th>输出表</th>
          <th>依赖节点</th>
          <th>执行顺序</th>
          <th>失败策略</th>
          <th>当前版本</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="node in nodes" :key="node.id" :class="{ disabled: !node.enabled }">
          <td>
            <input v-model="selected" type="checkbox" :value="node.code" :disabled="!node.enabled" />
          </td>
          <td>{{ node.code }}<span class="sub">{{ node.name }}</span></td>
          <td>{{ node.outputTable }}</td>
          <td>{{ node.dependsOn.length ? node.dependsOn.join('，') : '—' }}</td>
          <td>{{ node.order }}</td>
          <td>{{ strategyLabel(node.failureStrategy) }}</td>
          <td>v{{ node.version }}</td>
        </tr>
      </tbody>
    </table>

    <template v-if="draftPlan">
      <section class="result-block">
        <h3 class="block-title">第二步：检查波次与阻断</h3>

        <div v-if="hardBlockers.length" class="alert danger">
          <strong>存在硬阻断，计划不可确认：</strong>
          <ul>
            <li v-for="(blocker, index) in hardBlockers" :key="index">
              <span class="tag">{{ blockerLabel(blocker.kind) }}</span>
              {{ blocker.message }}
            </li>
          </ul>
        </div>

        <div v-if="qualityBlocking.length" class="alert warn">
          <strong>质量校验阻断（关联波次）：</strong>
          <ul>
            <li v-for="block in qualityBlocking" :key="block.ruleCode">
              <span class="tag">质量阻断</span>{{ block.message }}
              <span v-if="block.wave !== undefined" class="wave-ref">命中第 {{ block.wave + 1 }} 波</span>
            </li>
          </ul>
        </div>

        <div v-if="qualityWarnings.length" class="alert info">
          <strong>质量告警（不阻断）：</strong>
          <ul>
            <li v-for="block in qualityWarnings" :key="block.ruleCode">{{ block.message }}</li>
          </ul>
        </div>

        <div v-if="draftPlan.alarms.length" class="alert info">
          <strong>任务监控告警（关联节点波次）：</strong>
          <ul>
            <li v-for="alarm in draftPlan.alarms" :key="alarm.configCode">
              <span class="tag" :class="`level-${alarm.level}`">{{ alarm.level }}</span>
              {{ alarm.message }}
              <span v-if="alarm.wave !== undefined" class="wave-ref">节点 {{ alarm.nodeCode }} · 第 {{ alarm.wave + 1 }} 波</span>
            </li>
          </ul>
        </div>

        <h4 class="wave-title">可并行波次（共 {{ draftPlan.waves.length }} 波）</h4>
        <div class="wave-list">
          <div v-for="wave in draftPlan.waves" :key="wave.index" class="wave-card">
            <header>第 {{ wave.index + 1 }} 波</header>
            <ul>
              <li v-for="code in wave.nodeCodes" :key="code">
                {{ code }}
                <span v-if="isBlocked(code)" class="tag blocked">被阻断</span>
              </li>
            </ul>
          </div>
        </div>

        <h4 class="wave-title">失败策略预演（计划先说明下游影响）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>失败策略</th>
              <th>失败后下游处理说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="node in selectedNodes" :key="node.code">
              <td>{{ node.code }}</td>
              <td>{{ strategyLabel(node.failureStrategy) }}</td>
              <td>{{ failureExplain(node.code) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="confirm-bar">
          <label class="plan-name">
            <span>计划名称</span>
            <input v-model="planName" placeholder="如 日常销售链路-20261113" />
          </label>
          <button class="btn primary" type="button" :disabled="!!hardBlockers.length" @click="confirm">
            确认计划并锁定节点版本
          </button>
          <span v-if="hardBlockers.length" class="error-text">修复硬阻断后才能确认</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  BLOCKER_LABEL,
  FAILURE_STRATEGY_LABEL,
  simulateFailure,
} from '@/data/orchestration/engine'
import {
  confirmPlan,
  createPlan,
  listNodes,
} from '@/data/orchestration/store'
import type { FailureStrategy, TransformNode, TransformPlan } from '@/data/orchestration/types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const nodes = ref<TransformNode[]>(listNodes())
const selected = ref<string[]>([])
const planName = ref('')
const draftPlan = ref<TransformPlan | null>(null)

const selectedNodes = computed(() =>
  nodes.value.filter((node) => selected.value.includes(node.code)),
)

const hardBlockers = computed(() =>
  (draftPlan.value?.blockers ?? []).filter(
    (blocker) =>
      blocker.kind === 'missing-dependency' ||
      blocker.kind === 'self-loop' ||
      blocker.kind === 'cyclic-wait',
  ),
)

const qualityBlocking = computed(() =>
  (draftPlan.value?.qualityBlocks ?? []).filter((block) => block.blocking),
)
const qualityWarnings = computed(() =>
  (draftPlan.value?.qualityBlocks ?? []).filter((block) => !block.blocking),
)

function strategyLabel(value: FailureStrategy): string {
  return FAILURE_STRATEGY_LABEL[value]
}
function blockerLabel(kind: keyof typeof BLOCKER_LABEL): string {
  return BLOCKER_LABEL[kind]
}
function isBlocked(code: string): boolean {
  return draftPlan.value?.blockers.some(
    (blocker) =>
      (blocker.kind === 'quality-block' || blocker.kind === 'upstream-blocked') &&
      blocker.nodeCode === code,
  ) ?? false
}

function selectAll(): void {
  selected.value = nodes.value.filter((node) => node.enabled).map((node) => node.code)
}

function build(): void {
  const name = planName.value.trim() || `计划-${new Date().toISOString().slice(0, 10)}`
  planName.value = name
  draftPlan.value = createPlan(name, selected.value, '值班管理员')
}

function confirm(): void {
  if (!draftPlan.value) return
  const confirmed = confirmPlan(draftPlan.value.id, '值班管理员')
  draftPlan.value = confirmed
  emit('changed')
  window.alert(
    `计划已确认（第 ${confirmed.generation} 代），锁定节点版本：\n` +
      Object.entries(confirmed.confirmedVersions)
        .map(([code, version]) => `${code} -> v${version}`)
        .join('\n'),
  )
}

function failureExplain(code: string): string {
  if (!draftPlan.value) return ''
  const impacts = simulateFailure(code, selectedNodes.value, draftPlan.value.runtimes)
  if (impacts.length === 0) return '无下游节点，失败不影响其他节点'
  const node = selectedNodes.value.find((item) => item.code === code)!
  if (node.failureStrategy === 'resume-shard') {
    return `本节点失败后可从未完成分片续跑；下游：${impacts
      .map((item) => `${item.code}（${item.state === 'skipped' ? '跳过' : item.state === 'resumable' ? '可续跑' : '等待'}）`)
      .join('，')}`
  }
  return impacts.map((item) => `${item.code}：${item.message}`).join('；')
}
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.toolbar-actions {
  display: flex;
  gap: 8px;
}
.block-title {
  margin: 14px 0 8px;
}
.pick-table tr.disabled {
  color: var(--muted);
}
.sub {
  display: block;
  color: var(--muted);
  font-size: 12px;
}
.result-block {
  margin-top: 18px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.alert {
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
  font-size: 13px;
}
.alert ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.alert.danger {
  background: #fef3f2;
  border: 1px solid #fecdca;
}
.alert.warn {
  background: #fffaeb;
  border: 1px solid #fedf89;
}
.alert.info {
  background: #eff8ff;
  border: 1px solid #b2ddff;
}
.tag {
  display: inline-block;
  background: #eef2f7;
  border-radius: 4px;
  padding: 0 6px;
  font-size: 12px;
  margin-right: 6px;
}
.tag.blocked {
  background: #fef3f2;
  color: #b42318;
}
.tag.level-P1 {
  background: #fef3f2;
  color: #b42318;
}
.tag.level-P2 {
  background: #fffaeb;
  color: #b54708;
}
.tag.level-P3 {
  background: #eff8ff;
  color: #175cd3;
}
.wave-ref {
  color: var(--muted);
  font-size: 12px;
  margin-left: 6px;
}
.wave-title {
  margin: 16px 0 8px;
}
.wave-list {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.wave-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 180px;
  flex: 1;
}
.wave-card header {
  background: #eef2f7;
  padding: 6px 10px;
  font-weight: 600;
  font-size: 13px;
}
.wave-card ul {
  margin: 0;
  padding: 8px 10px 8px 26px;
  font-size: 13px;
}
.wave-card li {
  margin-bottom: 4px;
}
.confirm-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.plan-name {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
}
.plan-name input {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  min-width: 240px;
}
</style>
