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
const { runSyncJob, classifyAccountResult } = runner;

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

  console.log(`\nPASS smoke_mp_sync_runner: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_runner:', err && err.stack ? err.stack : err);
  cleanupDb();
  process.exit(1);
}

cleanupDb();
