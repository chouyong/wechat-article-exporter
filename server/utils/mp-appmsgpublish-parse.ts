/**
 * C3-7a：微信 /appmsgpublish 响应映射「纯层」（离线可测，零网络、零凭据、零库）。
 *
 * 职责：把微信 web 通道 `/cgi-bin/appmsgpublish` 的**原始响应**翻译成 C3-0 契约：
 *   - `parseAppmsgpublishResponse(raw)`  -> `FetchPageResult`（ret===0 成功页规范化为 SyncArticle[] + hasMore）。
 *   - `classifyAppmsgpublishError(input)` -> `SyncFetchError`（把 ret / HTTP 状态 / 传输层错误映射为明确 kind）。
 *
 * **切片边界（C3-7a）**：只做纯响应规范化 + 错误分类。**不发任何真实网络请求、不读 Cookie/credential、不写库、
 * 不注入 PageFetcher、不改 PageFetcher / AbortSignal / retry / cancel 契约**。真实抓取器（发起 HTTP、附带凭据、
 * 注入 PageFetcher）是 C3-7b，另行授权；本层是其内部可离线单测的纯构件——真实 fetcher 只需
 * `return parseAppmsgpublishResponse(await httpGet(...))`，传输/HTTP 异常经 `classifyAppmsgpublishError` 归类抛出。
 *
 * **口径不建立第二套语义**（与既有 web 通道逐字同源，见文件末「口径依据」）：
 *   - `aid`        = `AppMsgEx.aid`（响应原生字段）——与 `store/v2/article.ts` 的规范键 `${fakeid}:${aid}`、
 *                    `utils/exporter.ts` 同源；**非** `deriveAidFromUrl`（那是 credential 通道无原生 aid 才用的口径）。
 *   - `createTime` = `AppMsgEx.create_time`（epoch 秒），供 `syncSingleAccount` 的增量时间边界比较。
 *   - `hasMore`    = 过滤出「带 publish_info」的 publish_list 条目后其**条目数 > 0**——与
 *                    `apis/index.ts:getArticleList` 的 `isCompleted = publish_list.filter(!!publish_info).length === 0`
 *                    逐字同源；以 **publish_list 条目**计数，**不**以 appmsgex 文章数、**不**比对请求 size。
 *
 * **fail-closed（严格）**：ret!==0（含未知 ret）、HTTP 非 2xx、畸形 JSON / 畸形结构 / 关键字段（aid/link/create_time）
 * 缺失或非法，一律映射为明确 `SyncFetchError`、**绝不静默成功、绝不静默丢文章**；未知一律 `api_error`（不可重试），
 * **绝不默认标成可重试**。凭据/会话失效（ret 200003 / HTTP 401 / 403）→ `auth_required` 且**绝对优先**（H2：混合来源
 * 下 auth 信号永不被可重试的传输原因遮蔽），`RETRY_POLICY` 判其不可重试 → runner 的 `runWithRetry` 落终态、
 * **不进指数退避（即不会无限重试）**。
 *
 * **诊断保留 + 无敏感数据（H1）**：错误消息保留 kind / ret / HTTP 状态及有限的已知 err_msg 诊断词供排查。`cause`（unknown 传输异常）
 * **被接受用于分类 kind，但其 `message` / `String(cause)` 自由文本绝不回显进 `SyncFetchError.message`**——否则会经
 * `syncSingleAccount`→`applyAccountOutcome` 落进持久 `error_message`，把调用方可能挟带的 Cookie/凭据/请求头写库。
 * `cause.code` 也仅在通过错误码白名单 pattern（`safeCauseCode`）时才暴露；`errMsg` 仅允许精确匹配已知短诊断词，所有其它自由文本丢弃。**本层从不接受也从不输出 Cookie、凭据或任何请求头字段**。
 */

import {
  classifyFetchError,
  type FetchPageResult,
  type SyncArticle,
  type SyncErrorKind,
  SyncFetchError,
} from './mp-sync-service.ts';

/**
 * 微信 `/appmsgpublish` 已知「限流 / 频控」ret 码 → `rate_limited`（可重试）的**单一事实源**。
 * `200013` = freqcontrol（操作过于频繁）：微信文章采集社区 / 教程普遍据 `base_resp.ret === 200013` 判频控并
 * 长睡后重试。未列入本集的任何非零 ret 一律 fail-closed 归 `api_error`（不可重试）；待 C3-7b 真实响应确认更多
 * 瞬时限流子码后，**只改本集一处**定向扩充（不散落到分支）。
 */
export const APPMSGPUBLISH_RATE_LIMIT_RETS: ReadonlySet<number> = new Set<number>([200013]);

/** 微信 session 失效 ret（invalid session）→ `auth_required`（不可重试，需重新扫码登录）。同 getArticleList 处置。 */
export const APPMSGPUBLISH_AUTH_REQUIRED_RET = 200003;

/**
 * `classifyAppmsgpublishError` 的输入：覆盖真实抓取器可能遇到的三类错误来源。四者皆可选，按下方优先级判定；
 * 全空则 fail-closed 归 `api_error`。**刻意不含任何 Cookie / 凭据 / 请求头字段**（诊断绝不泄敏）。
 */
export interface AppmsgpublishErrorInput {
  /** 底层抛出的传输 / 中止错误（超时 / 网络 / abort 等）。有则优先走传输层分类（复用 service 单一事实源）。 */
  cause?: unknown;
  /** HTTP 响应状态码（若已拿到响应）。非 2xx 即错误。 */
  httpStatus?: number;
  /** 微信 `base_resp.ret`（若响应体已解析且 HTTP 2xx）。 */
  ret?: number;
  /** 微信 `base_resp.err_msg`（不受信任；仅精确匹配已知短诊断词才会进入输出）。 */
  errMsg?: string;
}

/**
 * 从 unknown `cause` **安全**提取错误码：仅接受形如网络/传输错误码的短大写标识（如 `ECONNRESET`、
 * `UND_ERR_CONNECT_TIMEOUT`、`ETIMEDOUT`），拒绝任何自由文本。防止调用方把 Cookie/凭据/请求头挟带进
 * `cause.code`（H1 防御纵深）。非法 / 缺失 → `undefined`（宁可少诊断，不泄敏）。
 */
const SAFE_CAUSE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
function safeCauseCode(cause: unknown): string | undefined {
  const raw = (cause as { code?: unknown } | null)?.code;
  return typeof raw === 'string' && SAFE_CAUSE_CODE.test(raw) ? raw : undefined;
}

// 微信 err_msg 来自不受信任响应，不能依赖调用方承诺“短且无敏感数据”。只保留
// 已知、固定的诊断词；未知文本（包括 Cookie、Authorization、pass_ticket 等）全部省略。
const SAFE_ERR_MESSAGES = new Set(['invalid session', 'freq control', 'unauthorized', 'forbidden']);
function safeErrMsg(errMsg: unknown): string | undefined {
  return typeof errMsg === 'string' && SAFE_ERR_MESSAGES.has(errMsg) ? errMsg : undefined;
}

/**
 * 把 `/appmsgpublish` 抓取的**错误来源**（传输异常 / HTTP 非 2xx / 微信 ret）映射为明确 `SyncFetchError`。
 * 判定优先级（fail-closed）：
 *   ①' **认证/会话失效信号绝对优先**（H2 修复）：`httpStatus` 401/403 或 `ret` 200003 → `auth_required`，
 *       **先于** cause 分支返回。混合来源输入（如 `{ cause: ECONNRESET, httpStatus: 401 }`）下，auth 信号
 *       **绝不**被可重试的传输原因遮蔽——否则凭据失效被降级为可重试 → 无效凭据被无限重试（违反安全线）。
 *   ①  `cause` 存在（底层抛错）→ 复用 service 的**单一事实源** `classifyFetchError` 得 kind（timeout / network /
 *       api_error…），不另写传输判定。**H1 修复：绝不回显 `cause.message` / `String(cause)`**（unknown 来源、
 *       可能挟带 Cookie/凭据/请求头，且会经 syncSingleAccount→applyAccountOutcome 落进持久 `error_message`）；
 *       只暴露 `kind` + 白名单 `code`（`safeCauseCode`）。诊断靠 kind + code，不靠自由文本。
 *   ②  其余 `httpStatus` 非 2xx（401/403 已在 ①' 处理）→ 429=rate_limited、其余=api_error。
 *   ③  其余 `ret`（200003 已在 ①' 处理）→ ret=0 误用=api_error、已知限流集=rate_limited、其余非零=api_error（fail-closed）。
 *   ④  皆无 → 无法识别，fail-closed `api_error`（**绝不默认可重试**）。
 * 可重试性由 `RETRY_POLICY` 依 kind 决定（rate_limited/timeout/network 可重试；auth_required/api_error/config_error 不可）。
 */
export function classifyAppmsgpublishError(input: AppmsgpublishErrorInput): SyncFetchError {
  const { cause, httpStatus, ret } = input;
  const safeMessage = safeErrMsg(input.errMsg);
  const suffix = safeMessage ? ` (${safeMessage})` : '';

  // ①' 认证/会话失效信号绝对优先（fail-closed 安全线：auth_required 永不被可重试原因遮蔽）。
  if (httpStatus === 401 || httpStatus === 403) {
    return new SyncFetchError(
      'auth_required',
      `appmsgpublish 凭据/会话失效 HTTP ${httpStatus}${suffix}`,
      `http:${httpStatus}`
    );
  }
  if (ret === APPMSGPUBLISH_AUTH_REQUIRED_RET) {
    return new SyncFetchError('auth_required', `appmsgpublish 凭据/会话失效 ret=${ret}${suffix}`, `ret:${ret}`);
  }

  // ① 传输 / 中止层：复用 service 单一事实源 classifyFetchError；绝不回显 cause 自由文本（H1）。
  if (cause !== undefined) {
    const kind = classifyFetchError(cause);
    return new SyncFetchError(kind, `appmsgpublish 传输层错误(${kind})`, safeCauseCode(cause));
  }

  // ② HTTP 非 2xx（401/403 已在 ①' 处理）。
  if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
    const kind: SyncErrorKind = httpStatus === 429 ? 'rate_limited' : 'api_error';
    return new SyncFetchError(kind, `appmsgpublish HTTP ${httpStatus}${suffix}`, `http:${httpStatus}`);
  }

  // ③ 微信应用层 ret（200003 已在 ①' 处理）。
  if (ret !== undefined) {
    if (ret === 0) {
      // 误用防御：classify 不应对成功响应调用。fail-closed 归 api_error（不可重试），绝不静默当成功。
      return new SyncFetchError('api_error', 'appmsgpublish classify 收到 ret=0（成功响应不应进入错误分类）', 'ret:0');
    }
    if (APPMSGPUBLISH_RATE_LIMIT_RETS.has(ret)) {
      return new SyncFetchError('rate_limited', `appmsgpublish 频控/限流 ret=${ret}${suffix}`, `ret:${ret}`);
    }
    // 其它非零 ret（已知或未知）：fail-closed api_error（不可重试），保留 ret + err_msg 诊断。
    return new SyncFetchError('api_error', `appmsgpublish 接口错误 ret=${ret}${suffix}`, `ret:${ret}`);
  }

  // ④ 无 cause / 无 httpStatus / 无 ret：无法识别 → fail-closed api_error（不可重试），绝不默认可重试。
  return new SyncFetchError('api_error', 'appmsgpublish 无法识别的错误（无 cause / httpStatus / ret）', 'unclassified');
}

/** 畸形响应统一走 api_error（不可重试，fail-closed），code='malformed_response' 便于排查与断言。 */
function malformed(detail: string): SyncFetchError {
  return new SyncFetchError('api_error', `appmsgpublish 响应畸形: ${detail}`, 'malformed_response');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 把单条 `appmsgex` 规范化为 `SyncArticle`。**身份 + 排序关键字段硬校验**（缺失/非法即 fail-closed 抛 malformed，
 * 绝不静默丢或伪造）：
 *   - `aid`（非空字符串）——去重主键（`syncSingleAccount` 以 `article.aid` 去重）。
 *   - `link`（非空字符串）——次级去重键；`SyncArticle.link` 为必填、exporter 全链路假定其存在。
 *   - `create_time`（有限数字）——增量时间边界比较基准；NaN/Infinity/缺失会让 `createTime < sinceTime` 判定失真。
 * 可选字段（title / author_name / digest / update_time / is_deleted）缺失即省略，不抛。
 */
function toSyncArticle(ex: unknown): SyncArticle {
  if (!isObject(ex)) throw malformed('appmsgex 条目非对象');

  const aid = ex.aid;
  if (typeof aid !== 'string' || aid.length === 0) throw malformed('appmsgex.aid 缺失或非非空字符串');
  const link = ex.link;
  if (typeof link !== 'string' || link.length === 0) throw malformed('appmsgex.link 缺失或非非空字符串');
  const createTime = ex.create_time;
  if (typeof createTime !== 'number' || !Number.isFinite(createTime)) {
    throw malformed('appmsgex.create_time 缺失或非有限数字');
  }

  const article: SyncArticle = { aid, link, createTime };
  if (typeof ex.title === 'string') article.title = ex.title;
  if (typeof ex.author_name === 'string') article.authorName = ex.author_name;
  if (typeof ex.digest === 'string') article.digest = ex.digest;
  if (typeof ex.update_time === 'number' && Number.isFinite(ex.update_time)) article.updateTime = ex.update_time;
  if (typeof ex.is_deleted === 'boolean') article.isDeleted = ex.is_deleted;
  return article;
}

/**
 * 把 `/appmsgpublish` 的**原始响应对象**规范化为 `FetchPageResult`。
 * 成功（`base_resp.ret === 0`）→ 返回 `{ articles, hasMore }`；任何错误 / 畸形 → **抛** `SyncFetchError`（fail-closed）。
 *
 * 步骤：
 *   1. 校验 `raw` 为对象、`base_resp.ret` 为数字；否则 malformed。
 *   2. `ret !== 0` → 交 `classifyAppmsgpublishError({ ret, errMsg })` 得明确 kind 并抛（auth_required/rate_limited/api_error）。
 *   3. `ret === 0`：`publish_page` 必为 JSON 字符串 → 解析 → `publish_list` 必为数组；否则 malformed。
 *   4. 先按 `!!publish_info` 过滤 publish_list（与 getArticleList 同源）→ `hasMore = 过滤后条目数 > 0`。
 *   5. 逐条 `JSON.parse(publish_info).appmsgex`（必为数组）→ 逐篇 `toSyncArticle`（关键字段硬校验）。
 *
 * 空页语义：过滤后条目数为 0（原生空 publish_list，或全部无 publish_info）→ `hasMore=false`、`articles=[]`。
 */
export function parseAppmsgpublishResponse(raw: unknown): FetchPageResult {
  if (!isObject(raw)) throw malformed('响应非对象');

  const baseResp = raw.base_resp;
  if (!isObject(baseResp) || typeof baseResp.ret !== 'number') {
    throw malformed('base_resp 缺失或 ret 非数字');
  }
  const ret = baseResp.ret;
  const errMsg = safeErrMsg(baseResp.err_msg);

  // 非 0：交分类器映射为明确 SyncFetchError 抛出（凭据失效 / 限流 / 接口错误）。
  if (ret !== 0) throw classifyAppmsgpublishError({ ret, errMsg });

  // ret===0 成功页：publish_page 是 JSON 字符串。
  if (typeof raw.publish_page !== 'string') throw malformed('publish_page 非字符串');
  let publishPage: unknown;
  try {
    publishPage = JSON.parse(raw.publish_page);
  } catch {
    throw malformed('publish_page JSON 解析失败');
  }
  if (!isObject(publishPage) || !Array.isArray(publishPage.publish_list)) {
    throw malformed('publish_page.publish_list 非数组');
  }

  // 与 getArticleList 逐字同源：过滤出「带 publish_info」的条目，hasMore 以过滤后**条目数**计（非文章数、非 size）。
  const filtered = (publishPage.publish_list as unknown[]).filter(
    (item): item is Record<string, unknown> => isObject(item) && !!item.publish_info
  );
  const hasMore = filtered.length > 0;

  const articles: SyncArticle[] = [];
  for (const item of filtered) {
    if (typeof item.publish_info !== 'string') throw malformed('publish_info 非字符串');
    let info: unknown;
    try {
      info = JSON.parse(item.publish_info);
    } catch {
      throw malformed('publish_info JSON 解析失败');
    }
    if (!isObject(info) || !Array.isArray(info.appmsgex)) throw malformed('publish_info.appmsgex 非数组');
    for (const ex of info.appmsgex as unknown[]) {
      articles.push(toSyncArticle(ex));
    }
  }

  return { articles, hasMore };
}

/**
 * ── hasMore 口径依据（权威代码 vs 计划 vs FetchPageResult 注释 的核对，C3-7a 要求留证）──
 *
 * 权威计划 `docs/PLAN_WECHAT_EXPORTER_C3_RUNNER.md` 对 C3-7 只有高层定义（「翻译响应语义为 SyncFetchError
 * kind；Cookie/credential 失效 → auth_required」），**未细化 hasMore 计数口径** → 与计划无冲突。
 *
 * 本层采用的口径以**既有生产代码**为准：`apis/index.ts:getArticleList` 对同一 `/appmsgpublish` 端点用
 * `isCompleted = publish_list.filter(!!publish_info).length === 0`，即「过滤后 publish_list 条目为空 = 完成」。
 * 故 `hasMore = 过滤后条目数 > 0`，**以 publish_list 条目计数**。
 *
 * `mp-sync-service.ts` 中 `FetchPageResult.hasMore` 注释写「**通常** = 本页返回条数是否等于请求的 size」——此为
 * 泛化契约的软描述（「通常」），非 `/appmsgpublish` 端点的权威口径；采信端点专属的既有代码可避免「第二套语义」。
 * 且 `syncSingleAccount` 的停止条件为 `hitOld || !page.hasMore || page.articles.length === 0`：即使某页
 * 过滤后条目非空但产出 0 篇文章，`articles.length === 0` 也会停，不会因本口径产生无限翻页。
 */
