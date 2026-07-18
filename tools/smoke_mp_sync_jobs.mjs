// 纯离线 smoke：C2 mp_sync_jobs / mp_sync_job_accounts 持久层（repository + 状态机 + 事务 + 幂等 + 重启语义）。
//
// 直连仓库层函数（不起 server、不发网络、不碰真实 .data）：隔离临时 SQLite（D:/tmp 或系统 tmp）。
// 覆盖：schema v2 迁移、创建/幂等键/重复账号、状态机合法与非法迁移、聚合重算、事务回滚、
//       failed_only 重置、finalize 四态、协作取消、reconcile 重启语义、跨连接持久化、单账号失败隔离。
//
// 运行（Node 25 默认；Node 22 需 22.18+ 的默认类型剥离）：
//   node --experimental-sqlite tools/smoke_mp_sync_jobs.mjs

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const tmpRoot = existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir();
const dbPath = path.join(tmpRoot, `mp-sync-jobs-smoke-${process.pid}-${Date.now()}.sqlite`);
process.env.MP_SYNC_DB_PATH = dbPath;

const registry = await import('../server/utils/mp-account-registry.ts');
const jobs = await import('../server/utils/mp-sync-job-registry.ts');

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
}
function throws(desc, fn) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(desc, threw);
}

function cleanupDb() {
  try {
    registry.closeMpAccountRegistry();
  } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {}
  }
}

try {
  // ── 1. schema v2 迁移 ────────────────────────────────────────────────
  const db = registry.getMpSyncDatabase();
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  check(`1. 迁移到 user_version=2（实得 ${version}）`, version === 2);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => String(r.name));
  check('1. mp_accounts (v1) 保留', tables.includes('mp_accounts'));
  check('1. mp_sync_jobs (v2) 存在', tables.includes('mp_sync_jobs'));
  check('1. mp_sync_job_accounts (v2) 存在', tables.includes('mp_sync_job_accounts'));

  // ── 2. 创建任务 + 账号快照 ───────────────────────────────────────────
  const job1 = jobs.createSyncJob({
    id: 'job-1',
    mode: 'incremental',
    requestedSince: 1700000000,
    accounts: [
      { fakeid: 'acc-a', priority: 5 },
      { fakeid: 'acc-b', priority: 1 },
      { fakeid: 'acc-c', priority: 9 },
    ],
  });
  check('2. 新任务 status=queued', job1.status === 'queued');
  check('2. totalAccounts=3', job1.totalAccounts === 3);
  check(
    '2. job_accounts 均 pending',
    jobs.listJobAccounts('job-1').every(a => a.status === 'pending')
  );
  check('2. 排序 priority desc 首个 acc-c', jobs.listJobAccounts('job-1')[0].fakeid === 'acc-c');

  // ── 3. 幂等键：同 key 不重复建 ────────────────────────────────────────
  const jA = jobs.createSyncJob({ idempotencyKey: 'daily-2026-07-12', accounts: [{ fakeid: 'x' }] });
  const jB = jobs.createSyncJob({ idempotencyKey: 'daily-2026-07-12', accounts: [{ fakeid: 'y' }] });
  check('3. 同幂等键返回同一任务', jA.id === jB.id);
  check('3. 幂等重建不新增账号（仍 1）', jobs.listJobAccounts(jA.id).length === 1);

  // ── 4. 同批重复 fakeid 去重 ───────────────────────────────────────────
  const jobDup = jobs.createSyncJob({
    id: 'job-dup',
    accounts: [{ fakeid: 'dup', priority: 1 }, { fakeid: 'dup', priority: 9 }, { fakeid: 'other' }],
  });
  check('4. 重复 fakeid 去重后 total=2', jobDup.totalAccounts === 2);
  check('4. job_accounts 行数=2', jobs.listJobAccounts('job-dup').length === 2);

  // ── 5. 状态机：合法 startJob；非法迁移抛错 ────────────────────────────
  const started = jobs.startJob('job-1');
  check('5. queued->running 合法', started.status === 'running' && started.startedAt !== null);
  check('5. startJob 幂等（再调仍 running）', jobs.startJob('job-1').status === 'running');
  check(
    '5. canTransitionAccount succeeded->running=false',
    jobs.canTransitionAccount('succeeded', 'running') === false
  );
  jobs.markAccountRunning('job-1', 'acc-a');
  jobs.applyAccountOutcome('job-1', 'acc-a', { status: 'succeeded', newArticles: 3, lastArticleTime: 1700500000 });
  throws('5. 已 succeeded 账号再 markRunning 抛错（非法迁移）', () => jobs.markAccountRunning('job-1', 'acc-a'));

  // ── 6. applyAccountOutcome 聚合重算 + 失败隔离 ────────────────────────
  jobs.markAccountRunning('job-1', 'acc-b');
  jobs.applyAccountOutcome('job-1', 'acc-b', {
    status: 'failed',
    errorCode: 'timeout',
    errorMessage: '请求超时',
  });
  const j1a = jobs.getSyncJob('job-1');
  check('6. succeeded=1', j1a.succeededAccounts === 1);
  check('6. failed=1（含错误账号）', j1a.failedAccounts === 1);
  check('6. processed=2', j1a.processedAccounts === 2);
  check('6. new_articles 累计=3', j1a.newArticles === 3);
  const accB = jobs.getJobAccount('job-1', 'acc-b');
  check('6. 失败账号 retry_count 累加=1', accB.retryCount === 1);
  check('6. 失败账号错误落库', accB.errorCode === 'timeout' && accB.errorMessage === '请求超时');
  const accC = jobs.getJobAccount('job-1', 'acc-c');
  check('6. 失败隔离：acc-c 仍 pending 未受影响', accC.status === 'pending' && accC.errorCode === null);

  // ── 7. 事务回滚：重复主键 id 创建失败不留半条 ─────────────────────────
  const beforeAcc = jobs.listJobAccounts('job-dup').length;
  throws('7. 重复 id 创建抛错', () => jobs.createSyncJob({ id: 'job-dup', accounts: [{ fakeid: 'zzz' }] }));
  check('7. 回滚后 job-dup 账号数不变（无半条写入）', jobs.listJobAccounts('job-dup').length === beforeAcc);
  check('7. 回滚后 zzz 未落库', jobs.getJobAccount('job-dup', 'zzz') === null);

  // ── 8. failed_only 重置：failed/auth_required -> pending，retry_count 保留 ─
  jobs.markAccountRunning('job-1', 'acc-c');
  jobs.applyAccountOutcome('job-1', 'acc-c', { status: 'auth_required', errorCode: 'auth' });
  const resetN = jobs.resetFailedAccounts('job-1');
  check('8. 重置账号数=2（failed + auth_required）', resetN === 2);
  const accBReset = jobs.getJobAccount('job-1', 'acc-b');
  check('8. acc-b 回到 pending', accBReset.status === 'pending');
  check('8. retry_count 保留=1（供退避）', accBReset.retryCount === 1);
  check('8. 错误已清空', accBReset.errorCode === null);
  check('8. 重置后 failed 聚合归零', jobs.getSyncJob('job-1').failedAccounts === 0);

  // ── 9. finalizeJob 四态 ───────────────────────────────────────────────
  // 9a. 全成功 -> completed
  const jc = jobs.createSyncJob({ id: 'job-complete', accounts: [{ fakeid: 'p' }, { fakeid: 'q' }] });
  jobs.startJob('job-complete');
  for (const f of ['p', 'q']) {
    jobs.markAccountRunning('job-complete', f);
    jobs.applyAccountOutcome('job-complete', f, { status: 'succeeded', newArticles: 1 });
  }
  check('9a. 全成功 -> completed', jobs.finalizeJob('job-complete').status === 'completed');
  // 9b. 混合 -> partial
  const jp = jobs.createSyncJob({ id: 'job-partial', accounts: [{ fakeid: 'p' }, { fakeid: 'q' }] });
  jobs.startJob('job-partial');
  jobs.markAccountRunning('job-partial', 'p');
  jobs.applyAccountOutcome('job-partial', 'p', { status: 'succeeded' });
  jobs.markAccountRunning('job-partial', 'q');
  jobs.applyAccountOutcome('job-partial', 'q', { status: 'failed', errorCode: 'x' });
  check('9b. 部分成功 -> partial', jobs.finalizeJob('job-partial').status === 'partial');
  // 9c. 全失败 -> failed
  const jf = jobs.createSyncJob({ id: 'job-failed', accounts: [{ fakeid: 'p' }] });
  jobs.startJob('job-failed');
  jobs.markAccountRunning('job-failed', 'p');
  jobs.applyAccountOutcome('job-failed', 'p', { status: 'failed', errorCode: 'x' });
  check('9c. 全失败 -> failed', jobs.finalizeJob('job-failed').status === 'failed');
  // 9d. 空任务 -> completed
  const je = jobs.createSyncJob({ id: 'job-empty', accounts: [] });
  jobs.startJob('job-empty');
  check('9d. 空任务 -> completed', jobs.finalizeJob('job-empty').status === 'completed');

  // ── 10. 协作取消 ─────────────────────────────────────────────────────
  const jx = jobs.createSyncJob({ id: 'job-cancel', accounts: [{ fakeid: 'p' }, { fakeid: 'q' }] });
  jobs.startJob('job-cancel');
  const cancelReq = jobs.requestCancel('job-cancel');
  check('10. cancel 打标记 cancel_requested_at', cancelReq.cancelRequestedAt !== null);
  check('10. 请求取消后 finalize -> cancelled', jobs.finalizeJob('job-cancel').status === 'cancelled');
  throws('10. 终态任务再取消抛错', () => jobs.requestCancel('job-cancel'));

  // ── 11. reconcile 重启语义：running 账号 -> interrupted，不执行抓取 ────
  const jr = jobs.createSyncJob({ id: 'job-restart', accounts: [{ fakeid: 'p' }, { fakeid: 'q' }] });
  jobs.startJob('job-restart');
  jobs.markAccountRunning('job-restart', 'p'); // 模拟崩溃时正在跑
  const rec = jobs.reconcileOrphanedJobs();
  check('11. reconcile 统计 jobs>=1', rec.jobs >= 1);
  check('11. reconcile 统计 accounts>=1', rec.accounts >= 1);
  check('11. running 账号 -> interrupted', jobs.getJobAccount('job-restart', 'p').status === 'interrupted');
  check('11. running 任务保持 running（待 C3 恢复）', jobs.getSyncJob('job-restart').status === 'running');
  check('11. interrupted 可迁回 running（可续跑）', jobs.canTransitionAccount('interrupted', 'running') === true);

  const totalJobsBeforeReopen = jobs.listSyncJobs({ limit: 500 }).length;

  // ── 12. 跨连接持久化：close 后重开仍在 ────────────────────────────────
  registry.closeMpAccountRegistry();
  const reopened = jobs.getSyncJob('job-restart');
  check('12. 重开后任务仍在（落盘持久化）', reopened !== null && reopened.id === 'job-restart');
  check('12. 重开后 interrupted 账号仍在', jobs.getJobAccount('job-restart', 'p').status === 'interrupted');
  check('12. 重开后任务总数一致', jobs.listSyncJobs({ limit: 500 }).length === totalJobsBeforeReopen);
  // interrupted -> running 续跑合法
  const resumed = jobs.markAccountRunning('job-restart', 'p');
  check('12. interrupted 续跑到 running', resumed.status === 'running');

  // ── 13. failed_only 重试：re-finalize 刷新 finished_at（startJob 清旧终态时间戳）──
  const jrt = jobs.createSyncJob({ id: 'job-retry-ts', accounts: [{ fakeid: 'p' }, { fakeid: 'q' }] });
  jobs.startJob('job-retry-ts');
  jobs.markAccountRunning('job-retry-ts', 'p');
  jobs.applyAccountOutcome('job-retry-ts', 'p', { status: 'succeeded' });
  jobs.markAccountRunning('job-retry-ts', 'q');
  jobs.applyAccountOutcome('job-retry-ts', 'q', { status: 'failed', errorCode: 'x' });
  const firstFinal = jobs.finalizeJob('job-retry-ts');
  check(
    '13. 首次 finalize -> partial 且有 finished_at',
    firstFinal.status === 'partial' && firstFinal.finishedAt !== null
  );
  jobs.resetFailedAccounts('job-retry-ts');
  const rerun = jobs.startJob('job-retry-ts'); // partial -> running，清 finished_at
  check('13. 重跑 startJob 清空 finished_at（不再是已完成）', rerun.finishedAt === null);
  jobs.markAccountRunning('job-retry-ts', 'q');
  jobs.applyAccountOutcome('job-retry-ts', 'q', { status: 'succeeded' });
  const reFinal = jobs.finalizeJob('job-retry-ts');
  check('13. 重试后 re-finalize -> completed', reFinal.status === 'completed');
  // 核心 fix-must-fail 在上一句「rerun.finishedAt === null」：无 startJob 清空则此处仍是首次陈旧值。
  // 经 NULL 后 COALESCE(NULL, now) 必写新鲜值，故只断言非 null（不比较字符串，避免同毫秒 flaky）。
  check('13. re-finalize 写入新鲜 finished_at（经 NULL 后重置）', reFinal.finishedAt !== null);

  // ── 14. F-C2-1: 终态 succeeded 账号 outcome 重放不得改写已完成事实 ──────────
  //  旧实现 canTransitionAccount 的全局 from===to 让 succeeded->succeeded 静默通过，
  //  UPDATE 会把记录改写为新 payload 并刷新 finished_at。返修后：不同 payload 拒绝、同 payload 只读幂等。
  const jrep = jobs.createSyncJob({ id: 'job-replay', accounts: [{ fakeid: 'r' }] });
  jobs.startJob('job-replay');
  jobs.markAccountRunning('job-replay', 'r');
  jobs.applyAccountOutcome('job-replay', 'r', {
    status: 'succeeded',
    newArticles: 1,
    pageCursor: 20,
    lastArticleTime: 100,
  });
  const rBefore = jobs.getJobAccount('job-replay', 'r');
  throws('14a. 终态 succeeded 不同 payload 重放被拒（fix-must-fail：旧实现会改写为 99/999/999）', () =>
    jobs.applyAccountOutcome('job-replay', 'r', {
      status: 'succeeded',
      newArticles: 99,
      pageCursor: 999,
      lastArticleTime: 999,
    })
  );
  const rAfter = jobs.getJobAccount('job-replay', 'r');
  check(
    '14a. 被拒后记录未被改写（仍 1/20/100）',
    rAfter.newArticles === 1 && rAfter.pageCursor === 20 && rAfter.lastArticleTime === 100
  );
  check('14a. 被拒后 finished_at 未刷新', rAfter.finishedAt === rBefore.finishedAt);
  const rIdem = jobs.applyAccountOutcome('job-replay', 'r', {
    status: 'succeeded',
    newArticles: 1,
    pageCursor: 20,
    lastArticleTime: 100,
  });
  check(
    '14b. 完全相同 payload 重放 -> 只读幂等（值不变、retry 不动）',
    rIdem.newArticles === 1 && rIdem.pageCursor === 20 && rIdem.lastArticleTime === 100 && rIdem.retryCount === 0
  );
  throws('14c. 终态 succeeded 想翻成 failed 被拒', () =>
    jobs.applyAccountOutcome('job-replay', 'r', { status: 'failed', errorCode: 'x' })
  );

  // ── 15. F-C2-1: failed 终态同 payload 重放不再累加 retry_count ─────────────
  //  旧实现每次重放都 retry_count += 1，导致退避次数漂移。返修后同 payload 只读幂等、不同 payload 拒绝。
  const jret = jobs.createSyncJob({ id: 'job-retrydrift', accounts: [{ fakeid: 's' }] });
  jobs.startJob('job-retrydrift');
  jobs.markAccountRunning('job-retrydrift', 's');
  jobs.applyAccountOutcome('job-retrydrift', 's', {
    status: 'failed',
    errorCode: 'timeout',
    errorMessage: 'boom',
  });
  check('15. 首次 failed -> retry_count=1', jobs.getJobAccount('job-retrydrift', 's').retryCount === 1);
  const sIdem = jobs.applyAccountOutcome('job-retrydrift', 's', {
    status: 'failed',
    errorCode: 'timeout',
    errorMessage: 'boom',
  });
  check('15. 同 payload failed 重放 retry_count 不漂移（fix-must-fail：旧实现变 2）', sIdem.retryCount === 1);
  throws('15. 不同 payload failed 重放被拒', () =>
    jobs.applyAccountOutcome('job-retrydrift', 's', { status: 'failed', errorCode: 'other' })
  );
  check('15. 被拒后 retry_count 仍为 1', jobs.getJobAccount('job-retrydrift', 's').retryCount === 1);

  // ── 16. F-C2-2: partial 任务请求取消后可落定为 cancelled ────────────────────
  //  旧实现 partial 只能迁到 running，requestCancel 却接受 partial 并写标记，
  //  随后 finalize 的 partial->cancelled 必抛错，形成“取消已落盘但无法收口”的死结。
  const jpc = jobs.createSyncJob({ id: 'job-partial-cancel', accounts: [{ fakeid: 'a' }, { fakeid: 'b' }] });
  jobs.startJob('job-partial-cancel');
  jobs.markAccountRunning('job-partial-cancel', 'a');
  jobs.applyAccountOutcome('job-partial-cancel', 'a', { status: 'succeeded', newArticles: 1 });
  // b 保持 pending：1 成功 + 1 未处理
  const pcFirst = jobs.finalizeJob('job-partial-cancel');
  check('16. 1 成功 + 1 pending -> partial', pcFirst.status === 'partial');
  const pcCancel = jobs.requestCancel('job-partial-cancel');
  check('16. partial 可请求取消并写标记', pcCancel.cancelRequestedAt !== null);
  const pcFinal = jobs.finalizeJob('job-partial-cancel');
  check('16. partial + 取消标记 -> cancelled（fix-must-fail：旧实现此处抛错卡死）', pcFinal.status === 'cancelled');
  check(
    '16. 收口后取消标记与终态一致',
    pcFinal.status === 'cancelled' && pcFinal.cancelRequestedAt !== null
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C3-4 协作式取消持久层（方案 §3.1 E 段）：cancelPendingAccounts + isCancelRequested
  //   17 混合态深等值 15 列快照 + interrupted 不被 clobber + 聚合不变
  //   18 幂等二次调用（含“既有 cancelled 不被 clobber”：finished_at 不刷新、15 列不变）
  //   19 E(P3) 绕过探针：未 requestCancel / job 不存在 → 抛错 + 事务回滚零副作用；requestCancel 后成功
  //   20 isCancelRequested：未 req→false / req 后→true / 不存在 job→false
  // 说明：cancelPendingAccounts 语义为“一次性把所有 pending 落 cancelled”，无法在单次调用构造“部分 pending
  //       残留 + pre-existing cancelled”共存于同一快照；故“既有 cancelled 不被 clobber”由 18 的幂等二次调用
  //       路径覆盖（第一次全 pending→cancelled，第二次 count=0 且 cancelled 账号 15 列逐字段不变）。
  // MpSyncJobAccount 15 持久列（深等值全枚举）：jobId/fakeid/status/priority/pageCursor/sinceTime/
  //   lastArticleTime/retryCount/newArticles/errorCode/errorMessage/createdAt/updatedAt/startedAt/finishedAt。
  const snap15 = (jobId, fakeid) => JSON.stringify(jobs.getJobAccount(jobId, fakeid));

  // ── 17. 混合态：只 pending→cancelled，其余账号 15 列逐字段不变；interrupted 不被 clobber；聚合不变 ──
  {
    jobs.createSyncJob({
      id: 'job-c34-mix',
      accounts: [
        { fakeid: 'm-p1' }, { fakeid: 'm-p2' }, { fakeid: 'm-run' }, { fakeid: 'm-succ' },
        { fakeid: 'm-fail' }, { fakeid: 'm-auth' }, { fakeid: 'm-intr' },
      ],
    });
    jobs.startJob('job-c34-mix');
    jobs.markAccountRunning('job-c34-mix', 'm-succ');
    jobs.applyAccountOutcome('job-c34-mix', 'm-succ', { status: 'succeeded', newArticles: 2, pageCursor: 20, lastArticleTime: 111 });
    jobs.markAccountRunning('job-c34-mix', 'm-fail');
    jobs.applyAccountOutcome('job-c34-mix', 'm-fail', { status: 'failed', errorCode: 'timeout', errorMessage: 'boom' });
    jobs.markAccountRunning('job-c34-mix', 'm-auth');
    jobs.applyAccountOutcome('job-c34-mix', 'm-auth', { status: 'auth_required', errorCode: 'auth' });
    // interrupted：先 running 再 reconcile（reconcile 是全局 running→interrupted；此刻 m-run 尚未 running、不受影响；
    // 历史遗留的其它 running 账号被一并 reconcile，无后续断言依赖，无害）。
    jobs.markAccountRunning('job-c34-mix', 'm-intr');
    jobs.reconcileOrphanedJobs();
    jobs.markAccountRunning('job-c34-mix', 'm-run'); // reconcile 之后再置 running → 保持 running

    check('17. 前置态就绪（run=running/succ=succeeded/fail=failed/auth=auth_required/intr=interrupted）',
      jobs.getJobAccount('job-c34-mix', 'm-run').status === 'running' &&
      jobs.getJobAccount('job-c34-mix', 'm-succ').status === 'succeeded' &&
      jobs.getJobAccount('job-c34-mix', 'm-fail').status === 'failed' &&
      jobs.getJobAccount('job-c34-mix', 'm-auth').status === 'auth_required' &&
      jobs.getJobAccount('job-c34-mix', 'm-intr').status === 'interrupted');

    // 非 pending 账号 15 列快照（before）
    const beforeRun = snap15('job-c34-mix', 'm-run');
    const beforeSucc = snap15('job-c34-mix', 'm-succ');
    const beforeFail = snap15('job-c34-mix', 'm-fail');
    const beforeAuth = snap15('job-c34-mix', 'm-auth');
    const beforeIntr = snap15('job-c34-mix', 'm-intr');
    const jobBefore = jobs.getSyncJob('job-c34-mix');

    jobs.requestCancel('job-c34-mix');
    const count = jobs.cancelPendingAccounts('job-c34-mix');

    check('17. cancelPendingAccounts 返回被改 pending 数=2', count === 2);
    check('17. 两 pending 账号 → cancelled',
      jobs.getJobAccount('job-c34-mix', 'm-p1').status === 'cancelled' &&
      jobs.getJobAccount('job-c34-mix', 'm-p2').status === 'cancelled');
    check('17. running 账号 15 列逐字段不变（深等值）', snap15('job-c34-mix', 'm-run') === beforeRun);
    check('17. succeeded 账号 15 列逐字段不变（深等值）', snap15('job-c34-mix', 'm-succ') === beforeSucc);
    check('17. failed 账号 15 列逐字段不变（深等值）', snap15('job-c34-mix', 'm-fail') === beforeFail);
    check('17. auth_required 账号 15 列逐字段不变（深等值）', snap15('job-c34-mix', 'm-auth') === beforeAuth);
    check('17. interrupted 账号 15 列逐字段不变（深等值，不被 clobber；ACCOUNT_TRANSITIONS 无 interrupted→cancelled）', snap15('job-c34-mix', 'm-intr') === beforeIntr);
    const jobAfter = jobs.getSyncJob('job-c34-mix');
    check('17. 聚合不变：cancelled 不计 succeeded/failed/processed',
      jobAfter.succeededAccounts === jobBefore.succeededAccounts &&
      jobAfter.failedAccounts === jobBefore.failedAccounts &&
      jobAfter.processedAccounts === jobBefore.processedAccounts);
    check('17. finalize → cancelled（cancelRequestedAt 驱动）', jobs.finalizeJob('job-c34-mix').status === 'cancelled');
  }

  // ── 18. idempotent + preserves existing cancelled rows（既有 cancelled 不被 clobber）──
  // 说明：公开状态机不存在“部分 pending 与 pre-existing cancelled 共存于单快照”的可达路径（唯一写 cancelled
  //       的入口就是 cancelPendingAccounts，且一次性把所有 pending 落 cancelled），故用**二次调用**验证同一
  //       “不覆盖既有 cancelled”属性；两次调用之间插入**真实时间间隔（>1ms）**使 nowIso() 明显前进——若错误实现
  //       刷新 finished_at，会写入更晚的新时间戳被本断言逮到（避免同毫秒的 vacuous pass）。本持久层 smoke 直连
  //       真实 SQLite，但此处**不直接篡改内部 DB 行**。
  {
    jobs.createSyncJob({ id: 'job-c34-idem', accounts: [{ fakeid: 'i-a' }, { fakeid: 'i-b' }] });
    jobs.startJob('job-c34-idem');
    jobs.requestCancel('job-c34-idem');
    const first = jobs.cancelPendingAccounts('job-c34-idem');
    check('18. idempotent: 首次 cancel 两 pending → cancelled、count=2', first === 2 &&
      jobs.getJobAccount('job-c34-idem', 'i-a').status === 'cancelled' &&
      jobs.getJobAccount('job-c34-idem', 'i-b').status === 'cancelled');
    const snapA = snap15('job-c34-idem', 'i-a');
    const snapB = snap15('job-c34-idem', 'i-b');
    // 明显不同的时间：真实等待使 nowIso() 前进（防同毫秒使 finished_at 断言 vacuous）。
    await new Promise((r) => setTimeout(r, 25));
    const second = jobs.cancelPendingAccounts('job-c34-idem'); // 此刻已无 pending
    check('18. idempotent: 二次调用 count=0（仍过 P3 门，因 cancel_requested_at 仍非空）', second === 0);
    check('18. preserves existing cancelled rows: 既有 cancelled 15 列逐字段不变（尤其 finished_at 未在更晚时刻被刷新）',
      snap15('job-c34-idem', 'i-a') === snapA && snap15('job-c34-idem', 'i-b') === snapB);
  }

  // ── 19. E(P3) 绕过探针（F-C3-4-P3 核心保护）──
  {
    jobs.createSyncJob({ id: 'job-c34-p3', accounts: [{ fakeid: 'g-a' }, { fakeid: 'g-b' }] });
    jobs.startJob('job-c34-p3');
    jobs.markAccountRunning('job-c34-p3', 'g-b');
    jobs.applyAccountOutcome('job-c34-p3', 'g-b', { status: 'succeeded', newArticles: 1 });
    // (a) 未 requestCancel 直调 → 抛错 + 事务回滚（账号 + 聚合逐字段不变）
    const beforeA = snap15('job-c34-p3', 'g-a');
    const beforeB = snap15('job-c34-p3', 'g-b');
    const jobBefore = jobs.getSyncJob('job-c34-p3');
    throws('19a. 未 requestCancel 直调 cancelPendingAccounts 必抛错（P3 前置 fail-closed）', () => jobs.cancelPendingAccounts('job-c34-p3'));
    check('19a. 回滚后账号 15 列逐字段不变（g-a pending / g-b succeeded 均不动）',
      snap15('job-c34-p3', 'g-a') === beforeA && snap15('job-c34-p3', 'g-b') === beforeB);
    const jobAfter = jobs.getSyncJob('job-c34-p3');
    check('19a. 回滚后聚合逐字段不变',
      jobAfter.succeededAccounts === jobBefore.succeededAccounts &&
      jobAfter.failedAccounts === jobBefore.failedAccounts &&
      jobAfter.processedAccounts === jobBefore.processedAccounts);
    // (b) job 不存在 → 抛错、零副作用
    throws('19b. job 不存在直调 cancelPendingAccounts 抛错', () => jobs.cancelPendingAccounts('job-does-not-exist'));
    // (c) requestCancel 后再调 → 成功，仅 pending 批量变 cancelled（g-a），g-b succeeded 不动
    jobs.requestCancel('job-c34-p3');
    const okCount = jobs.cancelPendingAccounts('job-c34-p3');
    check('19c. requestCancel 后调用成功、仅 pending g-a → cancelled（count=1）', okCount === 1 && jobs.getJobAccount('job-c34-p3', 'g-a').status === 'cancelled');
    check('19c. g-b succeeded 仍不被 clobber', jobs.getJobAccount('job-c34-p3', 'g-b').status === 'succeeded');
  }

  // ── 20. isCancelRequested：未 req→false / req 后→true / 不存在 job→false ──
  {
    jobs.createSyncJob({ id: 'job-c34-probe', accounts: [{ fakeid: 'pr-a' }] });
    jobs.startJob('job-c34-probe');
    check('20. 未 requestCancel → isCancelRequested=false', jobs.isCancelRequested('job-c34-probe') === false);
    jobs.requestCancel('job-c34-probe');
    check('20. requestCancel 后 → isCancelRequested=true', jobs.isCancelRequested('job-c34-probe') === true);
    check('20. 不存在的 job → isCancelRequested=false（防御不抛）', jobs.isCancelRequested('job-nope') === false);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C3-5 重启恢复原语 resetInterruptedAccounts（方案 §3.1 H 段）
  //   H1 基础 / H2 混合态只碰 interrupted（15 列深等值，含 cancelled 不被 clobber）/
  //   H3 字段最小化含非 null error_* 逐字段保留（N-C3-5-P1）/ H4 P-R1·P-R2 fail-closed（含终态 job 回滚）/
  //   H5 幂等 / H6 事务原子性（注入 UPDATE 后错误 → 全回滚）。
  // 构造 interrupted 的可达路径：markAccountRunning 后 reconcileOrphanedJobs（全局 running→interrupted、
  //   job 仍 running）。reconcile 全局性：只影响本 fixture 内当刻 running 的账号，历史 job 的账号被一并降级
  //   不影响任何后续断言（各 H fixture 只断言自身账号）。

  // ── H1 基础：running job 含 N interrupted → reset 返回 N、全 → pending、job 仍 running ──
  {
    jobs.createSyncJob({ id: 'job-h1', accounts: [{ fakeid: 'h1-a' }, { fakeid: 'h1-b' }, { fakeid: 'h1-c' }] });
    jobs.startJob('job-h1');
    for (const f of ['h1-a', 'h1-b', 'h1-c']) jobs.markAccountRunning('job-h1', f);
    jobs.reconcileOrphanedJobs(); // h1-a/b/c running → interrupted，job-h1 仍 running
    check('H1. 前置：3 账号 interrupted、job 仍 running',
      ['h1-a', 'h1-b', 'h1-c'].every((f) => jobs.getJobAccount('job-h1', f).status === 'interrupted') &&
      jobs.getSyncJob('job-h1').status === 'running');
    const h1n = jobs.resetInterruptedAccounts('job-h1');
    check('H1. reset 返回 count=3', h1n === 3);
    check('H1. 全部 interrupted → pending',
      ['h1-a', 'h1-b', 'h1-c'].every((f) => jobs.getJobAccount('job-h1', f).status === 'pending'));
    check('H1. job.status 仍 running（不改 job 态）', jobs.getSyncJob('job-h1').status === 'running');
  }

  // ── H2 混合态：只 interrupted → pending，其余账号 15 列逐字段不变；聚合不变 ──
  {
    jobs.createSyncJob({
      id: 'job-h2',
      accounts: [
        { fakeid: 'h2-int' }, { fakeid: 'h2-pend' }, { fakeid: 'h2-run' },
        { fakeid: 'h2-succ' }, { fakeid: 'h2-fail' }, { fakeid: 'h2-auth' },
      ],
    });
    jobs.startJob('job-h2');
    jobs.markAccountRunning('job-h2', 'h2-int');
    jobs.reconcileOrphanedJobs(); // h2-int running → interrupted（其余仍 pending，不受影响）
    // reconcile 之后再布置其它态（否则会被 reconcile 一并降级）：
    jobs.markAccountRunning('job-h2', 'h2-succ');
    jobs.applyAccountOutcome('job-h2', 'h2-succ', { status: 'succeeded', newArticles: 2, pageCursor: 20, lastArticleTime: 111 });
    jobs.markAccountRunning('job-h2', 'h2-fail');
    jobs.applyAccountOutcome('job-h2', 'h2-fail', { status: 'failed', errorCode: 'timeout', errorMessage: 'boom' });
    jobs.markAccountRunning('job-h2', 'h2-auth');
    jobs.applyAccountOutcome('job-h2', 'h2-auth', { status: 'auth_required', errorCode: 'auth' });
    jobs.markAccountRunning('job-h2', 'h2-run'); // 保持 running（H2 内无后续 reconcile）
    check('H2. 前置态就绪（int/pend/run/succ/fail/auth）',
      jobs.getJobAccount('job-h2', 'h2-int').status === 'interrupted' &&
      jobs.getJobAccount('job-h2', 'h2-pend').status === 'pending' &&
      jobs.getJobAccount('job-h2', 'h2-run').status === 'running' &&
      jobs.getJobAccount('job-h2', 'h2-succ').status === 'succeeded' &&
      jobs.getJobAccount('job-h2', 'h2-fail').status === 'failed' &&
      jobs.getJobAccount('job-h2', 'h2-auth').status === 'auth_required');
    const bPend = snap15('job-h2', 'h2-pend');
    const bRun = snap15('job-h2', 'h2-run');
    const bSucc = snap15('job-h2', 'h2-succ');
    const bFail = snap15('job-h2', 'h2-fail');
    const bAuth = snap15('job-h2', 'h2-auth');
    const jobBefore = jobs.getSyncJob('job-h2');
    const h2n = jobs.resetInterruptedAccounts('job-h2');
    check('H2. reset 只改 interrupted、count=1', h2n === 1);
    check('H2. interrupted → pending', jobs.getJobAccount('job-h2', 'h2-int').status === 'pending');
    check('H2. pending 账号 15 列逐字段不变（深等值）', snap15('job-h2', 'h2-pend') === bPend);
    check('H2. running 账号 15 列逐字段不变（深等值）', snap15('job-h2', 'h2-run') === bRun);
    check('H2. succeeded 账号 15 列逐字段不变（深等值）', snap15('job-h2', 'h2-succ') === bSucc);
    check('H2. failed 账号 15 列逐字段不变（深等值）', snap15('job-h2', 'h2-fail') === bFail);
    check('H2. auth_required 账号 15 列逐字段不变（深等值）', snap15('job-h2', 'h2-auth') === bAuth);
    const jobAfter = jobs.getSyncJob('job-h2');
    check('H2. 聚合不变（interrupted/pending 均不计 succeeded/failed/processed）',
      jobAfter.succeededAccounts === jobBefore.succeededAccounts &&
      jobAfter.failedAccounts === jobBefore.failedAccounts &&
      jobAfter.processedAccounts === jobBefore.processedAccounts);
  }

  // ── H2b cancelled 不被 clobber：job 含 interrupted + cancelled（可达构造）→ reset 只碰 interrupted ──
  // （公开状态机下 cancelled 只能由 cancelPendingAccounts 从 pending 产生；此处让 interrupted 与 cancelled 共存、
  //   无残留 pending，验证 reset 的 WHERE 源门绝不触及 cancelled。）
  {
    jobs.createSyncJob({ id: 'job-h2b', accounts: [{ fakeid: 'b-int' }, { fakeid: 'b-c1' }, { fakeid: 'b-c2' }] });
    jobs.startJob('job-h2b');
    jobs.markAccountRunning('job-h2b', 'b-int');
    jobs.reconcileOrphanedJobs(); // b-int → interrupted（b-c1/c2 仍 pending）
    jobs.requestCancel('job-h2b');
    const cN = jobs.cancelPendingAccounts('job-h2b'); // b-c1/c2 pending → cancelled（b-int interrupted 不被碰）
    check('H2b. 前置：cancelPendingAccounts 只落 2 pending → cancelled，b-int 仍 interrupted',
      cN === 2 && jobs.getJobAccount('job-h2b', 'b-int').status === 'interrupted' &&
      jobs.getJobAccount('job-h2b', 'b-c1').status === 'cancelled' &&
      jobs.getJobAccount('job-h2b', 'b-c2').status === 'cancelled');
    const bC1 = snap15('job-h2b', 'b-c1');
    const bC2 = snap15('job-h2b', 'b-c2');
    const h2bn = jobs.resetInterruptedAccounts('job-h2b'); // job 仍 running（未 finalize）→ P-R2 过
    check('H2b. reset 只改 interrupted、count=1', h2bn === 1);
    check('H2b. interrupted → pending', jobs.getJobAccount('job-h2b', 'b-int').status === 'pending');
    check('H2b. cancelled 账号 15 列逐字段不变（不被 clobber）',
      snap15('job-h2b', 'b-c1') === bC1 && snap15('job-h2b', 'b-c2') === bC2);
  }

  // ── H3 字段最小化（含非 null error_* 逐字段保留，N-C3-5-P1）──
  // 可达路径：failed（带 error_*/page_cursor/retry_count/started_at）→ markAccountRunning（failed→running
  //   不清 error_*）→ reconcile 降级 interrupted → 得到「带非 null error_* 的 interrupted 账号」。
  {
    jobs.createSyncJob({ id: 'job-h3', accounts: [{ fakeid: 'h3-a' }] });
    jobs.startJob('job-h3');
    jobs.markAccountRunning('job-h3', 'h3-a');
    jobs.applyAccountOutcome('job-h3', 'h3-a', {
      status: 'failed', newArticles: 5, pageCursor: 42, lastArticleTime: 999, errorCode: 'timeout', errorMessage: 'boom',
    });
    jobs.markAccountRunning('job-h3', 'h3-a'); // failed → running（不清 error_*/page_cursor/retry_count）
    jobs.reconcileOrphanedJobs(); // running → interrupted
    const before = jobs.getJobAccount('job-h3', 'h3-a');
    check('H3. 前置：interrupted 账号带非 null error_* / page_cursor=42 / retry_count=1 / started_at 非空',
      before.status === 'interrupted' && before.errorCode === 'timeout' && before.errorMessage === 'boom' &&
      before.pageCursor === 42 && before.retryCount === 1 && before.startedAt !== null);
    const h3n = jobs.resetInterruptedAccounts('job-h3');
    const after = jobs.getJobAccount('job-h3', 'h3-a');
    check('H3. reset count=1、interrupted → pending', h3n === 1 && after.status === 'pending');
    check('H3. error_code 非 null 逐字段原样保留（未被清）', after.errorCode === 'timeout');
    check('H3. error_message 非 null 逐字段原样保留（未被清）', after.errorMessage === 'boom');
    check('H3. started_at 保留（COALESCE，不刷新）', after.startedAt === before.startedAt);
    check('H3. retry_count 保留=1（不清）', after.retryCount === 1);
    check('H3. page_cursor 保留=42（不动）', after.pageCursor === 42);
    check('H3. newArticles / lastArticleTime / finished_at 保留',
      after.newArticles === before.newArticles && after.lastArticleTime === before.lastArticleTime &&
      after.finishedAt === before.finishedAt);
    check('H3. 仅 status 与 updated_at 变（updated_at 前进或相等）', after.updatedAt >= before.updatedAt);
  }

  // ── H4 P-R1/P-R2 fail-closed（含终态 job 回滚零副作用）──
  {
    // (a) job 不存在 → 抛 P-R1 not found（强化断言：区分干净 not found vs 移除 P-R1 后的下游 null deref，供 fix-must-fail (c)）
    let h4aErr;
    try { jobs.resetInterruptedAccounts('job-h4-nope'); } catch (e) { h4aErr = e; }
    check('H4a. 不存在 job → 抛 P-R1 not found（非下游 null deref）', h4aErr instanceof Error && /not found/.test(h4aErr.message));

    // (b) queued（未 startJob）→ 抛错、pending 账号不变
    jobs.createSyncJob({ id: 'job-h4-q', accounts: [{ fakeid: 'q-a' }] });
    const qBefore = snap15('job-h4-q', 'q-a');
    throws('H4b-queued. queued job → 抛错（P-R2）', () => jobs.resetInterruptedAccounts('job-h4-q'));
    check('H4b-queued. 回滚后 pending 账号 15 列不变', snap15('job-h4-q', 'q-a') === qBefore);

    // (b) partial（含 interrupted 账号）→ 抛错、interrupted 账号 + 聚合逐字段不变（强回滚断言）
    jobs.createSyncJob({ id: 'job-h4-p', accounts: [{ fakeid: 'p-int' }, { fakeid: 'p-succ' }] });
    jobs.startJob('job-h4-p');
    jobs.markAccountRunning('job-h4-p', 'p-int');
    jobs.reconcileOrphanedJobs(); // p-int → interrupted
    jobs.markAccountRunning('job-h4-p', 'p-succ');
    jobs.applyAccountOutcome('job-h4-p', 'p-succ', { status: 'succeeded', newArticles: 1 });
    check('H4b-partial. 前置 → partial（1 succeeded + 1 interrupted）', jobs.finalizeJob('job-h4-p').status === 'partial');
    const pIntBefore = snap15('job-h4-p', 'p-int');
    const pJobBefore = jobs.getSyncJob('job-h4-p');
    throws('H4b-partial. partial job → 抛错（P-R2）', () => jobs.resetInterruptedAccounts('job-h4-p'));
    check('H4b-partial. 回滚后 interrupted 账号 15 列不变（未被 reset 成 pending）', snap15('job-h4-p', 'p-int') === pIntBefore);
    const pJobAfter = jobs.getSyncJob('job-h4-p');
    check('H4b-partial. 回滚后 job 聚合逐字段不变',
      pJobAfter.succeededAccounts === pJobBefore.succeededAccounts &&
      pJobAfter.failedAccounts === pJobBefore.failedAccounts &&
      pJobAfter.processedAccounts === pJobBefore.processedAccounts);

    // (b) failed → 抛错
    jobs.createSyncJob({ id: 'job-h4-f', accounts: [{ fakeid: 'f-a' }] });
    jobs.startJob('job-h4-f');
    jobs.markAccountRunning('job-h4-f', 'f-a');
    jobs.applyAccountOutcome('job-h4-f', 'f-a', { status: 'failed', errorCode: 'x' });
    check('H4b-failed. 前置 → failed', jobs.finalizeJob('job-h4-f').status === 'failed');
    throws('H4b-failed. failed job → 抛错（P-R2）', () => jobs.resetInterruptedAccounts('job-h4-f'));

    // (b) completed → 抛错
    jobs.createSyncJob({ id: 'job-h4-c', accounts: [{ fakeid: 'c-a' }] });
    jobs.startJob('job-h4-c');
    jobs.markAccountRunning('job-h4-c', 'c-a');
    jobs.applyAccountOutcome('job-h4-c', 'c-a', { status: 'succeeded', newArticles: 1 });
    check('H4b-completed. 前置 → completed', jobs.finalizeJob('job-h4-c').status === 'completed');
    throws('H4b-completed. completed job → 抛错（P-R2）', () => jobs.resetInterruptedAccounts('job-h4-c'));

    // (b) cancelled（含 interrupted 账号）→ 抛错、interrupted 账号不变（强回滚断言）
    jobs.createSyncJob({ id: 'job-h4-x', accounts: [{ fakeid: 'x-int' }, { fakeid: 'x-c' }] });
    jobs.startJob('job-h4-x');
    jobs.markAccountRunning('job-h4-x', 'x-int');
    jobs.reconcileOrphanedJobs(); // x-int → interrupted
    jobs.requestCancel('job-h4-x');
    jobs.cancelPendingAccounts('job-h4-x'); // x-c pending → cancelled
    check('H4b-cancelled. 前置 → cancelled（含 interrupted 账号）', jobs.finalizeJob('job-h4-x').status === 'cancelled');
    const xIntBefore = snap15('job-h4-x', 'x-int');
    throws('H4b-cancelled. cancelled job → 抛错（P-R2）', () => jobs.resetInterruptedAccounts('job-h4-x'));
    check('H4b-cancelled. 回滚后 interrupted 账号 15 列不变', snap15('job-h4-x', 'x-int') === xIntBefore);
  }

  // ── H5 幂等：job 仍 running 且已无 interrupted → count=0、无副作用（深等值不变）──
  {
    jobs.createSyncJob({ id: 'job-h5', accounts: [{ fakeid: 'h5-a' }, { fakeid: 'h5-b' }] });
    jobs.startJob('job-h5');
    for (const f of ['h5-a', 'h5-b']) jobs.markAccountRunning('job-h5', f);
    jobs.reconcileOrphanedJobs(); // → interrupted
    check('H5. 首次 reset count=2', jobs.resetInterruptedAccounts('job-h5') === 2);
    const aSnap = snap15('job-h5', 'h5-a');
    const bSnap = snap15('job-h5', 'h5-b');
    const second = jobs.resetInterruptedAccounts('job-h5'); // 已无 interrupted、job 仍 running
    check('H5. 二次 reset count=0（仍过 P-R1/P-R2 门）', second === 0);
    check('H5. 二次调用无副作用：两账号 15 列逐字段不变',
      snap15('job-h5', 'h5-a') === aSnap && snap15('job-h5', 'h5-b') === bSnap);
  }

  // ── H6 事务原子性：UPDATE 之后（聚合重算处）注入错误 → 全回滚（interrupted 账号 + 聚合逐字段不变）──
  // 故障注入=临时包裹共享连接 db.prepare 在「聚合 UPDATE」处抛错（此刻 interrupted→pending 的 UPDATE 已执行、
  //   但在同一 BEGIN IMMEDIATE 内），验证 catch→ROLLBACK 把已发生的行改写完整撤销。不篡改任何 DB 行。
  {
    jobs.createSyncJob({ id: 'job-h6', accounts: [{ fakeid: 'h6-a' }, { fakeid: 'h6-b' }] });
    jobs.startJob('job-h6');
    for (const f of ['h6-a', 'h6-b']) jobs.markAccountRunning('job-h6', f);
    jobs.reconcileOrphanedJobs(); // → interrupted
    const bA = snap15('job-h6', 'h6-a');
    const bB = snap15('job-h6', 'h6-b');
    const jobBefore = jobs.getSyncJob('job-h6');
    const db = registry.getMpSyncDatabase();
    const origPrepare = db.prepare.bind(db);
    let threw = false;
    try {
      db.prepare = (sql) => {
        // 聚合重算的 UPDATE（在 interrupted→pending 的 UPDATE 之后、COMMIT 之前）注入失败。
        if (typeof sql === 'string' && sql.includes('succeeded_accounts = ?')) {
          throw new Error('injected aggregate UPDATE failure (H6 fault injection)');
        }
        return origPrepare(sql);
      };
      try {
        jobs.resetInterruptedAccounts('job-h6');
      } catch {
        threw = true;
      }
    } finally {
      db.prepare = origPrepare; // 无论如何还原，避免污染后续用例
    }
    check('H6. 注入聚合 UPDATE 失败 → reset 抛错', threw);
    check('H6. 全回滚：两 interrupted 账号 15 列逐字段不变（interrupted→pending 的写被撤销）',
      snap15('job-h6', 'h6-a') === bA && snap15('job-h6', 'h6-b') === bB);
    check('H6. 全回滚后账号仍 interrupted（未落 pending）',
      jobs.getJobAccount('job-h6', 'h6-a').status === 'interrupted' &&
      jobs.getJobAccount('job-h6', 'h6-b').status === 'interrupted');
    const jobAfter = jobs.getSyncJob('job-h6');
    check('H6. 全回滚：job 聚合逐字段不变',
      jobAfter.succeededAccounts === jobBefore.succeededAccounts &&
      jobAfter.failedAccounts === jobBefore.failedAccounts &&
      jobAfter.processedAccounts === jobBefore.processedAccounts);
    // 还原后 reset 正常工作（证明 db.prepare 已复原、无残留副作用）
    check('H6. 还原后 reset 正常 count=2', jobs.resetInterruptedAccounts('job-h6') === 2);
  }

  console.log(`\nPASS smoke_mp_sync_jobs: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_jobs:', err && err.stack ? err.stack : err);
  cleanupDb();
  process.exit(1);
}
cleanupDb();
