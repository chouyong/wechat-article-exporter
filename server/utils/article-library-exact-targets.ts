const EXACT_JOB_ID_RE = /^[0-9a-f]{32}$/;
const EXACT_WECHAT_ARTICLE_URL_RE = /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+$/;
const WECHAT_ARTICLE_URL_RE = /https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/;

type JsonRecord = Record<string, unknown>;

export interface ExactRecoveryTarget<T> {
  url: string;
  snapshotArticle: T | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(record: JsonRecord, name: string) {
  const value = record[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`恢复源 job 的 ${name} 不是非负整数`);
  }
  return value;
}

function validateOrderedUrls(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 缺少非空 URL 列表`);
  }
  const urls = value.map(item => {
    if (typeof item !== 'string' || !EXACT_WECHAT_ARTICLE_URL_RE.test(item)) {
      throw new Error(`${label} 含非法微信公众号文章 URL`);
    }
    return item;
  });
  if (new Set(urls).size !== urls.length) {
    throw new Error(`${label} 含重复 URL`);
  }
  return urls;
}

export function validateExactRecoveryJobId(value: unknown) {
  if (typeof value !== 'string' || !EXACT_JOB_ID_RE.test(value)) {
    throw new Error('恢复源 job id 必须是 32 位小写十六进制');
  }
  return value;
}

export function canonicalizeWechatArticleUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  return WECHAT_ARTICLE_URL_RE.exec(value.trim())?.[0] || '';
}

export function validateExactRecoverySourceJob(
  sourceJob: unknown,
  recoverySourceJobId: string,
  requestedUrls: string[]
) {
  const sourceId = validateExactRecoveryJobId(recoverySourceJobId);
  if (!isRecord(sourceJob)) {
    throw new Error('恢复源 job.json 结构无效');
  }
  if (sourceJob.id !== sourceId || sourceJob.mode !== 'single' || sourceJob.status !== 'completed') {
    throw new Error('恢复源 job 身份、模式或终态无效');
  }

  const sourceUrls = validateOrderedUrls(sourceJob.targetUrls, '恢复源 job');
  const requestUrls = validateOrderedUrls(requestedUrls, '恢复请求');
  if (sourceUrls.length !== requestUrls.length || sourceUrls.some((url, index) => url !== requestUrls[index])) {
    throw new Error('恢复请求 URL 顺序或集合与源 job 不一致');
  }

  const expected = sourceUrls.length;
  const total = readNonNegativeInteger(sourceJob, 'totalCandidates');
  const processed = readNonNegativeInteger(sourceJob, 'processedCandidates');
  const exported = readNonNegativeInteger(sourceJob, 'exportedCount');
  const skipped = readNonNegativeInteger(sourceJob, 'skippedExistingCount');
  const failed = readNonNegativeInteger(sourceJob, 'failedCount');
  if (total !== expected || processed !== expected || exported + skipped + failed !== expected || failed === 0) {
    throw new Error(
      `恢复源 job 范围不守恒：expected=${expected}, total=${total}, processed=${processed}, ` +
        `exported=${exported}, skipped=${skipped}, failed=${failed}`
    );
  }
  return sourceUrls;
}

export function buildExactRecoveryTargetPlan<T extends { link?: unknown; is_deleted?: unknown }>(
  snapshotArticles: T[],
  targetUrls: string[]
): ExactRecoveryTarget<T>[] {
  const urls = validateOrderedUrls(targetUrls, '恢复目标');
  const targetSet = new Set(urls);
  const articlesByUrl = new Map<string, T>();
  const deletedUrls = new Set<string>();

  for (const article of snapshotArticles) {
    const url = canonicalizeWechatArticleUrl(article.link);
    if (!url || !targetSet.has(url)) continue;
    if (article.is_deleted === true) {
      deletedUrls.add(url);
      continue;
    }
    articlesByUrl.set(url, article);
  }

  if (deletedUrls.size > 0) {
    throw new Error('恢复目标包含 snapshot 已删除文章，拒绝重新合成');
  }

  return urls.map(url => ({
    url,
    snapshotArticle: articlesByUrl.get(url) || null,
  }));
}
