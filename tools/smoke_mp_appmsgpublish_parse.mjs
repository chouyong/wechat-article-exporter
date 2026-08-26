// 纯离线 smoke：C3-7a mp-appmsgpublish-parse（微信 /appmsgpublish 响应映射纯层）。
//
// 全离线、零网络、零凭据、零库。覆盖：
//   - 正常多文章页 / 空页（原生空 + 全无 publish_info）
//   - ret 200003（auth_required 不可重试）/ 限流 200013（rate_limited 可重试）
//   - timeout / network error（cause 传输层）/ 非 2xx（429/401/403/500）
//   - 未知 ret（fail-closed api_error 不可重试）
//   - 畸形 JSON / 畸形结构 / 关键字段（aid/link/create_time）缺失或非法
//   - aid / createTime / hasMore 规范化口径锁定（hasMore 以过滤后 publish_list 条目计，非文章数、非 size）
//   - 「凭据失效不会进入无限重试」精确断言（classify 层 + 经真实 syncSingleAccount 的端到端链）
//   - 诊断信息保留 + 无敏感字段
//   - 无声成功防御：所有错误态都抛，绝不返回 FetchPageResult
//
// 运行（纯逻辑，无需 --experimental-sqlite；Node 22.18+ / 25 默认开类型剥离直接 import .ts）：
//   node tools/smoke_mp_appmsgpublish_parse.mjs

import assert from 'node:assert/strict';

const parseMod = await import('../server/utils/mp-appmsgpublish-parse.ts');
const {
  parseAppmsgpublishResponse,
  classifyAppmsgpublishError,
  APPMSGPUBLISH_RATE_LIMIT_RETS,
  APPMSGPUBLISH_AUTH_REQUIRED_RET,
} = parseMod;

const svc = await import('../server/utils/mp-sync-service.ts');
const { syncSingleAccount, isRetryableErrorKind, SyncFetchError } = svc;

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
}
/** 断言 fn() 抛出 SyncFetchError 且 kind 命中；返回该错误供进一步断言。 */
function throwsKind(desc, fn, kind) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  check(`${desc} - 抛出`, err !== undefined);
  check(`${desc} - 是 SyncFetchError`, err instanceof SyncFetchError);
  check(`${desc} - kind=${kind}`, err && err.kind === kind);
  return err;
}

// ── fixture builders ─────────────────────────────────────────────────────────
function ex(aid, createTime, over = {}) {
  return {
    aid,
    link: `https://mp.weixin.qq.com/s?mid=${aid}&idx=1`,
    title: `t-${aid}`,
    author_name: `au-${aid}`,
    digest: `dg-${aid}`,
    create_time: createTime,
    update_time: createTime + 5,
    is_deleted: false,
    ...over,
  };
}
function publishItem(appmsgexArr) {
  return { publish_type: 9, publish_info: JSON.stringify({ appmsgex: appmsgexArr }) };
}
function rawSuccess(publishListItems, pageOver = {}) {
  return {
    base_resp: { ret: 0, err_msg: 'ok' },
    publish_page: JSON.stringify({ publish_list: publishListItems, total_count: 123, ...pageOver }),
  };
}
function rawRet(ret, errMsg) {
  return { base_resp: { ret, err_msg: errMsg }, publish_page: '' };
}

try {
  // ═══ 1. 正常多文章页：多 publish_list 条目、单条含多 appmsgex ══════════════════
  const r1 = parseAppmsgpublishResponse(
    rawSuccess([publishItem([ex('a1', 2000), ex('a2', 1990)]), publishItem([ex('a3', 1980)])])
  );
  check('1. 收全 3 篇（跨 2 条 publish_list 的 flatMap）', r1.articles.length === 3);
  check('1. hasMore=true（过滤后 publish_list 条目数 2 > 0）', r1.hasMore === true);
  check('1. aid=原生 AppMsgEx.aid', r1.articles[0].aid === 'a1' && r1.articles[2].aid === 'a3');
  check(
    '1. createTime=create_time（epoch 秒）',
    r1.articles[0].createTime === 2000 && r1.articles[1].createTime === 1990
  );
  check(
    '1. 可选字段映射',
    r1.articles[0].title === 't-a1' && r1.articles[0].authorName === 'au-a1' && r1.articles[0].digest === 'dg-a1'
  );
  check('1. updateTime / isDeleted 映射', r1.articles[0].updateTime === 2005 && r1.articles[0].isDeleted === false);
  check('1. link 来自原生 link', r1.articles[0].link === 'https://mp.weixin.qq.com/s?mid=a1&idx=1');

  // ═══ 2. hasMore 口径锁定：以 publish_list 条目计数，非文章数、非请求 size ═══════
  // 单条 publish_list 内含 3 篇 → 文章数 3、但 publish_list 条目数 1 → hasMore=true。
  const r2 = parseAppmsgpublishResponse(rawSuccess([publishItem([ex('b1', 3000), ex('b2', 2999), ex('b3', 2998)])]));
  check('2. 单条 publish_list 含 3 篇 → articles=3', r2.articles.length === 3);
  check('2. hasMore=true 由条目数(=1)>0 决定，与文章数(3)/size 无关', r2.hasMore === true);

  // ═══ 3. 空页 ══════════════════════════════════════════════════════════════
  // 3a：原生空 publish_list。
  const r3a = parseAppmsgpublishResponse(rawSuccess([]));
  check('3a. 原生空页 articles=[]', r3a.articles.length === 0);
  check('3a. 原生空页 hasMore=false', r3a.hasMore === false);
  // 3b：publish_list 有条目但全无 publish_info（被 !!publish_info 过滤）→ 视为空（完成）。
  const r3b = parseAppmsgpublishResponse(rawSuccess([{ publish_type: 0 }, { publish_type: 0, publish_info: '' }]));
  check('3b. 全无 publish_info 被过滤 → articles=[]', r3b.articles.length === 0);
  check('3b. 全无 publish_info → hasMore=false（同 getArticleList 完成判定）', r3b.hasMore === false);
  // 3c：混合——有的带 publish_info（保留、计入 hasMore），有的不带（过滤）。
  const r3c = parseAppmsgpublishResponse(rawSuccess([{ publish_type: 0 }, publishItem([ex('c1', 1000)])]));
  check(
    '3c. 混合：只 flatMap 带 publish_info 的条目 → 1 篇',
    r3c.articles.length === 1 && r3c.articles[0].aid === 'c1'
  );
  check('3c. 混合：hasMore 以过滤后条目(=1)计 → true', r3c.hasMore === true);

  // ═══ 4. ret 200003 → auth_required（凭据失效不可重试）══════════════════════
  check('4. 常量 APPMSGPUBLISH_AUTH_REQUIRED_RET=200003', APPMSGPUBLISH_AUTH_REQUIRED_RET === 200003);
  const e4parse = throwsKind(
    '4. parse(ret=200003)',
    () => parseAppmsgpublishResponse(rawRet(200003, 'invalid session')),
    'auth_required'
  );
  const e4cls = classifyAppmsgpublishError({ ret: 200003, errMsg: 'invalid session' });
  check('4. classify(ret=200003).kind=auth_required', e4cls.kind === 'auth_required');
  check('4. auth_required 不可重试（RETRY_POLICY）', isRetryableErrorKind('auth_required') === false);
  check(
    '4. 诊断保留 ret + 已知 err_msg',
    e4parse.message.includes('200003') && e4parse.message.includes('invalid session')
  );
  check('4. code=ret:200003', e4cls.code === 'ret:200003');

  // ═══ 5. 限流 200013 → rate_limited（可重试）════════════════════════════════
  check('5. 200013 在限流单一事实源集合内', APPMSGPUBLISH_RATE_LIMIT_RETS.has(200013));
  throwsKind('5. parse(ret=200013)', () => parseAppmsgpublishResponse(rawRet(200013, 'freq control')), 'rate_limited');
  const e5 = classifyAppmsgpublishError({ ret: 200013, errMsg: 'freq control' });
  check('5. classify(ret=200013).kind=rate_limited', e5.kind === 'rate_limited');
  check('5. rate_limited 可重试', isRetryableErrorKind('rate_limited') === true);

  // ═══ 6. timeout（cause 传输层）════════════════════════════════════════════
  const e6a = classifyAppmsgpublishError({
    cause: Object.assign(new Error('operation timed out'), { name: 'TimeoutError' }),
  });
  check('6a. TimeoutError → timeout', e6a.kind === 'timeout');
  const e6b = classifyAppmsgpublishError({ cause: Object.assign(new Error('abort'), { name: 'AbortError' }) });
  check('6b. AbortError → timeout', e6b.kind === 'timeout');
  const e6c = classifyAppmsgpublishError({
    cause: Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  check('6c. UND_ERR_CONNECT_TIMEOUT → timeout', e6c.kind === 'timeout');
  check('6. timeout 可重试', isRetryableErrorKind('timeout') === true);
  check('6. cause.code 透传', e6c.code === 'UND_ERR_CONNECT_TIMEOUT');

  // ═══ 7. network error（cause 传输层）══════════════════════════════════════
  const e7a = classifyAppmsgpublishError({ cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  check('7a. ECONNRESET → network', e7a.kind === 'network');
  const e7b = classifyAppmsgpublishError({ cause: new Error('fetch failed') });
  check('7b. "fetch failed" → network', e7b.kind === 'network');
  check('7. network 可重试', isRetryableErrorKind('network') === true);

  // ═══ 8. 非 2xx HTTP ═══════════════════════════════════════════════════════
  check('8a. 429 → rate_limited', classifyAppmsgpublishError({ httpStatus: 429 }).kind === 'rate_limited');
  check('8b. 401 → auth_required', classifyAppmsgpublishError({ httpStatus: 401 }).kind === 'auth_required');
  check('8c. 403 → auth_required', classifyAppmsgpublishError({ httpStatus: 403 }).kind === 'auth_required');
  const e8d = classifyAppmsgpublishError({ httpStatus: 500 });
  check('8d. 500 → api_error', e8d.kind === 'api_error');
  check('8d. 500 不可重试（fail-closed）', isRetryableErrorKind(e8d.kind) === false);
  check('8d. code=http:500', e8d.code === 'http:500');
  check(
    '8e. 200(2xx) 不应被判非 2xx 错误路径 → 无 httpStatus 分支命中，落 unclassified api_error',
    classifyAppmsgpublishError({ httpStatus: 200 }).code === 'unclassified'
  );

  // ═══ 9. 未知 ret → fail-closed api_error（不可重试）════════════════════════
  const e9parse = throwsKind(
    '9. parse(未知 ret=200002)',
    () => parseAppmsgpublishResponse(rawRet(200002, 'invalid args')),
    'api_error'
  );
  check('9. 未知 ret 不可重试', isRetryableErrorKind(e9parse.kind) === false);
  const e9b = classifyAppmsgpublishError({ ret: 999999, errMsg: 'whatever' });
  check('9. classify(未知 ret=999999) → api_error', e9b.kind === 'api_error');
  check('9. 未知 ret 保留诊断', e9b.message.includes('999999'));

  // ═══ 10. 畸形 JSON ════════════════════════════════════════════════════════
  const e10a = throwsKind(
    '10a. publish_page 非法 JSON',
    () => parseAppmsgpublishResponse({ base_resp: { ret: 0 }, publish_page: '{ not json' }),
    'api_error'
  );
  check('10a. code=malformed_response', e10a.code === 'malformed_response');
  throwsKind(
    '10b. publish_info 非法 JSON',
    () => parseAppmsgpublishResponse(rawSuccess([{ publish_type: 9, publish_info: '{bad' }])),
    'api_error'
  );

  // ═══ 11. 畸形结构 ═════════════════════════════════════════════════════════
  throwsKind('11a. raw=null', () => parseAppmsgpublishResponse(null), 'api_error');
  throwsKind('11b. raw={}（无 base_resp）', () => parseAppmsgpublishResponse({}), 'api_error');
  throwsKind('11c. base_resp.ret 非数字', () => parseAppmsgpublishResponse({ base_resp: { ret: 'x' } }), 'api_error');
  throwsKind('11d. ret=0 但缺 publish_page', () => parseAppmsgpublishResponse({ base_resp: { ret: 0 } }), 'api_error');
  throwsKind(
    '11e. publish_list 非数组',
    () => parseAppmsgpublishResponse({ base_resp: { ret: 0 }, publish_page: JSON.stringify({ publish_list: 'x' }) }),
    'api_error'
  );
  throwsKind(
    '11f. appmsgex 非数组',
    () =>
      parseAppmsgpublishResponse(rawSuccess([{ publish_type: 9, publish_info: JSON.stringify({ appmsgex: 'x' }) }])),
    'api_error'
  );
  throwsKind(
    '11g. appmsgex 条目缺 aid',
    () => parseAppmsgpublishResponse(rawSuccess([publishItem([{ link: 'https://x', create_time: 1 }])])),
    'api_error'
  );
  throwsKind(
    '11h. appmsgex 条目缺 link',
    () => parseAppmsgpublishResponse(rawSuccess([publishItem([{ aid: 'z', create_time: 1 }])])),
    'api_error'
  );
  throwsKind(
    '11i. appmsgex 条目缺 create_time',
    () => parseAppmsgpublishResponse(rawSuccess([publishItem([{ aid: 'z', link: 'https://x' }])])),
    'api_error'
  );
  throwsKind(
    '11j. create_time=NaN',
    () => parseAppmsgpublishResponse(rawSuccess([publishItem([ex('z', Number.NaN)])])),
    'api_error'
  );
  throwsKind(
    '11k. create_time=Infinity',
    () => parseAppmsgpublishResponse(rawSuccess([publishItem([ex('z', Number.POSITIVE_INFINITY)])])),
    'api_error'
  );
  throwsKind('11l. aid 空串', () => parseAppmsgpublishResponse(rawSuccess([publishItem([ex('', 100)])])), 'api_error');

  // ═══ 12. 无输入兜底 → api_error 'unclassified'（绝不默认可重试）═════════════
  const e12 = classifyAppmsgpublishError({});
  check('12. 空输入 → api_error', e12.kind === 'api_error');
  check('12. 空输入 code=unclassified', e12.code === 'unclassified');
  check('12. 空输入不可重试', isRetryableErrorKind(e12.kind) === false);

  // ═══ 13. 诊断保留 + 无敏感字段 ════════════════════════════════════════════
  for (const e of [e4cls, e5, e8d, e9b, e12]) {
    check('13. 消息不含 cookie/凭据字样', !/cookie|pass_ticket|credential|token=/i.test(e.message));
  }
  // err_msg 同样来自不受信任微信响应：只有固定诊断词允许保留，敏感自由文本必须在分类层丢弃。
  const secretErrMsg = 'Cookie=SESSIONID=SECRET; Authorization: Bearer SUPERSECRETTOKEN; pass_ticket=TICKET123';
  const redactedErr = classifyAppmsgpublishError({ ret: 200002, errMsg: secretErrMsg });
  check(
    '13. 敏感 err_msg 不进入分类错误消息',
    !/SECRET|pass_ticket|Bearer|Authorization|Cookie=/i.test(redactedErr.message)
  );
  check('13. 敏感 err_msg 不影响错误 kind/code', redactedErr.kind === 'api_error' && redactedErr.code === 'ret:200002');
  const redactedHttp = classifyAppmsgpublishError({ httpStatus: 500, errMsg: secretErrMsg });
  check(
    '13. 敏感 err_msg 不进入 HTTP 错误消息',
    !/SECRET|pass_ticket|Bearer|Authorization|Cookie=/i.test(redactedHttp.message)
  );

  // ═══ 14. 凭据失效不进入无限重试：经真实 syncSingleAccount 的端到端链 ═════════
  // fetcher 抛 parse 出的 auth_required SyncFetchError → service catch → classifyFetchError → auth_required
  // → outcome.status='auth_required' → runner 侧 isRetryableErrorKind=false → runWithRetry 落终态、不退避。
  const authFetcher = async () => parseAppmsgpublishResponse(rawRet(200003, 'invalid session'));
  const outcome = await syncSingleAccount({ fakeid: 'acc', sinceTime: 0, pageSize: 5, maxPages: 500 }, authFetcher);
  check('14. outcome.status=auth_required', outcome.status === 'auth_required');
  check('14. outcome.errorKind=auth_required', outcome.errorKind === 'auth_required');
  check('14. auth_required 不可重试 → runner 不会无限重试', isRetryableErrorKind(outcome.errorKind) === false);
  // 首次 fetchPage 即抛 auth 错误：syncSingleAccount 的 pagesFetched+=1 在 await 之后、未执行 → 0；
  // 关键在于未重试、未继续翻页（单次尝试即落 auth_required 终态）。
  check('14. 单次抓取即终止、未重试翻页（pagesFetched=0，抛错在计数前）', outcome.pagesFetched === 0);

  // ═══ 15. 成功页也经真实 syncSingleAccount 端到端消费（口径互通）═══════════════
  const pageFetcher = async ({ begin }) =>
    begin === 0
      ? parseAppmsgpublishResponse(rawSuccess([publishItem([ex('p1', 2000), ex('p2', 1990)])]))
      : parseAppmsgpublishResponse(rawSuccess([])); // 第二页空 → hasMore=false 停
  const okOutcome = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 1000, pageSize: 2, maxPages: 500 },
    pageFetcher
  );
  check('15. 成功链 status=succeeded', okOutcome.status === 'succeeded');
  check('15. 收 2 篇（aid 去重口径互通）', okOutcome.newArticles.length === 2);
  check('15. lastArticleTime=最大 createTime', okOutcome.lastArticleTime === 2000);
  check('15. 空页 hasMore=false 触发停止（翻 2 页）', okOutcome.pagesFetched === 2);

  // ═══ 16. H1：cause 自由文本绝不泄露进错误消息 / 持久化 error_message ══════════
  // cause 是 unknown、可能挟带 Cookie/凭据/请求头；错误消息只暴露 kind（+白名单 code），绝不回显 cause.message。
  const secretCauses = [
    new Error('Cookie=SESSIONID=SECRET; pass_ticket=TICKET123'),
    Object.assign(new Error('request to https://mp.weixin.qq.com failed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('Authorization: Bearer SUPERSECRETTOKEN'), { name: 'TimeoutError' }),
    { toString: () => 'x-wechat-uin=999; Cookie=LEAK' }, // 非 Error：String(cause) 也绝不回显
  ];
  const leakRe = /SECRET|pass_ticket|TICKET123|Bearer|SUPERSECRET|Cookie=|Authorization|x-wechat|LEAK/i;
  for (const c of secretCauses) {
    const e = classifyAppmsgpublishError({ cause: c });
    check('16. cause 错误消息不含敏感自由文本', !leakRe.test(e.message));
  }
  // code 白名单：形如错误码的短大写标识保留；自由文本 code（挟带敏感值）被丢弃为 undefined。
  check(
    '16. 合法 cause.code 保留',
    classifyAppmsgpublishError({ cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }).code === 'ECONNRESET'
  );
  check(
    '16. 非法 cause.code（自由文本挟带）被丢弃',
    classifyAppmsgpublishError({ cause: Object.assign(new Error('x'), { code: 'Cookie=SECRET' }) }).code === undefined
  );
  // 端到端：经真实 syncSingleAccount 落 outcome.errorMessage 也绝不含敏感值（持久链 parse→service catch→outcome）。
  const leakFetcher = async () => {
    throw classifyAppmsgpublishError({ cause: new Error('Cookie=SESSIONID=SECRET; pass_ticket=TICKET123') });
  };
  const leakOutcome = await syncSingleAccount({ fakeid: 'acc', sinceTime: 0, pageSize: 5, maxPages: 10 }, leakFetcher);
  check('16. 持久化 outcome.errorMessage 不含敏感值', !leakRe.test(leakOutcome.errorMessage ?? ''));
  const errMsgLeakFetcher = async () => {
    throw parseAppmsgpublishResponse(rawRet(200002, secretErrMsg));
  };
  const errMsgLeakOutcome = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 0, pageSize: 5, maxPages: 10 },
    errMsgLeakFetcher
  );
  check('16. err_msg 经 syncSingleAccount 持久化链不含敏感值', !leakRe.test(errMsgLeakOutcome.errorMessage ?? ''));

  // ═══ 17. H2：混合来源下 auth 失效绝不被降级为可重试（auth 信号绝对优先）══════════
  const mixed = [
    [
      'cause=ECONNRESET + httpStatus=401',
      { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }), httpStatus: 401 },
    ],
    [
      'cause=TimeoutError + httpStatus=403',
      { cause: Object.assign(new Error('t'), { name: 'TimeoutError' }), httpStatus: 403 },
    ],
    [
      'cause=ECONNRESET + ret=200003',
      { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }), ret: 200003 },
    ],
  ];
  for (const [label, input] of mixed) {
    const e = classifyAppmsgpublishError(input);
    check(`17. ${label} → auth_required（不被 cause 遮蔽）`, e.kind === 'auth_required');
    check(`17. ${label} → 不可重试`, isRetryableErrorKind(e.kind) === false);
  }
  // 端到端：混合来源 auth 失效经真实 syncSingleAccount 单次即终态、不重试翻页。
  const mixedAuthFetcher = async () => {
    throw classifyAppmsgpublishError({
      cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      httpStatus: 401,
    });
  };
  const mixedOutcome = await syncSingleAccount(
    { fakeid: 'acc', sinceTime: 0, pageSize: 5, maxPages: 500 },
    mixedAuthFetcher
  );
  check('17. 混合 auth 经 syncSingleAccount → status=auth_required', mixedOutcome.status === 'auth_required');
  check('17. 混合 auth → 不可重试终态', isRetryableErrorKind(mixedOutcome.errorKind) === false);

  console.log(`\n✅ smoke_mp_appmsgpublish_parse: ${passed} 项断言全部通过`);
} catch (err) {
  console.error(`\n❌ smoke_mp_appmsgpublish_parse 失败（已通过 ${passed} 项）：`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
