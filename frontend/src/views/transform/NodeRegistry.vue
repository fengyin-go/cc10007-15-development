<template>
  <div>
    <div class="toolbar">
      <button class="btn primary" type="button" @click="openCreate">登记转换节点</button>
      <span class="hint">表达式或依赖变更会使节点版本 +1，计划确认时锁定该版本作为执行证据。</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>节点编号</th>
          <th>名称</th>
          <th>输入表</th>
          <th>输出表</th>
          <th>依赖节点</th>
          <th>执行顺序</th>
          <th>失败策略</th>
          <th>分片</th>
          <th>版本</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="node in nodes" :key="node.id">
          <td>{{ node.code }}</td>
          <td>{{ node.name }}</td>
          <td>{{ node.inputTables.join('，') }}</td>
          <td>{{ node.outputTable }}</td>
          <td>{{ node.dependsOn.length ? node.dependsOn.join('，') : '—' }}</td>
          <td>{{ node.order }}</td>
          <td>{{ strategyLabel(node.failureStrategy) }}</td>
          <td>{{ node.shardCount }}</td>
          <td>v{{ node.version }}</td>
          <td>
            <span class="badge" :class="node.enabled ? 'ok' : 'off'">
              {{ node.enabled ? '已启用' : '已停用' }}
            </span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openEdit(node)">编辑</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <form class="modal" @submit.prevent="submit">
        <h3>{{ form.id ? '编辑转换节点' : '登记转换节点' }}</h3>
        <label class="form-row">
          <span>节点编号</span>
          <input v-model="form.code" required :disabled="!!form.id" placeholder="如 dwd_order_detail" />
        </label>
        <label class="form-row">
          <span>节点名称</span>
          <input v-model="form.name" required />
        </label>
        <label class="form-row">
          <span>输入表（逗号分隔）</span>
          <input v-model="inputTablesText" required placeholder="ods.ods_order，ods.ods_payment" />
        </label>
        <label class="form-row">
          <span>输出表</span>
          <input v-model="form.outputTable" required placeholder="dwd.dwd_order_detail" />
        </label>
        <label class="form-row">
          <span>转换表达式</span>
          <textarea v-model="form.expression" rows="3" required></textarea>
        </label>
        <label class="form-row">
          <span>依赖节点</span>
          <span class="check-group">
            <label v-for="option in dependencyOptions" :key="option" class="check-item">
              <input v-model="form.dependsOn" type="checkbox" :value="option" :disabled="option === form.code" />
              {{ option }}
            </label>
          </span>
        </label>
        <div class="form-grid">
          <label class="form-row">
            <span>执行顺序</span>
            <input v-model.number="form.order" type="number" required />
          </label>
          <label class="form-row">
            <span>分片数</span>
            <input v-model.number="form.shardCount" type="number" min="1" required />
          </label>
        </div>
        <div class="form-grid">
          <label class="form-row">
            <span>失败策略</span>
            <select v-model="form.failureStrategy">
              <option value="block-downstream">阻断下游</option>
              <option value="skip-continue">跳过继续</option>
              <option value="resume-shard">分片续跑</option>
            </select>
          </label>
          <label class="form-row">
            <span>调度周期</span>
            <input v-model="form.schedule" required />
          </label>
        </div>
        <label class="form-row check-line">
          <input v-model="form.enabled" type="checkbox" />
          <span>启用节点</span>
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="showForm = false">取消</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { FAILURE_STRATEGY_LABEL } from '@/data/orchestration/engine'
import { listNodes, saveNode } from '@/data/orchestration/store'
import type { FailureStrategy, TransformNode } from '@/data/orchestration/types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const nodes = ref<TransformNode[]>(listNodes())
const showForm = ref(false)
const formError = ref('')
const inputTablesText = ref('')

type FormState = {
  id?: number
  code: string
  name: string
  outputTable: string
  expression: string
  order: number
  dependsOn: string[]
  failureStrategy: FailureStrategy
  schedule: string
  shardCount: number
  enabled: boolean
}

const emptyForm = (): FormState => ({
  code: '',
  name: '',
  outputTable: '',
  expression: '',
  order: 50,
  dependsOn: [],
  failureStrategy: 'block-downstream',
  schedule: '日级 06:00',
  shardCount: 1,
  enabled: true,
})

const form = ref<FormState>(emptyForm())

const dependencyOptions = computed(() =>
  nodes.value.map((node) => node.code).filter((code) => code !== form.value.code),
)

function strategyLabel(value: FailureStrategy): string {
  return FAILURE_STRATEGY_LABEL[value]
}

function openCreate(): void {
  form.value = emptyForm()
  inputTablesText.value = ''
  formError.value = ''
  showForm.value = true
}

function openEdit(node: TransformNode): void {
  form.value = {
    id: node.id,
    code: node.code,
    name: node.name,
    outputTable: node.outputTable,
    expression: node.expression,
    order: node.order,
    dependsOn: [...node.dependsOn],
    failureStrategy: node.failureStrategy,
    schedule: node.schedule,
    shardCount: node.shardCount,
    enabled: node.enabled,
  }
  inputTablesText.value = node.inputTables.join('，')
  formError.value = ''
  showForm.value = true
}

function submit(): void {
  formError.value = ''
  const inputTables = inputTablesText.value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (inputTables.length === 0) {
    formError.value = '至少填写一个输入表'
    return
  }
  if (form.value.dependsOn.includes(form.value.code)) {
    formError.value = '节点不能依赖自身（自环）'
    return
  }
  const duplicate = nodes.value.some(
    (node) => node.code === form.value.code && node.id !== form.value.id,
  )
  if (duplicate) {
    formError.value = '节点编号已存在'
    return
  }
  saveNode(
    {
      code: form.value.code,
      name: form.value.name,
      inputTables,
      outputTable: form.value.outputTable,
      expression: form.value.expression,
      order: form.value.order,
      dependsOn: form.value.dependsOn,
      failureStrategy: form.value.failureStrategy,
      schedule: form.value.schedule,
      shardCount: form.value.shardCount,
      enabled: form.value.enabled,
      updatedBy: '值班管理员',
    },
    form.value.id,
  )
  nodes.value = listNodes()
  showForm.value = false
  emit('changed')
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.hint {
  color: var(--muted);
  font-size: 12px;
}
.badge {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.badge.ok {
  background: #e7f6ec;
  color: #067647;
}
.badge.off {
  background: #f2f4f7;
  color: var(--muted);
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  width: 640px;
  max-height: 88vh;
  overflow: auto;
}
.modal h3 {
  margin: 0 0 14px;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}
.form-row > span {
  color: var(--muted);
}
.form-row input,
.form-row textarea,
.form-row select {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.check-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.check-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #f2f4f7;
  border-radius: 6px;
  padding: 4px 8px;
}
.check-line {
  flex-direction: row;
  align-items: center;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
