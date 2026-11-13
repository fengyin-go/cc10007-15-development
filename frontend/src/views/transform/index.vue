<template>
  <section class="page" data-module="transform">
    <header class="page-head">
      <div>
        <h2>转换编排</h2>
        <p class="page-desc">
          多选节点按输入表、输出表、依赖节点与执行顺序计算可并行波次，识别缺失依赖、自环与相互等待阻断；
          失败策略、质量阻断、监控告警与流程验收均关联到具体节点波次，并保留当次表达式与输入版本证据。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新数据</button>
      </div>
    </header>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <NodeRegistry v-if="activeTab === 'nodes'" @changed="reload" />
    <PlanBuilder v-else-if="activeTab === 'plan'" @changed="reload" />
    <PlanExecution v-else-if="activeTab === 'run'" @changed="reload" />
    <ReplayAcceptance v-else @changed="reload" />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import NodeRegistry from './NodeRegistry.vue'
import PlanBuilder from './PlanBuilder.vue'
import PlanExecution from './PlanExecution.vue'
import ReplayAcceptance from './ReplayAcceptance.vue'

type TabKey = 'nodes' | 'plan' | 'run' | 'replay'

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'nodes', label: '节点登记' },
  { key: 'plan', label: '波次计划' },
  { key: 'run', label: '执行与失败策略' },
  { key: 'replay', label: '回看与流程验收' },
]

const activeTab = ref<TabKey>('plan')
const reload = () => undefined
</script>

<style scoped>
.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 14px;
}
.tab-item {
  border: none;
  background: none;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}
.tab-item.active {
  color: var(--brand);
  border-bottom-color: var(--brand);
  font-weight: 600;
}
.page-actions {
  display: flex;
  gap: 8px;
}
</style>
