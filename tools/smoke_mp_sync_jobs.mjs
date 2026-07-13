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

  console.log(`\nPASS smoke_mp_sync_jobs: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_jobs:', err && err.stack ? err.stack : err);
  cleanupDb();
  process.exit(1);
}
cleanupDb();
