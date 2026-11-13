<template>
  <div>
    <div class="toolbar">
      <label class="plan-select">
        <span>回看计划（以转换编排为主对象）</span>
        <select v-model="selectedPlanId" @change="refresh">
          <option value="" disabled>请选择计划</option>
          <option v-for="plan in plans" :key="plan.id" :value="plan.id">
            {{ plan.name }} · 第 {{ plan.generation }} 代 · {{ planStatusLabel(plan.status) }}
          </option>
        </select>
      </label>
    </div>

    <template v-if="plan">
      <section>
        <h3 class="block-title">流程验收（依赖 / 构建 / 部署 / 环境 / 数据库版本）</h3>
        <div class="accept-grid">
          <div v-for="item in plan.acceptance" :key="item.key" class="accept-card" :class="{ pass: item.passed }">
            <header>
              <span>{{ item.label }}</span>
              <span class="state" :class="item.passed ? 'succeeded' : 'pending'">
                {{ item.passed ? '通过' : '待验收' }}
              </span>
            </header>
            <p>{{ item.detail }}</p>
            <p v-if="item.checkedAt" class="meta">
              {{ item.checkedAt }} · {{ item.checkedBy }}
            </p>
            <div class="accept-actions">
              <button class="link" type="button" @click="mark(item.key, true)">标记通过</button>
              <button class="link danger" type="button" @click="mark(item.key, false)">标记待整改</button>
            </div>
          </div>
        </div>
        <p class="hint">
          验收进度：{{ passedCount }} / {{ plan.acceptance.length }}
          <span v-if="allPassed" class="ok-text"> · 全部通过，计划具备交付条件</span>
        </p>
      </section>

      <section>
        <h3 class="block-title">执行波次回看</h3>
        <div v-for="wave in plan.waves" :key="wave.index" class="replay-wave">
          <header>第 {{ wave.index + 1 }} 波</header>
          <ul>
            <li v-for="code in wave.nodeCodes" :key="code">
              <strong>{{ code }}</strong>
              <span class="state" :class="runtimeOf(code)?.state">{{ stateLabel(runtimeOf(code)?.state) }}</span>
              <span class="meta">锁定 v{{ plan.confirmedVersions[code] ?? '—' }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section>
        <h3 class="block-title">执行证据（当次表达式与输入版本，不可变快照）</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>执行版本</th>
              <th>输入表（执行时版本）</th>
              <th>输出表</th>
              <th>当次表达式</th>
              <th>失败策略</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="snapshot in plan.snapshots" :key="snapshot.code">
              <td>{{ snapshot.code }}</td>
              <td>v{{ snapshot.version }}</td>
              <td>{{ snapshot.inputTables.join('，') }}</td>
              <td>{{ snapshot.outputTable }}</td>
              <td><code class="expr">{{ snapshot.expression }}</code></td>
              <td>{{ strategyLabel(snapshot.failureStrategy) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="hint">
          证据在计划确认时锁定；即使节点后续被修改并升版，本计划回看仍显示当次表达式与输入版本。
        </p>
      </section>

      <section>
        <h3 class="block-title">阻断与告警归档</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>节点</th>
              <th>波次</th>
              <th>关联对象</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(blocker, index) in plan.blockers" :key="`b-${index}`">
              <td>{{ blockerLabel(blocker.kind) }}</td>
              <td>{{ blocker.nodeCode }}</td>
              <td>{{ blocker.wave !== undefined ? `第 ${blocker.wave + 1} 波` : '—' }}</td>
              <td>{{ blocker.refCode ?? '—' }}</td>
              <td>{{ blocker.message }}</td>
            </tr>
            <tr v-for="alarm in plan.alarms" :key="alarm.configCode">
              <td>监控告警 {{ alarm.level }}</td>
              <td>{{ alarm.nodeCode }}</td>
              <td>{{ alarm.wave !== undefined ? `第 ${alarm.wave + 1} 波` : '—' }}</td>
              <td>{{ alarm.configCode }}</td>
              <td>{{ alarm.message }}</td>
            </tr>
            <tr v-if="!plan.blockers.length && !plan.alarms.length">
              <td colspan="5" class="empty-state">本计划无阻断与告警</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <p v-else class="empty-state">暂无计划，请先在「波次计划」标签生成并确认。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { BLOCKER_LABEL, FAILURE_STRATEGY_LABEL } from '@/data/orchestration/engine'
import {
  acceptanceAllPassed,
  listPlans,
  planStatusLabel,
  updateAcceptance,
} from '@/data/orchestration/store'
import type { FailureStrategy, NodeRunState, TransformPlan } from '@/data/orchestration/types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const plans = ref<TransformPlan[]>(listPlans())
const selectedPlanId = ref(plans.value[0]?.id ?? '')

const plan = computed(
  () => plans.value.find((item) => item.id === selectedPlanId.value) ?? null,
)

const STATE_LABEL: Record<NodeRunState, string> = {
  pending: '等待',
  ready: '就绪',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '已跳过',
  resumable: '可续跑',
}

const passedCount = computed(
  () => plan.value?.acceptance.filter((item) => item.passed).length ?? 0,
)
const allPassed = computed(() => (plan.value ? acceptanceAllPassed(plan.value) : false))

function refresh(): void {
  plans.value = listPlans()
}
function runtimeOf(code: string) {
  return plan.value?.runtimes.find((item) => item.code === code)
}
function stateLabel(state?: NodeRunState): string {
  return state ? STATE_LABEL[state] : '—'
}
function strategyLabel(value: FailureStrategy): string {
  return FAILURE_STRATEGY_LABEL[value]
}
function blockerLabel(kind: keyof typeof BLOCKER_LABEL): string {
  return BLOCKER_LABEL[kind]
}

function mark(key: string, passed: boolean): void {
  if (!plan.value) return
  const item = plan.value.acceptance.find((entry) => entry.key === key)
  if (!item) return
  updateAcceptance(
    plan.value.id,
    key as typeof item.key,
    passed,
    passed ? `${item.label}核对通过` : `${item.label}存在待整改项`,
    '值班管理员',
  )
  refresh()
  emit('changed')
}
</script>

<style scoped>
.plan-select {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
  max-width: 460px;
}
.plan-select select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}
.block-title {
  margin: 18px 0 10px;
}
.accept-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.accept-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.accept-card.pass {
  border-color: #6ce9a6;
}
.accept-card header {
  display: flex;
  justify-content: space-between;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.accept-card p {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0;
}
.accept-card .meta {
  font-size: 11px;
}
.accept-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}
.state {
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  background: #f2f4f7;
}
.state.succeeded {
  background: #e7f6ec;
  color: #067647;
}
.state.pending {
  background: #fffaeb;
  color: #b54708;
}
.state.ready {
  background: #eff8ff;
  color: #175cd3;
}
.state.running {
  background: #fffaeb;
  color: #b54708;
}
.state.failed {
  background: #fef3f2;
  color: #b42318;
}
.state.skipped {
  background: #f2f4f7;
  color: var(--muted);
}
.state.resumable {
  background: #f4f3ff;
  color: #5925dc;
}
.replay-wave {
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.replay-wave > header {
  background: #eef2f7;
  padding: 6px 10px;
  font-weight: 600;
  font-size: 13px;
}
.replay-wave ul {
  margin: 0;
  padding: 8px 10px 8px 28px;
}
.replay-wave li {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
  font-size: 13px;
}
.meta {
  color: var(--muted);
  font-size: 12px;
}
.expr {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  color: #344054;
  word-break: break-all;
}
.hint {
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #067647;
}
.link.danger {
  color: #b42318;
}
</style>
