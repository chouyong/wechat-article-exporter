// 相对 import 带 .ts 扩展：既让离线 smoke 在裸 Node ESM 下能直接 import（Node 类型剥离要求显式扩展），
// 也被 Nitro 打包（rollup/esbuild，不做 tsc 类型检查）正常解析。避免 ~ 别名导致 smoke 无法解析。
import {
  syncSingleAccount,
  SyncConfigError,
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
}

export interface RunSyncJobResult {
  job: MpSyncJob;
  accounts: AccountRunResult[];
}

/**
 * 单账号一次同步的完整处理单元：供顺序 runSyncJob 与并发 runSyncJobPool **共用同一语义源**
 * （失败隔离 / 系统故障传播 / startBegin 固定，两条编排路径逐字一致，差异只在“同时跑几个账号”）。
 *
 * 边界（F1/C3-1-F1）：try/catch **只**包住 syncSingleAccount，把它的抛错（通道 A 的 SyncConfigError /
 * 防御性未预期错误）翻译成该账号失败终态。**resolveOptions 求值 + options 组装在 try 之外、且在
 * markAccountRunning 之前**——resolver / 依赖配置器抛错属系统故障，原样向上抛（顺序版使 runSyncJob
 * reject；并发版由 runSyncJobPool 调度器捕获后停止调度、排空在飞再 reject），绝不伪装成账号业务失败、
 * 不迁移状态、不续跑；置于 markAccountRunning 之前 → resolver 抛错时账号连状态迁移都不发生、保持 pending。
 * applyAccountOutcome / 状态机原语的抛错同属真实不变量违规，也在 catch 之外、故意不吞（向上抛）。
 * startBegin 固定 0（F2/C3-1-F2）置于展开 overrides 之后作运行时第二层防御：C3-1/C3-2 不做断点续跑（C3-5）；
 * 即便 resolver 经非类型安全输入返回 startBegin，也被此处 0 覆盖。
 */
async function processAccount(
  jobId: string,
  account: MpSyncJobAccount,
  job: MpSyncJob,
  deps: RunSyncJobDeps
): Promise<AccountRunResult> {
  const overrides = deps.resolveOptions?.(account, job);
  const options: SyncAccountOptions = {
    fakeid: account.fakeid,
    sinceTime: account.sinceTime ?? job.requestedSince ?? 0,
    ...overrides,
    startBegin: 0,
  };

  markAccountRunning(jobId, account.fakeid); // pending -> running

  let classified: ReturnType<typeof classifyAccountResult>;
  try {
    const outcome = await syncSingleAccount(options, deps.fetchPage);
    classified = classifyAccountResult(account.fakeid, { ok: true, outcome });
  } catch (error) {
    classified = classifyAccountResult(account.fakeid, { ok: false, error });
  }

  applyAccountOutcome(jobId, account.fakeid, classified.outcomeInput);
  return classified.run;
}

/**
 * C3-1 核心循环（顺序 async、无并发、无 sleep、无 cancel 检查）：startJob → 逐个 pending 账号
 * （priority DESC）processAccount → finalizeJob。等价于 runSyncJobPool 并发上限恒为 1 的特例，但保留
 * 独立实现以零改动锁定 C3-1 既有回归。失败隔离 / 系统故障传播语义见 processAccount。
 */
export async function runSyncJob(jobId: string, deps: RunSyncJobDeps): Promise<RunSyncJobResult> {
  const job = startJob(jobId); // queued -> running（幂等）
  const pending = listJobAccounts(jobId, 'pending'); // 已按 priority DESC, fakeid 排序
  const accounts: AccountRunResult[] = [];

  for (const account of pending) {
    accounts.push(await processAccount(jobId, account, job, deps));
  }

  const finalJob = finalizeJob(jobId);
  return { job: finalJob, accounts };
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
  /** 调度期间在飞 worker 峰值（= 在飞 fetchPage 峰值，每账号同一时刻最多一个在飞 fetchPage）。 */
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
 *   - 并发上限约束作用于 admission：仅当 inFlight < currentLimit() 时调度新账号（while 条件保证；每账号
 *     同一时刻最多一个在飞 fetchPage）。429 降档不会中断已在飞 worker，因此短期内 inFlight 可高于新档位；
 *     期间停止新增 admission，待既有 worker 排空后自然收敛至新档位。
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
  const job = startJob(jobId); // queued -> running（幂等）
  const pending = listJobAccounts(jobId, 'pending'); // 已按 priority DESC, fakeid 排序
  const accounts: AccountRunResult[] = new Array<AccountRunResult>(pending.length);
  const controller = new ConcurrencyController(options);

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
  const schedule: Array<{ limit: number; inFlight: number }> = [];

  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      if (hasFatalError) reject(fatalError);
      else resolve();
    };

    const pump = () => {
      // 系统故障后不再调度新账号；等在飞排空后原样 reject（不新增 running，已在飞的各自落终态）。
      if (!hasFatalError) {
        while (nextIndex < pending.length && inFlight < controller.currentLimit()) {
          const index = nextIndex;
          nextIndex += 1;
          const account = pending[index];
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          schedule.push({ limit: controller.currentLimit(), inFlight });

          processAccount(jobId, account, job, deps).then(
            (run) => {
              inFlight -= 1;
              accounts[index] = run;
              controller.onResult(run.status === 'succeeded' ? 'succeeded' : run.errorKind);
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

      // 终止：无在飞且（账号处理完 或 已遇系统故障）。
      if (inFlight === 0 && (hasFatalError || nextIndex >= pending.length)) {
        settle();
      }
    };

    pump();
  });

  const finalJob = finalizeJob(jobId);
  return { job: finalJob, accounts, concurrency: { maxInFlight, schedule, finalLimit: controller.currentLimit() } };
}
