// 纯离线 smoke：C2 mp-sync-service（单账号分页同步逻辑，注入 fake fetcher，无网络无库）。
//
// 覆盖：分页翻页、时间边界停止、aid/URL 去重（含重叠窗口幂等）、maxPages 上限、断点续跑游标、
//       lastArticleTime 计算、错误分类（429/超时/auth_required/network/api_error/SyncFetchError）、
//       单账号失败隔离（返回带分类错误的 outcome 而非抛出）、重叠窗口计算、deriveAidFromUrl。
//
// 运行：node tools/smoke_mp_sync_service.mjs   （纯逻辑，无需 --experimental-sqlite）

import assert from 'node:assert/strict';

const svc = await import('../server/utils/mp-sync-service.ts');
const { syncSingleAccount, classifyFetchError, computeSinceWithOverlap, deriveAidFromUrl, SyncFetchError } = svc;

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
}

// 造文章：createTime 递减（越新的 begin 越小），aid 唯一，link 带 mid。
function article(aid, createTime, link) {
  return { aid, link: link ?? `https://mp.weixin.qq.com/s?mid=${aid}&idx=1`, title: `t-${aid}`, createTime };
}

// 按 begin/size 索引的 fake 分页器。
function pagedFetcher(pages) {
  return async ({ begin, size }) => {
    const idx = Math.floor(begin / size);
    return pages[idx] ?? { articles: [], hasMore: false };
  };
}

try {
  // ── 1. 基础分页 + 末页(hasMore=false)停止 ─────────────────────────────
  const f1 = pagedFetcher([
    { articles: [article('a1', 2000), article('a2', 1990)], hasMore: true },
    { articles: [article('a3', 1980), article('a4', 1970)], hasMore: false },
  ]);
  const r1 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 2 }, f1);
  check('1. 成功', r1.status === 'succeeded');
  check('1. 收全 4 篇', r1.newArticles.length === 4);
  check('1. 翻 2 页', r1.pagesFetched === 2);
  check('1. lastArticleTime=最大 create_time', r1.lastArticleTime === 2000);

  // ── 2. 时间边界停止：遇旧文章即停，不再翻页 ───────────────────────────
  const f2 = pagedFetcher([
    { articles: [article('b1', 2000), article('b2', 900)], hasMore: true }, // b2 < since=1000 触发停
    { articles: [article('b3', 2100)], hasMore: true }, // 不应被拉取
  ]);
  const r2 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 2 }, f2);
  check('2. 只翻 1 页（遇旧即停）', r2.pagesFetched === 1);
  check('2. 只收 >=since 的 b1', r2.newArticles.length === 1 && r2.newArticles[0].aid === 'b1');

  // ── 3. aid 去重（已知 + 页内重复）─────────────────────────────────────
  const f3 = pagedFetcher([
    { articles: [article('c1', 2000), article('c1', 1999), article('c2', 1998)], hasMore: false },
  ]);
  const r3 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 3, knownAids: ['c2'] }, f3);
  check(
    '3. 已知 c2 被去重、页内重复 c1 只留一次 -> 仅 c1',
    r3.newArticles.length === 1 && r3.newArticles[0].aid === 'c1'
  );

  // ── 4. URL 去重（aid 不同但 link 已知）────────────────────────────────
  const dupLink = 'https://mp.weixin.qq.com/s?mid=999&idx=1';
  const f4 = pagedFetcher([{ articles: [article('d1', 2000, dupLink), article('d2', 1999)], hasMore: false }]);
  const r4 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 2, knownLinks: [dupLink] }, f4);
  check('4. 已知 URL 被去重 -> 仅 d2', r4.newArticles.length === 1 && r4.newArticles[0].aid === 'd2');

  // ── 5. maxPages 上限（防无限翻页）────────────────────────────────────
  const fInfinite = async ({ begin, size }) => ({
    articles: [article(`e${begin}`, 5000 + begin)],
    hasMore: true,
  });
  const r5 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 1, maxPages: 3 }, fInfinite);
  check('5. maxPages=3 命中上限停止', r5.pagesFetched === 3);

  // ── 6. 断点续跑游标 ───────────────────────────────────────────────────
  const f6 = pagedFetcher([
    { articles: [article('g1', 2000)], hasMore: true },
    { articles: [article('g2', 1990)], hasMore: true },
    { articles: [article('g3', 1980)], hasMore: false },
  ]);
  const r6 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 1, startBegin: 1 }, f6);
  check('6. 从 begin=1 续跑，跳过 g1 -> 收 g2,g3', r6.newArticles.map(a => a.aid).join(',') === 'g2,g3');

  // ── 7. 错误分类 classifyFetchError ────────────────────────────────────
  check('7. HTTP 429 -> rate_limited', classifyFetchError({ status: 429 }) === 'rate_limited');
  check('7. HTTP 401 -> auth_required', classifyFetchError({ status: 401 }) === 'auth_required');
  check('7. HTTP 403 -> auth_required', classifyFetchError({ statusCode: 403 }) === 'auth_required');
  check('7. AbortError -> timeout', classifyFetchError({ name: 'AbortError' }) === 'timeout');
  check('7. ETIMEDOUT -> timeout', classifyFetchError({ code: 'ETIMEDOUT' }) === 'timeout');
  check('7. message timeout -> timeout', classifyFetchError(new Error('socket timeout')) === 'timeout');
  check('7. ECONNREFUSED -> network', classifyFetchError({ code: 'ECONNREFUSED' }) === 'network');
  check('7. "fetch failed" -> network', classifyFetchError(new Error('fetch failed')) === 'network');
  check(
    '7. SyncFetchError 保留 kind',
    classifyFetchError(new SyncFetchError('auth_required', 'x')) === 'auth_required'
  );
  check('7. 未知 -> api_error 兜底', classifyFetchError(new Error('some api error')) === 'api_error');

  // ── 8. 单账号失败隔离：第 2 页抛错 -> 返回 failed，不抛出，保留已收 ────
  let calls = 0;
  const fFail = async ({ begin, size }) => {
    calls += 1;
    if (calls === 1) return { articles: [article('h1', 2000)], hasMore: true };
    throw new SyncFetchError('rate_limited', '429 Too Many Requests');
  };
  const r8 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: 1 }, fFail);
  check('8. 失败返回 status=failed（rate_limited 非 auth）', r8.status === 'failed');
  check('8. errorKind=rate_limited', r8.errorKind === 'rate_limited');
  check(
    '8. 保留第 1 页已收 h1（失败隔离，不丢部分结果）',
    r8.newArticles.length === 1 && r8.newArticles[0].aid === 'h1'
  );

  // ── 9. auth_required 单独态 ───────────────────────────────────────────
  const fAuth = async () => {
    throw new SyncFetchError('auth_required', 'session expired');
  };
  const r9 = await syncSingleAccount({ fakeid: 'acc', sinceTime: 1000 }, fAuth);
  check('9. auth 失败 -> status=auth_required', r9.status === 'auth_required' && r9.errorKind === 'auth_required');

  // ── 10. 重叠窗口计算 ──────────────────────────────────────────────────
  check('10. overlap 正常', computeSinceWithOverlap(1700000000, 3600) === 1700000000 - 3600);
  check('10. overlap 不下溢负数', computeSinceWithOverlap(1000, 5000) === 0);

  // ── 11. deriveAidFromUrl（移植自 credential 通道口径）──────────────────
  check('11. mid+idx -> mid_idx', deriveAidFromUrl('https://mp.weixin.qq.com/s?mid=222&idx=2') === '222_2');
  check('11. idx 缺省=1', deriveAidFromUrl('https://mp.weixin.qq.com/s?mid=333') === '333_1');
  check('11. 无 mid -> 空串', deriveAidFromUrl('https://mp.weixin.qq.com/s?idx=1') === '');
  check('11. 非法 URL -> 空串', deriveAidFromUrl('not a url') === '');

  // ── 12. 重叠窗口幂等：重叠区间已知文章不重复收 ────────────────────────
  const f12 = pagedFetcher([{ articles: [article('k1', 1700003600), article('k2', 1700000000)], hasMore: false }]);
  const since12 = computeSinceWithOverlap(1700000000, 3600); // 拉回窗口
  const r12 = await syncSingleAccount({ fakeid: 'acc', sinceTime: since12, pageSize: 2, knownAids: ['k2'] }, f12);
  check('12. 重叠区已知 k2 去重 -> 仅新 k1', r12.newArticles.length === 1 && r12.newArticles[0].aid === 'k1');

  // ── 13. N-C2-1：非法分页参数 fail-fast（安全正整数硬校验 + 零网络调用）──
  //   fix-must-fail：若移除服务里的 assertPositiveIntParam，pageSize=0（空翻）/ maxPages=0（零请求）
  //   会返回 succeeded 而非 reject，下列 assert.rejects 将变红。
  //   F-N-C2-1 加固：MAX_SAFE_INTEGER+1 / MAX_VALUE 等「有限但不安全」整数被 Number.isInteger 判 true，
  //   却会让 begin 算术溢出到 Infinity 仍伪装 succeeded；改用 Number.isSafeInteger 后被拒。若把服务里的
  //   isSafeInteger 退回 isInteger，下面 UNSAFE 两个用例将精确变红（Missing expected rejection）。
  let n13calls = 0;
  const fCount = async () => {
    n13calls += 1;
    return { articles: [], hasMore: false };
  };
  const UNSAFE = [Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE];
  for (const bad of [0, -1, 2.5, NaN, Infinity, ...UNSAFE]) {
    await assert.rejects(
      syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, pageSize: bad }, fCount),
      /pageSize 必须为安全正整数/,
      `13. pageSize=${bad} 应 fail-fast`
    );
    passed += 1;
  }
  for (const bad of [0, -1, 1.5, NaN, Infinity, ...UNSAFE]) {
    await assert.rejects(
      syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, maxPages: bad }, fCount),
      /maxPages 必须为安全正整数/,
      `13. maxPages=${bad} 应 fail-fast`
    );
    passed += 1;
  }
  check('13. 非法分页参数零网络调用（fetchPage 未触发）', n13calls === 0);
  const r13 = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, pageSize: 2, maxPages: 5 },
    pagedFetcher([{ articles: [article('z1', 2000)], hasMore: false }])
  );
  check('13. 合法正整数分页参数仍 succeeded', r13.status === 'succeeded' && r13.newArticles.length === 1);
  // 参数校验层：pageSize=MAX_SAFE_INTEGER 作为「参数」被校验接受（不抛 RangeError）。
  //   注意：此处空页立即停止，仅证「参数被接受」，不证游标累加安全——累加安全见 13c，勿据此声称「边界精确」。
  const rParamMax = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, pageSize: Number.MAX_SAFE_INTEGER, maxPages: 3 },
    async () => ({ articles: [], hasMore: false })
  );
  check('13. 参数 MAX_SAFE_INTEGER 通过校验被接受（空页即停，仅证参数接受）', rParamMax.status === 'succeeded');

  // ── 13c. F-N-C2-1（累加闭包）：pageSize 安全但多次 begin+=pageSize 使游标越界 → fail-closed ──
  //   fix-must-fail：移除服务里循环内 `begin > MAX_SAFE_INTEGER - pageSize` 的游标 guard 后，
  //   第 3 次 fetch 的 begin = 2*MAX_SAFE_INTEGER（非安全整数）且最终仍 succeeded，
  //   下面「fetcher 从未收到非安全整数 begin」将精确变红。
  const beginsSeen = [];
  const fOverflow = async ({ begin: b }) => {
    beginsSeen.push(b);
    return { articles: [article(`ov${b}`, 5000)], hasMore: true };
  };
  const rOv = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, pageSize: Number.MAX_SAFE_INTEGER, maxPages: 3 },
    fOverflow
  );
  check('13c. 游标累加：fetcher 从未收到非安全整数 begin', beginsSeen.every(b => Number.isSafeInteger(b)));
  check('13c. 游标累加：只发生 2 次 fetch（第 3 次不安全，未发起）', beginsSeen.length === 2);
  check(
    '13c. 游标累加：begin 序列 = [0, MAX_SAFE_INTEGER]',
    beginsSeen[0] === 0 && beginsSeen[1] === Number.MAX_SAFE_INTEGER
  );
  check('13c. 游标累加：fail-closed 绝不返回 succeeded', rOv.status !== 'succeeded');
  check('13c. 游标累加：status=failed', rOv.status === 'failed');
  check('13c. 游标累加：pageCursor 仍是安全整数', Number.isSafeInteger(rOv.pageCursor));
  check(
    '13c. 游标累加：保留最后一个安全 pageCursor=MAX_SAFE_INTEGER',
    rOv.pageCursor === Number.MAX_SAFE_INTEGER
  );

  // ── 13d. F-N-C2-1：startBegin 非负安全整数 fail-fast（零网络）+ 合法边界 ──
  //   原实现 Math.max(0, startBegin ?? 0) 会静默放行 Infinity / 非安全整数、并把负数 clamp 成 0。
  let sbCalls = 0;
  const fSb = async () => {
    sbCalls += 1;
    return { articles: [], hasMore: false };
  };
  for (const bad of [Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, -1, 2.5, NaN]) {
    await assert.rejects(
      syncSingleAccount({ fakeid: 'acc', sinceTime: 1000, startBegin: bad }, fSb),
      /startBegin 必须为非负安全整数/,
      `13d. startBegin=${bad} 应 fail-fast`
    );
    passed += 1;
  }
  check('13d. startBegin 非法零网络调用（fetchPage 未触发）', sbCalls === 0);
  const rSb0 = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, startBegin: 0, pageSize: 2 },
    pagedFetcher([{ articles: [article('sb0', 2000)], hasMore: false }])
  );
  check('13d. startBegin=0 合法 succeeded', rSb0.status === 'succeeded' && rSb0.newArticles.length === 1);
  const rSbMax = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, startBegin: Number.MAX_SAFE_INTEGER, pageSize: 2 },
    async () => ({ articles: [article('sbm', 2000)], hasMore: false })
  );
  check(
    '13d. startBegin=MAX_SAFE_INTEGER 合法边界 succeeded 且 pageCursor 安全',
    rSbMax.status === 'succeeded' &&
      Number.isSafeInteger(rSbMax.pageCursor) &&
      rSbMax.pageCursor === Number.MAX_SAFE_INTEGER
  );

  console.log(`\nPASS smoke_mp_sync_service: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_sync_service:', err && err.stack ? err.stack : err);
  process.exit(1);
}
