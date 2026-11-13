<template>
  <div>
    <div class="toolbar">
      <label class="plan-select">
        <span>选择计划</span>
        <select v-model="selectedPlanId" @change="refresh">
          <option value="" disabled>请选择已确认的计划</option>
          <option v-for="plan in plans" :key="plan.id" :value="plan.id">
            {{ plan.name }} · 第 {{ plan.generation }} 代 · {{ planStatusLabel(plan.status) }}
          </option>
        </select>
      </label>
    </div>

    <template v-if="plan">
      <div class="alert" :class="plan.status === 'superseded' ? 'warn' : 'info'">
        当前代数：第 {{ plan.generation }} 代 · 状态：{{ planStatusLabel(plan.status) }}
        <span v-if="plan.confirmedAt"> · 确认时间：{{ plan.confirmedAt }}</span>
      </div>

      <h3 class="block-title">按波次执行（同波节点可并行，波间严格依赖）</h3>
      <div v-for="wave in plan.waves" :key="wave.index" class="wave-run">
        <header>第 {{ wave.index + 1 }} 波</header>
        <table class="data-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>状态</th>
              <th>分片进度</th>
              <th>锁定版本</th>
              <th>说明</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="code in wave.nodeCodes" :key="code">
              <td>{{ code }}</td>
              <td><span class="state" :class="runtimeOf(code)?.state">{{ stateLabel(runtimeOf(code)?.state) }}</span></td>
              <td>{{ runtimeOf(code)?.finishedShards ?? 0 }} / {{ snapshotOf(code)?.shardCount ?? 1 }}</td>
              <td>v{{ plan.confirmedVersions[code] ?? '—' }}</td>
              <td class="msg">{{ runtimeOf(code)?.message ?? '—' }}</td>
              <td class="row-actions">
                <button
                  v-if="canAdvance(code)"
                  class="link"
                  type="button"
                  @click="advance(code)"
                >
                  {{ runtimeOf(code)?.state === 'running' ? '完成一个分片' : '开始执行' }}
                </button>
                <button
                  v-if="canFail(code)"
                  class="link danger"
                  type="button"
                  @click="fail(code)"
                >
                  模拟失败
                </button>
                <button
                  v-if="runtimeOf(code)?.state === 'resumable'"
                  class="link"
                  type="button"
                  @click="resume(code)"
                >
                  从断点分片续跑
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <section class="stale-block">
        <h3 class="block-title">并发与陈旧消息隔离</h3>
        <p class="hint">
          模拟两个操作员同时修改同一依赖：重新确认同名计划会生成新一代并作废旧一代。
          旧计划迟到的完成消息按代数校验，不能推进新计划。
        </p>
        <div class="stale-actions">
          <button class="btn" type="button" @click="sendCurrent">发送当前代数完成消息</button>
          <button class="btn" type="button" @click="sendStale">发送旧代数迟到消息</button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>接收时间</th>
              <th>计划代数</th>
              <th>节点</th>
              <th>载荷</th>
              <th>是否接受</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="message in messages" :key="message.id">
              <td>{{ message.receivedAt }}</td>
              <td>第 {{ message.generation }} 代</td>
              <td>{{ message.nodeCode }}</td>
              <td>{{ message.payload }}</td>
              <td>
                <span class="state" :class="message.accepted ? 'succeeded' : 'skipped'">
                  {{ message.accepted ? '已接受' : '已隔离' }}
                </span>
              </td>
              <td class="msg">{{ message.reason }}</td>
            </tr>
            <tr v-if="!messages.length">
              <td colspan="6" class="empty-state">暂无消息记录</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <p v-else class="empty-state">请先在「波次计划」标签确认一个计划。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  advanceNode,
  failNode,
  listMessages,
  listPlans,
  planStatusLabel,
  receiveCompletion,
  resumeShard,
} from '@/data/orchestration/store'
import type { NodeRunState, StaleMessage, TransformPlan } from '@/data/orchestration/types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const plans = ref<TransformPlan[]>(listPlans())
const selectedPlanId = ref('')
const messages = ref<StaleMessage[]>(listMessages())

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

function refresh(): void {
  plans.value = listPlans()
  messages.value = listMessages()
}
function stateLabel(state?: NodeRunState): string {
  return state ? STATE_LABEL[state] : '—'
}
function runtimeOf(code: string) {
  return plan.value?.runtimes.find((item) => item.code === code)
}
function snapshotOf(code: string) {
  return plan.value?.snapshots.find((item) => item.code === code)
}
function canAdvance(code: string): boolean {
  const state = runtimeOf(code)?.state
  return state === 'ready' || state === 'running'
}
function canFail(code: string): boolean {
  const state = runtimeOf(code)?.state
  return state === 'ready' || state === 'running' || state === 'resumable'
}

function advance(code: string): void {
  if (!plan.value) return
  advanceNode(plan.value.id, code)
  refresh()
  emit('changed')
}
function fail(code: string): void {
  if (!plan.value) return
  failNode(plan.value.id, code, `节点 ${code} 执行失败（模拟）`)
  refresh()
  emit('changed')
}
function resume(code: string): void {
  if (!plan.value) return
  resumeShard(plan.value.id, code)
  refresh()
  emit('changed')
}

function sendCurrent(): void {
  if (!plan.value) return
  const target = plan.value.runtimes.find(
    (item) => item.state === 'ready' || item.state === 'pending',
  )
  if (!target) {
    window.alert('当前计划没有可接收完成消息的节点')
    return
  }
  receiveCompletion(
    plan.value.name,
    plan.value.generation,
    target.code,
    `shard-completed:${target.code}`,
  )
  refresh()
}
function sendStale(): void {
  if (!plan.value) return
  const target = plan.value.runtimes[0]
  receiveCompletion(
    plan.value.name,
    Math.max(1, plan.value.generation - 1),
    target.code,
    `late-completion:${target.code}`,
  )
  refresh()
}
</script>

<style scoped>
.toolbar {
  margin-bottom: 12px;
}
.plan-select {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--muted);
  max-width: 420px;
}
.plan-select select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}
.block-title {
  margin: 16px 0 8px;
}
.alert {
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
}
.alert.info {
  background: #eff8ff;
  border: 1px solid #b2ddff;
}
.alert.warn {
  background: #fffaeb;
  border: 1px solid #fedf89;
}
.wave-run {
  margin-bottom: 14px;
}
.wave-run > header {
  font-weight: 600;
  font-size: 13px;
  background: #eef2f7;
  padding: 6px 10px;
  border-radius: 6px 6px 0 0;
}
.state {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #f2f4f7;
}
.state.ready {
  background: #eff8ff;
  color: #175cd3;
}
.state.running {
  background: #fffaeb;
  color: #b54708;
}
.state.succeeded {
  background: #e7f6ec;
  color: #067647;
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
.msg {
  font-size: 12px;
  color: var(--muted);
}
.link.danger {
  color: #b42318;
}
.stale-block {
  border-top: 1px solid var(--border);
  margin-top: 18px;
  padding-top: 8px;
}
.hint {
  color: var(--muted);
  font-size: 12px;
}
.stale-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
</style>
