/**
 * C2 单账号分页增量同步 service（纯逻辑，可注入 fetcher，离线可测）。
 *
 * 复用 pipeline/tools/sync_wechat_articles.py 与 sync_wechat_credential_retry.py 的算法：
 *  - 按 begin/size 分页；
 *  - 遇到 create_time < sinceTime 的旧文章即停（当前页收完再停），或末页/空页停；
 *  - 以 aid + URL 去重（幂等，配合 last_article_time 前的重叠窗口重复拉取时不产生重复）；
 *  - 从文章 URL 派生 aid（mid_idx），沿用 credential 通道的解析口径。
 *
 * 边界：本模块不发真实网络请求、不写库、不并发调度。真实微信抓取（标准 /article 与 credential
 * profile_ext_getmsg 通道）由 C3 runner 注入 PageFetcher；本模块只消费其返回的规范化页结果。
 * 单账号失败不抛出，而是返回带分类错误的 outcome，使 runner 能隔离单账号失败、继续其它账号。
 */

export interface SyncArticle {
  aid: string;
  link: string;
  title?: string;
  authorName?: string;
  digest?: string;
  createTime: number; // epoch 秒
  updateTime?: number;
  isDeleted?: boolean;
}

export interface FetchPageResult {
  articles: SyncArticle[];
  /** 是否可能还有下一页（通常 = 本页返回条数是否等于请求的 size）。 */
  hasMore: boolean;
}

export type PageFetcher = (params: { fakeid: string; begin: number; size: number }) => Promise<FetchPageResult>;

export type SyncErrorKind = 'rate_limited' | 'timeout' | 'auth_required' | 'network' | 'api_error';

/** fetcher 可抛出的分类错误；C3 的真实抓取器把微信响应语义翻译成明确 kind。 */
export class SyncFetchError extends Error {
  kind: SyncErrorKind;
  code?: string;
  constructor(kind: SyncErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'SyncFetchError';
    this.kind = kind;
    this.code = code;
  }
}

export interface SyncAccountOptions {
  fakeid: string;
  /** 起始时间（epoch 秒）；create_time < sinceTime 的文章触发停止。通常 = last_article_time - 重叠窗口。 */
  sinceTime: number;
  pageSize?: number;
  /** 已知 aid / link，用于跨轮次去重（幂等）。 */
  knownAids?: Iterable<string>;
  knownLinks?: Iterable<string>;
  /** 安全上限：最多翻多少页，防止异常源导致无限翻页。 */
  maxPages?: number;
  /** 断点续跑起始 begin 游标。 */
  startBegin?: number;
}

export interface AccountSyncOutcome {
  status: 'succeeded' | 'failed' | 'auth_required';
  newArticles: SyncArticle[];
  pagesFetched: number;
  /** 最终 begin 游标（供断点续跑）。 */
  pageCursor: number;
  /** 本轮新文章里最大的 create_time（供下一轮增量游标）；无新文章为 null。 */
  lastArticleTime: number | null;
  errorKind?: SyncErrorKind;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * 把原始错误（HTTP 状态 / 抛出的异常 / 传输层错误）分类为 SyncErrorKind。
 * 微信应用层的 auth/限流由 fetcher 直接抛 SyncFetchError（它掌握响应语义）；此处只做传输层判定 + 兜底。
 */
export function classifyFetchError(err: unknown): SyncErrorKind {
  if (err instanceof SyncFetchError) return err.kind;
  const e = (err ?? {}) as Record<string, unknown>;
  const status = Number(e.status ?? e.statusCode ?? (e.response as Record<string, unknown>)?.status ?? 0);
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_required';

  const name = String(e.name ?? '');
  const code = String(e.code ?? '');
  const message = String(e.message ?? '');
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    /time(?:d)?\s?out|timeout/i.test(message)
  ) {
    return 'timeout';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /fetch failed|network|socket hang up/i.test(message)
  ) {
    return 'network';
  }
  return 'api_error';
}

/** 从 last_article_time 前留一个重叠窗口，避免边界漏文；去重保证重叠部分不产生重复。 */
export function computeSinceWithOverlap(lastArticleTime: number, overlapSeconds = 3600): number {
  return Math.max(0, Math.floor(lastArticleTime) - Math.max(0, Math.floor(overlapSeconds)));
}

/**
 * 从微信文章 URL 派生 aid（mid_idx）。移植自 sync_wechat_credential_retry.py 的解析口径：
 * 取 query 中的 mid 与 idx（idx 缺省为 '1'），拼成 `${mid}_${idx}`；无 mid 返回空串。
 */
export function deriveAidFromUrl(url: string): string {
  try {
    const query = new URL(url).searchParams;
    const mid = query.get('mid') ?? '';
    const idx = query.get('idx') ?? '1';
    return mid ? `${mid}_${idx}` : '';
  } catch {
    return '';
  }
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 500;

/**
 * 拉取单账号 create_time >= sinceTime 的新文章（增量）。
 * 停止条件：本页出现旧文章 / 末页（返回数 < size 或 hasMore=false）/ 空页 / 达 maxPages 上限。
 * 失败不抛出：返回 status='failed'|'auth_required' 且带 errorKind，已收集的文章一并返回（失败隔离）。
 */
export async function syncSingleAccount(
  options: SyncAccountOptions,
  fetchPage: PageFetcher
): Promise<AccountSyncOutcome> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seenAids = new Set<string>(options.knownAids ?? []);
  const seenLinks = new Set<string>(options.knownLinks ?? []);
  const collected: SyncArticle[] = [];
  let lastArticleTime: number | null = null;
  let begin = Math.max(0, options.startBegin ?? 0);
  let pagesFetched = 0;

  try {
    while (pagesFetched < maxPages) {
      const page = await fetchPage({ fakeid: options.fakeid, begin, size: pageSize });
      pagesFetched += 1;

      let hitOld = false;
      for (const article of page.articles) {
        if (article.createTime < options.sinceTime) {
          hitOld = true;
          continue;
        }
        const aid = article.aid;
        if (!aid || seenAids.has(aid)) continue;
        if (article.link && seenLinks.has(article.link)) continue;
        seenAids.add(aid);
        if (article.link) seenLinks.add(article.link);
        collected.push(article);
        if (lastArticleTime === null || article.createTime > lastArticleTime) {
          lastArticleTime = article.createTime;
        }
      }

      if (hitOld || !page.hasMore || page.articles.length === 0) break;
      begin += pageSize;
    }
    return {
      status: 'succeeded',
      newArticles: collected,
      pagesFetched,
      pageCursor: begin,
      lastArticleTime,
    };
  } catch (error) {
    const kind = classifyFetchError(error);
    return {
      status: kind === 'auth_required' ? 'auth_required' : 'failed',
      newArticles: collected,
      pagesFetched,
      pageCursor: begin,
      lastArticleTime,
      errorKind: kind,
      errorCode: (error as { code?: string })?.code,
      errorMessage: (error as { message?: string })?.message ?? String(error),
    };
  }
}
