/**
 * C2-A 纯逻辑：把浏览器 IndexedDB 账号映射为服务端 import-browser 入参，并对 dry-run 结果做纯函数汇总/分类。
 *
 * 无 Vue / Nuxt / IndexedDB(dexie) 依赖，可离线 smoke（tools/smoke_mp_account_import.mjs）。
 * 与之配套的响应式包装见 composables/useServerAccountImport.ts；UI 见 components/dashboard/ServerImportDialog.vue。
 *
 * 契约来源（禁止凭空发明字段）：
 *  - 源：store/v2/info.ts 的 MpAccount（这里只取用服务端认可的子集，避免引入 dexie）。
 *  - 目标：server/utils/mp-account-api.ts 的 mpAccountInputSchema（fakeid/nickname/round_head_img/
 *    total_count/last_update_time 等），未知字段由服务端 zod 剥离。
 *  - 端点：POST /api/tools/mp-accounts/import-browser，body { accounts, dryRun }；
 *    返回 { inserted, updated, unchanged, changes, dryRun, invalid, invalidItems }。
 *  - 主键：fakeid（服务端 mp_accounts PRIMARY KEY）。
 */

/** 源账号（IndexedDB MpAccount 的结构化子集）。 */
export interface ImportSourceAccount {
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
  total_count?: number;
  last_update_time?: number;
}

/** 发往 import-browser 的单账号入参（仅服务端认可字段）。 */
export interface MpAccountImportInput {
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
  total_count?: number;
  last_update_time?: number;
}

/**
 * 字段映射 + 客户端预过滤：丢弃空白 fakeid；只带服务端认可字段，其余（completed/count/articles/
 * create_time/update_time）不发送（服务端 zod 也会剥离，这里显式收窄以减少噪声）。
 */
export function mapToImportInputs(accounts: ImportSourceAccount[] | null | undefined): MpAccountImportInput[] {
  const out: MpAccountImportInput[] = [];
  for (const account of accounts ?? []) {
    const fakeid = String(account?.fakeid ?? '').trim();
    if (!fakeid) continue;
    const input: MpAccountImportInput = { fakeid };
    if (account.nickname != null) input.nickname = account.nickname;
    if (account.round_head_img != null) input.round_head_img = account.round_head_img;
    if (typeof account.total_count === 'number') input.total_count = account.total_count;
    if (typeof account.last_update_time === 'number') input.last_update_time = account.last_update_time;
    out.push(input);
  }
  return out;
}

/** 服务端 dry-run 响应形状。 */
export interface DryRunResponse {
  inserted: number;
  updated: number;
  unchanged: number;
  invalid: number;
  invalidItems?: Array<{ index: number; reason: string }>;
  changes?: Array<{ fakeid: string; action: 'inserted' | 'updated' | 'unchanged' }>;
  dryRun?: boolean;
}

export interface DryRunSummary {
  /** 发送的有效账号数。 */
  total: number;
  /** 可导入 = 新增 + 更新既有。 */
  importable: number;
  /** 新增（服务端不存在）。 */
  inserted: number;
  /** 更新既有（会覆盖服务端记录，视为变更/冲突）。 */
  updated: number;
  /** 跳过（与服务端一致，无变化）。 */
  unchanged: number;
  /** 非法（服务端 schema 拒绝）。 */
  invalid: number;
  invalidItems: Array<{ index: number; reason: string }>;
  /** 是否存在冲突/需关注项（更新既有 或 非法）。 */
  hasConflicts: boolean;
}

export function summarizeDryRun(resp: DryRunResponse, sentCount: number): DryRunSummary {
  const inserted = Number(resp?.inserted ?? 0);
  const updated = Number(resp?.updated ?? 0);
  const unchanged = Number(resp?.unchanged ?? 0);
  const invalid = Number(resp?.invalid ?? 0);
  return {
    total: sentCount,
    importable: inserted + updated,
    inserted,
    updated,
    unchanged,
    invalid,
    invalidItems: Array.isArray(resp?.invalidItems) ? resp.invalidItems : [],
    hasConflicts: updated > 0 || invalid > 0,
  };
}

export interface ImportErrorInfo {
  kind: string;
  message: string;
  /** 是否可通过重试恢复（网络/超时/限流/服务端 5xx/鉴权可恢复；400 数据非法不可靠重试）。 */
  recoverable: boolean;
}

/** 把请求错误分类为用户可见信息 + 是否可重试恢复。 */
export function classifyImportError(err: unknown): ImportErrorInfo {
  const e = (err ?? {}) as Record<string, unknown>;
  const response = (e.response ?? {}) as Record<string, unknown>;
  const status = Number(e.statusCode ?? e.status ?? response.status ?? 0);
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (status === 400) {
    return {
      kind: 'bad_request',
      message: String(data.message || e.statusMessage || '请求被服务端拒绝（400）：数据格式不合法。'),
      recoverable: false,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth_required', message: '未授权（401/403），请重新登录后重试。', recoverable: true };
  }
  if (status === 429) {
    return { kind: 'rate_limited', message: '请求过于频繁（429），请稍后重试。', recoverable: true };
  }
  if (status >= 500) {
    return { kind: 'server_error', message: `服务端错误（${status}），请稍后重试。`, recoverable: true };
  }
  const name = String(e.name ?? '');
  const message = String(e.message ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || /time(?:d)?\s?out|timeout/i.test(message)) {
    return { kind: 'timeout', message: '请求超时，请重试。', recoverable: true };
  }
  if (/fetch failed|failed to fetch|network|socket/i.test(message)) {
    return { kind: 'network', message: '网络异常，请检查连接后重试。', recoverable: true };
  }
  return { kind: 'unknown', message: message || '未知错误，请重试。', recoverable: true };
}

/** dry-run 决策：空数据 / 正忙 → 不发请求。 */
export type DryRunDecision = 'send' | 'empty' | 'busy';
export function decideDryRun(mappedCount: number, isBusy: boolean): DryRunDecision {
  if (isBusy) return 'busy';
  if (mappedCount <= 0) return 'empty';
  return 'send';
}

export type DryRunOutcome =
  | { kind: 'empty' }
  | { kind: 'busy' }
  | { kind: 'success'; summary: DryRunSummary; sent: MpAccountImportInput[] }
  | { kind: 'error'; error: ImportErrorInfo };

export interface DryRunDeps {
  /** 注入的请求函数（生产为 $fetch 包装，smoke 为 fake）。始终收到 dryRun:true 的 payload。 */
  request: (payload: { accounts: MpAccountImportInput[]; dryRun: true }) => Promise<DryRunResponse>;
  /** 是否正忙（防并发重复提交）。 */
  isBusy?: boolean;
}

/**
 * dry-run 核心编排（可注入、离线可测）：映射 → 决策（空/忙不发）→ 以 **dryRun:true** 发请求 → 汇总/分类。
 * **永不发送 dryRun:false**，因此客户端侧绝不触发正式写入（服务端对 dryRun:true 亦只算不写）。
 */
export async function runDryRunCore(
  accounts: ImportSourceAccount[] | null | undefined,
  deps: DryRunDeps
): Promise<DryRunOutcome> {
  const mapped = mapToImportInputs(accounts);
  const decision = decideDryRun(mapped.length, deps.isBusy ?? false);
  if (decision === 'busy') return { kind: 'busy' };
  if (decision === 'empty') return { kind: 'empty' };
  try {
    const resp = await deps.request({ accounts: mapped, dryRun: true });
    return { kind: 'success', summary: summarizeDryRun(resp, mapped.length), sent: mapped };
  } catch (err) {
    return { kind: 'error', error: classifyImportError(err) };
  }
}

/**
 * 根因修复：清理 URL 中的 imported 参数时**只移除 imported、保留其它 query 参数**，
 * 避免用裸路径导航把尚未确认的其它状态一并清掉。
 */
export function stripImportedFromQuery<T extends Record<string, unknown>>(query: T | null | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === 'imported') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
