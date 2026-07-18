// 相对 import 带 .ts 扩展：既让离线 smoke 在裸 Node ESM 下能直接 import（Node 类型剥离要求显式扩展），
// 也被 Nitro 打包（rollup/esbuild，不做 tsc 类型检查）正常解析。避免 ~ 别名导致 smoke 无法解析。
import {
  syncSingleAccount,
  SyncConfigError,
  SyncFetchError,
  isRetryableErrorKind,
  type PageFetcher,
  type SyncAccountOptions,
  type AccountSyncOutcome,
  type SyncErrorKind,
} from './mp-sync-service.ts';
import {
  startJob,
  listJobAccounts,
  markAccountRunning,
  applyAccountOutcome,
  finalizeJob,
  cancelPendingAccounts,
  isCancelRequested,
  reconcileOrphanedJobs,
  resetInterruptedAccounts,
  listRunningJobIdsForRecovery,
  type MpSyncJob,
  type MpSyncJobAccount,
  type AccountOutcomeInput,
} from './mp-sync-job-registry.ts';

/**
 * C3-1 后台同步 runner **核心循环**（A 类·纯离线：注入 PageFetcher + 临时 SQLite，可离线全验）。
 *
 * 职责：把 C2 持久层原语（mp-sync-job-registry.ts）与 C3-0 抓取算法/错误契约（mp-sync-service.ts）
 * 串成单次、顺序的编排循环，并**首次消费 C3-0 的两条 `config_error` 通道**，收敛到明确失败终态：
 *   - 通道 A：`syncSingleAccount` 在任何 fetchPage 之前抛 `SyncConfigError`（前置参数违规，零网络）——
 *     本 runner catch 后落该账号失败终态、不中断整 job（失败隔离）。
 *   - 通道 B：`syncSingleAccount` 运行中游标累加溢出，返回 `failed` + `errorKind='config_error'`——
 *     本 runner 落失败终态，保留已收文章与安全游标。
 *   - 未知 / 未登记 errorKind：经 `isRetryableErrorKind` fail-closed 判为不可重试。
 *
 * 明确不做（后续切片）：并发池（C3-2）、退避 / 重试 / 时钟注入（C3-3）、协作取消（C3-4）、
 * 重启恢复与断点续跑（C3-5，故 startBegin 固定 0）、failed_only 重试编排（C3-6）、真实网络
 * PageFetcher（C3-7）、snapshot·export 串行提交与 HTTP API（C 类）。
 *
 * 单次尝试语义：每个账号只抓一次；失败（含可重试类）一律落终态、**本切片不重试**。runner 会计算并
 * 返回 `retryable` 分类（isRetryableErrorKind 的结果），作为 C3-3 退避 / C3-6 重试的接线缝，但 C3-1
 * 不据此重试。retryable 只在返回摘要里体现，**不写入持久层**（契约：不给 AccountSyncOutcome / job 账号
 * 行新增 retryable 字段）。
 */

/** 单账号一次同步的最终态（与 mp-sync-service 的 outcome.status 同集）。 */
export type AccountFinalStatus = 'succeeded' | 'failed' | 'auth_required';

/** runner 返回的逐账号摘要（非持久：errorKind / retryable 只用于观测与 C3-3/C3-6 决策，不落库）。 */
export interface AccountRunResult {
  fakeid: string;
  status: AccountFinalStatus;
  newArticles: number;
  /** 失败分类；succeeded 或未知来源为 null。 */
  errorKind: SyncErrorKind | null;
  /** isRetryableErrorKind(errorKind) 的结果；succeeded / 未知 / config_error 均为 false（fail-closed）。 */
  retryable: boolean;
  errorMessage: string | null;
  /** C3-3 观测：本账号实际尝试次数（含首次）；由 runWithRetry 填充，**非持久**、仅观测。 */
  attempts?: number;
}

/** classifyAccountResult 的输入：要么是 service 返回的 outcome，要么是 service 抛出的错误。 */
export type RawAccountResult =
  | { ok: true; outcome: AccountSyncOutcome }
  | { ok: false; error: unknown };

/**
 * 纯函数：把「一次账号尝试的原始结果」翻译成 (a) 落库入参 AccountOutcomeInput 与 (b) 观测摘要 AccountRunResult。
 * 独立导出便于离线单测直灌合成输入（含未知 errorKind、未预期抛错等真实 service 不会产出的边界）。
 *
 * service 契约事实（决定分支）：
 *   - service **只有** 前置校验会抛 `SyncConfigError`（通道 A，在 try 之前）；fetcher 抛错与通道 B
 *     游标溢出都被 service catch/return 成 outcome，故 ok:false 分支主要处理 SyncConfigError + 防御性未预期错误。
 *   - service 的 `newArticles` 是数组；job 账号行的 newArticles 是计数——此处取 `.length`。
 *   - job 账号行无 errorKind 字段（只有 errorCode/errorMessage）；把 errorKind 作为稳定分类落到持久 errorCode。
 */
export function classifyAccountResult(
  fakeid: string,
  raw: RawAccountResult
): { outcomeInput: AccountOutcomeInput; run: AccountRunResult } {
  if (raw.ok) {
    const outcome = raw.outcome;
    const newArticles = outcome.newArticles.length;

    if (outcome.status === 'succeeded') {
      return {
        outcomeInput: {
          status: 'succeeded',
          newArticles,
          pageCursor: outcome.pageCursor,
          lastArticleTime: outcome.lastArticleTime,
          errorCode: null,
          errorMessage: null,
        },
        run: { fakeid, status: 'succeeded', newArticles, errorKind: null, retryable: false, errorMessage: null },
      };
    }

    // failed | auth_required：分类经 isRetryableErrorKind 判定可重试性（未知 / 缺失 → false，fail-closed）。
    const errorKind = outcome.errorKind ?? null;
    const retryable = errorKind ? isRetryableErrorKind(errorKind) : false;
    const errorMessage = outcome.errorMessage ?? null;
    return {
      outcomeInput: {
        status: outcome.status,
        newArticles,
        pageCursor: outcome.pageCursor,
        lastArticleTime: outcome.lastArticleTime,
        // 稳定分类优先落 errorCode；无 errorKind 时退回 service 自带 errorCode。
        errorCode: errorKind ?? outcome.errorCode ?? null,
        errorMessage,
      },
      run: { fakeid, status: outcome.status, newArticles, errorKind, retryable, errorMessage },
    };
  }

  // ok:false —— service 抛出。
  const error = raw.error;
  if (error instanceof SyncConfigError) {
    // 通道 A：前置参数违规，零网络。error.kind === 'config_error'、retryable=false。
    // 不写 pageCursor / lastArticleTime → applyAccountOutcome 以 ?? 保留账号原值（零网络未推进游标）。
    const errorMessage = error.message;
    return {
      outcomeInput: { status: 'failed', newArticles: 0, errorCode: error.kind, errorMessage },
      run: {
        fakeid,
        status: 'failed',
        newArticles: 0,
        errorKind: error.kind,
        retryable: isRetryableErrorKind(error.kind),
        errorMessage,
      },
    };
  }

  // 未预期错误（非 SyncConfigError）：fail-closed 落失败终态、不可重试，不臆造 SyncErrorKind。
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    outcomeInput: { status: 'failed', newArticles: 0, errorCode: 'unexpected_error', errorMessage },
    run: { fakeid, status: 'failed', newArticles: 0, errorKind: null, retryable: false, errorMessage },
  };
}

export interface RunSyncJobDeps {
  /** 注入的分页抓取器；按 fakeid 路由（真实实现由 C3-7 注入微信 /credential 通道）。 */
  fetchPage: PageFetcher;
  /**
   * 可选：按账号解析 syncSingleAccount 选项覆盖（pageSize / maxPages / sinceTime / knownAids…）。
   * **不含 startBegin**（F2/C3-1-F2）：断点续跑是 C3-5 语义，C3-1 切片内 startBegin 恒 0，故从可覆盖类型
   * 中 Omit 掉；即便调用方经非类型安全输入塞入 startBegin，runner 也在展开后固定 0 覆盖（运行时第二层防御）。
   * 生产默认不传，走 service 默认（pageSize=20 / maxPages=500）。离线测试用它触发真实通道 A/B，不桩掉 service。
   */
  resolveOptions?: (account: MpSyncJobAccount, job: MpSyncJob) => Partial<Omit<SyncAccountOptions, 'fakeid' | 'startBegin'>>;
  /**
   * C3-3：注入时钟，退避 sleep 与 per-page timeout 均经此。默认 `createRealClock()`（Date.now + setTimeout）。
   * 离线测试注入逻辑时钟（smoke `createManualClock`）以零真实等待、确定性推进退避/超时时序。
   */
  clock?: RunnerClock;
  /**
   * C3-3：账号级退避重试策略。默认 `{ maxAttempts: 1 }`（**不重试**，与 C3-1/C3-2 完全等价、锁 145 既有回归）。
   * `baseDelayMs`/`maxDelayMs` 缺省 1000/30000；`jitter` 缺省 full jitter。入口 `normalizeRetryOptions` 校验。
   */
  retry?: RetryPolicyOptions;
  /**
   * C3-3：per-page **软** timeout（ms）。默认 `undefined`（不启用，`fetchPage` 原样传入）。启用时用同签名
   * `withTimeout` 装饰器包裹，判定超时后归类为可重试 `timeout`，但**不主动中止在飞网络**（PageFetcher 无
   * AbortSignal；真实中止 = 改生产契约 = 重新授权门 / C3-7）。入口 `assertTimeoutMs` 校验。
   */
  timeoutMs?: number;
  /**
   * C3-4：协作式 cancel probe。默认 registry 的 `isCancelRequested`（读 `cancel_requested_at`）。仅测试注入
   * 替身以确定性构造 cancel 时序；生产不传、恒用默认实现。DI 风格对齐既有 `clock`。
   * **不变量注意**：`cancelRequested=true ⟹ cancel_requested_at 非空` 仅对生产默认 probe 成立；测试注入替身
   * 若走 cancel-resolve 路径（触达 `cancelPendingAccounts`），**必须先真实 `requestCancel`** 建同一真库标记，
   * 否则被 `cancelPendingAccounts` 的 P3 前置拦截（见 runSyncJobPool §④ 收口 + smoke G9a fixture 不变量）。
   */
  isCancelRequested?: (jobId: string) => boolean;
}

export interface RunSyncJobResult {
  job: MpSyncJob;
  accounts: AccountRunResult[];
}

/**
 * 单账号一次同步的完整处理单元：供顺序 runSyncJob 与并发 runSyncJobPool **共用同一语义源**
 * （失败隔离 / 系统故障传播 / startBegin 固定，两条编排路径逐字一致，差异只在“同时跑几个账号”）。
 *
 * 边界（F1/C3-1-F1，C3-3 保持）：每次 attempt 的窄 try/catch **只**包住 syncSingleAccount（见 runWithRetry），
 * 把它的抛错（通道 A 的 SyncConfigError / 防御性未预期错误）翻译成该账号失败终态。**resolveOptions 求值 +
 * options 组装在重试循环之外、且在 markAccountRunning 之前**——resolver / 依赖配置器抛错属系统故障，原样
 * 向上抛（顺序版使 runSyncJob reject；并发版由 runSyncJobPool 调度器捕获后停止调度、排空在飞再 reject），
 * 绝不伪装成账号业务失败、不迁移状态、不续跑；置于 markAccountRunning 之前 → resolver 抛错时账号连状态迁移
 * 都不发生、保持 pending。applyAccountOutcome / 状态机原语的抛错同属真实不变量违规，也在窄 catch 之外、故意
 * 不吞（向上抛）。startBegin 固定 0（F2/C3-1-F2）置于展开 overrides 之后作运行时第二层防御。
 *
 * C3-3 增量：① B4·可重放快照——knownAids/knownLinks 若为一次性 generator，重试前快照成数组，保证每 attempt
 * 去重集可重放；② 若 ctx.timeoutMs 提供，用同签名 withTimeout 装饰 fetchPage（per-page 软 timeout，§2.7）；
 * ③ 退避重试收进 runWithRetry（每 attempt 恰 emit 一次升降档信号 §2.5；退避 sleep 故障在窄 catch 外原样
 * 上抛 §2.4/§2.8）；④ applyAccountOutcome 仍**只在循环后调一次**（最终 outcome）→ retry_count 每次
 * processAccount 至多 +1（重试成功精确 0、耗尽精确 1）。
 */
async function processAccount(
  jobId: string,
  account: MpSyncJobAccount,
  job: MpSyncJob,
  deps: RunSyncJobDeps,
  ctx: ResolvedRetryContext,
  emitSignal: (signal: ConcurrencySignal) => void
): Promise<AccountRunResult> {
  const overrides = deps.resolveOptions?.(account, job);
  const options: SyncAccountOptions = {
    fakeid: account.fakeid,
    sinceTime: account.sinceTime ?? job.requestedSince ?? 0,
    ...overrides,
    startBegin: 0,
  };
  // B4/§2.4·可重放快照：一次性 generator 快照成数组，保证每 attempt 复用同一去重集（否则第二 attempt 去重失效）。
  if (options.knownAids !== undefined) options.knownAids = [...options.knownAids];
  if (options.knownLinks !== undefined) options.knownLinks = [...options.knownLinks];

  markAccountRunning(jobId, account.fakeid); // pending -> running

  // per-page 软 timeout（§2.7）：未设 timeoutMs 则原样传入 fetchPage（默认 OFF、零 withTimeout 包裹）。
  const timeoutFetchPage =
    ctx.timeoutMs === undefined ? deps.fetchPage : withTimeout(deps.fetchPage, ctx.clock, ctx.timeoutMs);

  const { outcomeInput, run } = await runWithRetry(
    account.fakeid,
    options,
    timeoutFetchPage,
    ctx.clock,
    ctx.retry,
    emitSignal
  );

  applyAccountOutcome(jobId, account.fakeid, outcomeInput); // 循环后只调一次（最终 outcome）
  return run;
}

/**
 * C3-1 核心循环（顺序 async、无并发、无 cancel 检查）：startJob → 逐个 pending 账号（priority DESC）
 * processAccount → finalizeJob。等价于 runSyncJobPool 并发上限恒为 1 的特例，但保留独立实现以零改动锁定
 * C3-1 既有回归。失败隔离 / 系统故障传播语义见 processAccount。
 *
 * C3-3：入口先 `resolveRetryContext(deps)` 校验/规范化 retry+timeout 配置——**严格前置于 startJob（首次
 * DB 写 queued→running）**，非法即 fail-fast 抛 RangeError（零持久副作用，R1-B2·B4 验收）。顺序版无并发
 * 控制器，emitSignal 为 no-op（默认 OFF 时行为与 C3-1 逐字等价）。
 */
export async function runSyncJob(jobId: string, deps: RunSyncJobDeps): Promise<RunSyncJobResult> {
  const ctx = resolveRetryContext(deps); // 校验/规范化前置于 startJob（零持久副作用）
  const job = startJob(jobId); // queued -> running（幂等）
  const pending = listJobAccounts(jobId, 'pending'); // 已按 priority DESC, fakeid 排序
  const accounts: AccountRunResult[] = [];
  const emitSignal: (signal: ConcurrencySignal) => void = () => {}; // 顺序版无控制器 → no-op
  // C3-4：协作 cancel probe。默认 registry isCancelRequested（生产恒用）；测试可注入替身。
  const probe = deps.isCancelRequested ?? isCancelRequested;

  for (const account of pending) {
    // 账号间隙检查（当前账号已自然跑完）：cancel 到达 → 停止处理后续账号。检查置于每账号处理**之前**：
    // cancel 在 account[k] 处理期间到达 → account[k] 自然落终态 → 下一轮 break → account[k+1..] 仍 pending。
    // probe 抛错 = 系统故障：在 async 函数体内同步调用、自然沿 runSyncJob 向上传出 → 返回 Promise reject
    // → 不执行后续 cancelPendingAccounts/finalize、job 保持 running 交 C3-5（与并发版 fatal 语义一致，无需 try/catch）。
    if (probe(jobId)) break;
    accounts.push(await processAccount(jobId, account, job, deps, ctx, emitSignal));
  }

  // cancel 已到达（含循环 break 提前退出、或最后一个账号完成后 cancel 到达）→ 剩余 pending 落 cancelled。
  // P3 门：probe 为默认实现时 cancel_requested_at 已非空；无剩余 pending 时 cancelPendingAccounts 返回 0（F-C2-2）。
  if (probe(jobId)) cancelPendingAccounts(jobId);
  const finalJob = finalizeJob(jobId); // cancelRequestedAt 非空 → cancelled
  return { job: finalJob, accounts }; // push 累积，天然无空洞（P1 不涉及顺序版）
}

// ══════════════════════════════════════════════════════════════════════════════
// C3-2 并发池 + 自适应档位（A 类·纯离线：注入 PageFetcher + 临时 SQLite，可离线全验）
//
// **切片边界（PLAN §一/§二 C3-2，2026-07-15 用户拍板选项 1）**：本切片只做“账号级并发调度 +
// 自适应并发档位”。**不实现主动超时中断 / AbortSignal / 退避 sleep（C3-3）、协作式 cancel（C3-4）**。
// timeout 仅作为**已完成账号 outcome 的降档信号**，不在此主动中断慢请求；协作式 cancel 及账号
// cancelled 落定（需持久层新增 mutator）归 C3-4。避免把“未实现”误判为漏测。
// ══════════════════════════════════════════════════════════════════════════════

/** C3-2 并发档位表（PLAN §三决策 1：固定档位表，简单 / 可测 / 可解释；非连续 AIMD）。 */
export const DEFAULT_CONCURRENCY_LEVELS = [1, 2, 4, 6, 8] as const;
/** 起始档位下标（值 4）。 */
export const DEFAULT_START_LEVEL_INDEX = 2;
/** 连续成功多少次升一档。 */
export const DEFAULT_HEALTHY_STREAK_TO_RAISE = 4;

export interface ConcurrencyControllerOptions {
  /** 并发档位表，必须为严格递增的安全正整数序列。默认 [1,2,4,6,8]。 */
  levels?: readonly number[];
  /** 起始档位下标（clamp 到合法范围）。默认 2（值 4）。 */
  startIndex?: number;
  /** 连续成功多少次升一档。默认 4。 */
  healthyStreakToRaise?: number;
}

/** onResult 的输入信号：'succeeded' 或失败账号的 errorKind（null = 未知来源失败）。 */
export type ConcurrencySignal = 'succeeded' | SyncErrorKind | null;

/**
 * C3-2 自适应并发档位控制器（纯逻辑，离线可单测）。**只决定“允许多少账号并发”，不做任何 sleep /
 * 退避时序**（退避是 C3-3）。升降规则消费已完成账号 outcome 的信号（PLAN §一 C3-2）：
 *   - succeeded：连续成功计数 +1；达 healthyStreakToRaise 且未到顶档 → 升一档、计数清零（健康升档）。
 *   - rate_limited / timeout / auth_required：**立即降到最低档**（levels[0]），连续成功计数清零
 *     （保守：遇限流 / 超时 / 需重登，最小化在飞压力）。
 *   - 其它失败（config_error / api_error / network / 未知）：中断连续成功（计数清零），但**不升不降**
 *     （确定性 / 账号级问题不代表服务端限流，不应据此收缩全局并发）。
 *
 * JS 单线程 event loop 内 onResult 只在各 worker 完成回调中串行调用、currentLimit 只在调度器同步 pump
 * 时读取，无并发竞态。
 */
export class ConcurrencyController {
  private readonly levels: readonly number[];
  private readonly healthyStreakToRaise: number;
  private index: number;
  private healthyStreak = 0;

  constructor(options: ConcurrencyControllerOptions = {}) {
    const levels = options.levels ?? DEFAULT_CONCURRENCY_LEVELS;
    if (levels.length === 0) throw new RangeError('ConcurrencyController: levels 不能为空');
    if (!levels.every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new RangeError('ConcurrencyController: levels 必须均为安全正整数');
    }
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] <= levels[i - 1]) throw new RangeError('ConcurrencyController: levels 必须严格递增');
    }
    const raise = options.healthyStreakToRaise ?? DEFAULT_HEALTHY_STREAK_TO_RAISE;
    if (!Number.isSafeInteger(raise) || raise <= 0) {
      throw new RangeError('ConcurrencyController: healthyStreakToRaise 必须为安全正整数');
    }
    const startIndex = options.startIndex ?? DEFAULT_START_LEVEL_INDEX;
    this.levels = levels;
    this.healthyStreakToRaise = raise;
    this.index = Math.min(Math.max(0, Number.isSafeInteger(startIndex) ? startIndex : 0), levels.length - 1);
  }

  /** 当前并发上限。 */
  currentLimit(): number {
    return this.levels[this.index];
  }

  /** 当前档位下标（观测 / 测试用）。 */
  currentIndex(): number {
    return this.index;
  }

  /** 消费一个账号的完成信号，按规则升 / 降 / 保持档位。 */
  onResult(signal: ConcurrencySignal): void {
    if (signal === 'succeeded') {
      this.healthyStreak += 1;
      if (this.healthyStreak >= this.healthyStreakToRaise && this.index < this.levels.length - 1) {
        this.index += 1;
        this.healthyStreak = 0;
      }
      return;
    }
    // 失败信号一律中断健康连续。
    this.healthyStreak = 0;
    if (signal === 'rate_limited' || signal === 'timeout' || signal === 'auth_required') {
      this.index = 0; // 降到最低档
    }
    // 其它失败（config_error / api_error / network / 未知）：不改档位。
  }
}

/** runSyncJobPool 的并发观测（供测试断言 + C3-3 退避接线的观测缝）。 */
export interface RunSyncJobPoolObservation {
  /**
   * 调度期间**逻辑账号 worker/admission** 并发峰值（= 同一时刻 processAccount 未 resolve 的账号数峰值）。
   * **不等于真实在飞 fetchPage 峰值**（R1-B3/§2.6）：C3-3 软 timeout 下被放弃的底层 fetch 仍在后台跑，
   * 若该账号退避后起下一 attempt，则同账号可能旧 fetch + 新 fetch 重叠，真实底层 fetch 峰值可高于本值。
   */
  maxInFlight: number;
  /**
   * 每次启动一个 worker 时（admission 时刻）采样的 (limit, inFlight) 快照；每条满足 inFlight <= limit
   * （admission 门 inFlight < currentLimit 保证）。注意这是 **admission 时刻**采样、非任意时刻：429 降档后
   * 旧 worker 排空期间可能短暂 inFlight > currentLimit()，期间不再新增 admission，故不会写入违反项。
   */
  schedule: Array<{ limit: number; inFlight: number }>;
  /** 结束时的并发档位。 */
  finalLimit: number;
}

export interface RunSyncJobPoolResult extends RunSyncJobResult {
  concurrency: RunSyncJobPoolObservation;
}

/**
 * C3-2 并发池 runner：在 C3-1 顺序编排之上做**账号级并发调度 + 自适应档位**，与 runSyncJob 共用
 * processAccount（同一失败隔离 / 系统故障 / startBegin 语义），差异只在“同时处理多少账号”。
 *
 * 不变量：
 *   - 并发上限约束作用于 admission：仅当 inFlight < currentLimit() 时调度新账号（while 条件保证；此处
 *     inFlight 为**逻辑账号 worker/admission** 计数——每账号同一时刻最多一个逻辑 worker 在处理）。429 降档
 *     不会中断已在飞 worker，因此短期内 inFlight 可高于新档位；期间停止新增 admission，待既有 worker 排空后
 *     自然收敛至新档位。**注意（C3-3/§2.6）**：软 timeout 下被放弃的底层 fetch 仍在后台跑、可与该账号下一
 *     attempt 的新 fetch 重叠，故真实在飞 fetchPage 峰值可高于逻辑 worker 峰值；若需硬约束真实网络并发须给
 *     PageFetcher 加 AbortSignal（重新授权门 / C3-7），本切片不伪装完成。
 *   - 结果 accounts 严格按输入 pending 顺序（priority DESC, fakeid）按 index 落位，**与完成顺序无关**。
 *   - 账号业务失败被 processAccount 隔离为该账号失败终态，不影响其它并发账号。
 *   - 系统故障（processAccount 向上抛）：停止调度新账号 → 排空所有在飞 worker（不再新增 running）→ reject；
 *     已在飞账号各自落终态（不悬挂），未调度账号保持 pending，job 不 finalize（保持 running，交 C3-5 恢复）。
 *   - 全部账号处理完 → finalizeJob（与 runSyncJob 同）。
 *
 * 并发安全：node:sqlite 为同步 API，markAccountRunning / applyAccountOutcome 全同步执行、无 await 切换点，
 * 单线程 event loop 下多 worker 的 DB 写天然串行、事务不交错；唯一异步切换在 await fetchPage（不碰 DB）。
 */
export async function runSyncJobPool(
  jobId: string,
  deps: RunSyncJobDeps,
  options: ConcurrencyControllerOptions = {}
): Promise<RunSyncJobPoolResult> {
  const ctx = resolveRetryContext(deps); // C3-3：校验/规范化前置于 startJob（首次 DB 写），零持久副作用
  const job = startJob(jobId); // queued -> running（幂等）
  const pending = listJobAccounts(jobId, 'pending'); // 已按 priority DESC, fakeid 排序
  // C3-4/§①：缓冲改稀疏可空类型——cancel 路径未 admit 的槽位保持 undefined，resolve 后 filter 压实（§④/P1）。
  const accounts: (AccountRunResult | undefined)[] = new Array<AccountRunResult | undefined>(pending.length);
  const controller = new ConcurrencyController(options);
  // C3-3/§2.5：升降档信号下沉为 per-attempt——runWithRetry 每 attempt 恰调一次 emitSignal；据此移除下方
  // 完成回调里原“每账号一次 onResult”（原 :392），改由此闭包在每次 attempt 把信号转发给控制器。
  const emitSignal: (signal: ConcurrencySignal) => void = (signal) => controller.onResult(signal);

  let nextIndex = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  // 系统故障哨兵：hasFatalError 独立表达“是否已发生系统故障”，与 fatalError 的**取值**彻底解耦。
  // Promise 可合法以 null 拒绝（resolver throw null / reject(null)），故绝不能用 `fatalError === null`
  // 兼表“尚无故障”——否则 null rejection 会被误判为“未故障”：调度门继续开、排空后 resolve、finalize 成
  // 业务 partial，把系统/依赖故障伪装成业务部分失败，调用方进不了 C3-5 恢复路径。fatalError 只承载
  // “原样待抛的值”（含 null / undefined），是否故障一律看 hasFatalError。
  let hasFatalError = false;
  let fatalError: unknown = undefined;
  let settled = false;
  // C3-4/§②：协作 cancel 哨兵 + probe。cancelRequested 与 hasFatalError **解耦**（cancel-only 走 resolve、
  // fatal 走 reject，二者同发 fatal 严格优先，见 settle）。probe 默认 registry isCancelRequested（生产恒用），
  // 可注入替身（仅测试）。
  let cancelRequested = false;
  const probe = deps.isCancelRequested ?? isCancelRequested;
  const schedule: Array<{ limit: number; inFlight: number }> = [];

  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      if (hasFatalError) reject(fatalError);
      else resolve();
    };

    const pump = () => {
      // C3-4/§②：协作 cancel probe——抛错=系统故障，复用 fatal sentinel（P2）。probe 只在未 fatal 且未 cancel
      // 时调用：一旦 cancel 置位或已 fatal 就不再探询（省重复 SELECT、也避免重复抛点）。
      if (!hasFatalError && !cancelRequested) {
        try {
          if (probe(jobId)) cancelRequested = true;
        } catch (err) {
          // probe 抛错 = 系统故障（DB 异常）→ 归 hasFatalError（**不是** cancelRequested）；err 原样保留（含 null）
          // 待 settle 时透传。这样后续 pump 走 fatal-drain-reject（不 finalize、job 保持 running 交 C3-5），
          // 精确关闭 P2：回调内 probe 抛错不再让外层手写 Promise 永挂。
          if (!hasFatalError) {
            hasFatalError = true;
            fatalError = err;
          }
        }
      }
      // 系统故障或已请求取消后都不再调度新账号；等在飞排空后 settle（fatal→reject / cancel-only→resolve）。
      if (!hasFatalError && !cancelRequested) {
        while (nextIndex < pending.length && inFlight < controller.currentLimit()) {
          const index = nextIndex;
          nextIndex += 1;
          const account = pending[index];
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          schedule.push({ limit: controller.currentLimit(), inFlight });

          processAccount(jobId, account, job, deps, ctx, emitSignal).then(
            (run) => {
              inFlight -= 1;
              accounts[index] = run;
              // onResult 已在 runWithRetry 内 per-attempt 经 emitSignal 调用（§2.5）；此处不再重复。
              pump();
            },
            (err) => {
              inFlight -= 1;
              // 记录首个系统故障；err 原样保留（含 null）待 settle 时透传，绝不据其取值判断是否故障。
              if (!hasFatalError) {
                hasFatalError = true;
                fatalError = err;
              }
              pump();
            }
          );
        }
      }

      // 终止：无在飞且（账号处理完 或 已遇系统故障 或 已请求取消）。
      if (inFlight === 0 && (hasFatalError || cancelRequested || nextIndex >= pending.length)) {
        settle();
      }
    };

    pump();
  });

  // ── C3-4/§④：resolve 后（await 正常返回，即**非 fatal** 路径）收口 cancel + 压实（P1）。fatal 路径 reject
  // 从不到达此处。cancelRequested 时把未 admit 的 pending → cancelled（P3 门：生产默认 probe 下
  // cancelRequested ⟹ cancel_requested_at 非空；测试须先真实 requestCancel 建同一真库标记，见 smoke G9a
  // fixture 不变量）。
  if (cancelRequested) cancelPendingAccounts(jobId);
  const finalJob = finalizeJob(jobId); // cancelRequestedAt 非空 → cancelled；否则按四态收口
  // P1：压实稀疏缓冲为纯 AccountRunResult[]（无空洞、保持 pending 相对顺序）。非 cancel 非 fatal 路径所有槽位
  // 填满 → filter 为 no-op（同序同内容，锁 236 回归）；cancel 路径未 admit 槽位为空洞 → 被剔除 → accounts 只含
  // 本次实际完成的账号、按 pending 相对顺序压实、JSON.stringify 不产 null、类型收窄回 AccountRunResult[]。
  const compact = accounts.filter((r): r is AccountRunResult => r !== undefined);
  return {
    job: finalJob,
    accounts: compact,
    concurrency: { maxInFlight, schedule, finalLimit: controller.currentLimit() },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// C3-3 退避重试 + 抖动 + 注入时钟 + 可取消 per-page timeout（A 类·纯离线）
//
// 方案：docs/PLAN_WECHAT_EXPORTER_C3_3_BACKOFF_CLOCK.md（首审→R3 四审 Codex GO）。切片边界：
//   - 账号级指数退避重试（在 processAccount 内、applyAccountOutcome 之前），由注入 RunnerClock 驱动 sleep、
//     isRetryableErrorKind 驱动可重试性、可注入 jitter 决定抖动；引入 per-page **软** timeout（同签名装饰器）。
//   - **软** timeout（§2.7）：判定超时 + 归类为可重试 timeout，**不主动中止在飞网络**（PageFetcher 无
//     AbortSignal）。真正中止在飞请求 = 改生产 PageFetcher 契约 = 重新授权门 / C3-7。
//   - 默认 OFF（retry 缺省 = maxAttempts:1、timeoutMs=undefined）时与 C3-1/C3-2 完全等价，锁既有回归。
//   - 逻辑时钟（测试基建）不进生产模块，仅存于 smoke；生产只导出 RunnerClock / createRealClock。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * sleep 被 abort 时的 reject 载体。**非 timeout**：withTimeout 的 timeout 分支只在 sleep fulfilled 时抛
 * SyncFetchError('timeout')，sleep 被 abort → reject(ClockAbortError) 会跳过 then 的 onFulfilled，不误触发
 * 超时分支（§2.1/§2.7）。
 */
export class ClockAbortError extends Error {
  constructor(message = 'clock sleep aborted') {
    super(message);
    this.name = 'ClockAbortError';
  }
}

/**
 * 注入时钟：退避 sleep 与 per-page timeout 均经此。now() 预留给未来 deadline/观测（本切片轻用）；sleep 可
 * 取消（传入 signal abort → reject(ClockAbortError)）。生产用 createRealClock；测试注入逻辑时钟零真实等待。
 */
export interface RunnerClock {
  now(): number;
  sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** 退避重试策略（全部可选；入口 normalizeRetryOptions 填充默认 + 校验值域）。 */
export interface RetryPolicyOptions {
  /** 单账号最大尝试次数（含首次）。默认 1（不重试，锁回归）。必须为 >=1 的安全整数。 */
  maxAttempts?: number;
  /** 退避基数 ms。默认 1000。必须为有限非负数。 */
  baseDelayMs?: number;
  /** 退避封顶 ms。默认 30000。必须为有限非负数、>= baseDelayMs、<= 真实定时器上限 2_147_483_647。 */
  maxDelayMs?: number;
  /** 可注入抖动：raw → 实际 delay。默认 full jitter（random(0,raw)）；输出每次经 computeBackoffDelay fail-fast 校验。 */
  jitter?: (rawDelayMs: number) => number;
}

/** normalizeRetryOptions 的输出：默认已填充、值域已校验。 */
export interface NormalizedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: (rawDelayMs: number) => number;
}

/** processAccount 的运行时上下文（在 runner 入口一次性解析，校验前置于 startJob）。 */
interface ResolvedRetryContext {
  clock: RunnerClock;
  retry: NormalizedRetryOptions;
  timeoutMs: number | undefined;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Node setTimeout 32-bit signed 上限；超过打 TimeoutOverflowWarning 并把 delay 退化为 1ms（本机 Node v25 只读探针已证）。 */
const MAX_TIMER_MS = 2_147_483_647;

/** 默认 full jitter：random(0, raw)。exporter 普通运行时 Math.random 合法（仅 Workflow 脚本禁用）。 */
function fullJitter(raw: number): number {
  return Math.random() * raw;
}

/**
 * 生产真实时钟：now=Date.now；sleep=setTimeout。资源清理与单次结算是硬约束（防定时器泄漏 + 防双结算）：
 *   - 预先 aborted（进入即 signal.aborted）：立即 reject(ClockAbortError)，**不注册 setTimeout、不加 listener**；
 *   - 到期（resolve 路径）：removeEventListener 后 resolve；
 *   - 中途 abort（reject 路径）：clearTimeout(timer) + removeEventListener 后 reject(ClockAbortError)；
 *   - settled 布尔守卫保证 resolve/reject **只结算一次**、listener 只移除一次。
 * （Date.now / setTimeout 在 exporter 普通 TS 运行时合法；Date.now 禁用只针对 Workflow 脚本。）
 */
export function createRealClock(): RunnerClock {
  return {
    now: () => Date.now(),
    sleep: (ms, opts) =>
      new Promise<void>((resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new ClockAbortError());
          return;
        }
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(new ClockAbortError());
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
      }),
  };
}

/**
 * 入口配置校验 + 默认值填充。**必须在 startJob（首次 DB 写 queued→running）之前调用**：非法即 fail-fast 抛
 * RangeError（零持久副作用，R1-B2·B4 验收）。与 ConcurrencyController 构造器的 RangeError fail-fast 风格一致。
 */
export function normalizeRetryOptions(retry?: RetryPolicyOptions): NormalizedRetryOptions {
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts 必须为 >=1 的安全整数，收到 ${String(maxAttempts)}`);
  }
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(`retry.baseDelayMs 必须为有限非负数，收到 ${String(baseDelayMs)}`);
  }
  const maxDelayMs = retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError(`retry.maxDelayMs 必须为有限非负数，收到 ${String(maxDelayMs)}`);
  }
  if (baseDelayMs > maxDelayMs) {
    throw new RangeError(`retry.baseDelayMs(${baseDelayMs}) 不得大于 maxDelayMs(${maxDelayMs})`);
  }
  if (maxDelayMs > MAX_TIMER_MS) {
    throw new RangeError(`retry.maxDelayMs(${maxDelayMs}) 超过真实定时器上限 ${MAX_TIMER_MS}`);
  }
  const jitter = retry?.jitter;
  if (jitter !== undefined && typeof jitter !== 'function') {
    throw new RangeError('retry.jitter 必须为函数');
  }
  return { maxAttempts, baseDelayMs, maxDelayMs, jitter: jitter ?? fullJitter };
}

/** 校验 timeoutMs（若提供）：有限、严格正、<= 真实定时器上限。同样必须前置于 startJob。 */
export function assertTimeoutMs(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs 必须为有限正数，收到 ${String(timeoutMs)}`);
  }
  if (timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`timeoutMs(${timeoutMs}) 超过真实定时器上限 ${MAX_TIMER_MS}`);
  }
}

/** runner 入口一次性解析运行时上下文；**校验/规范化严格前置于 startJob**（零持久副作用）。 */
function resolveRetryContext(deps: RunSyncJobDeps): ResolvedRetryContext {
  const retry = normalizeRetryOptions(deps.retry);
  assertTimeoutMs(deps.timeoutMs);
  const clock = deps.clock ?? createRealClock();
  return { clock, retry, timeoutMs: deps.timeoutMs };
}

/**
 * 严格纯：raw 退避时延 = min(maxDelayMs, baseDelayMs * 2**min(attempt,30))。attempt 从 0 起。**无随机**、单调不减。
 * 指数封顶 min(attempt,30) 是硬约束：防 attempt 大到 2**attempt=Infinity 时 base=0 触发 0*Infinity=NaN
 * （cap=30 时 2**30≈1.07e9 恒有限 → base=0 时 raw 恒 0、base>0 时被 maxDelayMs 封顶）。
 */
export function computeRawBackoff(
  attempt: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number } = {}
): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(max, base * 2 ** Math.min(attempt, 30));
}

/**
 * raw 后过 jitter（默认 full jitter），并对 jitter 输出 **fail-fast 校验**：必须有限、>=0、<=raw；越界
 * （负 / NaN / Infinity / >raw）抛 RangeError（**不静默 clamp**，避免坏 jitter 悄悄产出非法 sleep 时长）。
 * 注意：full jitter 只保证 delay ∈ [0, raw]、**不保证单调**；单调只对 raw / identity-jitter 序列成立。
 */
export function computeBackoffDelay(attempt: number, opts: RetryPolicyOptions = {}): number {
  const raw = computeRawBackoff(attempt, { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs });
  const delay = (opts.jitter ?? fullJitter)(raw);
  if (!Number.isFinite(delay) || delay < 0 || delay > raw) {
    throw new RangeError(`jitter 输出 ${String(delay)} 越界（要求有限且 ∈ [0, ${raw}]）`);
  }
  return delay;
}

/**
 * per-page 软 timeout 装饰器（同签名 PageFetcher，不改 service / PageFetcher 契约）。§2.7 冻结结构（实施
 * 不得偏离）：
 *   ① fetchPage 调用包进 Promise.resolve().then(...)：捕获注入 fetcher 的**同步 throw**，保证 finally 一定
 *      执行、定时器一定清理；
 *   ② timeout scheduler 的 clock.sleep 调用**也**包进 Promise.resolve().then(...)（R2-C3-3-1 关闭点）：其
 *      同步 throw 转成 timeoutP 的 rejection → Promise.race **一定被构造**、fetchP **一定进 race** 被内部
 *      handler 消费 → 无孤儿 promise、无 unhandledRejection；
 *   ③ timeout 只在 sleep **fulfilled**（真到点）时抛 SyncFetchError('timeout')；sleep 被 abort →
 *      reject(ClockAbortError) 跳过 onFulfilled、不误触发 timeout；
 *   ④ 外层 finally 无条件 ac.abort() → createRealClock.sleep clearTimeout（“可取消”）。
 * 装饰器返回的任何 rejection 按 PageFetcher 契约 = 本页抓取失败，由 syncSingleAccount 的 catch 归类为受控
 * 业务 outcome（§2.8 ②：正常到点=timeout 可重试；scheduler 异常无 timeout/network 特征=classifyFetchError
 * 兜底 api_error 不可重试）——**非** runner fatal/drain。
 */
export function withTimeout(fetchPage: PageFetcher, clock: RunnerClock, timeoutMs: number): PageFetcher {
  return (params) => {
    const ac = new AbortController();
    const fetchP = Promise.resolve().then(() => fetchPage(params));
    const timeoutP = Promise.resolve()
      .then(() => clock.sleep(timeoutMs, { signal: ac.signal }))
      .then(() => {
        throw new SyncFetchError('timeout', `withTimeout: 单页抓取超过 ${timeoutMs}ms`);
      });
    return Promise.race([fetchP, timeoutP]).finally(() => {
      ac.abort();
    });
  };
}

/** runWithRetry 的返回：最终落库入参 + 观测摘要（run.attempts 已填充）。 */
interface RunWithRetryResult {
  outcomeInput: AccountOutcomeInput;
  run: AccountRunResult;
}

/**
 * 账号级退避重试循环（§2.4，B1 / R2-C3-3-1 关闭点）。每 attempt **窄 try/catch 只包 syncSingleAccount**：
 * 返回 outcome 或抛错（通道 A SyncConfigError / service 防御性抛错）都翻成 RawAccountResult →
 * classifyAccountResult 归类 → **恰 emit 一次**升降档信号（返回型 & 抛出型都 emit，关闭 B1 抛出型漏信号）。
 *
 * **退避 sleep（computeBackoffDelay + clock.sleep）在窄 catch 之外**（§2.4/§2.8 调用点①）：抛错 = 基础
 * 设施/系统故障，原样出 runWithRetry → 顺序版 runSyncJob reject / 并发版 pool fatal-drain，**绝不**落成账号
 * unexpected_error。注意：withTimeout 内的 timeout scheduler sleep（§2.8 调用点②）不在此列——它在
 * syncSingleAccount 的 try 内，抛错走 service catch 的受控业务 outcome 路径。
 *
 * 终态判定：succeeded / auth_required（status!=='failed'）、不可重试、或已达 maxAttempts → 返回终态。
 */
async function runWithRetry(
  fakeid: string,
  options: SyncAccountOptions,
  fetchPage: PageFetcher,
  clock: RunnerClock,
  retry: NormalizedRetryOptions,
  emitSignal: (signal: ConcurrencySignal) => void
): Promise<RunWithRetryResult> {
  let attempt = 0;
  for (;;) {
    // ── 窄 try/catch：只包 syncSingleAccount；返回/抛出都翻成 RawAccountResult 交纯函数归类 ──
    let raw: RawAccountResult;
    try {
      raw = { ok: true, outcome: await syncSingleAccount(options, fetchPage) };
    } catch (error) {
      raw = { ok: false, error };
    }
    const classified = classifyAccountResult(fakeid, raw);
    const attempts = attempt + 1;
    // 恰 emit 一次（返回型 & 抛出型都 emit；succeeded→'succeeded'，否则 errorKind[含 null]）。
    emitSignal(classified.run.status === 'succeeded' ? 'succeeded' : classified.run.errorKind);

    // ── 以下判定/退避在窄 catch 之外：抛错 = 系统故障，原样向上（不吞、进 fatal/drain）──
    if (
      classified.run.status !== 'failed' || // succeeded / auth_required → 终态
      !classified.run.retryable || // 不可重试（含 config_error / api_error / 未预期）→ 终态
      attempts >= retry.maxAttempts // 耗尽 → 终态
    ) {
      return { outcomeInput: classified.outcomeInput, run: { ...classified.run, attempts } };
    }
    await clock.sleep(computeBackoffDelay(attempt, retry)); // 退避（槽位保持，§2.6）；sleep/jitter 抛错向上传
    attempt = attempts;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// C3-5 重启恢复编排（A 类·纯离线：复用既有 runSyncJobPool，不新写账号抓取循环）
//
// 方案：docs/PLAN_WECHAT_EXPORTER_C3_5_RESTART_RECOVERY.md（R2 Codex 方案层 GO）。切片边界：
//   - 首版保守恢复：interrupted -> pending -> running，账号从头重跑（startBegin=0），**不做 page_cursor
//     断点续跑、不改 PageFetcher 契约**，依赖既有 knownAids/aid 去重防重复结果。
//   - 复用 runSyncJobPool（C3-2 起的生产并发原语，全仓唯一 ConcurrencyController）续跑，不复制账号抓取循环、
//     不改 runSyncJob/runSyncJobPool/processAccount/runWithRetry 既有实现，不扩 RunSyncJobDeps 契约。
//   - 无 DDL、无新持久态、不 bump schema（interrupted->pending 是既有合法迁移；registry 只新增
//     resetInterruptedAccounts + listRunningJobIdsForRecovery 两原语）。
//   - 生产启动接线（把 recoverInterruptedJobs 挂 Nitro 启动钩子）属后续切片（§5-P3），本切片纯离线编排 +
//     测试直调；不接生产启动路径、不联网、不启动生产服务。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 重启恢复汇总。逐 job try/catch 使外层 Promise **即便 failed 非空也整体 resolve**。
 *
 * ⚠ 可观测契约（§2.2/§5-P3，N-C3-5-P3）：生产启动接线**必须**把非空 `failed` 当作「部分恢复失败」经
 * **结构化日志 / 指标 / 告警**显式消费——**绝不能把 Promise fulfilled 当成「全部 job 恢复成功」**；`failed`
 * 为空才是「全绿」的唯一判据。本片只写此返回契约（生产 logger + 启动屏障挂载见 §5-P3 待接线条件：awaited
 * 屏障 / 恢复完成前新 runner 不得 admission / 非空 failed 必被消费 / fulfilled≠全成功；仅具体挂载机制待确认，
 * 不引入定时 / daemon），不实现生产 logger。
 */
export interface RecoverySummary {
  /** reconcileOrphanedJobs 结果（本次启动降级的孤儿 job / 账号数）。 */
  reconciled: { jobs: number; accounts: number };
  /** 正常续跑并 finalize（job.status !== 'cancelled'）的 jobId。 */
  recovered: string[];
  /** 收口为 cancelled 的 jobId（入口 cancel 分支 + reset 后途中 cancel 被 pool 收口）。 */
  cancelled: string[];
  /** 恢复中 fatal（job 仍 running、未 finalize，交下次进程重启的 reconcile）。 */
  failed: Array<{ jobId: string; error: unknown }>;
}

/**
 * 重启恢复编排（§2.2）：启动屏障 reconcileOrphanedJobs → listRunningJobIdsForRecovery 一次性无饥饿快照枚举
 * 全部 running job → 逐 job recoverOneJob（cancel 严格优先 or reset + 复用 runSyncJobPool 续跑）→ 按 pool
 * 返回的 job.status 分类 recovered/cancelled。**不新写账号抓取循环、不改 runner 既有函数。**
 *
 * **所有权 / 启动屏障（§2.4 P-O1，首版单进程假设）**：reconcileOrphanedJobs 是**全局** running->interrupted
 * 操作（不按 job 过滤），故本函数只能在**确认旧进程 runner 不存在的启动阶段、任何新 job runner admission 之前
 * 调用一次**，运行期绝不再调。本片可机器证明的是「单次 invocation 内部 reconcile 恰一次、且先于任何 job
 * admission」（快照枚举与逐 job 恢复都在这一次 reconcile 之后）；「运行期不再次调用 / 新 runner 在恢复屏障完成
 * 前不启动」属生产启动钩子的调用所有权，是后续接线验收（§5-P3），本片离线 smoke 无法证明、也不冒充。
 *
 * **单 job fatal 不阻断全局（§5-P4）**：逐 job try/catch——单 job fatal 记录进 summary.failed（不吞成成功、
 * 不伪装账号 failed/cancelled），该 job 保持 running（未 finalize）交下次 reconcile，继续恢复下一个 job。
 */
export async function recoverInterruptedJobs(deps: RunSyncJobDeps): Promise<RecoverySummary> {
  // 启动屏障：全局 running 账号 -> interrupted（job 仍 running）。本次 invocation 内 reconcile 恰一次、
  // 先于任何 job admission（快照枚举与逐 job 恢复都在其后）。
  const reconciled = reconcileOrphanedJobs();
  const summary: RecoverySummary = { reconciled, recovered: [], cancelled: [], failed: [] };
  // F-C3-5-P1：一次性无饥饿快照枚举全部 running job（非 listSyncJobs，避免 500 上限 + fatal 饥饿，见 registry
  // listRunningJobIdsForRecovery）；created_at ASC, id ASC 全序。
  for (const jobId of listRunningJobIdsForRecovery()) {
    try {
      const outcome = await recoverOneJob(jobId, deps);
      if (outcome === 'cancelled') summary.cancelled.push(jobId);
      else summary.recovered.push(jobId);
    } catch (error) {
      // 单 job fatal：不吞、不伪装成功；job 保持 running（未 finalize）交下次 reconcile；记录后继续下一个 job。
      summary.failed.push({ jobId, error });
    }
  }
  return summary;
}

/**
 * 恢复单个 running job（§2.2）。**cancel 严格优先于恢复**（用户 2026-07-18 拍板）：
 *   - 重启后 job 已请求取消 → 零 fetch、不拉起 interrupted 账号；复用 C3-4 cancelPendingAccounts + finalizeJob
 *     收口 cancelled；interrupted 账号保留作崩溃历史事实（§5-P1，不新增 interrupted->cancelled 迁移）。
 *   - 无 cancel → resetInterruptedAccounts 归一化 interrupted->pending，复用 runSyncJobPool 续跑全部 pending
 *     （含刚 reset 的 + 原 pending）；finalize 由 pool 内部完成。
 *
 * **F-C3-5-P2：必须读 runSyncJobPool 返回的 job.status 分类**。「reset 后 / 途中 cancel 到达」时，pool 内
 * C3-4 probe 观察 cancel → 停 admission → 排空 → cancelPendingAccounts → finalizeJob 返回 cancelled，且
 * **正常 resolve（不 reject）**；若无条件 return 'recovered'，一次真实取消会被误记为 recovered（summary 失真）。
 *
 * probe 与 runSyncJobPool 内部同源解析（deps.isCancelRequested ?? 默认 registry probe），使入口 cancel 检查与
 * pool 内部 cancel 检查一致。cancel-resolve 路径要求 cancel_requested_at 真实非空（cancelPendingAccounts 的
 * P3 前置门）：生产默认 probe 读真库自然满足；测试注入替身走该路径时须先真实 requestCancel（见 smoke fixture 不变量）。
 */
async function recoverOneJob(jobId: string, deps: RunSyncJobDeps): Promise<'recovered' | 'cancelled'> {
  const probe = deps.isCancelRequested ?? isCancelRequested;
  // ── cancel 严格优先：重启后 job 已请求取消 → 零 fetch、不拉起 interrupted ──
  if (probe(jobId)) {
    cancelPendingAccounts(jobId); // pending->cancelled（P3 门：cancel_requested_at 非空）
    finalizeJob(jobId); // cancelRequestedAt 非空 → cancelled
    return 'cancelled'; // 不进 runner；interrupted 账号保留作崩溃历史事实（§5-P1）
  }
  // ── 无 cancel：interrupted->pending 归一化，复用 runSyncJobPool 续跑 ──
  resetInterruptedAccounts(jobId); // interrupted->pending（P-R2 running 门保护）
  const result = await runSyncJobPool(jobId, deps); // 续跑全部 pending（含刚 reset 的 + 原 pending）
  // F-C3-5-P2：读 pool 返回值分类——「reset 后途中 cancel」pool 正常 resolve 且 job.status='cancelled'。
  return result.job.status === 'cancelled' ? 'cancelled' : 'recovered';
}
