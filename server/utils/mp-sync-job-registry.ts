import { randomUUID } from 'node:crypto';
// 相对 import 带 .ts 扩展：既让离线 smoke 在裸 Node ESM 下能直接 import（Node 类型剥离要求显式扩展），
// 也被 Nitro 打包（rollup/esbuild，不做 tsc 类型检查）正常解析。避免 ~ 别名导致 smoke 无法解析。
import { getMpSyncDatabase } from './mp-account-registry.ts';

/**
 * C2 后台增量同步任务持久层（repository + 状态机 + 事务边界 + 幂等键 + 服务重启语义）。
 *
 * 边界说明：本模块只负责“任务与逐账号状态如何落盘、如何合法迁移、重启后如何被安全 reconcile”，
 * 不包含 runner / 并发调度 / 重启恢复执行器 / 重试·取消 HTTP API / 自适应并发 / snapshot·export 串行提交
 * （这些属于 C3）。逐账号抓取算法在 mp-sync-service.ts，同样不在此执行真实网络请求。
 *
 * 数据表 mp_sync_jobs / mp_sync_job_accounts 由 mp-account-registry.ts 的 schema v2 迁移创建，
 * 与 mp_accounts 共用同一 SQLite 连接与迁移链。
 */

export type MpSyncJobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type MpSyncJobMode = 'incremental' | 'full' | 'failed_only';
export type MpSyncJobAccountStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'auth_required'
  | 'interrupted'
  | 'cancelled';

export interface MpSyncJob {
  id: string;
  status: MpSyncJobStatus;
  mode: MpSyncJobMode;
  idempotencyKey: string | null;
  requestedSince: number | null;
  totalAccounts: number;
  processedAccounts: number;
  succeededAccounts: number;
  failedAccounts: number;
  newArticles: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
}

export interface MpSyncJobAccount {
  jobId: string;
  fakeid: string;
  status: MpSyncJobAccountStatus;
  priority: number;
  pageCursor: number;
  sinceTime: number | null;
  lastArticleTime: number | null;
  retryCount: number;
  newArticles: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateSyncJobAccountInput {
  fakeid: string;
  priority?: number;
  sinceTime?: number | null;
}

export interface CreateSyncJobInput {
  id?: string;
  mode?: MpSyncJobMode;
  idempotencyKey?: string | null;
  requestedSince?: number | null;
  accounts: CreateSyncJobAccountInput[];
}

/** 单账号一次同步结果落库入参（由 mp-sync-service.ts 的 AccountSyncOutcome 映射而来）。 */
export interface AccountOutcomeInput {
  status: 'succeeded' | 'failed' | 'auth_required';
  newArticles?: number;
  pageCursor?: number;
  lastArticleTime?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

// ── 状态机：任何非法迁移都抛错，防止调用方把状态改花 ────────────────────────────
const JOB_TRANSITIONS: Record<MpSyncJobStatus, MpSyncJobStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'partial', 'failed', 'cancelled'],
  partial: ['running', 'cancelled'], // failed_only 重试可重新拉起；也允许用户放弃重试直接取消（F-C2-2）
  failed: ['running'],
  completed: [],
  cancelled: [],
};

const ACCOUNT_TRANSITIONS: Record<MpSyncJobAccountStatus, MpSyncJobAccountStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'auth_required', 'interrupted', 'cancelled'],
  failed: ['pending', 'running'],
  auth_required: ['pending', 'running'],
  interrupted: ['pending', 'running'],
  succeeded: [],
  cancelled: [],
};

// 不再用全局 from===to 放宽“同态自迁移”：那会让 succeeded->succeeded / failed->failed
// 等终态重放静默通过 assert，进而改写已完成事实、重复累加 retry_count（F-C2-1）。
// 幂等一律在各 mutator 入口显式处理（startJob / markAccountRunning 的 running 早返回、
// applyAccountOutcome 的终态只读幂等门、finalizeJob 的 next===status 早返回）。
export function canTransitionJob(from: MpSyncJobStatus, to: MpSyncJobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canTransitionAccount(from: MpSyncJobAccountStatus, to: MpSyncJobAccountStatus): boolean {
  return ACCOUNT_TRANSITIONS[from].includes(to);
}

function assertJobTransition(from: MpSyncJobStatus, to: MpSyncJobStatus) {
  if (!canTransitionJob(from, to)) {
    throw new Error(`illegal mp_sync_job transition: ${from} -> ${to}`);
  }
}

function assertAccountTransition(from: MpSyncJobAccountStatus, to: MpSyncJobAccountStatus) {
  if (!canTransitionAccount(from, to)) {
    throw new Error(`illegal mp_sync_job_account transition: ${from} -> ${to}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

type SqliteRow = Record<string, unknown>;

function jobFromRow(row: SqliteRow): MpSyncJob {
  return {
    id: String(row.id),
    status: String(row.status) as MpSyncJobStatus,
    mode: String(row.mode) as MpSyncJobMode,
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    requestedSince: row.requested_since === null ? null : Number(row.requested_since),
    totalAccounts: Number(row.total_accounts),
    processedAccounts: Number(row.processed_accounts),
    succeededAccounts: Number(row.succeeded_accounts),
    failedAccounts: Number(row.failed_accounts),
    newArticles: Number(row.new_articles),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    cancelRequestedAt: row.cancel_requested_at === null ? null : String(row.cancel_requested_at),
  };
}

function accountFromRow(row: SqliteRow): MpSyncJobAccount {
  return {
    jobId: String(row.job_id),
    fakeid: String(row.fakeid),
    status: String(row.status) as MpSyncJobAccountStatus,
    priority: Number(row.priority),
    pageCursor: Number(row.page_cursor),
    sinceTime: row.since_time === null ? null : Number(row.since_time),
    lastArticleTime: row.last_article_time === null ? null : Number(row.last_article_time),
    retryCount: Number(row.retry_count),
    newArticles: Number(row.new_articles),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function selectJob(db: ReturnType<typeof getMpSyncDatabase>, id: string): MpSyncJob | null {
  const row = db.prepare('SELECT * FROM mp_sync_jobs WHERE id = ?').get(id) as SqliteRow | undefined;
  return row ? jobFromRow(row) : null;
}

export function getSyncJob(id: string): MpSyncJob | null {
  return selectJob(getMpSyncDatabase(), id.trim());
}

export function getSyncJobByIdempotencyKey(key: string): MpSyncJob | null {
  const db = getMpSyncDatabase();
  const row = db.prepare('SELECT * FROM mp_sync_jobs WHERE idempotency_key = ?').get(key) as SqliteRow | undefined;
  return row ? jobFromRow(row) : null;
}

export function getJobAccount(jobId: string, fakeid: string): MpSyncJobAccount | null {
  const db = getMpSyncDatabase();
  const row = db
    .prepare('SELECT * FROM mp_sync_job_accounts WHERE job_id = ? AND fakeid = ?')
    .get(jobId, fakeid.trim()) as SqliteRow | undefined;
  return row ? accountFromRow(row) : null;
}

export function listJobAccounts(jobId: string, status?: MpSyncJobAccountStatus): MpSyncJobAccount[] {
  const db = getMpSyncDatabase();
  const rows = status
    ? (db
        .prepare(
          `SELECT * FROM mp_sync_job_accounts WHERE job_id = ? AND status = ?
           ORDER BY priority DESC, fakeid`
        )
        .all(jobId, status) as SqliteRow[])
    : (db
        .prepare(
          `SELECT * FROM mp_sync_job_accounts WHERE job_id = ?
           ORDER BY priority DESC, fakeid`
        )
        .all(jobId) as SqliteRow[]);
  return rows.map(accountFromRow);
}

export function listSyncJobs(options: { status?: MpSyncJobStatus; limit?: number } = {}): MpSyncJob[] {
  const db = getMpSyncDatabase();
  const limit = Math.min(500, Math.max(1, options.limit ?? 50));
  const rows = options.status
    ? (db
        .prepare('SELECT * FROM mp_sync_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(options.status, limit) as SqliteRow[])
    : (db.prepare('SELECT * FROM mp_sync_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as SqliteRow[]);
  return rows.map(jobFromRow);
}

/**
 * C3-5 重启恢复：枚举全部 status='running' 的 job id（无 LIMIT / 无游标 / 无 fatal 饥饿）。
 * 一次性读取全部 running id 形成稳定快照；ORDER BY created_at ASC, id ASC = 全序确定性恢复顺序
 * （created_at 由 nowIso() 毫秒级 new Date().toISOString() 生成、schema 仅 id 主键 + idempotency_key 唯一、
 * created_at 无唯一约束可碰撞，加主键 id 并列键兜底全序，便于验收精确断言恢复次序）。
 *
 * **为何不用 listSyncJobs（不能用）**：listSyncJobs 的 limit 硬夹 1..500、created_at DESC LIMIT 无
 * offset/cursor，结构上无法枚举全部 running job；且 C3-5 让 fatal job 保持 running，最新 500 个若持续
 * fatal 会长踞第一页，更老的 running job 永不可见（饥饿）。「反复读第一页」也不解决——不改 job 状态就翻不了页，
 * 改 job 状态翻页则违反「fatal 保持 running / 不伪装」。故新增本一次性稳定快照原语：单一时点捕获全部 running id，
 * 不靠改 job 状态翻页，fatal job 保持 running 也不遮住任何其它 running job（同一快照同时捕获）。
 *
 * 仅在启动屏障 reconcileOrphanedJobs 完成后、任何新 runner admission 之前调用一次（单进程前提，见
 * mp-sync-runner.ts recoverInterruptedJobs）；只 SELECT id 保持轻量；DB 异常原样上抛（fail-fast 整个恢复、
 * 不静默漏 job）。多进程/多副本部署会破坏快照稳定性前提（属 OUT，需所有权租约独立切片）。
 */
export function listRunningJobIdsForRecovery(): string[] {
  const db = getMpSyncDatabase();
  const rows = db
    .prepare(`SELECT id FROM mp_sync_jobs WHERE status = 'running' ORDER BY created_at ASC, id ASC`)
    .all() as SqliteRow[];
  return rows.map((r) => String(r.id));
}

/**
 * 创建同步任务并落盘账号快照。事务化：任务行 + 全部 job_account 行要么全写要么全不写。
 * 幂等键（idempotencyKey）已存在则直接返回既有任务，不重复创建（“重复 job 幂等”）。
 * 同一 job 内重复 fakeid 用 INSERT OR IGNORE 去重（“重复账号幂等”）。
 */
export function createSyncJob(input: CreateSyncJobInput): MpSyncJob {
  const db = getMpSyncDatabase();
  const key = input.idempotencyKey ?? null;
  if (key) {
    const existing = getSyncJobByIdempotencyKey(key);
    if (existing) return existing;
  }

  const id = input.id?.trim() || randomUUID();
  const mode: MpSyncJobMode = input.mode ?? 'incremental';
  const requestedSince = input.requestedSince ?? null;
  const now = nowIso();

  db.exec('BEGIN IMMEDIATE;');
  try {
    // 去重账号快照：同批同 fakeid 只留第一条；高优先级排前面。
    const seen = new Set<string>();
    const accounts: CreateSyncJobAccountInput[] = [];
    for (const account of input.accounts) {
      const fakeid = account.fakeid.trim();
      if (!fakeid || seen.has(fakeid)) continue;
      seen.add(fakeid);
      accounts.push({ ...account, fakeid });
    }

    db.prepare(
      `INSERT INTO mp_sync_jobs (
        id, status, mode, idempotency_key, requested_since,
        total_accounts, processed_accounts, succeeded_accounts, failed_accounts, new_articles,
        created_at, started_at, finished_at, cancel_requested_at
      ) VALUES (?, 'queued', ?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, NULL, NULL)`
    ).run(id, mode, key, requestedSince, accounts.length, now);

    const insertAccount = db.prepare(
      `INSERT OR IGNORE INTO mp_sync_job_accounts (
        job_id, fakeid, status, priority, page_cursor, since_time, last_article_time,
        retry_count, new_articles, error_code, error_message, created_at, updated_at, started_at, finished_at
      ) VALUES (?, ?, 'pending', ?, 0, ?, NULL, 0, 0, NULL, NULL, ?, ?, NULL, NULL)`
    );
    for (const account of accounts) {
      insertAccount.run(id, account.fakeid, account.priority ?? 0, account.sinceTime ?? null, now, now);
    }

    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  return selectJob(db, id) as MpSyncJob;
}

/**
 * queued -> running（也含 failed_only 重试的 partial/failed -> running）。已 running 幂等返回；其它非法迁移抛错。
 * 进入 running 时清 finished_at：重试重跑的任务不再是“已完成”，避免 re-finalize 因 COALESCE 保留首次终态时间戳而失真。
 */
export function startJob(id: string): MpSyncJob {
  const db = getMpSyncDatabase();
  const job = selectJob(db, id);
  if (!job) throw new Error(`mp_sync_job not found: ${id}`);
  if (job.status === 'running') return job;
  assertJobTransition(job.status, 'running');
  db.prepare(
    'UPDATE mp_sync_jobs SET status = ?, started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?'
  ).run('running', nowIso(), id);
  return selectJob(db, id) as MpSyncJob;
}

/** 标记单账号进入 running（pending/interrupted/failed/auth_required -> running）。 */
export function markAccountRunning(jobId: string, fakeid: string): MpSyncJobAccount {
  const db = getMpSyncDatabase();
  const account = getJobAccount(jobId, fakeid);
  if (!account) throw new Error(`mp_sync_job_account not found: ${jobId}/${fakeid}`);
  if (account.status === 'running') return account;
  assertAccountTransition(account.status, 'running');
  const now = nowIso();
  db.prepare(
    `UPDATE mp_sync_job_accounts
     SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE job_id = ? AND fakeid = ?`
  ).run(now, now, jobId, fakeid.trim());
  return getJobAccount(jobId, fakeid) as MpSyncJobAccount;
}

function recomputeJobAggregates(db: ReturnType<typeof getMpSyncDatabase>, jobId: string) {
  // succeeded / failed(含 auth_required) / processed / 累计新文章，全部从 job_accounts 真值重算，避免计数漂移。
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status IN ('failed', 'auth_required') THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(new_articles), 0) AS new_articles
       FROM mp_sync_job_accounts WHERE job_id = ?`
    )
    .get(jobId) as SqliteRow;
  const succeeded = Number(row.succeeded ?? 0);
  const failed = Number(row.failed ?? 0);
  const newArticles = Number(row.new_articles ?? 0);
  db.prepare(
    `UPDATE mp_sync_jobs
     SET succeeded_accounts = ?, failed_accounts = ?, processed_accounts = ?, new_articles = ?
     WHERE id = ?`
  ).run(succeeded, failed, succeeded + failed, newArticles, jobId);
}

/**
 * 落库单账号一次同步结果并重算任务聚合。事务化：账号行 + 任务聚合要么一起更新要么回滚。
 * failed/auth_required 会累加 retry_count（供 failed_only 重试与退避判断）。
 * 单账号失败只改这一行 + 聚合，不影响其它账号（失败隔离在数据层的体现）。
 */
export function applyAccountOutcome(jobId: string, fakeid: string, outcome: AccountOutcomeInput): MpSyncJobAccount {
  const db = getMpSyncDatabase();
  const account = getJobAccount(jobId, fakeid);
  if (!account) throw new Error(`mp_sync_job_account not found: ${jobId}/${fakeid}`);

  // 只有 running 账号能落定一次 outcome（outcome = 一次 running 尝试的结果）。
  // 已终态账号再次进入这里 = 重复回调 / 恢复重放 / API 重试（F-C2-1）：
  //   - 目标终态与现状“落库后完全等值”（用与下方 UPDATE 相同的 ?? 解析口径逐字段比对）→ 只读幂等返回，
  //     绝不改写终态字段、绝不再累加 retry_count、绝不刷新 finished_at；
  //   - 任何字段不同 → 视为对已完成事实的非法改写，拒绝。
  if (account.status !== 'running') {
    const resolvedNewArticles = outcome.newArticles ?? account.newArticles;
    const resolvedPageCursor = outcome.pageCursor ?? account.pageCursor;
    const resolvedLastArticleTime = outcome.lastArticleTime ?? account.lastArticleTime;
    const resolvedErrorCode = outcome.status === 'succeeded' ? null : (outcome.errorCode ?? null);
    const resolvedErrorMessage = outcome.status === 'succeeded' ? null : (outcome.errorMessage ?? null);
    const identicalReplay =
      account.status === outcome.status &&
      resolvedNewArticles === account.newArticles &&
      resolvedPageCursor === account.pageCursor &&
      resolvedLastArticleTime === account.lastArticleTime &&
      resolvedErrorCode === account.errorCode &&
      resolvedErrorMessage === account.errorMessage;
    if (identicalReplay) return account;
    throw new Error(
      `cannot apply outcome '${outcome.status}' to non-running account '${account.status}': ${jobId}/${fakeid}`
    );
  }
  // 到这里 account.status === 'running'；running -> succeeded|failed|auth_required 均合法（防御性再断言）。
  assertAccountTransition(account.status, outcome.status);

  const now = nowIso();
  const bumpRetry = outcome.status === 'failed' || outcome.status === 'auth_required' ? 1 : 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `UPDATE mp_sync_job_accounts SET
         status = ?,
         new_articles = ?,
         page_cursor = ?,
         last_article_time = ?,
         retry_count = retry_count + ?,
         error_code = ?,
         error_message = ?,
         finished_at = ?,
         updated_at = ?
       WHERE job_id = ? AND fakeid = ?`
    ).run(
      outcome.status,
      outcome.newArticles ?? account.newArticles,
      outcome.pageCursor ?? account.pageCursor,
      outcome.lastArticleTime ?? account.lastArticleTime,
      bumpRetry,
      outcome.status === 'succeeded' ? null : (outcome.errorCode ?? null),
      outcome.status === 'succeeded' ? null : (outcome.errorMessage ?? null),
      now,
      now,
      jobId,
      fakeid.trim()
    );
    recomputeJobAggregates(db, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return getJobAccount(jobId, fakeid) as MpSyncJobAccount;
}

/** 协作式取消：只打标记，由 runner（C3）在账号间隙检查后停止。非法状态（已终态）抛错。 */
export function requestCancel(id: string): MpSyncJob {
  const db = getMpSyncDatabase();
  const job = selectJob(db, id);
  if (!job) throw new Error(`mp_sync_job not found: ${id}`);
  // 单一事实源：能否请求取消 == 该状态能否合法迁移到 cancelled（JOB_TRANSITIONS 为唯一真相）。
  // 由此 requestCancel 的受理集与 finalizeJob 的落定集永不 split-brain：
  // queued/running/partial 可取消；completed/failed/cancelled 不可（抛错）。
  if (!canTransitionJob(job.status, 'cancelled')) {
    throw new Error(`cannot cancel job in status: ${job.status}`);
  }
  db.prepare('UPDATE mp_sync_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?').run(
    nowIso(),
    id
  );
  return selectJob(db, id) as MpSyncJob;
}

/**
 * C3-4 轻量探询：该 job 是否已请求取消（读 cancel_requested_at，非空即 true）。
 * 是 runner 协作 cancel 的**默认 probe 实现**（runner 可经 RunSyncJobDeps 注入替身，仅测试用；生产恒用本函数）。
 * 不存在的 job 返回 false（防御、不抛；runner 已持有合法 jobId）。只 SELECT 单列，避免每账号读整行。
 * 注意：这是在默认 OFF 路径也会执行的 SQLite 读，**可能抛错**（DB 层异常）——顺序版靠自然向上传出、
 * 并发版靠 pump 顶 try/catch 归 fatal 收口（见 mp-sync-runner.ts runSyncJob/runSyncJobPool）。
 */
export function isCancelRequested(jobId: string): boolean {
  const db = getMpSyncDatabase();
  const row = db.prepare('SELECT cancel_requested_at FROM mp_sync_jobs WHERE id = ?').get(jobId) as
    | SqliteRow
    | undefined;
  return !!row && row.cancel_requested_at !== null;
}

/**
 * C3-4 协作式取消收口：把该 job 的 pending 账号批量落为 cancelled，返回被改的账号数。
 * runner 在停止调度新账号后调用（见 mp-sync-runner.ts runSyncJob/runSyncJobPool）。沿用
 * prepareFailedRetry/finalizeJob 的 BEGIN IMMEDIATE 事务范式。
 *
 * **两道硬门，缺一 fail-closed 全回滚、账号与聚合逐字段不变**：
 *   1. **job cancel 标记前置（P3 单一事实源）**：同一事务内 selectJob 读该 job，job 不存在或
 *      cancel_requested_at IS NULL → 抛错 → ROLLBACK → 零账号变化、聚合不变。杜绝“账号已 cancelled、
 *      job 从未请求取消”的跨聚合不一致；校验与 UPDATE 在同一 BEGIN IMMEDIATE 内，无 TOCTOU 缝隙。
 *      取消受理的唯一真相仍是 requestCancel（canTransitionJob 驱动），本函数只服从、不另立更宽的门。
 *   2. **WHERE status='pending' 源状态硬门**：只碰 pending 源（pending->cancelled 合法），**绝不**触及
 *      running / succeeded / failed / auth_required / interrupted / 既有 cancelled（已完成/在飞/待恢复/已取消
 *      账号事实不被改）。
 *
 * 聚合：cancelled 既不计 succeeded 也不计 failed，故 recomputeJobAggregates 对计数是 no-op；仍调用以保持
 * 事务一致 + 未来聚合口径变化时不失真。幂等：requestCancel 后重复调 → 第二次已无 pending → changes=0、
 * 无副作用（仍过 P3 门，cancel_requested_at 仍非空）。
 */
export function cancelPendingAccounts(jobId: string): number {
  const db = getMpSyncDatabase();
  const now = nowIso();
  let count = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    // ── P3 单一事实源硬门（fail-closed）：job 必须存在且已 requestCancel ──
    const job = selectJob(db, jobId);
    if (!job) throw new Error(`mp_sync_job not found: ${jobId}`);
    if (!job.cancelRequestedAt) {
      throw new Error(
        `cancelPendingAccounts requires prior requestCancel (cancel_requested_at is null): ${jobId}`
      );
    }
    // ── pending->cancelled 批量；WHERE status='pending' 硬门只碰 pending 源 ──
    const result = db
      .prepare(
        `UPDATE mp_sync_job_accounts
         SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE job_id = ? AND status = 'pending'`
      )
      .run(now, now, jobId);
    count = Number(result.changes ?? 0);
    recomputeJobAggregates(db, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return count;
}

/**
 * 计算并落定任务终态：
 * - 已请求取消 -> cancelled
 * - 全部成功（total>0）-> completed
 * - 无一成功且有失败 -> failed
 * - 其余（部分成功/部分失败/尚有未处理）-> partial
 * - total=0 空任务 -> completed
 */
export function finalizeJob(id: string): MpSyncJob {
  const db = getMpSyncDatabase();
  db.exec('BEGIN IMMEDIATE;');
  try {
    recomputeJobAggregates(db, id);
    const job = selectJob(db, id);
    if (!job) throw new Error(`mp_sync_job not found: ${id}`);
    let next: MpSyncJobStatus;
    if (job.cancelRequestedAt) {
      next = 'cancelled';
    } else if (job.totalAccounts === 0 || job.succeededAccounts === job.totalAccounts) {
      next = 'completed';
    } else if (job.succeededAccounts === 0 && job.failedAccounts > 0) {
      next = 'failed';
    } else {
      next = 'partial';
    }
    if (next === job.status) {
      // 幂等：重复 finalize 且结论未变 -> 只读返回，不做 X->X 迁移、不刷新 finished_at。
      // 聚合已按 job_accounts 真值幂等重算，提交无副作用。
      // 注意：partial 任务在 requestCancel 后再 finalize 时 next='cancelled'!==job.status，
      // 不会命中此早返回，仍走下方合法迁移收口（F-C2-2）。
      db.exec('COMMIT;');
      return selectJob(db, id) as MpSyncJob;
    }
    assertJobTransition(job.status, next);
    db.prepare('UPDATE mp_sync_jobs SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?').run(
      next,
      nowIso(),
      id
    );
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return selectJob(db, id) as MpSyncJob;
}

/**
 * C3-6 failed_only 重试的**原子准备原语**（替换原 exported resetFailedAccounts）：在单个 BEGIN IMMEDIATE 内
 * 「认领并准备重试」——四道权威门 + 把 job 从 partial|failed 迁 running（清 finished_at）+ 把 failed/auth_required
 * 账号重置回 pending（清 error_*、保留 retry_count 作退避依据）+ 重算聚合，缺一 fail-closed 全回滚。返回迁移后的
 * job 与被 reset 的账号数（供断言）。runner 的 retryFailedJob 在本原语提交后复用 runSyncJobPool 只重跑 pending
 * （见 mp-sync-runner.ts）。沿用 cancelPendingAccounts/finalizeJob/resetInterruptedAccounts 的 BEGIN IMMEDIATE 事务范式。
 *
 * **四道硬门（全在同一事务内、任一迁移/reset 写入之前，缺一 fail-closed 全回滚、job/账号/聚合逐字段不变）**：
 *   ① **存在门（P-RF1）**：selectJob 读该 job，不存在 → 抛 `mp_sync_job not found: <id>` → ROLLBACK → 零变化。
 *   ② **源态硬门（P-RF2，迁移前 partial|failed）**：只允许 job.status ∈ {partial, failed}；running/completed/
 *      queued/cancelled 一律抛 `job not retryable in status ...` → ROLLBACK。**门锚到迁移前源态、结构性拒绝活跃
 *      running job**（活跃重跑中的 job 非 partial|failed），不依赖“唯一调用方”约定：failed/auth_required 账号与
 *      活跃 pool 共存，仅检查 reset 时 status='running' 的更宽做法在 failed 源上不足以独立保证安全。
 *   ③ **cancel 权威门**：读 job.cancelRequestedAt（selectJob 映射后的**驼峰**对象字段，对应 SQL 列 cancel_requested_at）；
 *      非空 → 抛 `job has pending cancel request, not retryable: <id>` → ROLLBACK。与 cancelPendingAccounts P3 门同读
 *      同列、同在事务内，无 TOCTOU；cancel 严格优先于重试（不复活已请求取消的 job）。**绝不写 job.cancel_requested_at**
 *      （MpSyncJob 对象无此 snake_case 属性、恒 undefined → 门静默失效）；snake_case 只出现在 SQL 列名与错误文案。
 *   ④ **assertJobTransition 防御性再断言**：partial|failed → running 合法（JOB_TRANSITIONS 已保证，门② 通过后恒真），
 *      冗余断言防未来状态机改动悄悄放宽。
 *
 * 迁移 + reset 内联在同一事务（startJob 无自身 BEGIN IMMEDIATE、不可嵌进本事务，故此处内联等价迁移 SQL，不复用
 * startJob 函数体）：
 *   - job partial|failed → running，started_at COALESCE 保留、finished_at 清空（重跑不再是“已完成”，与 startJob 一致）。
 *   - failed/auth_required 账号 → pending，清 error_code/error_message/finished_at、**保留 retry_count**（退避依据）；
 *     WHERE 源门只碰 failed/auth_required，绝不触 pending/running/succeeded/interrupted/cancelled。
 *   - recomputeJobAggregates 从账号真值重算。
 *
 * **原子性**：① 同 job 两次 prepareFailedRetry 只一个获胜——第二个拿锁后 selectJob 见 running、门② 在任何写入前
 * fail-closed；② 任一门/SQL/聚合抛错整体回滚，绝不留“running 但未 reset”半状态；③ 提交后至少是 running + pending
 * 的完整可执行态。**幂等边界**：job 被认领跑到终态后重复调 → 门② 命中（非 partial|failed）抛错 fail-closed（是“已终态
 * 不该再认领”的正确拒绝、非 no-op；与 resetInterruptedAccounts 已终态 fail-closed 同理）。
 */
export function prepareFailedRetry(jobId: string): { job: MpSyncJob; reset: number } {
  const db = getMpSyncDatabase();
  const now = nowIso();
  let reset = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    // ── 门① 存在（P-RF1） ──
    const job = selectJob(db, jobId);
    if (!job) throw new Error(`mp_sync_job not found: ${jobId}`);
    // ── 门② 源态硬门（迁移前 partial|failed；结构性拒绝活跃 running / 已终结 / 未启动 job） ──
    if (job.status !== 'partial' && job.status !== 'failed') {
      throw new Error(`job not retryable in status '${job.status}': ${jobId}`);
    }
    // ── 门③ cancel 权威门（读驼峰对象字段 = SQL 列 cancel_requested_at；cancel 严格优先，无 TOCTOU） ──
    if (job.cancelRequestedAt != null) {
      throw new Error(`job has pending cancel request, not retryable: ${jobId}`);
    }
    // ── 门④ assertJobTransition 防御性再断言（partial|failed -> running 合法） ──
    assertJobTransition(job.status, 'running');
    // ── 迁移 job partial|failed -> running（清 finished_at，与 startJob 语义一致） ──
    db.prepare(
      'UPDATE mp_sync_jobs SET status = ?, started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?'
    ).run('running', now, jobId);
    // ── reset failed/auth_required -> pending（清 error_*/finished_at、保留 retry_count） ──
    const result = db
      .prepare(
        `UPDATE mp_sync_job_accounts
         SET status = 'pending', error_code = NULL, error_message = NULL, finished_at = NULL, updated_at = ?
         WHERE job_id = ? AND status IN ('failed', 'auth_required')`
      )
      .run(now, jobId);
    reset = Number(result.changes ?? 0);
    recomputeJobAggregates(db, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { job: selectJob(db, jobId) as MpSyncJob, reset };
}

/**
 * C3-5 重启恢复原语：把该 job 的 interrupted 账号批量归一化为 pending，供 runner 复用既有 pool 续跑，
 * 返回被改的账号数。与 prepareFailedRetry 对称（同为「把某源状态账号重置回 pending」），但只碰 interrupted
 * 源、且**只改 status + updated_at**（字段最小化，见下）。runner 的 recoverOneJob 在 reset 后复用 runSyncJobPool
 * 续跑（见 mp-sync-runner.ts）。沿用 prepareFailedRetry/cancelPendingAccounts 的 BEGIN IMMEDIATE 事务范式。
 *
 * **三道硬门 + 字段最小化，缺一 fail-closed 全回滚、账号与聚合逐字段不变**：
 *   1. **P-R1 job 存在**：同一事务内 selectJob 读该 job，不存在 → 抛错 → ROLLBACK → 零变化。
 *   2. **P-R2 job 状态门（单一事实源、不比状态机更宽）**：只允许 job.status==='running'。reconcileOrphanedJobs
 *      与 C3-4 fatal 路径都让「待恢复」job 保持 running；completed/partial/failed/cancelled 是已终结事实、
 *      queued 未启动（无 interrupted 账号），均不应恢复。校验与 UPDATE 在同一 BEGIN IMMEDIATE 内，无 TOCTOU。
 *   3. **WHERE status='interrupted' 源状态硬门**：只碰 interrupted 源（interrupted->pending 合法），**绝不**
 *      触及 pending / running / succeeded / failed / auth_required / cancelled（已完成/在飞/待重试/已取消账号
 *      事实不被改）。
 *   4. **字段最小化（只改 status + updated_at，对齐 reconcileOrphanedJobs 的降级写法）**：不清 started_at
 *      （COALESCE 保留首次开始时间）、不清 retry_count（保留崩溃前重试历史供退避判断）、不动 page_cursor
 *      （首版 startBegin=0、runner 不读它作 startBegin，保留无害）、**不动 error_code/error_message（无论 null
 *      或非 null 一律逐字段原样保留）**。error_* 保留的正确依据：不能声称「interrupted 账号本就为 null」——
 *      markAccountRunning 允许 failed/auth_required->running 且不清 error_*，故一个带非 null error_* 的账号
 *      failed->running 重试→进程崩溃→reconcileOrphanedJobs 降级 running->interrupted，此时 interrupted 账号带
 *      非 null error_* 是可达状态；reset 逐字段原样保留全部崩溃前事实（与 prepareFailedRetry 显式清 error_*
 *      与 finished_at 的「干净可重试 pending」语义不同——本函数只做崩溃降级账号的状态归一化）。
 *
 * 聚合：interrupted/pending 都不计 succeeded/failed，故 recomputeJobAggregates 对计数是 no-op；仍调用以保持
 * 事务一致 + 未来聚合口径变化不失真。幂等：job 仍 running 且已无 interrupted 时重复调 → changes=0、无副作用
 * （仍过 P-R1/P-R2 门）。注意区分：恢复跑完 finalizeJob 后 job 变 completed/partial/cancelled（非 running），
 * 此时再调会命中 P-R2 抛错——这是「已终态 job 不该恢复」的正确 fail-closed，不属幂等范畴。
 */
export function resetInterruptedAccounts(jobId: string): number {
  const db = getMpSyncDatabase();
  const now = nowIso();
  let count = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    // ── 硬门 P-R1：job 必须存在 ──
    const job = selectJob(db, jobId);
    if (!job) throw new Error(`mp_sync_job not found: ${jobId}`);
    // ── 硬门 P-R2：job 必须处于允许恢复的 'running' 状态（单一事实源，不比状态机更宽）──
    if (job.status !== 'running') {
      throw new Error(
        `resetInterruptedAccounts requires job status 'running', got '${job.status}': ${jobId}`
      );
    }
    // ── interrupted->pending 批量；WHERE status='interrupted' 源门只碰 interrupted、只改 status+updated_at ──
    const result = db
      .prepare(
        `UPDATE mp_sync_job_accounts
         SET status = 'pending', updated_at = ?
         WHERE job_id = ? AND status = 'interrupted'`
      )
      .run(now, jobId);
    count = Number(result.changes ?? 0);
    recomputeJobAggregates(db, jobId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return count;
}

/**
 * 服务重启后的持久状态语义（不执行任何抓取）：
 * 进程崩溃/重启会遗留 status='running' 的孤儿任务与账号。这里把 running 账号安全降级为 'interrupted'（可续跑），
 * running 任务保持 running 等待 runner（C3）恢复；不清数据、不并发、不发请求。
 * 返回被 reconcile 的账号数，供启动日志与后续 C3 恢复用。
 */
export function reconcileOrphanedJobs(): { jobs: number; accounts: number } {
  const db = getMpSyncDatabase();
  const now = nowIso();
  let accounts = 0;
  let jobs = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    const acc = db
      .prepare(
        `UPDATE mp_sync_job_accounts SET status = 'interrupted', updated_at = ?
         WHERE status = 'running'`
      )
      .run(now);
    accounts = Number(acc.changes ?? 0);
    jobs = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM mp_sync_jobs WHERE status = 'running'`).get() as SqliteRow).n ?? 0
    );
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return { jobs, accounts };
}

/** 删除任务及其账号行（事务化）。测试与运维清理用；不启用 FK cascade 以免影响 C1 连接的全局 PRAGMA。 */
export function deleteSyncJob(id: string): void {
  const db = getMpSyncDatabase();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM mp_sync_job_accounts WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM mp_sync_jobs WHERE id = ?').run(id);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
