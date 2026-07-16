// 纯离线 smoke：C3-1 mp-sync-runner（核心编排循环 + classifyAccountResult 纯函数）。
//
// 直连 runner + 仓库层 + 真实 syncSingleAccount（不起 server、不发网络、不碰真实 .data）：
//   - A 段：classifyAccountResult 单测，合成输入覆盖 succeeded / 各 errorKind / 未知 kind fail-closed /
//           通道 A(SyncConfigError) / 未预期抛错。
//   - B 段：runSyncJob 集成，临时 SQLite + 注入假 fetcher + resolveOptions 触发**真实** service 的
//           通道 A(pageSize=0) 与 通道 B(游标溢出)；覆盖正常 succeeded 终态、空 job、失败隔离、
//           零网络、优先级顺序、单次尝试不重试、finalize 三态。
//
// 运行（需 node:sqlite；Node 25 默认可用，Node 22.18+ 类型剥离默认开）：
//   node --experimental-sqlite tools/smoke_mp_sync_runner.mjs

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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

  console.log(`\nPASS smoke_mp_sync_runner: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_runner:', err && err.stack ? err.stack : err);
  cleanupDb();
  process.exit(1);
}

cleanupDb();
