import { request } from '#shared/utils/request';
import {
  type DryRunSummary,
  type ImportErrorInfo,
  type ImportSourceAccount,
  mapToImportInputs,
  runDryRunCore,
} from '#shared/utils/mp-account-import';

/**
 * C2-A 服务端账号 dry-run 导入的响应式包装。
 * 纯编排/映射/汇总/分类逻辑在 #shared/utils/mp-account-import（离线可测）；本 composable 只负责：
 *  - 反应式 UI 状态机：idle → loading → (preview | error | empty)
 *  - 同步双击守卫（loading 时忽略再次触发，不并发第二次提交）
 *  - 始终走 dryRun:true（本轮不做正式写入）
 */
export type ImportUiState = 'idle' | 'loading' | 'preview' | 'error' | 'empty';

const IMPORT_BROWSER_ENDPOINT = '/api/tools/mp-accounts/import-browser';

export function useServerAccountImport() {
  const state = ref<ImportUiState>('idle');
  const summary = ref<DryRunSummary | null>(null);
  const errorInfo = ref<ImportErrorInfo | null>(null);
  const sourceCount = ref(0);
  const mappedCount = ref(0);

  const isBusy = computed(() => state.value === 'loading');
  const canRun = computed(() => state.value !== 'loading');

  async function runDryRun(accounts: ImportSourceAccount[]) {
    // 同步双击守卫：loading 中直接忽略，避免并发重复提交。
    if (state.value === 'loading') return;

    sourceCount.value = accounts?.length ?? 0;
    // 空数据（无有效 fakeid）预判：不置 loading、不发请求。
    const mapped = mapToImportInputs(accounts);
    mappedCount.value = mapped.length;
    if (mapped.length === 0) {
      state.value = 'empty';
      summary.value = null;
      errorInfo.value = null;
      return;
    }

    state.value = 'loading';
    summary.value = null;
    errorInfo.value = null;

    const outcome = await runDryRunCore(accounts, {
      // dryRun:true 由 runDryRunCore 注入，这里只负责把 payload 发到端点。
      request: payload =>
        request<import('#shared/utils/mp-account-import').DryRunResponse>(IMPORT_BROWSER_ENDPOINT, {
          method: 'POST',
          body: payload,
        }),
    });

    if (outcome.kind === 'success') {
      summary.value = outcome.summary;
      state.value = 'preview';
    } else if (outcome.kind === 'error') {
      errorInfo.value = outcome.error;
      state.value = 'error';
    } else {
      // 'empty'/'busy' 已由上面同步分支拦截，这里兜底。
      state.value = 'empty';
    }
  }

  function reset() {
    state.value = 'idle';
    summary.value = null;
    errorInfo.value = null;
    sourceCount.value = 0;
    mappedCount.value = 0;
  }

  return { state, summary, errorInfo, sourceCount, mappedCount, isBusy, canRun, runDryRun, reset };
}
