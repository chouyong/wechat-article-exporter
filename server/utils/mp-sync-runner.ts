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
 * C3-1 核心循环：startJob → 逐个 pending 账号（priority DESC）解析 options → markRunning →
 * syncSingleAccount → classifyAccountResult → applyAccountOutcome → finalizeJob。顺序 async、无并发、
 * 无 sleep、无 cancel 检查。
 *
 * 失败隔离边界（F1/C3-1-F1）：try/catch **只**包住 syncSingleAccount，把它的抛错（通道 A 的
 * SyncConfigError / 防御性未预期错误）翻译成该账号失败终态，绝不中断整个 job 循环。
 * **resolveOptions 求值与 options 组装在 try 之外、且在 markAccountRunning 之前**——resolver / 依赖
 * 配置器抛错属系统故障，原样向上抛（runSyncJob reject），绝不伪装成账号业务失败、不迁移状态、不续跑。
 * applyAccountOutcome / 状态机原语的抛错同属真实不变量违规，也在 catch 之外、故意不吞（向上抛）。
 */
export async function runSyncJob(jobId: string, deps: RunSyncJobDeps): Promise<RunSyncJobResult> {
  const job = startJob(jobId); // queued -> running（幂等）
  const pending = listJobAccounts(jobId, 'pending'); // 已按 priority DESC, fakeid 排序
  const accounts: AccountRunResult[] = [];

  for (const account of pending) {
    // F1（C3-1-F1）：resolveOptions 求值 + options 组装放在状态迁移与 try/catch **之外**。
    // resolver / 依赖配置器抛错属系统故障（编程 / 依赖错误），不是远端账号业务失败：必须原样向上抛
    // （runSyncJob 整体 reject），绝不被下方只为 syncSingleAccount 设的 catch 吞掉、伪装成该账号的
    // failed/unexpected_error（那会污染持久错误事实与 retry 预算、让调用方无法感知系统性故障）。
    // 置于 markAccountRunning 之前：resolver 抛错时该账号连状态迁移都不发生，保持 pending。
    const overrides = deps.resolveOptions?.(account, job);
    const options: SyncAccountOptions = {
      fakeid: account.fakeid,
      sinceTime: account.sinceTime ?? job.requestedSince ?? 0,
      ...overrides,
      // F2（C3-1-F2）：startBegin 固定 0 置于展开 overrides 之后 = 运行时第二层防御。C3-1 不做断点
      // 续跑（C3-5）；即便 resolver 经非类型安全输入返回 startBegin，也被此处 0 覆盖。
      startBegin: 0,
    };

    markAccountRunning(jobId, account.fakeid); // pending -> running

    // 失败隔离边界**只**包住 syncSingleAccount：其抛错（通道 A 的 SyncConfigError / 防御性未预期错误）
    // 翻译成该账号失败终态，不中断整 job。applyAccountOutcome / 状态机原语的抛错属真实不变量违规，故意不吞。
    let classified: ReturnType<typeof classifyAccountResult>;
    try {
      const outcome = await syncSingleAccount(options, deps.fetchPage);
      classified = classifyAccountResult(account.fakeid, { ok: true, outcome });
    } catch (error) {
      classified = classifyAccountResult(account.fakeid, { ok: false, error });
    }

    applyAccountOutcome(jobId, account.fakeid, classified.outcomeInput);
    accounts.push(classified.run);
  }

  const finalJob = finalizeJob(jobId);
  return { job: finalJob, accounts };
}
