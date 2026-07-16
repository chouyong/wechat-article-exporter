// 纯离线 smoke：mp-sync-runner（C3-1 核心编排 + C3-2 并发池 + C3-3 退避/时钟/timeout + 纯函数）。
//
// 直连 runner + 仓库层 + 真实 syncSingleAccount（不起 server、不发网络、不碰真实 .data）：
//   - A 段：classifyAccountResult 单测，合成输入覆盖 succeeded / 各 errorKind / 未知 kind fail-closed /
//           通道 A(SyncConfigError) / 未预期抛错。
//   - B 段：runSyncJob 集成（临时 SQLite + 注入假 fetcher + resolveOptions 触发真实通道 A/B）。
//   - C 段：ConcurrencyController 纯逻辑（升 / 降 / 保持 / 构造校验 / clamp）。
//   - D 段：runSyncJobPool 集成（并发调度 + 自适应档位 + 系统故障传播）。
//   - E 段（C3-3）：退避纯函数 + 配置校验 + 真实 createRealClock.sleep + 逻辑时钟结算协议单测。
//   - F 段（C3-3）：退避重试 / per-page 软 timeout / 每 attempt 降档 / 逻辑 vs 真实 fetch 峰值 /
//           非法配置零持久副作用 / timeout scheduler 故障 = 受控业务 outcome（R2-C3-3-1）集成。
//
// 运行（需 node:sqlite；Node 25 默认可用，Node 22.18+ 类型剥离默认开）：
//   node --experimental-sqlite tools/smoke_mp_sync_runner.mjs

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// F12（R2-C3-3-1）：捕获全局 unhandledRejection。timeout scheduler 同步 throw 时，withTimeout 的 wrapped
// 结构保证已创建的 fetchP 进 Promise.race 被消费（无孤儿）；fix-must-fail (i) 退回裸 clock.sleep 会让
// fetchP 成孤儿、晚到 fetch reject 触发 unhandledRejection。用带 __c33tag 的 reason 精确识别本段的晚到 reject。
const c33Unhandled = [];
process.on('unhandledRejection', (reason) => {
  c33Unhandled.push(reason && reason.__c33tag ? reason.__c33tag : String(reason));
});

const tmpRoot = existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir();
const dbPath = path.join(tmpRoot, `mp-sync-runner-smoke-${process.pid}-${Date.now()}.sqlite`);
process.env.MP_SYNC_DB_PATH = dbPath;

const registry = await import('../server/utils/mp-account-registry.ts');
const jobs = await import('../server/utils/mp-sync-job-registry.ts');
const service = await import('../server/utils/mp-sync-service.ts');
const runner = await import('../server/utils/mp-sync-runner.ts');

const { createSyncJob, getSyncJob, getJobAccount } = jobs;
const { SyncConfigError, isRetryableErrorKind } = service;
const { runSyncJob, runSyncJobPool, classifyAccountResult, ConcurrencyController } = runner;
const {
  ClockAbortError,
  createRealClock,
  normalizeRetryOptions,
  assertTimeoutMs,
  computeRawBackoff,
  computeBackoffDelay,
  withTimeout,
} = runner;

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
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

// createTime 递减、aid 唯一、link 带 mid（与 service smoke 同口径）。
function article(aid, createTime, link) {
  return { aid, link: link ?? `https://mp.weixin.qq.com/s?mid=${aid}&idx=1`, title: `t-${aid}`, createTime };
}

// 按 fakeid 路由的假 fetcher；记录每个 fakeid 的调用次数与收到的 begin 序列（供零网络 / 安全 begin 断言）。
// routes[fakeid] = ({ begin, size, call }) => FetchPageResult（可 throw 模拟传输层错误）。
function makeRoutingFetcher(routes) {
  const calls = {};
  const begins = {};
  const fetchPage = async ({ fakeid, begin, size }) => {
    calls[fakeid] = (calls[fakeid] ?? 0) + 1;
    (begins[fakeid] ??= []).push(begin);
    const handler = routes[fakeid];
    if (!handler) return { articles: [], hasMore: false };
    return handler({ begin, size, call: calls[fakeid] });
  };
  return { fetchPage, calls, begins };
}

// 固定多页脚本 → handler。
function pagesHandler(pages) {
  return ({ begin, size }) => pages[Math.floor(begin / size)] ?? { articles: [], hasMore: false };
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  // A 段：classifyAccountResult 纯函数（合成输入，覆盖全分支）
  // ══════════════════════════════════════════════════════════════════════════

  // A1. succeeded：errorKind=null、retryable=false、newArticles 取数组长度、errorCode/errorMessage=null。
  {
    const { outcomeInput, run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'succeeded', newArticles: [article('x', 1), article('y', 2)], pagesFetched: 1, pageCursor: 2, lastArticleTime: 2 },
    });
    check('A1. succeeded status', run.status === 'succeeded');
    check('A1. newArticles 计数=2', run.newArticles === 2 && outcomeInput.newArticles === 2);
    check('A1. errorKind=null', run.errorKind === null);
    check('A1. retryable=false', run.retryable === false);
    check('A1. outcomeInput.errorCode=null', outcomeInput.errorCode === null);
    check('A1. outcomeInput.status=succeeded', outcomeInput.status === 'succeeded');
  }

  // A2. failed + config_error（通道 B 形状）：retryable=false、errorCode 落 'config_error'、保留已收计数。
  {
    const { outcomeInput, run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'failed', newArticles: [article('x', 1)], pagesFetched: 2, pageCursor: Number.MAX_SAFE_INTEGER, lastArticleTime: 1, errorKind: 'config_error', errorMessage: 'overflow' },
    });
    check('A2. failed status', run.status === 'failed');
    check("A2. errorKind='config_error'", run.errorKind === 'config_error');
    check('A2. retryable=false', run.retryable === false);
    check("A2. outcomeInput.errorCode='config_error'", outcomeInput.errorCode === 'config_error');
    check('A2. 保留已收计数=1', outcomeInput.newArticles === 1);
  }

  // A3-A5. 瞬时可重试类：rate_limited / timeout / network → retryable=true。
  for (const kind of ['rate_limited', 'timeout', 'network']) {
    const { run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'failed', newArticles: [], pagesFetched: 1, pageCursor: 3, lastArticleTime: null, errorKind: kind, errorMessage: kind },
    });
    check(`A3-5. ${kind} retryable=true`, run.retryable === true && run.errorKind === kind);
  }

  // A6. api_error → retryable=false（默认保守）。
  {
    const { run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'failed', newArticles: [], pagesFetched: 1, pageCursor: 0, lastArticleTime: null, errorKind: 'api_error', errorMessage: 'x' },
    });
    check('A6. api_error retryable=false', run.retryable === false);
  }

  // A7. auth_required → status=auth_required、retryable=false。
  {
    const { outcomeInput, run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'auth_required', newArticles: [], pagesFetched: 1, pageCursor: 0, lastArticleTime: null, errorKind: 'auth_required', errorMessage: 'relogin' },
    });
    check('A7. auth_required status', run.status === 'auth_required' && outcomeInput.status === 'auth_required');
    check('A7. auth_required retryable=false', run.retryable === false);
  }

  // A8. 未知 / 未登记 errorKind → fail-closed retryable=false（关键：requirement #3）。
  {
    const { outcomeInput, run } = classifyAccountResult('f', {
      ok: true,
      outcome: { status: 'failed', newArticles: [], pagesFetched: 1, pageCursor: 5, lastArticleTime: null, errorKind: 'bogus_kind', errorMessage: 'unknown' },
    });
    check('A8. 未知 kind retryable=false（fail-closed）', run.retryable === false);
    check('A8. 未知 kind 透传到 errorCode', outcomeInput.errorCode === 'bogus_kind');
  }

  // A9. 抛 SyncConfigError（通道 A）：status=failed、errorKind=config_error、retryable=false、newArticles=0。
  {
    const { outcomeInput, run } = classifyAccountResult('f', { ok: false, error: new SyncConfigError('bad param') });
    check('A9. 通道A status=failed', run.status === 'failed');
    check("A9. 通道A errorKind='config_error'", run.errorKind === 'config_error');
    check('A9. 通道A retryable=false', run.retryable === false);
    check('A9. 通道A newArticles=0', run.newArticles === 0 && outcomeInput.newArticles === 0);
    check("A9. 通道A errorCode='config_error'", outcomeInput.errorCode === 'config_error');
    check('A9. 通道A 保留错误信息', outcomeInput.errorMessage === 'bad param');
  }

  // A10. 抛未预期错误（非 SyncConfigError）：fail-closed 落 failed、errorKind=null、retryable=false。
  {
    const { outcomeInput, run } = classifyAccountResult('f', { ok: false, error: new Error('boom') });
    check('A10. 未预期错误 status=failed', run.status === 'failed');
    check('A10. 未预期错误 errorKind=null', run.errorKind === null);
    check('A10. 未预期错误 retryable=false（fail-closed）', run.retryable === false);
    check("A10. 未预期错误 errorCode='unexpected_error'", outcomeInput.errorCode === 'unexpected_error');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // B 段：runSyncJob 集成（临时 SQLite + 真实 syncSingleAccount + 假 fetcher）
  // ══════════════════════════════════════════════════════════════════════════

  // B1. 多账号全正常 → 全 succeeded、聚合正确、job=completed（正常终态，requirement #5）。
  {
    createSyncJob({
      id: 'job-normal',
      requestedSince: 1000,
      accounts: [{ fakeid: 'acc-a', priority: 5 }, { fakeid: 'acc-b', priority: 1 }],
    });
    const { fetchPage } = makeRoutingFetcher({
      'acc-a': pagesHandler([
        { articles: [article('n1', 2000), article('n2', 1990)], hasMore: true },
        { articles: [article('n3', 1980)], hasMore: false },
      ]),
      'acc-b': pagesHandler([{ articles: [article('m1', 2000)], hasMore: false }]),
    });
    const res = await runSyncJob('job-normal', { fetchPage });
    check('B1. job=completed', res.job.status === 'completed');
    check('B1. succeeded=2 processed=2 failed=0', res.job.succeededAccounts === 2 && res.job.processedAccounts === 2 && res.job.failedAccounts === 0);
    check('B1. newArticles 聚合=4', res.job.newArticles === 4);
    check('B1. 逐账号 succeeded', getJobAccount('job-normal', 'acc-a').status === 'succeeded' && getJobAccount('job-normal', 'acc-b').status === 'succeeded');
    check('B1. 摘要全 succeeded + retryable=false', res.accounts.length === 2 && res.accounts.every(a => a.status === 'succeeded' && a.retryable === false));
    check('B1. acc-a 收 3 篇 / acc-b 收 1 篇', getJobAccount('job-normal', 'acc-a').newArticles === 3 && getJobAccount('job-normal', 'acc-b').newArticles === 1);
  }

  // B2. 空 job → completed、accounts=[]。
  {
    createSyncJob({ id: 'job-empty', requestedSince: 1000, accounts: [] });
    const { fetchPage, calls } = makeRoutingFetcher({});
    const res = await runSyncJob('job-empty', { fetchPage });
    check('B2. 空 job=completed', res.job.status === 'completed');
    check('B2. accounts=[]', res.accounts.length === 0);
    check('B2. totalAccounts=0', res.job.totalAccounts === 0);
    check('B2. fetcher 从未被调用', Object.keys(calls).length === 0);
  }

  // B3. 通道 A（pageSize=0 触发真实 SyncConfigError）+ 正常账号混跑 → 零网络 + 失败隔离 + job=partial。
  {
    createSyncJob({
      id: 'job-chA',
      requestedSince: 1000,
      accounts: [{ fakeid: 'acc-configA', priority: 9 }, { fakeid: 'acc-ok', priority: 1 }],
    });
    const { fetchPage, calls } = makeRoutingFetcher({
      'acc-configA': () => {
        throw new Error('通道A 账号不应触达 fetchPage');
      },
      'acc-ok': pagesHandler([{ articles: [article('ok1', 2000)], hasMore: false }]),
    });
    const res = await runSyncJob('job-chA', {
      fetchPage,
      resolveOptions: account => (account.fakeid === 'acc-configA' ? { pageSize: 0 } : {}),
    });
    check('B3. 通道A 账号零网络（fetchPage 调用=0）', (calls['acc-configA'] ?? 0) === 0);
    check('B3. 通道A 账号 failed', getJobAccount('job-chA', 'acc-configA').status === 'failed');
    check("B3. 通道A errorCode='config_error'", getJobAccount('job-chA', 'acc-configA').errorCode === 'config_error');
    check('B3. 失败隔离：正常账号 succeeded', getJobAccount('job-chA', 'acc-ok').status === 'succeeded');
    check('B3. job=partial', res.job.status === 'partial');
    const chA = res.accounts.find(a => a.fakeid === 'acc-configA');
    check("B3. 通道A 摘要 errorKind='config_error' retryable=false", chA.errorKind === 'config_error' && chA.retryable === false);
  }

  // B4. 通道 B（pageSize=MAX_SAFE_INTEGER 触发真实游标溢出）→ failed(config_error) + 保留已收 + 安全游标。
  {
    createSyncJob({ id: 'job-chB', requestedSince: 1000, accounts: [{ fakeid: 'acc-overflow' }] });
    const { fetchPage, begins } = makeRoutingFetcher({
      'acc-overflow': ({ begin }) => ({ articles: [article(`ov-${begin}`, 5000)], hasMore: true }),
    });
    const res = await runSyncJob('job-chB', {
      fetchPage,
      resolveOptions: () => ({ pageSize: Number.MAX_SAFE_INTEGER, maxPages: 3 }),
    });
    const acc = getJobAccount('job-chB', 'acc-overflow');
    check('B4. 通道B failed', acc.status === 'failed');
    check("B4. 通道B errorCode='config_error'", acc.errorCode === 'config_error');
    check('B4. 通道B pageCursor 仍为安全整数', Number.isSafeInteger(acc.pageCursor));
    check('B4. 通道B 保留已收文章(>=1)', acc.newArticles >= 1);
    check('B4. 通道B fetcher 从未收到非安全 begin', begins['acc-overflow'].every(b => Number.isSafeInteger(b)));
    check('B4. 通道B 摘要 config_error 且绝不 succeeded', res.accounts[0].errorKind === 'config_error' && res.accounts[0].status !== 'succeeded');
    check('B4. 仅此账号失败 → job=failed', res.job.status === 'failed');
  }

  // B5. 可重试失败（fetcher 抛 429）→ 单次尝试落 failed、摘要 retryable=true、retryCount=1（证明 C3-1 不重试）。
  {
    createSyncJob({ id: 'job-429', requestedSince: 1000, accounts: [{ fakeid: 'acc-429' }] });
    const { fetchPage, calls } = makeRoutingFetcher({
      'acc-429': () => {
        const e = new Error('rate limited');
        e.status = 429;
        throw e;
      },
    });
    const res = await runSyncJob('job-429', { fetchPage });
    const acc = getJobAccount('job-429', 'acc-429');
    check('B5. 429 落 failed', acc.status === 'failed');
    check("B5. 429 errorCode='rate_limited'", acc.errorCode === 'rate_limited');
    check('B5. 单次尝试 retryCount=1', acc.retryCount === 1);
    check('B5. fetcher 只被调用 1 次（不重试）', calls['acc-429'] === 1);
    check('B5. 摘要 retryable=true 但未被重试', res.accounts[0].retryable === true);
  }

  // B6. 优先级顺序：priority DESC 处理；结果摘要顺序与处理顺序一致。
  {
    createSyncJob({
      id: 'job-order',
      requestedSince: 1000,
      accounts: [{ fakeid: 'p-low', priority: 1 }, { fakeid: 'p-high', priority: 9 }, { fakeid: 'p-mid', priority: 5 }],
    });
    const seen = [];
    const fetchPage = async ({ fakeid }) => {
      if (!seen.includes(fakeid)) seen.push(fakeid);
      return { articles: [article(`${fakeid}-a`, 2000)], hasMore: false };
    };
    const res = await runSyncJob('job-order', { fetchPage });
    check('B6. 处理顺序 priority DESC', JSON.stringify(seen) === JSON.stringify(['p-high', 'p-mid', 'p-low']));
    check('B6. 摘要顺序一致', JSON.stringify(res.accounts.map(a => a.fakeid)) === JSON.stringify(['p-high', 'p-mid', 'p-low']));
    check('B6. 全 succeeded → completed', res.job.status === 'completed');
  }

  // B7. finalize 三态补全：多账号全失败 → failed（B1=completed / B3=partial 已覆盖另两态）。
  {
    createSyncJob({
      id: 'job-allfail',
      requestedSince: 1000,
      accounts: [{ fakeid: 'x1' }, { fakeid: 'x2' }],
    });
    const { fetchPage } = makeRoutingFetcher({
      x1: () => {
        const e = new Error('boom1');
        e.status = 500;
        throw e;
      },
      x2: () => {
        const e = new Error('boom2');
        e.status = 500;
        throw e;
      },
    });
    const res = await runSyncJob('job-allfail', { fetchPage });
    check('B7. 全失败 → job=failed', res.job.status === 'failed');
    check('B7. failedAccounts=2 succeeded=0', res.job.failedAccounts === 2 && res.job.succeededAccounts === 0);
    check("B7. 500 归类 api_error（非 auth/瞬时）", getJobAccount('job-allfail', 'x1').errorCode === 'api_error');
  }

  // B8. 【F1/C3-1-F1 定向 fix-must-fail】resolveOptions 抛错 = 系统故障，必须向上 reject，绝不伪装成账号业务失败。
  //     修复前（resolveOptions 在 try 内）：抛错被 catch → 落 failed/unexpected_error + retryCount++ + 续跑，
  //     runSyncJob 不 reject（第一条断言即变红）。
  {
    createSyncJob({
      id: 'job-resolver-bug',
      requestedSince: 1000,
      accounts: [{ fakeid: 'acc-bug', priority: 9 }, { fakeid: 'acc-after', priority: 1 }],
    });
    const { fetchPage, calls } = makeRoutingFetcher({
      'acc-bug': () => {
        throw new Error('通道系统故障：resolver 抛错账号不应触达 fetchPage');
      },
      'acc-after': pagesHandler([{ articles: [article('after1', 2000)], hasMore: false }]),
    });
    let rejected = null;
    try {
      await runSyncJob('job-resolver-bug', {
        fetchPage,
        // 首账号的依赖配置器编程/依赖错误（非远端业务失败）。
        resolveOptions: account => {
          if (account.fakeid === 'acc-bug') throw new Error('resolver internal bug');
          return {};
        },
      });
    } catch (e) {
      rejected = e;
    }
    check('B8. resolver 抛错 → runSyncJob 向上 reject', rejected instanceof Error && /resolver internal bug/.test(rejected.message));
    check('B8. 系统故障零网络（fetchPage 从未被调用）', Object.keys(calls).length === 0);
    const bug = getJobAccount('job-resolver-bug', 'acc-bug');
    check('B8. 故障账号未被伪装成账号失败（保持 pending，不落 failed/unexpected_error）', bug.status === 'pending');
    check('B8. 故障账号 retryCount 未被错误累加(=0)', bug.retryCount === 0);
    check('B8. 故障账号 errorCode 未被伪造(null)', bug.errorCode === null);
    const after = getJobAccount('job-resolver-bug', 'acc-after');
    check('B8. 系统故障后续账号不得继续（acc-after 保持 pending）', after.status === 'pending');
    check('B8. job 未被 finalize 成业务终态（保持 running）', getSyncJob('job-resolver-bug').status === 'running');
  }

  // B9. 【F2/C3-1-F2 定向 fix-must-fail】resolver 经运行时非类型安全输入返回 startBegin:7，runner 必须固定 0 覆盖。
  //     修复前（startBegin:0 在展开之前 + 类型未 Omit）：resolver 覆盖生效 → fetcher 首个 begin=7（断言变红），
  //     提前泄漏 C3-5 断点续跑语义、切片边界不封闭。
  {
    createSyncJob({ id: 'job-startbegin', requestedSince: 1000, accounts: [{ fakeid: 'acc-sb' }] });
    const { fetchPage, begins } = makeRoutingFetcher({
      'acc-sb': pagesHandler([{ articles: [article('sb1', 2000)], hasMore: false }]),
    });
    const res = await runSyncJob('job-startbegin', {
      fetchPage,
      // 类型层已 Omit startBegin；此处模拟绕过类型的调用方（.mjs 运行时不做类型检查）。
      resolveOptions: () => ({ startBegin: 7 }),
    });
    check('B9. resolver 的 startBegin=7 被 runtime 固定 0 覆盖（fetcher 首个 begin=0）', begins['acc-sb'][0] === 0);
    check('B9. C3-1 全程 begin 未泄漏非 0 断点', begins['acc-sb'].every(b => b === 0));
    check('B9. 账号仍正常 succeeded（覆盖不破坏正常路径）', getJobAccount('job-startbegin', 'acc-sb').status === 'succeeded');
    check('B9. job=completed', res.job.status === 'completed');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C 段：ConcurrencyController 纯逻辑单测（C3-2 自适应档位：升 / 降 / 保持 / 构造校验 / clamp）
  // ══════════════════════════════════════════════════════════════════════════

  // C1. 默认档位表 [1,2,4,6,8]、起始档 4（index 2）。
  {
    const c = new ConcurrencyController();
    check('C1. 默认起始档=4', c.currentLimit() === 4);
    check('C1. 默认起始 index=2', c.currentIndex() === 2);
  }

  // C2. 健康升档：连续 4 成功 4→6；再 4 → 6→8；到顶不再升。
  {
    const c = new ConcurrencyController({ healthyStreakToRaise: 4 });
    for (let i = 0; i < 4; i += 1) c.onResult('succeeded');
    check('C2. 连续4成功 → 升到 6', c.currentLimit() === 6);
    for (let i = 0; i < 4; i += 1) c.onResult('succeeded');
    check('C2. 再连续4成功 → 升到 8（顶）', c.currentLimit() === 8);
    for (let i = 0; i < 8; i += 1) c.onResult('succeeded');
    check('C2. 到顶不再升（仍 8）', c.currentLimit() === 8);
  }

  // C3. 升档需“连续”：不足阈值不升；中途失败清零连续计数。
  {
    const c = new ConcurrencyController({ healthyStreakToRaise: 4 });
    c.onResult('succeeded'); c.onResult('succeeded'); c.onResult('succeeded');
    check('C3. 3次成功(<4)不升档（仍4）', c.currentLimit() === 4);
    c.onResult('api_error'); // 其它失败：清零连续但不改档
    check('C3. api_error 不改档（仍4）', c.currentLimit() === 4);
    c.onResult('succeeded'); c.onResult('succeeded'); c.onResult('succeeded');
    check('C3. 清零后再3次(<4)仍不升（证明连续被打断）', c.currentLimit() === 4);
    c.onResult('succeeded');
    check('C3. 满4次连续 → 升到6', c.currentLimit() === 6);
  }

  // C4. 降档信号 rate_limited / timeout / auth_required → 立即降到最低档1（穷举三个降档信号）。
  for (const sig of ['rate_limited', 'timeout', 'auth_required']) {
    const c = new ConcurrencyController({ healthyStreakToRaise: 100000 });
    for (let i = 0; i < 3; i += 1) c.onResult('succeeded');
    const before = c.currentLimit();
    c.onResult(sig);
    check(`C4. ${sig} → 降到最低档1（降档前=${before}）`, c.currentLimit() === 1);
  }

  // C5. 非降档失败（config_error / api_error / network / 未知 null）不降档（保持当前档）。
  for (const sig of ['config_error', 'api_error', 'network', null]) {
    const c = new ConcurrencyController(); // 起始4
    c.onResult(sig);
    check(`C5. ${sig ?? 'null'} 不降档（仍4）`, c.currentLimit() === 4);
  }

  // C6. 降档后可再健康升档（从最低档爬升）。
  {
    const c = new ConcurrencyController({ healthyStreakToRaise: 2 });
    c.onResult('rate_limited');
    check('C6. 降档后=1', c.currentLimit() === 1);
    c.onResult('succeeded'); c.onResult('succeeded');
    check('C6. 从1连续2成功 → 升到2', c.currentLimit() === 2);
  }

  // C7. 构造校验：空表 / 非严格递增 / 递减 / 含0 / 非整数 / 非法 healthyStreakToRaise → 抛 RangeError。
  {
    let threw = 0;
    const bad = [
      () => new ConcurrencyController({ levels: [] }),
      () => new ConcurrencyController({ levels: [1, 1, 2] }),
      () => new ConcurrencyController({ levels: [2, 1] }),
      () => new ConcurrencyController({ levels: [0, 2] }),
      () => new ConcurrencyController({ levels: [1, 2.5] }),
      () => new ConcurrencyController({ healthyStreakToRaise: 0 }),
      () => new ConcurrencyController({ healthyStreakToRaise: -1 }),
    ];
    for (const fn of bad) {
      try { fn(); } catch (e) { if (e instanceof RangeError) threw += 1; }
    }
    check('C7. 7 个非法构造全部抛 RangeError', threw === 7);
  }

  // C8. startIndex clamp：越界 / 非安全整数 → clamp 到合法范围。
  {
    check('C8. startIndex 超上界 clamp 到顶档8', new ConcurrencyController({ startIndex: 99 }).currentLimit() === 8);
    check('C8. startIndex 负数 clamp 到最低档1', new ConcurrencyController({ startIndex: -5 }).currentLimit() === 1);
    check('C8. startIndex NaN 回退到0档1', new ConcurrencyController({ startIndex: NaN }).currentLimit() === 1);
    check('C8. startIndex=0 → 档1', new ConcurrencyController({ startIndex: 0 }).currentLimit() === 1);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // D 段：runSyncJobPool 集成（并发调度 + 自适应档位；可控延迟假 fetcher 观测在飞峰值）
  // ══════════════════════════════════════════════════════════════════════════

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // 并发可观测 fetcher：记录同时在飞 fetchPage 峰值 + 完成顺序（单页账号下 ≈ 账号完成序）。
  // spec[fakeid] = { delayMs?, handler?, throwStatus? }；默认单页成功 1 篇。
  function makeConcurrentFetcher(spec, defaultDelay = 15) {
    let inFlight = 0;
    let maxInFlight = 0;
    const completions = [];
    const calls = {};
    const fetchPage = async ({ fakeid, begin, size }) => {
      calls[fakeid] = (calls[fakeid] ?? 0) + 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        const s = spec[fakeid] ?? {};
        await delay(s.delayMs ?? defaultDelay);
        if (s.throwStatus) {
          const e = new Error(`http ${s.throwStatus}`);
          e.status = s.throwStatus;
          throw e;
        }
        if (typeof s.handler === 'function') return s.handler({ begin, size, call: calls[fakeid] });
        return { articles: [article(`${fakeid}-a`, 2000)], hasMore: false };
      } finally {
        inFlight -= 1;
        completions.push(fakeid);
      }
    };
    return { fetchPage, getMax: () => maxInFlight, completions, calls };
  }

  // D1. 正常并发全成功：结果正确 + 稳定顺序 + job=completed。
  {
    const ids = ['d1-a', 'd1-b', 'd1-c', 'd1-d', 'd1-e'];
    createSyncJob({ id: 'job-pool-normal', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 10 - i })) });
    const fc = makeConcurrentFetcher({});
    const res = await runSyncJobPool('job-pool-normal', { fetchPage: fc.fetchPage });
    check('D1. job=completed', res.job.status === 'completed');
    check('D1. 全 succeeded', res.accounts.length === 5 && res.accounts.every((a) => a.status === 'succeeded'));
    check('D1. 结果按输入 priority DESC 稳定顺序', JSON.stringify(res.accounts.map((a) => a.fakeid)) === JSON.stringify(ids));
    check('D1. newArticles 聚合=5', res.job.newArticles === 5);
    check('D1. 每账号仅一次 fetch', ids.every((f) => fc.calls[f] === 1));
  }

  // D2. 在飞 ≤ 档：8 账号、起始档4、禁升档 → 在飞峰值恰=4，schedule 每条 inFlight<=limit。
  {
    const ids = Array.from({ length: 8 }, (_, i) => `d2-${i}`);
    createSyncJob({ id: 'job-pool-cap', requestedSince: 1000, accounts: ids.map((f) => ({ fakeid: f, priority: 0 })) });
    const fc = makeConcurrentFetcher({}, 25);
    const res = await runSyncJobPool('job-pool-cap', { fetchPage: fc.fetchPage }, { healthyStreakToRaise: 100000 });
    check('D2. 在飞峰值恰=起始档4（调度器视角与 fetcher 视角一致）', res.concurrency.maxInFlight === 4 && fc.getMax() === 4);
    check('D2. schedule 每条 inFlight<=limit（核心不变量）', res.concurrency.schedule.every((s) => s.inFlight <= s.limit));
    check('D2. 全程 limit 未升（恒4）', res.concurrency.schedule.every((s) => s.limit === 4));
    check('D2. 8 账号全 succeeded、job completed', res.job.status === 'completed' && res.job.succeededAccounts === 8);
  }

  // D3. 输入顺序 ≠ 完成顺序，结果仍按输入稳定落位。delay 递增使完成顺序与输入相反。
  {
    const ids = ['d3-a', 'd3-b', 'd3-c', 'd3-d'];
    createSyncJob({ id: 'job-pool-order', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 10 - i })) });
    const fc = makeConcurrentFetcher({ 'd3-a': { delayMs: 40 }, 'd3-b': { delayMs: 30 }, 'd3-c': { delayMs: 20 }, 'd3-d': { delayMs: 10 } });
    const res = await runSyncJobPool('job-pool-order', { fetchPage: fc.fetchPage }, { healthyStreakToRaise: 100000 });
    check('D3. 完成顺序确与输入相反（d,c,b,a）', JSON.stringify(fc.completions) === JSON.stringify(['d3-d', 'd3-c', 'd3-b', 'd3-a']));
    check('D3. 结果仍按输入顺序稳定（a,b,c,d）', JSON.stringify(res.accounts.map((a) => a.fakeid)) === JSON.stringify(ids));
    check('D3. 每个 index 都被填充（无稀疏空洞）', res.accounts.every((a) => a && a.status === 'succeeded'));
  }

  // D4. 单账号失败隔离（并发下）：一个账号 500(api_error) 失败，其它并发账号不受影响。
  {
    const ids = ['d4-ok1', 'd4-bad', 'd4-ok2', 'd4-ok3'];
    createSyncJob({ id: 'job-pool-iso', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 10 - i })) });
    const fc = makeConcurrentFetcher({ 'd4-bad': { throwStatus: 500 } });
    const res = await runSyncJobPool('job-pool-iso', { fetchPage: fc.fetchPage }, { healthyStreakToRaise: 100000 });
    check('D4. 失败账号 failed(api_error)', getJobAccount('job-pool-iso', 'd4-bad').status === 'failed' && getJobAccount('job-pool-iso', 'd4-bad').errorCode === 'api_error');
    check('D4. 其它 3 账号 succeeded（隔离）', ['d4-ok1', 'd4-ok2', 'd4-ok3'].every((f) => getJobAccount('job-pool-iso', f).status === 'succeeded'));
    check('D4. job=partial', res.job.status === 'partial');
    check('D4. 结果稳定顺序', JSON.stringify(res.accounts.map((a) => a.fakeid)) === JSON.stringify(ids));
  }

  // D5. 自适应升档：全成功、账号足够 → 档位从4升到顶8。
  {
    const ids = Array.from({ length: 24 }, (_, i) => `d5-${String(i).padStart(2, '0')}`);
    createSyncJob({ id: 'job-pool-raise', requestedSince: 1000, accounts: ids.map((f) => ({ fakeid: f, priority: 0 })) });
    const fc = makeConcurrentFetcher({}, 8);
    const res = await runSyncJobPool('job-pool-raise', { fetchPage: fc.fetchPage }, { healthyStreakToRaise: 4 });
    check('D5. 最终档位升到顶=8', res.concurrency.finalLimit === 8);
    check('D5. schedule 出现过 limit=8（确实升到顶）', res.concurrency.schedule.some((s) => s.limit === 8));
    check('D5. 在飞峰值 > 起始档4（升档生效）', res.concurrency.maxInFlight > 4);
    check('D5. 在飞峰值不超上限8', res.concurrency.maxInFlight <= 8);
    check('D5. 全 succeeded、job completed', res.job.status === 'completed' && res.job.succeededAccounts === 24);
  }

  // D6. 自适应降档：8 账号、最先完成者 429 → 降到最低档1；禁升档隔离干扰。
  {
    const ids = Array.from({ length: 8 }, (_, i) => `d6-${i}`);
    createSyncJob({ id: 'job-pool-down', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 10 - i })) });
    const spec = { 'd6-0': { throwStatus: 429, delayMs: 5 } };
    for (let i = 1; i < 8; i += 1) spec[`d6-${i}`] = { delayMs: 40 };
    const fc = makeConcurrentFetcher(spec);
    const res = await runSyncJobPool('job-pool-down', { fetchPage: fc.fetchPage }, { healthyStreakToRaise: 100000 });
    check('D6. 降档后最终档位=1', res.concurrency.finalLimit === 1);
    check('D6. schedule 出现过 limit=1（降档已体现在后续调度）', res.concurrency.schedule.some((s) => s.limit === 1));
    check('D6. 起始批在飞达4（降档前）', res.concurrency.maxInFlight === 4);
    check('D6. 429 账号 failed(rate_limited)', getJobAccount('job-pool-down', 'd6-0').errorCode === 'rate_limited');
    check('D6. 其余账号仍全部处理完（未因降档丢账号）', ids.slice(1).every((f) => getJobAccount('job-pool-down', f).status === 'succeeded'));
    // N-C3-2-1：降档只约束 admission。429 把档降到 1 后，后续每次 admission 恒满足 inFlight<=limit（=1）；
    // 旧 worker 不被中断、自然排空——若把降档误当“任意时刻硬上限”而在 inFlight>1 时仍 admit，这里会出现
    // limit===1 && inFlight>1 的记录而变红。（非任意时刻不变量：降档瞬间旧 worker 仍在飞属预期，不采样在此。）
    const d6DownAdmissions = res.concurrency.schedule.filter((s) => s.limit === 1);
    check('D6. 降档(limit=1)后每次 admission 恒 inFlight<=limit（无超额 admission，旧 worker 自然排空）', d6DownAdmissions.length > 0 && d6DownAdmissions.every((s) => s.inFlight <= s.limit));
  }

  // D7. 系统故障传播（并发）：resolver 对最高优先账号抛错 → reject + 排空在飞 + 未调度账号 pending + job 不 finalize。
  {
    const ids = ['d7-bug', 'd7-a', 'd7-b', 'd7-c', 'd7-d', 'd7-e']; // prio 9..4
    createSyncJob({ id: 'job-pool-fatal', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 9 - i })) });
    const fc = makeConcurrentFetcher({}, 15);
    let didReject = false;               // 独立布尔哨兵：与 rejection **取值** 解耦（不用 rejected=null 兼表“未 reject”）
    let rejectedValue;
    try {
      await runSyncJobPool('job-pool-fatal', {
        fetchPage: fc.fetchPage,
        resolveOptions: (acc) => { if (acc.fakeid === 'd7-bug') throw new Error('resolver internal bug'); return {}; },
      }, { healthyStreakToRaise: 100000 });
    } catch (e) { didReject = true; rejectedValue = e; }
    check('D7. 系统故障 → runSyncJobPool 向上 reject', didReject && rejectedValue instanceof Error && /resolver internal bug/.test(rejectedValue.message));
    check('D7. 故障账号未被伪装（保持 pending，零 markRunning）', getJobAccount('job-pool-fatal', 'd7-bug').status === 'pending');
    check('D7. 故障账号 retryCount 未被累加(=0)', getJobAccount('job-pool-fatal', 'd7-bug').retryCount === 0);
    check('D7. 故障账号零网络（fetchPage 未触达）', (fc.calls['d7-bug'] ?? 0) === 0);
    check('D7. 已在飞账号被排空落终态（a,b,c succeeded）', ['d7-a', 'd7-b', 'd7-c'].every((f) => getJobAccount('job-pool-fatal', f).status === 'succeeded'));
    check('D7. 未调度账号保持 pending（d,e）', ['d7-d', 'd7-e'].every((f) => getJobAccount('job-pool-fatal', f).status === 'pending'));
    check('D7. job 未 finalize 成业务终态（保持 running）', getSyncJob('job-pool-fatal').status === 'running');
  }

  // D8. 空 job（并发版）→ completed、accounts=[]、fetcher 未调用、maxInFlight=0。
  {
    createSyncJob({ id: 'job-pool-empty', requestedSince: 1000, accounts: [] });
    const fc = makeConcurrentFetcher({});
    const res = await runSyncJobPool('job-pool-empty', { fetchPage: fc.fetchPage });
    check('D8. 空 job=completed', res.job.status === 'completed');
    check('D8. accounts=[]、maxInFlight=0', res.accounts.length === 0 && res.concurrency.maxInFlight === 0);
    check('D8. fetcher 从未被调用', Object.keys(fc.calls).length === 0);
  }

  // D9. 并发下真实通道 A/B（复用 C3-0 service，不桩掉）：混跑 config_error 与正常账号，隔离 + 稳定顺序。
  {
    const ids = ['d9-cfgA', 'd9-ok', 'd9-cfgB'];
    createSyncJob({ id: 'job-pool-cfg', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 10 - i })) });
    const fc = makeConcurrentFetcher({
      'd9-cfgA': { handler: () => { throw new Error('通道A 不应触达 fetchPage'); } },
      'd9-cfgB': { handler: ({ begin }) => ({ articles: [article(`ov-${begin}`, 5000)], hasMore: true }) },
    });
    const res = await runSyncJobPool('job-pool-cfg', {
      fetchPage: fc.fetchPage,
      resolveOptions: (acc) => {
        if (acc.fakeid === 'd9-cfgA') return { pageSize: 0 };
        if (acc.fakeid === 'd9-cfgB') return { pageSize: Number.MAX_SAFE_INTEGER, maxPages: 3 };
        return {};
      },
    }, { healthyStreakToRaise: 100000 });
    check('D9. 通道A 账号零网络 failed(config_error)', (fc.calls['d9-cfgA'] ?? 0) === 0 && getJobAccount('job-pool-cfg', 'd9-cfgA').errorCode === 'config_error');
    const cfgB = getJobAccount('job-pool-cfg', 'd9-cfgB');
    check('D9. 通道B 账号 failed(config_error)、安全游标', cfgB.errorCode === 'config_error' && Number.isSafeInteger(cfgB.pageCursor));
    check('D9. 正常账号 succeeded（隔离）', getJobAccount('job-pool-cfg', 'd9-ok').status === 'succeeded');
    check('D9. 结果稳定顺序', JSON.stringify(res.accounts.map((a) => a.fakeid)) === JSON.stringify(ids));
  }

  // D10. 系统故障以 null 拒绝（F-C3-2-1 回归）：resolver throw null → 必须原样 reject（rejection value 恒等
  //      null）、不继续调度、故障+未调度账号保持 pending、job 不 finalize（保持 running，可进 C3-5 恢复）。
  //      未修复态（用 fatalError===null 兼表“未故障”）会把 null rejection 误判为未故障：调度门继续开、
  //      settle 走 resolve、finalizeJob 把 job 落成 partial —— didReject / rejectedValue / d,e pending /
  //      job running 全线变红。测试自身用独立 didReject + 非 null 初值 rejectedValue，绝不用 null 兼表“未 reject”。
  {
    const ids = ['d10-bug', 'd10-a', 'd10-b', 'd10-c', 'd10-d', 'd10-e']; // prio 9..4；bug 最高优先，与 a/b/c 同批入调度
    createSyncJob({ id: 'job-pool-null', requestedSince: 1000, accounts: ids.map((f, i) => ({ fakeid: f, priority: 9 - i })) });
    const fc = makeConcurrentFetcher({}, 15);
    let didReject = false;               // 独立布尔哨兵：与 rejection **取值** 解耦
    let rejectedValue = 'UNSET';         // 非 null 初值，用于区分“未 reject”与“以 null reject”
    try {
      await runSyncJobPool('job-pool-null', {
        fetchPage: fc.fetchPage,
        resolveOptions: (acc) => { if (acc.fakeid === 'd10-bug') throw null; return {}; },
      }, { healthyStreakToRaise: 100000 });
    } catch (e) { didReject = true; rejectedValue = e; }
    check('D10. throw null → runSyncJobPool 确实 reject（未被伪装成 resolve）', didReject === true);
    check('D10. rejection value 恒等 null（原样透传，未被 null 哨兵吞掉）', rejectedValue === null);
    check('D10. 故障账号保持 pending（未 markRunning / 未续跑）', getJobAccount('job-pool-null', 'd10-bug').status === 'pending');
    check('D10. 故障账号零网络（fetchPage 未触达）', (fc.calls['d10-bug'] ?? 0) === 0);
    check('D10. 已在飞账号被排空落终态（a,b,c succeeded）', ['d10-a', 'd10-b', 'd10-c'].every((f) => getJobAccount('job-pool-null', f).status === 'succeeded'));
    check('D10. 未调度账号保持 pending（d,e；调度门已闭，未继续 admit）', ['d10-d', 'd10-e'].every((f) => getJobAccount('job-pool-null', f).status === 'pending'));
    check('D10. job 未 finalize 成业务终态（保持 running，可进 C3-5 恢复）', getSyncJob('job-pool-null').status === 'running');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C3-3 测试基建：逻辑时钟（§2.1 结算协议）+ 驱动器 + 逻辑时钟感知假 fetcher
  // ══════════════════════════════════════════════════════════════════════════

  // 逻辑时钟：维护定时器堆，advance(ms) 按 (dueTime, seq) 稳定排序、**逐 timer** 结算——每轮只 pop 最早一项、
  // settle 前先 now=due、settle 后过 setImmediate barrier（排空回调链微任务 + 让链上新注册的 timer 登记），
  // 再 rescan（含 barrier 期间新注册且 due<=target 的项）。不进生产模块（生产只用 createRealClock）。
  function createManualClock(startNow = 0) {
    let now = startNow;
    let seq = 0;
    const timers = []; // 未结算定时器
    let registered = 0; // 累计注册 sleep 次数（供“零 sleep 注册”断言）
    const removeTimer = (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
      if (t.signal && t.onAbort) t.signal.removeEventListener('abort', t.onAbort);
    };
    return {
      now: () => now,
      sleep: (ms, opts) =>
        new Promise((resolve, reject) => {
          registered += 1;
          const signal = opts?.signal;
          if (signal?.aborted) {
            reject(new ClockAbortError());
            return;
          }
          const t = { dueTime: now + ms, seq: (seq += 1), settled: false, resolve, reject, signal, onAbort: null };
          if (signal) {
            t.onAbort = () => {
              if (t.settled) return;
              t.settled = true;
              removeTimer(t);
              t.reject(new ClockAbortError());
            };
            signal.addEventListener('abort', t.onAbort);
          }
          timers.push(t);
        }),
      async advance(ms) {
        const target = now + ms;
        await new Promise((r) => setImmediate(r)); // 先让已排队微任务落地（注册 sleep），再扫描
        let guard = 0;
        for (;;) {
          if ((guard += 1) > 1_000_000) throw new Error('manualClock.advance: 结算迭代超上限（疑似无限注册）');
          let pick = null;
          for (const t of timers) {
            if (t.settled || t.dueTime > target) continue;
            if (!pick || t.dueTime < pick.dueTime || (t.dueTime === pick.dueTime && t.seq < pick.seq)) pick = t;
          }
          if (!pick) break;
          now = pick.dueTime; // 先把时钟推进到该 timer 到点时刻，再结算（回调内 now()==该到点时刻）
          pick.settled = true;
          removeTimer(pick);
          pick.resolve();
          await new Promise((r) => setImmediate(r)); // event-loop barrier
        }
        now = target; // 收敛
      },
      pendingCount: () => timers.length,
      registeredCount: () => registered,
    };
  }

  // 驱动逻辑时钟把一个 pool/job promise 跑到 settle：advance 一大步（超过任何 dueTime），逐 timer 有序结算。
  async function runToSettle(promise, clock, bigMs = 10_000_000) {
    let done = false;
    let ok = false;
    let value;
    let err;
    promise.then(
      (v) => { done = true; ok = true; value = v; },
      (e) => { done = true; err = e; }
    );
    await clock.advance(bigMs);
    for (let i = 0; i < 20 && !done; i += 1) await new Promise((r) => setImmediate(r));
    if (!done) throw new Error('runToSettle: promise 未在时钟推进后 settle');
    if (!ok) throw err;
    return value;
  }

  // 推进逻辑时钟到指定 ms 后再取 promise 结果（用于 timeout 精确时序断言，不越过后续 dueTime）。
  async function advanceThenAwait(promise, clock, ms) {
    let done = false;
    let ok = false;
    let value;
    let err;
    promise.then(
      (v) => { done = true; ok = true; value = v; },
      (e) => { done = true; err = e; }
    );
    await clock.advance(ms);
    for (let i = 0; i < 20 && !done; i += 1) await new Promise((r) => setImmediate(r));
    if (!done) throw new Error(`advanceThenAwait: promise 未在 advance(${ms}) 后 settle`);
    if (!ok) throw err;
    return value;
  }

  // 逻辑时钟感知 fetcher：用 clock.sleep 模拟抓取延迟（可被 timeout 抢先），记录底层 fetch 活跃峰值。
  function makeClockFetcher(clock, spec) {
    const active = { count: 0, max: 0 };
    const calls = {};
    const fetchPage = async ({ fakeid, begin }) => {
      calls[fakeid] = (calls[fakeid] ?? 0) + 1;
      active.count += 1;
      if (active.count > active.max) active.max = active.count;
      try {
        const s = spec[fakeid] ?? {};
        await clock.sleep(s.latencyMs ?? 1000);
        if (s.throwAfter) throw s.throwAfter({ begin, call: calls[fakeid] });
        return { articles: [article(`${fakeid}-${begin}`, 2000)], hasMore: false };
      } finally {
        active.count -= 1;
      }
    };
    return { fetchPage, calls, active };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // E 段（C3-3）：纯函数 + 配置校验 + 真实 createRealClock.sleep + 逻辑时钟结算协议单测
  // ══════════════════════════════════════════════════════════════════════════

  // E1. computeRawBackoff（严格纯，R1-B4b）：精确指数序列 + 封顶 + base=0/指数溢出组合非 NaN。
  {
    const seq = [0, 1, 2, 3, 4].map((a) => computeRawBackoff(a, { baseDelayMs: 100, maxDelayMs: 1000 }));
    check('E1. raw 指数序列 [100,200,400,800,封顶1000]', JSON.stringify(seq) === JSON.stringify([100, 200, 400, 800, 1000]));
    check('E1. raw 单调不减', seq.every((v, i) => i === 0 || v >= seq[i - 1]));
    check('E1. 缺省 base/max → 1000 起 / 封顶 30000', computeRawBackoff(0) === 1000 && computeRawBackoff(5, {}) === 30000);
    check('E1. base=0 + attempt=40 → raw=0（非 NaN/Infinity，指数 cap 生效）', computeRawBackoff(40, { baseDelayMs: 0, maxDelayMs: 30000 }) === 0);
    check('E1. base=0 + attempt=100 → raw=0（min(attempt,30) 封住 2**attempt 溢出）', computeRawBackoff(100, { baseDelayMs: 0, maxDelayMs: 30000 }) === 0);
    check('E1. base>0 + attempt=100 → 封顶 30000 且有限', computeRawBackoff(100, { baseDelayMs: 1000, maxDelayMs: 30000 }) === 30000 && Number.isFinite(computeRawBackoff(100, { baseDelayMs: 1000, maxDelayMs: 30000 })));
  }

  // E2. computeBackoffDelay：identity-jitter == raw；full jitter ∈[0,raw]（只断范围）；越界 jitter fail-fast。
  {
    check('E2. identity-jitter → == raw', computeBackoffDelay(2, { baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d }) === 400);
    const raw3 = computeRawBackoff(3, { baseDelayMs: 100, maxDelayMs: 1000 }); // 800
    let inRange = true;
    for (let i = 0; i < 50; i += 1) {
      const d = computeBackoffDelay(3, { baseDelayMs: 100, maxDelayMs: 1000 });
      if (!(d >= 0 && d <= raw3)) inRange = false;
    }
    check('E2. full jitter 50 次均 ∈[0,raw]（只断范围、不断单调）', inRange);
    let threw = 0;
    for (const bad of [() => -1, () => NaN, () => Infinity, (d) => d + 1]) {
      try {
        computeBackoffDelay(1, { baseDelayMs: 100, maxDelayMs: 1000, jitter: bad });
      } catch (e) {
        if (e instanceof RangeError) threw += 1;
      }
    }
    check('E2. 4 个越界 jitter（负/NaN/Infinity/>raw）均抛 RangeError（不静默 clamp）', threw === 4);
  }

  // E3. normalizeRetryOptions + assertTimeoutMs：非法值域 fail-fast RangeError；缺省填充；合法原样。
  {
    let threw = 0;
    const bad = [
      () => normalizeRetryOptions({ maxAttempts: 0 }),
      () => normalizeRetryOptions({ maxAttempts: -1 }),
      () => normalizeRetryOptions({ maxAttempts: 2.5 }),
      () => normalizeRetryOptions({ maxAttempts: Infinity }),
      () => normalizeRetryOptions({ baseDelayMs: -1 }),
      () => normalizeRetryOptions({ baseDelayMs: NaN }),
      () => normalizeRetryOptions({ maxDelayMs: Infinity }),
      () => normalizeRetryOptions({ baseDelayMs: 5000, maxDelayMs: 1000 }),
      () => normalizeRetryOptions({ maxDelayMs: 2_147_483_648 }),
      () => assertTimeoutMs(0),
      () => assertTimeoutMs(-1),
      () => assertTimeoutMs(NaN),
      () => assertTimeoutMs(Infinity),
      () => assertTimeoutMs(2_147_483_648),
    ];
    for (const fn of bad) {
      try {
        fn();
      } catch (e) {
        if (e instanceof RangeError) threw += 1;
      }
    }
    check('E3. 14 个非法 retry/timeout 配置全部抛 RangeError', threw === 14);
    const n = normalizeRetryOptions();
    check('E3. 缺省填充 maxAttempts=1 / base=1000 / max=30000 / jitter 为函数', n.maxAttempts === 1 && n.baseDelayMs === 1000 && n.maxDelayMs === 30000 && typeof n.jitter === 'function');
    const n2 = normalizeRetryOptions({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 });
    check('E3. 合法值原样规范化', n2.maxAttempts === 3 && n2.baseDelayMs === 500 && n2.maxDelayMs === 5000);
    let okNoThrow = true;
    try {
      assertTimeoutMs(100);
      assertTimeoutMs(undefined);
      assertTimeoutMs(2_147_483_647);
    } catch {
      okNoThrow = false;
    }
    check('E3. 合法 timeoutMs / undefined / 上限值 不抛', okNoThrow);
  }

  // E4. 真实 createRealClock.sleep（用小真实 ms 直测）：预 abort / 到期 / 中途 abort / 到期后再 abort 只结算一次。
  {
    const clock = createRealClock();
    {
      const ac = new AbortController();
      ac.abort();
      let err;
      try {
        await clock.sleep(50, { signal: ac.signal });
      } catch (e) {
        err = e;
      }
      check('E4. 预先 aborted → 立即 reject(ClockAbortError)', err instanceof ClockAbortError);
    }
    {
      const t0 = Date.now();
      await clock.sleep(5);
      check('E4. 正常到期 resolve（>=~3ms）', Date.now() - t0 >= 3);
    }
    {
      const ac = new AbortController();
      const p = clock.sleep(2000, { signal: ac.signal });
      setTimeout(() => ac.abort(), 5);
      let err;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      check('E4. 中途 abort → reject(ClockAbortError)', err instanceof ClockAbortError);
    }
    {
      const ac = new AbortController();
      await clock.sleep(3, { signal: ac.signal });
      let okNoThrow = true;
      try {
        ac.abort(); // 到期后再 abort：settled 守卫 → no-op、不二次结算、无抛错
      } catch {
        okNoThrow = false;
      }
      check('E4. 到期后再 abort 不二次结算（settled 守卫，无抛错）', okNoThrow);
    }
  }

  // E5. 逻辑时钟结算协议（R1-B4a）：稳定 FIFO + settle 前 now=due + 新注册重排 + 不提前结算 + abort 单次。
  {
    {
      const clock = createManualClock();
      const order = [];
      clock.sleep(100).then(() => order.push(['a', clock.now()]));
      clock.sleep(100).then(() => order.push(['b', clock.now()])); // 同 due，后注册 → FIFO 靠后
      clock.sleep(50).then(() => order.push(['c', clock.now()]));
      await clock.advance(100);
      check('E5. 按 due 升序 + 同 due FIFO：c,a,b', JSON.stringify(order.map((o) => o[0])) === JSON.stringify(['c', 'a', 'b']));
      check('E5. settle 前 now=due（回调内 now==该 timer 到点时刻）', order[0][1] === 50 && order[1][1] === 100 && order[2][1] === 100);
    }
    {
      const clock = createManualClock();
      const order = [];
      clock.sleep(100).then(() => {
        order.push(100);
        clock.sleep(50).then(() => order.push('150-new')); // barrier 期间新注册 due=150
      });
      clock.sleep(200).then(() => order.push(200));
      await clock.advance(200);
      check('E5. 新注册 due=150 排到原有 due=200 之前结算（每轮只 pop 最早一项）', JSON.stringify(order) === JSON.stringify([100, '150-new', 200]));
    }
    {
      const clock = createManualClock();
      const seen = [];
      clock.sleep(100).then(() => {
        seen.push(`first@${clock.now()}`);
        clock.sleep(100).then(() => seen.push(`second@${clock.now()}`)); // 链式累计到点 200
      });
      await clock.advance(150);
      check('E5. advance(150)：首个(due100)结算、链式(due200>150)不提前结算', JSON.stringify(seen) === JSON.stringify(['first@100']));
      check('E5. 链式项 pending、now=150', clock.pendingCount() === 1 && clock.now() === 150);
      await clock.advance(100); // now→250
      check('E5. 再 advance 到 250 → 链式 second@200 结算', seen.includes('second@200'));
    }
    {
      const clock = createManualClock();
      const ac = new AbortController();
      let err;
      const p = clock.sleep(100, { signal: ac.signal }).catch((e) => {
        err = e;
      });
      ac.abort();
      ac.abort(); // 重复 abort
      await p;
      check('E5. manual sleep abort → reject(ClockAbortError)，重复 abort 只结算一次、pending 归零', err instanceof ClockAbortError && clock.pendingCount() === 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // F 段（C3-3）：退避重试 / 软 timeout / 每 attempt 降档 / 逻辑 vs 真实 fetch 峰值 /
  //              非法配置零副作用 / timeout scheduler 故障 = 受控业务 outcome（R2-C3-3-1）
  // ══════════════════════════════════════════════════════════════════════════

  // F1. 可重试(429)重试到成功：退避序列驱动、最终 succeeded、retry_count 精确 0、观测 attempts。
  {
    createSyncJob({ id: 'job-f1', requestedSince: 1000, accounts: [{ fakeid: 'acc-f1' }] });
    const clock = createManualClock();
    const { fetchPage, calls } = makeRoutingFetcher({
      'acc-f1': ({ call }) => {
        if (call <= 2) {
          const e = new Error('rate limited');
          e.status = 429;
          throw e;
        }
        return { articles: [article('f1-ok', 2000)], hasMore: false };
      },
    });
    const res = await runToSettle(
      runSyncJob('job-f1', { fetchPage, clock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d } }),
      clock
    );
    const acc = getJobAccount('job-f1', 'acc-f1');
    check('F1. 重试到成功 → succeeded', acc.status === 'succeeded');
    check('F1. fetcher 被调用 3 次（2×429 + 1 成功）', calls['acc-f1'] === 3);
    check('F1. 成功不 bump → retry_count 精确 0', acc.retryCount === 0);
    check('F1. 观测 attempts=3', res.accounts[0].attempts === 3);
    check('F1. 退避 sleep 注册 2 次（两次重试各一次）', clock.registeredCount() === 2);
    check('F1. job=completed', res.job.status === 'completed');
  }

  // F2. config_error（通道 A 抛）不重试 + 抛出型 attempt 也发信号（关闭 B1）。用 limit=1 顺序化 + healthy streak
  //     重置观测：cfg 若不发信号则 streak 不被打断、末尾 success 触发升档 → finalLimit 变 2（本用例断言 =1）。
  {
    createSyncJob({
      id: 'job-f2',
      requestedSince: 1000,
      accounts: [{ fakeid: 'f2-sa', priority: 9 }, { fakeid: 'f2-cfg', priority: 8 }, { fakeid: 'f2-sb', priority: 7 }],
    });
    const clock = createManualClock();
    const { fetchPage, calls } = makeRoutingFetcher({
      'f2-sa': () => ({ articles: [article('sa', 2000)], hasMore: false }),
      'f2-cfg': () => {
        throw new Error('通道A 不应触达 fetchPage');
      },
      'f2-sb': () => ({ articles: [article('sb', 2000)], hasMore: false }),
    });
    const res = await runToSettle(
      runSyncJobPool(
        'job-f2',
        { fetchPage, clock, resolveOptions: (acc) => (acc.fakeid === 'f2-cfg' ? { pageSize: 0 } : {}) },
        { levels: [1, 2], startIndex: 0, healthyStreakToRaise: 2 }
      ),
      clock
    );
    check('F2. 通道A config_error 账号零网络 failed', (calls['f2-cfg'] ?? 0) === 0 && getJobAccount('job-f2', 'f2-cfg').errorCode === 'config_error');
    check('F2. 抛出型 config_error attempt 确发信号（重置 healthy streak → 末尾 success 不升档 → finalLimit=1）', res.concurrency.finalLimit === 1);
    check('F2. 两正常账号 succeeded', getJobAccount('job-f2', 'f2-sa').status === 'succeeded' && getJobAccount('job-f2', 'f2-sb').status === 'succeeded');
    check('F2. config_error 不重试 → 零退避 sleep 注册', clock.registeredCount() === 0);
  }

  // F3. auth_required → 不退避不重试、账号 auth_required 终态、降到最低档。
  {
    createSyncJob({ id: 'job-f3', requestedSince: 1000, accounts: [{ fakeid: 'f3' }] });
    const clock = createManualClock();
    const { fetchPage, calls } = makeRoutingFetcher({
      f3: () => {
        const e = new Error('unauthorized');
        e.status = 401;
        throw e;
      },
    });
    const res = await runToSettle(
      runSyncJobPool('job-f3', { fetchPage, clock, retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d } }, { startIndex: 2, healthyStreakToRaise: 100000 }),
      clock
    );
    check('F3. auth_required 账号终态', getJobAccount('job-f3', 'f3').status === 'auth_required');
    check('F3. auth_required 不重试（fetcher 1 次，即便 maxAttempts=5）', calls['f3'] === 1);
    check('F3. auth_required 零退避 sleep', clock.registeredCount() === 0);
    check('F3. auth_required → 降到最低档 finalLimit=1', res.concurrency.finalLimit === 1);
  }

  // F4. per-page 软 timeout（B2 四路径 + 同步 throw）。
  // F4a. fetch 先赢（latency 50 < timeout 100）：succeeded + finally abort → 结束后 pending 定时器归零（守 fix-must-fail c）。
  {
    createSyncJob({ id: 'job-f4a', requestedSince: 1000, accounts: [{ fakeid: 'f4a' }] });
    const clock = createManualClock();
    const { fetchPage } = makeClockFetcher(clock, { f4a: { latencyMs: 50 } });
    const res = await advanceThenAwait(runSyncJob('job-f4a', { fetchPage, clock, timeoutMs: 100 }), clock, 60); // 推进到 60：fetch(50) 结算、timeout(100) 未到
    check('F4a. fetch 先赢 → succeeded', getJobAccount('job-f4a', 'f4a').status === 'succeeded' && res.job.status === 'completed');
    check('F4a. finally abort timeout 定时器 → 结束后 pending 归零（timeout 未空等到 100）', clock.pendingCount() === 0);
  }

  // F4b. timeout 先赢（latency 200 > timeout 100）：failed(timeout)、摘要 retryable=true。
  {
    createSyncJob({ id: 'job-f4b', requestedSince: 1000, accounts: [{ fakeid: 'f4b' }] });
    const clock = createManualClock();
    const { fetchPage } = makeClockFetcher(clock, { f4b: { latencyMs: 200 } });
    const res = await runToSettle(runSyncJob('job-f4b', { fetchPage, clock, timeoutMs: 100 }), clock);
    const acc = getJobAccount('job-f4b', 'f4b');
    check('F4b. timeout 先赢 → failed(timeout)', acc.status === 'failed' && acc.errorCode === 'timeout');
    check('F4b. 摘要 retryable=true（timeout 可重试）', res.accounts[0].retryable === true);
  }

  // F4c. timeout 先赢后底层 fetch 晚 resolve → 无第二 outcome（仍 failed/timeout）、retry_count 精确 1。
  {
    createSyncJob({ id: 'job-f4c', requestedSince: 1000, accounts: [{ fakeid: 'f4c' }] });
    const clock = createManualClock();
    const { fetchPage } = makeClockFetcher(clock, { f4c: { latencyMs: 200 } });
    await runToSettle(runSyncJob('job-f4c', { fetchPage, clock, timeoutMs: 100 }), clock);
    const acc = getJobAccount('job-f4c', 'f4c');
    check('F4c. timeout 先赢后 fetch 晚 resolve → 无第二 outcome（仍 failed/timeout）', acc.status === 'failed' && acc.errorCode === 'timeout');
    check('F4c. 单次 processAccount 落库一次 → retry_count 精确 1', acc.retryCount === 1);
  }

  // F4d. timeout 先赢后底层 fetch 晚 reject → 无第二 outcome + 无 unhandledRejection（race 已消费晚到 reject）。
  {
    createSyncJob({ id: 'job-f4d', requestedSince: 1000, accounts: [{ fakeid: 'f4d' }] });
    const clock = createManualClock();
    const uhBefore = c33Unhandled.length;
    const { fetchPage } = makeClockFetcher(clock, {
      f4d: {
        latencyMs: 200,
        throwAfter: () => {
          const e = new Error('fetch failed later');
          e.__c33tag = 'f4d-late';
          return e;
        },
      },
    });
    await runToSettle(runSyncJob('job-f4d', { fetchPage, clock, timeoutMs: 100 }), clock);
    const acc = getJobAccount('job-f4d', 'f4d');
    check('F4d. timeout 先赢后 fetch 晚 reject → 无第二 outcome（仍 failed/timeout）', acc.status === 'failed' && acc.errorCode === 'timeout');
    await new Promise((r) => setTimeout(r, 20));
    check('F4d. 晚到 fetch reject 无 unhandledRejection（race 已装 handler 消费）', !c33Unhandled.slice(uhBefore).includes('f4d-late'));
  }

  // F4e. fetcher 同步 throw：归类 api_error（500）且定时器仍清理。
  {
    createSyncJob({ id: 'job-f4e', requestedSince: 1000, accounts: [{ fakeid: 'f4e' }] });
    const clock = createManualClock();
    const fetchPage = () => {
      const e = new Error('sync boom');
      e.status = 500;
      throw e; // 同步 throw
    };
    await runToSettle(runSyncJob('job-f4e', { fetchPage, clock, timeoutMs: 100 }), clock);
    const acc = getJobAccount('job-f4e', 'f4e');
    check('F4e. fetcher 同步 throw → 归类 api_error（500）', acc.status === 'failed' && acc.errorCode === 'api_error');
    check('F4e. 同步 throw 也清定时器（结束后 pending=0）', clock.pendingCount() === 0);
  }

  // F5. 每次 attempt 降档（§2.5/B1）：单账号 429,429,succeeded → 中途两次 rate_limited 已把档降到 1，
  //     即便最终成功 finalLimit 仍=1（守 fix-must-fail d：若只在最终态发信号则只见 succeeded、finalLimit=4）。
  {
    createSyncJob({ id: 'job-f5', requestedSince: 1000, accounts: [{ fakeid: 'f5' }] });
    const clock = createManualClock();
    const { fetchPage, calls } = makeRoutingFetcher({
      f5: ({ call }) => {
        if (call <= 2) {
          const e = new Error('rl');
          e.status = 429;
          throw e;
        }
        return { articles: [article('f5ok', 2000)], hasMore: false };
      },
    });
    const res = await runToSettle(
      runSyncJobPool('job-f5', { fetchPage, clock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d } }, { startIndex: 2, healthyStreakToRaise: 100000 }),
      clock
    );
    check('F5. 中途 429 已降档：finalLimit=1（证明每 attempt 都发信号、非只看最终成功态）', res.concurrency.finalLimit === 1);
    check('F5. 账号最终 succeeded', getJobAccount('job-f5', 'f5').status === 'succeeded');
    check('F5. fetcher 3 次', calls['f5'] === 3);
  }

  // F6. 逻辑 worker 峰值 ≠ 真实 fetch 峰值（B3）：单账号软 timeout 恒超时 + 重试 → 旧 fetch 与新 fetch 重叠。
  {
    createSyncJob({ id: 'job-f6', requestedSince: 1000, accounts: [{ fakeid: 'f6' }] });
    const clock = createManualClock();
    const { fetchPage, active } = makeClockFetcher(clock, { f6: { latencyMs: 1000 } }); // 恒 > timeout(100)
    const res = await runToSettle(
      runSyncJobPool('job-f6', { fetchPage, clock, timeoutMs: 100, retry: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 50, jitter: (d) => d } }, { startIndex: 2, healthyStreakToRaise: 100000 }),
      clock
    );
    check('F6. 逻辑账号 worker 峰值=1（单账号）', res.concurrency.maxInFlight === 1);
    check('F6. 底层 fetch 活跃峰值=2（软 timeout 下旧 fetch 与重试新 fetch 重叠）', active.max === 2);
    check('F6. 逻辑 worker 峰值 < 底层 fetch 峰值（B3：二者可不同）', res.concurrency.maxInFlight < active.max);
    check('F6. 两次都超时 → failed(timeout)', getJobAccount('job-f6', 'f6').status === 'failed' && getJobAccount('job-f6', 'f6').errorCode === 'timeout');
  }

  // F7. maxAttempts 耗尽 → failed、末次 errorKind、retry_count 精确 1、摘要 retryable=true 但停止重试。
  {
    createSyncJob({ id: 'job-f7', requestedSince: 1000, accounts: [{ fakeid: 'acc-f7' }] });
    const clock = createManualClock();
    const { fetchPage, calls } = makeRoutingFetcher({
      'acc-f7': () => {
        const e = new Error('rl');
        e.status = 429;
        throw e; // 恒 429
      },
    });
    const res = await runToSettle(
      runSyncJob('job-f7', { fetchPage, clock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d } }),
      clock
    );
    const acc = getJobAccount('job-f7', 'acc-f7');
    check('F7. 耗尽 → failed', acc.status === 'failed');
    check('F7. 末次 errorKind=rate_limited', acc.errorCode === 'rate_limited');
    check('F7. fetcher 被调用 3 次（= maxAttempts）', calls['acc-f7'] === 3);
    check('F7. 耗尽 bump → retry_count 精确 1', acc.retryCount === 1);
    check('F7. 观测 attempts=3', res.accounts[0].attempts === 3);
    check('F7. 退避 sleep 注册 2 次（3 attempt 之间 2 次退避）', clock.registeredCount() === 2);
    check('F7. 摘要 retryable=true 但已停止重试', res.accounts[0].retryable === true);
    check('F7. job=failed', res.job.status === 'failed');
  }

  // F-gen. B4·可重放快照（fix-must-fail g）：knownAids 为一次性 generator，重试后仍去重（否则第二 attempt 去重失效）。
  {
    createSyncJob({ id: 'job-fg', requestedSince: 1000, accounts: [{ fakeid: 'fg' }] });
    const clock = createManualClock();
    function* knownGen() {
      yield 'dup-1';
      yield 'dup-2';
    }
    const { fetchPage, calls } = makeRoutingFetcher({
      fg: ({ call }) => {
        if (call === 1) {
          const e = new Error('rl');
          e.status = 429;
          throw e; // 首次 429 触发重试
        }
        return { articles: [article('dup-1', 2000), article('new-1', 1990)], hasMore: false }; // dup-1 应被去重
      },
    });
    const res = await runToSettle(
      runSyncJob('job-fg', { fetchPage, clock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, jitter: (d) => d }, resolveOptions: () => ({ knownAids: knownGen() }) }),
      clock
    );
    const acc = getJobAccount('job-fg', 'fg');
    check('F-gen. 重试后成功', acc.status === 'succeeded');
    check('F-gen. 一次性 generator 已快照 → 第二 attempt 仍去重（dup-1 去掉、仅 new-1 入账 newArticles=1）', acc.newArticles === 1);
    check('F-gen. fetcher 2 次（429 + 成功）', calls['fg'] === 2);
    check('F-gen. job=completed', res.job.status === 'completed');
  }

  // F8. 系统故障传播（B1/§2.8 调用点①，fix-must-fail f）：坏**退避** clock.sleep（窄 catch 外）→ 顺序版
  //     runSyncJob reject、故障账号不落 unexpected_error、job 不 finalize、后续账号不处理。
  {
    createSyncJob({ id: 'job-f8', requestedSince: 1000, accounts: [{ fakeid: 'f8-a', priority: 9 }, { fakeid: 'f8-b', priority: 1 }] });
    const badBackoffClock = {
      now: () => 0,
      sleep: () => {
        throw new Error('backoff clock failure');
      },
    };
    const { fetchPage, calls } = makeRoutingFetcher({
      'f8-a': () => {
        const e = new Error('rl');
        e.status = 429;
        throw e; // 429 可重试 → 触发退避 → 坏 clock 抛
      },
      'f8-b': () => ({ articles: [article('b', 2000)], hasMore: false }),
    });
    let rej;
    try {
      await runSyncJob('job-f8', { fetchPage, clock: badBackoffClock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 } });
    } catch (e) {
      rej = e;
    }
    check('F8. 坏退避 clock.sleep（窄 catch 外）→ 系统故障向上 reject（非账号 unexpected_error）', rej instanceof Error && /backoff clock failure/.test(rej.message));
    check('F8. 故障账号 f8-a 未落 unexpected_error 终态（保持 running）', getJobAccount('job-f8', 'f8-a').status === 'running');
    check('F8. job 未 finalize（保持 running，交 C3-5 恢复）', getSyncJob('job-f8').status === 'running');
    check('F8. 后续账号 f8-b 未处理（顺序版首账号故障即中断，保持 pending 零网络）', getJobAccount('job-f8', 'f8-b').status === 'pending' && (calls['f8-b'] ?? 0) === 0);
  }

  // F9. 默认 OFF 全等价（retry 缺省 + timeoutMs=undefined）：完全不触碰逻辑时钟 sleep、不包 withTimeout。
  {
    createSyncJob({ id: 'job-f9', requestedSince: 1000, accounts: [{ fakeid: 'f9-a', priority: 9 }, { fakeid: 'f9-b', priority: 1 }] });
    const clock = createManualClock();
    const { fetchPage } = makeRoutingFetcher({
      'f9-a': () => ({ articles: [article('a', 2000)], hasMore: false }),
      'f9-b': () => ({ articles: [article('b', 2000)], hasMore: false }),
    });
    const res = await runSyncJob('job-f9', { fetchPage, clock }); // 无 retry / 无 timeoutMs → 默认 OFF；无 clock.sleep 需推进
    check('F9. 默认 OFF：完全不触碰逻辑时钟 sleep（注册数=0）', clock.registeredCount() === 0);
    check('F9. 默认 OFF：全 succeeded、job completed', res.job.status === 'completed' && res.accounts.every((a) => a.status === 'succeeded'));
    check('F9. 默认 OFF：观测 attempts=1', res.accounts.every((a) => a.attempts === 1));
  }

  // F10. auth 聚合：单 auth → job=failed；success+auth → job=partial。
  {
    createSyncJob({ id: 'job-f10a', requestedSince: 1000, accounts: [{ fakeid: 'a10a' }] });
    const c1 = createManualClock();
    const { fetchPage: fp1 } = makeRoutingFetcher({
      a10a: () => {
        const e = new Error('401');
        e.status = 401;
        throw e;
      },
    });
    const r1 = await runSyncJob('job-f10a', { fetchPage: fp1, clock: c1 });
    check('F10a. 单 auth 账号 → job=failed', r1.job.status === 'failed');
    createSyncJob({ id: 'job-f10b', requestedSince: 1000, accounts: [{ fakeid: 'a10b-ok', priority: 9 }, { fakeid: 'a10b-auth', priority: 1 }] });
    const c2 = createManualClock();
    const { fetchPage: fp2 } = makeRoutingFetcher({
      'a10b-ok': () => ({ articles: [article('ok', 2000)], hasMore: false }),
      'a10b-auth': () => {
        const e = new Error('403');
        e.status = 403;
        throw e;
      },
    });
    const r2 = await runSyncJob('job-f10b', { fetchPage: fp2, clock: c2 });
    check('F10b. success+auth 混合 → job=partial', r2.job.status === 'partial');
  }

  // F11. 非法配置零持久副作用（R1-B2·B4 验收，fix-must-fail h）：顺序版 + 并发版注入非法 retry/timeout →
  //      reject(RangeError)、job 仍 queued、账号仍 pending、fetch=0、sleep=0（校验严格前置于 startJob）。
  {
    createSyncJob({ id: 'job-f11a', requestedSince: 1000, accounts: [{ fakeid: 'f11a' }] });
    const clock = createManualClock();
    const fa = makeRoutingFetcher({ f11a: () => ({ articles: [], hasMore: false }) });
    let rej;
    try {
      await runSyncJob('job-f11a', { fetchPage: fa.fetchPage, clock, retry: { maxAttempts: 0 } });
    } catch (e) {
      rej = e;
    }
    check('F11a. 顺序版非法 maxAttempts=0 → reject(RangeError)', rej instanceof RangeError);
    check('F11a. job 仍 queued（未 startJob）', getSyncJob('job-f11a').status === 'queued');
    check('F11a. 账号仍 pending、fetcher 0 次、sleep 0 次（零持久/网络副作用）', getJobAccount('job-f11a', 'f11a').status === 'pending' && Object.keys(fa.calls).length === 0 && clock.registeredCount() === 0);

    createSyncJob({ id: 'job-f11b', requestedSince: 1000, accounts: [{ fakeid: 'f11b' }] });
    const clock2 = createManualClock();
    const fb = makeRoutingFetcher({ f11b: () => ({ articles: [], hasMore: false }) });
    let rej2;
    try {
      await runSyncJobPool('job-f11b', { fetchPage: fb.fetchPage, clock: clock2, timeoutMs: -1 });
    } catch (e) {
      rej2 = e;
    }
    check('F11b. 并发版非法 timeoutMs=-1 → reject(RangeError)', rej2 instanceof RangeError);
    check('F11b. job 仍 queued、账号 pending、fetch=0、sleep=0', getSyncJob('job-f11b').status === 'queued' && getJobAccount('job-f11b', 'f11b').status === 'pending' && Object.keys(fb.calls).length === 0 && clock2.registeredCount() === 0);

    createSyncJob({ id: 'job-f11c', requestedSince: 1000, accounts: [{ fakeid: 'f11c' }] });
    const clock3 = createManualClock();
    const fcc = makeRoutingFetcher({ f11c: () => ({ articles: [], hasMore: false }) });
    let rej3;
    try {
      await runSyncJob('job-f11c', { fetchPage: fcc.fetchPage, clock: clock3, timeoutMs: 2_147_483_648 });
    } catch (e) {
      rej3 = e;
    }
    check('F11c. timeoutMs 超真实定时器上限 → reject(RangeError)、job 仍 queued', rej3 instanceof RangeError && getSyncJob('job-f11c').status === 'queued');
  }

  // F12. timeout scheduler 故障 = 受控业务 outcome（R2-C3-3-1，非 fatal/drain）。
  // F12a. scheduler 同步 throw：账号 failed(api_error)、job 正常 finalize、晚到 fetch reject 无 unhandledRejection
  //       （fix-must-fail i：退回裸 clock.sleep 会让 fetchP 成孤儿 → 本 unhandledRejection 断言变红）。
  {
    createSyncJob({ id: 'job-f12a', requestedSince: 1000, accounts: [{ fakeid: 'f12a' }] });
    const uhBefore = c33Unhandled.length;
    let lateReject;
    const controlled = new Promise((_resolve, reject) => {
      lateReject = reject;
    });
    const fetchPage = () => controlled; // 返回受控 pending promise（稍后 test 触发晚到 reject）
    const badTimeoutClock = {
      now: () => 0,
      sleep: () => {
        throw new Error('clock failure'); // 同步 throw（无 timeout/network 特征 → 兜底 api_error）
      },
    };
    const res = await runSyncJob('job-f12a', { fetchPage, clock: badTimeoutClock, timeoutMs: 100 });
    const acc = getJobAccount('job-f12a', 'f12a');
    check('F12a. scheduler 同步 throw → 账号 failed(api_error)（受控业务 outcome，非 fatal）', acc.status === 'failed' && acc.errorCode === 'api_error');
    check('F12a. job 正常 finalize=failed（未 drain/未保持 running）', res.job.status === 'failed');
    lateReject({ __c33tag: 'f12a-late', message: 'late fetch after abandon' }); // 触发孤儿候选 fetchP 的晚到 reject
    await new Promise((r) => setTimeout(r, 20));
    check('F12a. 晚到 fetch reject 无 unhandledRejection（fetchP 已进 race 被消费、非孤儿）', !c33Unhandled.slice(uhBefore).includes('f12a-late'));
  }

  // F12b. scheduler 异步 spurious reject（非 ClockAbortError、无 timeout/network 特征）→ 同 12a 归类 api_error、受控隔离。
  {
    createSyncJob({ id: 'job-f12b', requestedSince: 1000, accounts: [{ fakeid: 'f12b' }] });
    const uhBefore = c33Unhandled.length;
    let lateReject;
    const controlled = new Promise((_resolve, reject) => {
      lateReject = reject;
    });
    const fetchPage = () => controlled;
    const badTimeoutClock = {
      now: () => 0,
      sleep: () => Promise.reject(new Error('clock failure')), // 异步 spurious reject
    };
    const res = await runSyncJob('job-f12b', { fetchPage, clock: badTimeoutClock, timeoutMs: 100 });
    const acc = getJobAccount('job-f12b', 'f12b');
    check('F12b. scheduler spurious reject → 账号 failed(api_error)（受控业务 outcome）', acc.status === 'failed' && acc.errorCode === 'api_error');
    check('F12b. job 正常 finalize=failed', res.job.status === 'failed');
    lateReject({ __c33tag: 'f12b-late', message: 'late fetch' });
    await new Promise((r) => setTimeout(r, 20));
    check('F12b. 无 unhandledRejection', !c33Unhandled.slice(uhBefore).includes('f12b-late'));
  }

  // F12c. 对照：坏**退避** clock.sleep（窄 catch 外）→ 仍 fatal/drain（并发版 pool reject），证两调用点边界确不同。
  {
    createSyncJob({ id: 'job-f12c', requestedSince: 1000, accounts: [{ fakeid: 'f12c-a', priority: 9 }, { fakeid: 'f12c-b', priority: 8 }] });
    const badBackoffClock = {
      now: () => 0,
      sleep: () => {
        throw new Error('backoff clock failure');
      },
    };
    const { fetchPage } = makeRoutingFetcher({
      'f12c-a': () => {
        const e = new Error('rl');
        e.status = 429;
        throw e; // 429 → 退避 → 坏 clock 抛（窄 catch 外）
      },
      'f12c-b': () => ({ articles: [article('b', 2000)], hasMore: false }),
    });
    let rej;
    try {
      await runSyncJobPool('job-f12c', { fetchPage, clock: badBackoffClock, retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 } }, { startIndex: 2, healthyStreakToRaise: 100000 });
    } catch (e) {
      rej = e;
    }
    check('F12c. 对照：坏退避 clock → pool fatal-drain reject（≠ timeout scheduler 的受控 outcome）', rej instanceof Error && /backoff clock failure/.test(rej.message));
    check('F12c. job 未 finalize（保持 running）', getSyncJob('job-f12c').status === 'running');
  }

  check('F12. 全程无残留 unhandledRejection（正确实现下 c33Unhandled 为空）', c33Unhandled.length === 0);

  console.log(`\nPASS smoke_mp_sync_runner: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_runner:', err && err.stack ? err.stack : err);
  cleanupDb();
  process.exit(1);
}

cleanupDb();
