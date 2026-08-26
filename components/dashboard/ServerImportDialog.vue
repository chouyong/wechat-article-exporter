<script setup lang="ts">
import type { ImportSourceAccount } from '#shared/utils/mp-account-import';
import { useServerAccountImport } from '~/composables/useServerAccountImport';

const props = defineProps<{
  accounts: ImportSourceAccount[];
}>();

const modal = useModal();
const { state, summary, errorInfo, sourceCount, mappedCount, runDryRun, reset } = useServerAccountImport();

const pendingCount = computed(() => props.accounts?.length ?? 0);

async function start() {
  await runDryRun(props.accounts ?? []);
}

function close() {
  reset();
  modal.close();
}
</script>

<template>
  <UModal prevent-close :ui="{ width: 'sm:max-w-lg' }">
    <UCard>
      <template #header>
        <div class="flex items-center gap-2 font-medium text-lg">
          <UIcon name="i-lucide:cloud-upload" class="size-6 text-blue-500" />
          <span>导入到服务端账号注册表（预检 / dry-run）</span>
        </div>
      </template>

      <!-- 始终可见的安全边界横幅：本轮只做预检，绝不写入 -->
      <div
        class="mb-4 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
      >
        <UIcon name="i-lucide:shield-alert" class="size-4 mt-0.5 shrink-0" />
        <span>这是<strong>预检（dry-run）</strong>，仅计算差异、<strong>不会写入服务端</strong>。正式导入将由后续步骤单独提供。</span>
      </div>

      <!-- 待导入 -->
      <div v-if="state === 'idle'" class="space-y-3">
        <p class="text-sm">
          将读取本浏览器中已缓存的 <strong>{{ pendingCount }}</strong> 个公众号账号，提交到服务端做预检。
        </p>
        <p v-if="pendingCount === 0" class="text-sm text-rose-500">当前浏览器没有可导入的账号。</p>
      </div>

      <!-- dry-run 进行中 -->
      <div v-else-if="state === 'loading'" class="flex items-center gap-2 text-sm">
        <UIcon name="i-lucide:loader-circle" class="size-5 animate-spin text-blue-500" />
        <span>预检进行中……（共 {{ mappedCount }} 个账号）</span>
      </div>

      <!-- 空数据（无有效 fakeid） -->
      <div v-else-if="state === 'empty'" class="flex items-center gap-2 text-sm text-rose-500">
        <UIcon name="i-lucide:circle-slash" class="size-5" />
        <span>没有可导入的有效账号（缺少 fakeid），未向服务端发起请求。</span>
      </div>

      <!-- 预检结果（通过 / 存在冲突） -->
      <div v-else-if="state === 'preview' && summary" class="space-y-3">
        <div
          class="flex items-center gap-2 text-sm font-medium"
          :class="summary.hasConflicts ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'"
        >
          <UIcon
            :name="summary.hasConflicts ? 'i-lucide:alert-triangle' : 'i-lucide:check-circle-2'"
            class="size-5"
          />
          <span>{{ summary.hasConflicts ? '预检完成：存在需关注项' : '预检通过：无冲突' }}</span>
        </div>

        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="rounded bg-gray-50 dark:bg-gray-800 px-3 py-2">共发送 <strong>{{ summary.total }}</strong></div>
          <div class="rounded bg-blue-50 dark:bg-blue-950/40 px-3 py-2">可导入 <strong>{{ summary.importable }}</strong></div>
          <div class="rounded bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2">新增 <strong>{{ summary.inserted }}</strong></div>
          <div class="rounded bg-amber-50 dark:bg-amber-950/40 px-3 py-2">更新既有 <strong>{{ summary.updated }}</strong></div>
          <div class="rounded bg-gray-50 dark:bg-gray-800 px-3 py-2">跳过（无变化） <strong>{{ summary.unchanged }}</strong></div>
          <div class="rounded bg-rose-50 dark:bg-rose-950/40 px-3 py-2">非法 <strong>{{ summary.invalid }}</strong></div>
        </div>

        <div v-if="summary.invalidItems.length > 0" class="text-xs text-rose-500 space-y-1">
          <p class="font-medium">非法项（最多显示前 5 条）：</p>
          <ul class="list-disc pl-5">
            <li v-for="item in summary.invalidItems.slice(0, 5)" :key="item.index">
              #{{ item.index }}：{{ item.reason }}
            </li>
          </ul>
        </div>

        <p class="text-xs text-gray-500">
          <UIcon name="i-lucide:info" class="size-3 inline-block" />
          尚未正式提交：以上仅为预检结果，服务端未发生任何写入。
        </p>
      </div>

      <!-- 失败 -->
      <div v-else-if="state === 'error' && errorInfo" class="space-y-2">
        <div class="flex items-center gap-2 text-sm font-medium text-rose-600 dark:text-rose-400">
          <UIcon name="i-lucide:x-circle" class="size-5" />
          <span>预检失败</span>
        </div>
        <p class="text-sm">{{ errorInfo.message }}</p>
      </div>

      <template #footer>
        <div class="flex justify-end gap-3">
          <UButton color="white" class="px-3" @click="close">关闭</UButton>
          <UButton
            v-if="state === 'idle' || state === 'empty'"
            color="blue"
            class="px-3"
            :disabled="pendingCount === 0"
            @click="start"
          >
            开始预检
          </UButton>
          <UButton v-else-if="state === 'loading'" color="blue" class="px-3" loading disabled>预检中…</UButton>
          <UButton
            v-else-if="state === 'error' && errorInfo?.recoverable"
            color="blue"
            class="px-3"
            @click="start"
          >
            重试
          </UButton>
          <UButton v-else-if="state === 'preview'" color="blue" class="px-3" @click="start">重新预检</UButton>
        </div>
      </template>
    </UCard>
  </UModal>
</template>
