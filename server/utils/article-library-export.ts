import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import PQueue from 'p-queue';
import { ProxyAgent } from 'undici';
import { parseCgiDataNew } from '#shared/utils/html';
import { createMarkdownTurndownService, postProcessMarkdown } from '#shared/utils/markdown';
import { renderHTMLFromCgiDataNew, renderTextFromCgiDataNew } from '#shared/utils/renderer';
import { USER_AGENT } from '~/config';
import {
  buildExactRecoveryTargetPlan,
  validateExactRecoveryJobId,
  validateExactRecoverySourceJob,
} from './article-library-exact-targets';
import {
  buildWechatPublishedFrontmatterLine,
  formatWechatPublishedTime,
  resolveWechatPublishedTime,
} from './wechat-published-time';

export type ArticleLibraryExportMode = 'full' | 'recent-3d' | 'failed-only' | 'cached-only' | 'single';
export type ArticleLibraryExportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface SnapshotAccount {
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
  total_count?: number;
  completed?: boolean;
  count?: number;
  articles?: number;
  create_time?: number;
  update_time?: number;
  last_update_time?: number;
}

export interface SnapshotArticle {
  fakeid: string;
  aid: string;
  link: string;
  title: string;
  author_name?: string;
  digest?: string;
  create_time: number;
  update_time: number;
  is_deleted?: boolean;
}

interface SnapshotPayload {
  accounts: SnapshotAccount[];
  articles: SnapshotArticle[];
}

interface SnapshotHtmlItem {
  fakeid: string;
  url: string;
  title: string;
  commentID?: string | null;
  html: string;
}

interface PersistedSnapshot extends SnapshotPayload {
  createdAt: string;
}

interface PersistedHtmlSnapshotIndex {
  items: Record<string, { fakeid: string; title: string; commentID: string | null; file: string; updatedAt: string }>;
}

interface ExportCandidate extends SnapshotArticle {
  accountName: string;
  recoveryTargetOnly?: boolean;
}

interface ArticleMeta {
  sourceUrl: string;
  title: string;
  accountName: string;
  description: string;
  publishedRaw: string;
  publishedAt: Date | null;
}

interface PersistedExportIndex {
  items: Record<string, { relativePath: string; exportedAt: string; title: string }>;
}

interface ScannedLibraryIndexEntry {
  relativePath: string;
  title: string;
}

export interface ArticleLibraryExportJob {
  id: string;
  mode: ArticleLibraryExportMode;
  syncFromTimestamp: number | null;
  syncToTimestamp: number | null;
  targetUrls?: string[];
  recoverySourceJobId?: string;
  status: ArticleLibraryExportJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
  outputDir: string;
  zipPath: string | null;
  snapshotCreatedAt: string | null;
  totalAccounts: number;
  scannedArticles: number;
  totalCandidates: number;
  processedCandidates: number;
  exportedCount: number;
  skippedExistingCount: number;
  failedCount: number;
  failureSamples: Array<{ url: string; reason: string }>;
}

export interface ArticleLibraryExportPreview {
  mode: ArticleLibraryExportMode;
  snapshotCreatedAt: string | null;
  totalAccounts: number;
  scannedArticles: number;
  totalCandidates: number;
  cachedCandidateCount: number;
  uncachedCandidateCount: number;
  totalCachedCount: number;
  estimatedExportCount: number;
  estimatedSkipCount: number;
  createdAt: string;
}

export interface ArticleLibraryExportPreviewJob {
  id: string;
  mode: ArticleLibraryExportMode;
  syncFromTimestamp: number | null;
  syncToTimestamp: number | null;
  status: ArticleLibraryExportJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
  preview: ArticleLibraryExportPreview | null;
}

const EXPORT_ROOT = path.resolve(process.cwd(), 'data', 'exports', 'article-library');
const JOBS_ROOT = path.join(EXPORT_ROOT, 'jobs');
const LIBRARY_ROOT = path.join(EXPORT_ROOT, 'library');
const INDEX_PATH = path.join(EXPORT_ROOT, 'source-index.json');
const SNAPSHOT_PATH = path.join(EXPORT_ROOT, 'snapshot.json');
const HTML_CACHE_ROOT = path.join(EXPORT_ROOT, 'html-cache');
const HTML_INDEX_PATH = path.join(EXPORT_ROOT, 'html-cache-index.json');
const PREVIEW_JOBS_ROOT = path.join(EXPORT_ROOT, 'preview-jobs');
const PREVIEW_CACHE_ROOT = path.join(EXPORT_ROOT, 'preview-cache');
const EXPORT_TIMEZONE = 'Asia/Shanghai';
const NETWORK_EXPORT_CONCURRENCY = 1;
const CACHED_EXPORT_CONCURRENCY = 6;
const REQUEST_DELAY_MS = 3500;
const FAILURE_SAMPLE_LIMIT = 20;
const ARTICLE_REQUEST_TIMEOUT_MS = 45000;
const ARTICLE_REQUEST_RETRY = 2;
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const proxyDispatcher = (() => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!proxyUrl) return undefined;
  try {
    return new ProxyAgent(proxyUrl);
  } catch (error) {
    console.warn('failed to create proxy agent for article library export:', error);
    return undefined;
  }
})();

const jobs = new Map<string, ArticleLibraryExportJob>();
const previewJobs = new Map<string, ArticleLibraryExportPreviewJob>();
const jobPersistenceChains = new Map<string, Promise<void>>();
let latestJobId: string | null = null;
let latestPreviewJobId: string | null = null;
let scannedLibraryIndexCache:
  | {
      builtAt: number;
      items: Record<string, ScannedLibraryIndexEntry>;
    }
  | null = null;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compareCreatedAtDesc(
  left: { createdAt?: string | null },
  right: { createdAt?: string | null },
) {
  const leftValue = left.createdAt || '';
  const rightValue = right.createdAt || '';
  return rightValue.localeCompare(leftValue);
}

function normalizePath(input: string) {
  return input.replaceAll('\\', '/');
}

function yamlEscape(text: string) {
  return (text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, ' ').replace(/\n/g, ' ').trim();
}

function truncateUtf8(text: string, maxBytes: number) {
  let result = '';
  for (const char of text) {
    const next = result + char;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) {
      break;
    }
    result = next;
  }
  return result;
}

function sanitizeFilename(name: string, maxBytes = 120) {
  const cleaned = (name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '');
  return truncateUtf8(cleaned || 'untitled', maxBytes);
}

function canonicalizeUrl(url: string) {
  const trimmed = (url || '').trim();
  const matched = /https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/.exec(trimmed);
  if (matched) {
    return matched[0];
  }
  return trimmed;
}

function parseDate(value: string) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return new Date(direct);
  return null;
}

function formatDatePartsInTimezone(date: Date, timeZone = EXPORT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: values.year || '1970',
    month: values.month || '01',
    day: values.day || '01',
    hour: values.hour || '00',
    minute: values.minute || '00',
    second: values.second || '00',
  };
}

function formatDateOnlyInTimezone(date: Date | null, timeZone = EXPORT_TIMEZONE) {
  if (!date) return '';
  const parts = formatDatePartsInTimezone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDayFolder(date: Date | null) {
  const target = date || new Date();
  const parts = formatDatePartsInTimezone(target);
  return `${parts.year}${parts.month}${parts.day}`;
}

async function fileExists(targetPath: string) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function markdownFileMatchesSource(targetPath: string, sourceUrl: string) {
  if (!(await fileExists(targetPath))) {
    return false;
  }

  try {
    const markdown = await readFile(targetPath, 'utf8');
    return extractMarkdownSourceUrl(markdown) === canonicalizeUrl(sourceUrl);
  } catch {
    return false;
  }
}

function toCheerioText(value: string) {
  return cheerio.load(`<div>${value || ''}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

function buildFrontmatter(meta: ArticleMeta, createdAt: Date) {
  return [
    '---',
    `title: "${yamlEscape(meta.title)}"`,
    `source: "${yamlEscape(meta.sourceUrl)}"`,
    'author:',
    meta.accountName ? `  - "[[${yamlEscape(meta.accountName)}]]"` : '  - "[[未知公众号]]"',
    buildWechatPublishedFrontmatterLine(meta.publishedAt, meta.publishedRaw),
    `created: ${formatDateOnlyInTimezone(createdAt)}`,
    `description: "${yamlEscape(meta.description)}"`,
    'tags:',
    '  - "clippings"',
    '  - "wechat"',
    '---',
    '',
  ].join('\n');
}

function buildMarkdown(meta: ArticleMeta, body: string) {
  const createdAt = meta.publishedAt || new Date();
  const frontmatter = buildFrontmatter(meta, createdAt);
  return `${frontmatter}${body.trim()}\n`;
}

function resolveOutputPath(title: string, publishedAt: Date | null) {
  const dayFolder = formatDayFolder(publishedAt);
  const filename = `${sanitizeFilename(title)}.md`;
  const absolutePath = path.join(LIBRARY_ROOT, dayFolder, filename);
  const relativePath = path.relative(EXPORT_ROOT, absolutePath);
  return {
    dayFolder,
    filename,
    absolutePath,
    relativePath: normalizePath(relativePath),
  };
}

function resolveCandidateOutputPath(candidate: ExportCandidate) {
  const publishedAt = candidate.create_time ? new Date(candidate.create_time * 1000) : null;
  return resolveOutputPath(candidate.title, publishedAt);
}

function resolveMetaOutputPath(meta: ArticleMeta, fallbackTitle: string) {
  return resolveOutputPath(meta.title || fallbackTitle, meta.publishedAt || parseDate(meta.publishedRaw));
}

async function resolveWritableOutputPath(
  output: { dayFolder: string; filename: string; absolutePath: string; relativePath: string },
  sourceUrl: string,
) {
  if (!(await fileExists(output.absolutePath))) {
    return output;
  }

  try {
    const existingMarkdown = await readFile(output.absolutePath, 'utf8');
    if (extractMarkdownSourceUrl(existingMarkdown) === canonicalizeUrl(sourceUrl)) {
      return output;
    }
  } catch {}

  const suffix = createHash('sha1').update(canonicalizeUrl(sourceUrl)).digest('hex').slice(0, 8);
  const basename = output.filename.replace(/\.md$/i, '');
  const filename = `${basename}-${suffix}.md`;
  const absolutePath = path.join(LIBRARY_ROOT, output.dayFolder, filename);
  const relativePath = normalizePath(path.relative(EXPORT_ROOT, absolutePath));
  return {
    dayFolder: output.dayFolder,
    filename,
    absolutePath,
    relativePath,
  };
}

async function isCandidateAlreadyExported(
  candidate: ExportCandidate,
  index: PersistedExportIndex,
): Promise<{ exported: boolean; relativePath?: string; title?: string }> {
  const canonicalUrl = canonicalizeUrl(candidate.link);
  const indexed = index.items[canonicalUrl];
  if (indexed?.relativePath) {
    const indexedAbsolutePath = path.join(EXPORT_ROOT, indexed.relativePath);
    if (await markdownFileMatchesSource(indexedAbsolutePath, canonicalUrl)) {
      return {
        exported: true,
        relativePath: indexed.relativePath,
        title: indexed.title || candidate.title,
      };
    }
  }

  const outputPath = resolveCandidateOutputPath(candidate);
  if (await markdownFileMatchesSource(outputPath.absolutePath, canonicalUrl)) {
    return {
      exported: true,
      relativePath: outputPath.relativePath,
      title: candidate.title,
    };
  }

  return { exported: false };
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

function getJobDir(jobId: string) {
  return path.join(JOBS_ROOT, jobId);
}

function getJobFailureLogPath(jobId: string) {
  return path.join(getJobDir(jobId), 'failures.jsonl');
}

async function readJsonWithFallback<T>(targetPath: string): Promise<T> {
  const buffer = await readFile(targetPath);
  for (const encoding of ['utf8', 'utf16le', 'latin1'] as BufferEncoding[]) {
    try {
      return JSON.parse(buffer.toString(encoding).replace(/^\uFEFF/, '')) as T;
    } catch {}
  }
  throw new Error(`无法解析 JSON: ${targetPath}`);
}

async function readIndex(): Promise<PersistedExportIndex> {
  try {
    return await readJsonWithFallback<PersistedExportIndex>(INDEX_PATH);
  } catch {
    return { items: {} };
  }
}

async function writeIndex(index: PersistedExportIndex) {
  await ensureDir(EXPORT_ROOT);
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

function extractMarkdownSourceUrl(markdownText: string) {
  const match = /^source:\s*"([^"]+)"/m.exec(markdownText || '');
  return match?.[1] ? canonicalizeUrl(match[1]) : '';
}

function extractMarkdownTitle(markdownText: string, fallbackTitle: string) {
  const match = /^title:\s*"([^"]+)"/m.exec(markdownText || '');
  return match?.[1]?.trim() || fallbackTitle;
}

async function scanLibraryMarkdownFiles() {
  const entries: Record<string, ScannedLibraryIndexEntry> = {};
  const stack = [LIBRARY_ROOT];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let dirEntries: Awaited<ReturnType<typeof readdir>>;
    try {
      dirEntries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      try {
        const markdownText = await readFile(absolutePath, 'utf8');
        const sourceUrl = extractMarkdownSourceUrl(markdownText);
        if (!sourceUrl) continue;
        const relativePath = normalizePath(path.relative(EXPORT_ROOT, absolutePath));
        entries[sourceUrl] = {
          relativePath,
          title: extractMarkdownTitle(markdownText, path.basename(entry.name, '.md')),
        };
      } catch {}
    }
  }

  return entries;
}

async function readScannedLibraryIndex() {
  const now = Date.now();
  if (scannedLibraryIndexCache && now - scannedLibraryIndexCache.builtAt < PREVIEW_CACHE_TTL_MS) {
    return scannedLibraryIndexCache.items;
  }

  const items = await scanLibraryMarkdownFiles();
  scannedLibraryIndexCache = {
    builtAt: now,
    items,
  };
  return items;
}

export async function reconcileArticleLibraryExportIndex() {
  await ensureDir(EXPORT_ROOT);
  const index = await readIndex();
  const scannedIndex = await readScannedLibraryIndex();

  let added = 0;
  let updated = 0;

  for (const [sourceUrl, scanned] of Object.entries(scannedIndex)) {
    const current = index.items[sourceUrl];
    if (!current) {
      index.items[sourceUrl] = {
        relativePath: scanned.relativePath,
        exportedAt: new Date().toISOString(),
        title: scanned.title,
      };
      added += 1;
      continue;
    }

    if (current.relativePath !== scanned.relativePath || current.title !== scanned.title) {
      index.items[sourceUrl] = {
        relativePath: scanned.relativePath,
        exportedAt: current.exportedAt || new Date().toISOString(),
        title: scanned.title,
      };
      updated += 1;
    }
  }

  await writeIndex(index);
  return {
    scannedCount: Object.keys(scannedIndex).length,
    totalIndexCount: Object.keys(index.items).length,
    added,
    updated,
  };
}

async function readHtmlIndex(): Promise<PersistedHtmlSnapshotIndex> {
  try {
    return await readJsonWithFallback<PersistedHtmlSnapshotIndex>(HTML_INDEX_PATH);
  } catch {
    return { items: {} };
  }
}

async function writeHtmlIndex(index: PersistedHtmlSnapshotIndex) {
  await ensureDir(EXPORT_ROOT);
  await writeFile(HTML_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

export async function updateArticleLibrarySnapshot(payload: SnapshotPayload) {
  await ensureDir(EXPORT_ROOT);
  const snapshot: PersistedSnapshot = {
    accounts: payload.accounts || [],
    articles: payload.articles || [],
    createdAt: new Date().toISOString(),
  };
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshot;
}

function htmlSnapshotFileKey(url: string) {
  return createHash('sha1').update(canonicalizeUrl(url)).digest('hex');
}

export async function updateArticleLibraryHtmlSnapshot(items: SnapshotHtmlItem[]) {
  if (!items.length) {
    return { updated: 0 };
  }

  await ensureDir(HTML_CACHE_ROOT);
  const index = await readHtmlIndex();
  let updated = 0;

  for (const item of items) {
    const canonicalUrl = canonicalizeUrl(item.url);
    if (!canonicalUrl || !item.html) continue;
    const key = htmlSnapshotFileKey(canonicalUrl);
    const relativeFile = path.join('html-cache', `${key}.json`);
    const absoluteFile = path.join(EXPORT_ROOT, relativeFile);
    await writeFile(
      absoluteFile,
      JSON.stringify(
        {
          fakeid: item.fakeid,
          url: canonicalUrl,
          title: item.title,
          commentID: item.commentID || null,
          html: item.html,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    index.items[canonicalUrl] = {
      fakeid: item.fakeid,
      title: item.title,
      commentID: item.commentID || null,
      file: normalizePath(relativeFile),
      updatedAt: new Date().toISOString(),
    };
    updated += 1;
  }

  await writeHtmlIndex(index);
  return { updated };
}

async function readSnapshot() {
  try {
    return await readJsonWithFallback<PersistedSnapshot>(SNAPSHOT_PATH);
  } catch {
    return null;
  }
}

async function readHtmlSnapshot(url: string) {
  const canonicalUrl = canonicalizeUrl(url);
  if (!canonicalUrl) return null;
  const index = await readHtmlIndex();
  const item = index.items[canonicalUrl];
  const candidatePaths = [];
  if (item?.file) {
    candidatePaths.push(path.join(EXPORT_ROOT, item.file));
  }
  candidatePaths.push(path.join(HTML_CACHE_ROOT, `${htmlSnapshotFileKey(canonicalUrl)}.json`));

  for (const targetPath of candidatePaths) {
    try {
      const payload = await readJsonWithFallback<{ html: string }>(targetPath);
      if (payload.html) {
        return payload.html;
      }
    } catch {}
  }

  return null;
}

function isArticleWithinRange(
  article: SnapshotArticle,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  if (syncFromTimestamp !== null && article.create_time < syncFromTimestamp) return false;
  if (syncToTimestamp !== null && article.create_time > syncToTimestamp) return false;
  return true;
}

function buildCandidates(
  snapshot: PersistedSnapshot,
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  const nicknameByFakeid = new Map(snapshot.accounts.map(account => [account.fakeid, (account.nickname || '').trim()]));
  const deduped = new Map<string, ExportCandidate>();
  const recentThreshold = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);

  for (const article of snapshot.articles || []) {
    if (!article.link || article.is_deleted) continue;
    if (mode === 'recent-3d' && article.update_time < recentThreshold) continue;
    if (!isArticleWithinRange(article, syncFromTimestamp, syncToTimestamp)) continue;
    const canonicalUrl = canonicalizeUrl(article.link);
    if (!canonicalUrl) continue;
    deduped.set(canonicalUrl, {
      ...article,
      link: canonicalUrl,
      accountName: nicknameByFakeid.get(article.fakeid) || article.fakeid,
    });
  }

  return Array.from(deduped.values()).sort((a, b) => a.update_time - b.update_time);
}

function buildFailedOnlyCandidates(
  snapshot: PersistedSnapshot,
  failedUrls: string[],
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  const failedSet = new Set(failedUrls.map(canonicalizeUrl).filter(Boolean));
  const nicknameByFakeid = new Map(snapshot.accounts.map(account => [account.fakeid, (account.nickname || '').trim()]));
  const candidates: ExportCandidate[] = [];

  for (const article of snapshot.articles || []) {
    if (article.is_deleted) continue;
    if (!isArticleWithinRange(article, syncFromTimestamp, syncToTimestamp)) continue;
    const canonicalUrl = canonicalizeUrl(article.link);
    if (!canonicalUrl || !failedSet.has(canonicalUrl)) continue;
    candidates.push({
      ...article,
      link: canonicalUrl,
      accountName: nicknameByFakeid.get(article.fakeid) || article.fakeid,
    });
  }

  return candidates.sort((a, b) => a.update_time - b.update_time);
}

async function buildCachedOnlyCandidates(
  snapshot: PersistedSnapshot,
  baseMode: 'full' | 'recent-3d' = 'full',
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  const candidates = buildCandidates(snapshot, baseMode, syncFromTimestamp, syncToTimestamp);
  const htmlIndex = await readHtmlIndex();
  const cachedFileNames = new Set<string>();
  try {
    const entries = await readdir(HTML_CACHE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        cachedFileNames.add(entry.name);
      }
    }
  } catch {}
  const cached: ExportCandidate[] = [];

  for (const candidate of candidates) {
    const canonicalUrl = canonicalizeUrl(candidate.link);
    const indexedFile = htmlIndex.items[canonicalUrl]?.file;
    const indexedFileName = indexedFile ? path.basename(indexedFile) : '';
    const fallbackFileName = `${htmlSnapshotFileKey(canonicalUrl)}.json`;
    const hasCachedHtml = Boolean(
      (indexedFileName && cachedFileNames.has(indexedFileName))
      || cachedFileNames.has(fallbackFileName),
    );
    if (hasCachedHtml) {
      cached.push(candidate);
    }
  }

  return cached;
}

async function countCachedCandidates(candidates: ExportCandidate[]) {
  const htmlIndex = await readHtmlIndex();
  let cachedCandidateCount = 0;

  for (const candidate of candidates) {
    if (htmlIndex.items[candidate.link]?.file) {
      cachedCandidateCount += 1;
    }
  }

  return {
    cachedCandidateCount,
    uncachedCandidateCount: Math.max(candidates.length - cachedCandidateCount, 0),
    totalCachedCount: Object.keys(htmlIndex.items).length,
  };
}

function buildSpecificCandidates(snapshot: PersistedSnapshot, urls: string[]) {
  const targetSet = new Set(urls.map(canonicalizeUrl).filter(Boolean));
  const nicknameByFakeid = new Map(snapshot.accounts.map(account => [account.fakeid, (account.nickname || '').trim()]));
  const deduped = new Map<string, ExportCandidate>();

  for (const article of snapshot.articles || []) {
    const canonicalUrl = canonicalizeUrl(article.link);
    if (!canonicalUrl || !targetSet.has(canonicalUrl) || article.is_deleted) continue;
    deduped.set(canonicalUrl, {
      ...article,
      link: canonicalUrl,
      accountName: nicknameByFakeid.get(article.fakeid) || article.fakeid,
    });
  }

  return Array.from(deduped.values()).sort((a, b) => a.update_time - b.update_time);
}

async function readExactRecoverySourceJob(recoverySourceJobId: string, targetUrls: string[]) {
  const sourceId = validateExactRecoveryJobId(recoverySourceJobId);
  const sourceJob = await readJsonWithFallback<unknown>(path.join(getJobDir(sourceId), 'job.json'));
  return validateExactRecoverySourceJob(sourceJob, sourceId, targetUrls);
}

async function buildExactRecoveryCandidates(
  snapshot: PersistedSnapshot,
  recoverySourceJobId: string,
  targetUrls: string[]
) {
  const validatedUrls = await readExactRecoverySourceJob(recoverySourceJobId, targetUrls);
  const nicknameByFakeid = new Map(snapshot.accounts.map(account => [account.fakeid, (account.nickname || '').trim()]));
  return buildExactRecoveryTargetPlan(snapshot.articles || [], validatedUrls).map(item => {
    const article = item.snapshotArticle;
    if (article) {
      return {
        ...article,
        link: item.url,
        accountName: nicknameByFakeid.get(article.fakeid) || article.fakeid,
      };
    }
    return {
      fakeid: '',
      aid: '',
      link: item.url,
      title: '微信公众号文章',
      create_time: 0,
      update_time: 0,
      accountName: '',
      recoveryTargetOnly: true,
    };
  });
}

async function resolveCandidates(snapshot: PersistedSnapshot, job: ArticleLibraryExportJob) {
  if (job.mode === 'single') {
    if (job.recoverySourceJobId !== undefined) {
      return await buildExactRecoveryCandidates(snapshot, job.recoverySourceJobId, job.targetUrls || []);
    }
    return buildSpecificCandidates(snapshot, job.targetUrls || []);
  }
  if (job.mode === 'failed-only') {
    return buildFailedOnlyCandidates(
      snapshot,
      await readLatestFailedUrls(),
      job.syncFromTimestamp,
      job.syncToTimestamp,
    );
  }
  if (job.mode === 'cached-only') {
    return await buildCachedOnlyCandidates(snapshot, 'full', job.syncFromTimestamp, job.syncToTimestamp);
  }
  return buildCandidates(snapshot, job.mode, job.syncFromTimestamp, job.syncToTimestamp);
}

async function readFailedUrlsFromJob(jobId: string) {
  try {
    const lines = (await readFile(getJobFailureLogPath(jobId), 'utf8'))
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const deduped = new Set<string>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { url?: string };
        const canonicalUrl = canonicalizeUrl(parsed.url || '');
        if (canonicalUrl) {
          deduped.add(canonicalUrl);
        }
      } catch {}
    }
    return Array.from(deduped);
  } catch {
    return [];
  }
}

async function readLatestFailedUrls() {
  const finishedJobs = Array.from(jobs.values())
    .filter(job => (job.status === 'completed' || job.status === 'failed') && job.failedCount > 0)
    .sort((a, b) => compareCreatedAtDesc(a, b));

  for (const finishedJob of finishedJobs) {
    const fullFailureUrls = await readFailedUrlsFromJob(finishedJob.id);
    if (fullFailureUrls.length > 0) {
      return fullFailureUrls;
    }
    const sampleUrls = finishedJob.failureSamples.map(item => canonicalizeUrl(item.url)).filter(Boolean);
    if (sampleUrls.length > 0) {
      return sampleUrls;
    }
  }

  return [];
}

export async function previewArticleLibraryExport(
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
): Promise<ArticleLibraryExportPreview> {
  await ensureDir(EXPORT_ROOT);
  const snapshot = await readSnapshot();
  if (!snapshot) {
    throw new Error('系统内文章快照不存在，请先打开文章下载页后重试');
  }

  const candidates = mode === 'failed-only'
    ? buildFailedOnlyCandidates(snapshot, readLatestFailedUrls(), syncFromTimestamp, syncToTimestamp)
    : mode === 'cached-only'
      ? await buildCachedOnlyCandidates(snapshot, 'full', syncFromTimestamp, syncToTimestamp)
      : buildCandidates(snapshot, mode, syncFromTimestamp, syncToTimestamp);
  const cacheSummary = await countCachedCandidates(candidates);
  const index = await readIndex();
  let estimatedSkipCount = 0;
  for (const candidate of candidates) {
    const exported = await isCandidateAlreadyExported(candidate, index);
    if (exported.exported) {
      estimatedSkipCount += 1;
    }
  }

  return {
    mode,
    snapshotCreatedAt: snapshot.createdAt,
    totalAccounts: snapshot.accounts.length,
    scannedArticles: snapshot.articles.length,
    totalCandidates: candidates.length,
    cachedCandidateCount: cacheSummary.cachedCandidateCount,
    uncachedCandidateCount: cacheSummary.uncachedCandidateCount,
    totalCachedCount: cacheSummary.totalCachedCount,
    estimatedExportCount: Math.max(candidates.length - estimatedSkipCount, 0),
    estimatedSkipCount,
    createdAt: new Date().toISOString(),
  };
}

async function fetchText(url: string, timeoutMs: number, retries = 0) {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const requestInit = {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7',
          Referer: 'https://mp.weixin.qq.com/',
          Origin: 'https://mp.weixin.qq.com',
        },
      } as const;

      const attemptFetch = async (dispatcher?: typeof proxyDispatcher) => {
        const response = await fetch(url, {
          ...requestInit,
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return response.text();
      };

      try {
        return await attemptFetch(proxyDispatcher);
      } catch (proxyError) {
        if (proxyDispatcher) {
          console.warn(`article export proxy fetch failed, retrying direct: ${url}`, proxyError);
          return await attemptFetch(undefined);
        }
        throw proxyError;
      }
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  throw new Error(lastError?.message || `请求失败: ${url}`);
}

function extractArticleMeta(
  sourceUrl: string,
  htmlText: string,
  fallbackAccountName: string,
  fallbackTitle: string,
  publishedRaw: string,
  publishedAt: Date | null,
): ArticleMeta {
  const $ = cheerio.load(htmlText);
  const resolvedPublished = resolveWechatPublishedTime(htmlText, publishedRaw, publishedAt);
  const title =
    $('meta[property="og:title"]').attr('content')
    || $('#activity-name').text()
    || $('title').text()
    || fallbackTitle;
  const accountName =
    $('meta[property="profile:nickname"]').attr('content')
    || $('.profile_nickname').first().text()
    || fallbackAccountName;
  const description =
    $('meta[property="og:description"]').attr('content')
    || $('meta[name="description"]').attr('content')
    || '';

  return {
    sourceUrl,
    title: toCheerioText(title) || fallbackTitle || sourceUrl,
    accountName: toCheerioText(accountName) || fallbackAccountName,
    description: toCheerioText(description),
    publishedRaw: resolvedPublished.publishedRaw,
    publishedAt: resolvedPublished.publishedAt,
  };
}

function normalizeMarkdownText(text: string) {
  const lines = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const normalized: string[] = [];
  let inFence = false;
  let previousBlank = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    const trimmed = line.trim();
    const fenceMatch = /^(```|~~~)/.exec(trimmed);

    if (fenceMatch) {
      inFence = !inFence;
      normalized.push(line);
      previousBlank = false;
      continue;
    }

    if (inFence) {
      normalized.push(line);
      previousBlank = false;
      continue;
    }

    if (!trimmed) {
      if (!previousBlank) {
        normalized.push('');
        previousBlank = true;
      }
      continue;
    }

    normalized.push(line);
    previousBlank = false;
  }

  return normalized.join('\n').replace(/^\n+|\n+$/g, '');
}

function isLikelyScriptPayload(text: string) {
  if (!text) return false;
  return [
    'window.page_begintime = (+new Date());',
    'window.__canAsyncImport = window.__pageLoadReady',
    'window.cgiDataNew = {',
  ].some(pattern => text.includes(pattern));
}

function createTurndownService() {
  return createMarkdownTurndownService();
}

function normalizeHtmlFragmentImages(fragmentHtml: string) {
  const $ = cheerio.load(fragmentHtml || '', null, false);
  $('script, style, noscript, template').remove();
  $('img').each((_, element) => {
    const image = $(element);
    const preferredSrc =
      image.attr('data-src') || image.attr('data-backsrc') || image.attr('data-original-src') || image.attr('src');
    if (preferredSrc) {
      image.attr('src', preferredSrc.replace(/&amp;/g, '&'));
    }
    image.removeAttr('data-src');
    image.removeAttr('data-backsrc');
    image.removeAttr('data-original-src');
    image.removeAttr('height');
  });
  return $.root().html() || '';
}

function markdownFromHtmlFragment(fragmentHtml: string) {
  const normalizedHtml = normalizeHtmlFragmentImages(fragmentHtml);
  const markdown = normalizeMarkdownText(postProcessMarkdown(createTurndownService().turndown(normalizedHtml)));
  if (!markdown || isLikelyScriptPayload(markdown)) {
    return '';
  }
  return markdown;
}

function collectPicturePageUrls(cgiData: any) {
  const pictureList = Array.isArray(cgiData?.picture_page_info_list) ? cgiData.picture_page_info_list : [];
  const urls = pictureList
    .map((item: any) => item?.cdn_url || item?.url || item?.img_url || '')
    .map((url: string) => `${url}`.replace(/&amp;/g, '&').trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function extractMarkdownBodyFromCgiData(cgiData: any) {
  const itemShowType = Number(cgiData?.item_show_type ?? 0);
  const parts: string[] = [];

  if (itemShowType === 10) {
    const textHtml = `${cgiData?.text_page_info?.content_noencode || cgiData?.content_noencode || ''}`.trim();
    const markdown = markdownFromHtmlFragment(textHtml);
    return markdown || '';
  }

  const contentHtml = `${cgiData?.content_noencode || ''}`.trim();
  const contentMarkdown = markdownFromHtmlFragment(contentHtml);
  if (contentMarkdown) {
    parts.push(contentMarkdown);
  }

  const pictureUrls = collectPicturePageUrls(cgiData);
  if (pictureUrls.length > 0) {
    const imageMarkdown = pictureUrls.map((url, index) => `![图${index + 1}](${url})`).join('\n\n');
    if (!parts.join('\n\n').includes(imageMarkdown)) {
      parts.push(imageMarkdown);
    }
  }

  return normalizeMarkdownText(parts.join('\n\n'));
}

function extractReadableText(element: cheerio.Cheerio<any>) {
  if (!element.length) return '';
  const clone = element.clone();
  clone.find('script, style, noscript, template').remove();
  const text = normalizeMarkdownText(clone.text() || '');
  if (!text || isLikelyScriptPayload(text)) {
    return '';
  }
  return text;
}

async function extractMarkdownBody(htmlText: string) {
  const $ = cheerio.load(htmlText);
  const content = $('#js_content').first();
  if (content.length > 0) {
    content.find('script, style, mp-common-profile, .mp_profile_iframe_wrp, .original_panel_tool, .js_uneditable').remove();
    content.find('img').each((_, element) => {
      const image = $(element);
      const preferredSrc = image.attr('data-src') || image.attr('data-backsrc') || image.attr('src');
      if (preferredSrc) {
        image.attr('src', preferredSrc);
      }
    });

    const fragmentHtml = content.html() || '';
    const markdown = markdownFromHtmlFragment(fragmentHtml);
    if (markdown) {
      return markdown;
    }
  }

  const cgiData = await parseCgiDataNew(htmlText);
  if (cgiData) {
    try {
      const cgiMarkdown = extractMarkdownBodyFromCgiData(cgiData);
      if (cgiMarkdown) {
        return cgiMarkdown;
      }
    } catch {}

    try {
      const renderedHtml = await renderHTMLFromCgiDataNew(cgiData, false);
      const rendered$ = cheerio.load(renderedHtml);
      const renderedContent = rendered$('#js_content').first();
      const fragmentHtml = renderedContent.length > 0 ? renderedContent.html() || '' : renderedHtml;
      const markdown = markdownFromHtmlFragment(fragmentHtml);
      if (markdown) {
        return markdown;
      }
    } catch {}

    try {
      const renderedText = normalizeMarkdownText(renderTextFromCgiDataNew(cgiData));
      if (renderedText) {
        return renderedText;
      }
    } catch {}
  }

  const articleText = extractReadableText($('#js_article').first());
  if (articleText) {
    return articleText;
  }

  const bodyText = extractReadableText($('body').first());
  if (bodyText) {
    return bodyText;
  }

  throw new Error('原文中未找到可导出的正文内容');
}

async function persistJobJson(key: string, targetPath: string, value: unknown) {
  const serialized = JSON.stringify(value, null, 2);
  const previous = jobPersistenceChains.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await ensureDir(path.dirname(targetPath));
    const temporaryPath = `${targetPath}.tmp`;
    await writeFile(temporaryPath, serialized, 'utf8');
    await rename(temporaryPath, targetPath);
  });
  jobPersistenceChains.set(key, current);
  try {
    await current;
  } finally {
    if (jobPersistenceChains.get(key) === current) {
      jobPersistenceChains.delete(key);
    }
  }
}

async function updateJob(jobId: string, patch: Partial<ArticleLibraryExportJob>) {
  const current = jobs.get(jobId);
  if (!current) return;
  const next = { ...current, ...patch };
  jobs.set(jobId, next);
  await persistJob(next);
}

async function persistJob(job: ArticleLibraryExportJob) {
  await persistJobJson(`export:${job.id}`, path.join(getJobDir(job.id), 'job.json'), job);
}

async function createJobZip(job: ArticleLibraryExportJob, jobFiles: Array<{ relativePath: string; absolutePath: string }>) {
  const zip = new JSZip();
  for (const file of jobFiles) {
    const content = await readFile(file.absolutePath);
    zip.file(file.relativePath.replaceAll('\\', '/'), content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const zipPath = path.join(JOBS_ROOT, job.id, 'export.zip');
  await writeFile(zipPath, buffer);
  return zipPath;
}

function toZipEntryRelativePath(exportRelativePath: string) {
  return normalizePath(exportRelativePath).replace(/^library\//, '');
}

async function appendFailure(jobId: string, title: string, url: string, reason: string) {
  await appendFile(getJobFailureLogPath(jobId), `${JSON.stringify({ url, reason })}\n`, 'utf8');
  const latest = jobs.get(jobId);
  if (!latest) return;
  const failures = latest.failureSamples.slice();
  if (failures.length < FAILURE_SAMPLE_LIMIT) {
    failures.push({ url, reason });
  }
  await updateJob(jobId, {
    failureSamples: failures,
    processedCandidates: latest.processedCandidates + 1,
    failedCount: latest.failedCount + 1,
    message: `导出失败：${title}`,
  });
}

async function runJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    await updateJob(jobId, { status: 'running', startedAt: new Date().toISOString(), message: '正在读取系统内文章快照' });

    const snapshot = await readSnapshot();
    if (!snapshot) {
      throw new Error('系统内文章快照不存在，请先打开文章下载页后重试');
    }

    const candidates = await resolveCandidates(snapshot, job);
    const index = await readIndex();
    await updateJob(jobId, {
      snapshotCreatedAt: snapshot.createdAt,
      totalAccounts: snapshot.accounts.length,
      scannedArticles: snapshot.articles.length,
      totalCandidates: candidates.length,
      message: job.mode === 'single'
        ? `已读取系统快照，待处理指定文章 ${candidates.length} 篇`
        : job.mode === 'failed-only'
        ? `已读取系统快照，待重跑最近一次失败文章 ${candidates.length} 篇`
        : `已读取系统快照：${snapshot.accounts.length} 个公众号，${snapshot.articles.length} 篇文章，待处理 ${candidates.length} 篇`,
    });

    if (candidates.length === 0) {
      await updateJob(jobId, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        message: job.mode === 'single'
          ? '任务完成：指定文章未命中系统内快照'
          : job.mode === 'recent-3d'
          ? '任务完成：最近 3 天没有新增已同步文章'
          : job.mode === 'failed-only'
            ? '任务完成：最近一次失败任务中没有可重跑文章'
            : '任务完成：当前系统内没有可导出的文章',
        zipPath: null,
      });
      return;
    }

    const queue = new PQueue({
      concurrency: job.mode === 'cached-only' ? CACHED_EXPORT_CONCURRENCY : NETWORK_EXPORT_CONCURRENCY,
    });
    const jobFiles: Array<{ relativePath: string; absolutePath: string }> = [];

    await Promise.all(
      candidates.map(candidate =>
        queue.add(async () => {
          const current = jobs.get(jobId);
          if (!current || current.status === 'failed') return;

          const canonicalUrl = canonicalizeUrl(candidate.link);
          const publishedAt = candidate.create_time ? new Date(candidate.create_time * 1000) : null;

          if (job.mode !== 'single' || job.recoverySourceJobId !== undefined) {
            const exported = await isCandidateAlreadyExported(candidate, index);
            if (exported.exported) {
              index.items[canonicalUrl] = {
                relativePath: exported.relativePath || index.items[canonicalUrl]?.relativePath || '',
                exportedAt: new Date().toISOString(),
                title: exported.title || candidate.title,
              };
              if (exported.relativePath && job.recoverySourceJobId === undefined) {
                jobFiles.push({
                  relativePath: toZipEntryRelativePath(exported.relativePath),
                  absolutePath: path.join(EXPORT_ROOT, exported.relativePath),
                });
              }
              const latest = jobs.get(jobId);
              if (!latest) return;
              await updateJob(jobId, {
                processedCandidates: latest.processedCandidates + 1,
                skippedExistingCount: latest.skippedExistingCount + 1,
                message: `已跳过：${candidate.title}`,
              });
              return;
            }
          }

          try {
            let originalHtml = await readHtmlSnapshot(canonicalUrl);
            if (!originalHtml && job.mode !== 'cached-only') {
              await sleep(REQUEST_DELAY_MS);
              originalHtml = await fetchText(canonicalUrl, ARTICLE_REQUEST_TIMEOUT_MS, ARTICLE_REQUEST_RETRY);
            }
            if (!originalHtml) {
              throw new Error('cached html not found');
            }
            if (originalHtml && !candidate.recoveryTargetOnly) {
              await updateArticleLibraryHtmlSnapshot([
                {
                  fakeid: candidate.fakeid,
                  url: canonicalUrl,
                  title: candidate.title,
                  html: originalHtml,
                  commentID: null,
                },
              ]);
            }
            const meta = extractArticleMeta(
              canonicalUrl,
              originalHtml,
              candidate.accountName,
              candidate.title,
              formatWechatPublishedTime(publishedAt),
              publishedAt,
            );
            const markdownBody = await extractMarkdownBody(originalHtml);
            const markdownText = buildMarkdown(meta, markdownBody);
            const plannedOutput = await resolveWritableOutputPath(
              resolveMetaOutputPath(meta, candidate.title),
              canonicalUrl,
            );

            await ensureDir(path.dirname(plannedOutput.absolutePath));
            await writeFile(plannedOutput.absolutePath, markdownText, 'utf8');
            index.items[canonicalUrl] = {
              relativePath: plannedOutput.relativePath,
              exportedAt: new Date().toISOString(),
              title: meta.title,
            };
            jobFiles.push({
              relativePath: path.join(plannedOutput.dayFolder, plannedOutput.filename),
              absolutePath: plannedOutput.absolutePath,
            });

            const latest = jobs.get(jobId);
            if (!latest) return;
            await updateJob(jobId, {
              processedCandidates: latest.processedCandidates + 1,
              exportedCount: latest.exportedCount + 1,
              message: `已导出：${meta.title}`,
            });
          } catch (error) {
            await appendFailure(jobId, candidate.title, canonicalUrl, (error as Error).message);
          }
        })
      )
    );

    await writeIndex(index);
    const latest = jobs.get(jobId);
    if (!latest) return;
    const zipPath = jobFiles.length > 0 ? await createJobZip(latest, jobFiles) : null;
    const completionMessage =
      latest.exportedCount > 0
        ? `任务完成：导出 ${latest.exportedCount} 篇，跳过 ${latest.skippedExistingCount} 篇，失败 ${latest.failedCount} 篇`
        : latest.skippedExistingCount > 0 && latest.failedCount === 0
          ? `任务完成：本次无新增正文需要导出，已跳过 ${latest.skippedExistingCount} 篇已存在文章`
          : `任务完成：未生成可下载文件，跳过 ${latest.skippedExistingCount} 篇，失败 ${latest.failedCount} 篇`;
    await updateJob(jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      zipPath,
      message: completionMessage,
    });
  } catch (error) {
    await updateJob(jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: `任务失败：${(error as Error).message}`,
    });
  }
}

export async function startArticleLibraryExportJob(
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  await ensureDir(JOBS_ROOT);
  await ensureDir(LIBRARY_ROOT);

  const activeJob = Array.from(jobs.values()).find(job => job.status === 'queued' || job.status === 'running');
  if (activeJob) {
    return activeJob;
  }

  const id = crypto.randomUUID().replaceAll('-', '');
  const job: ArticleLibraryExportJob = {
    id,
    mode,
    syncFromTimestamp,
    syncToTimestamp,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    message: '任务已创建，等待后台执行',
    outputDir: LIBRARY_ROOT,
    zipPath: null,
    snapshotCreatedAt: null,
    totalAccounts: 0,
    scannedArticles: 0,
    totalCandidates: 0,
    processedCandidates: 0,
    exportedCount: 0,
    skippedExistingCount: 0,
    failedCount: 0,
    failureSamples: [],
  };

  jobs.set(id, job);
  latestJobId = id;
  await ensureDir(getJobDir(id));
  await writeFile(getJobFailureLogPath(id), '', 'utf8');
  await persistJob(job);
  setTimeout(() => {
    void runJob(id).catch(error => {
      console.error('文章库导出后台任务异常', error);
    });
  }, 0);
  return job;
}

export async function startSingleArticleLibraryExportJob(urls: string[], recoverySourceJobId?: string) {
  await ensureDir(JOBS_ROOT);
  await ensureDir(LIBRARY_ROOT);

  const normalizedUrls = Array.from(new Set(urls.map(canonicalizeUrl).filter(Boolean)));
  if (normalizedUrls.length === 0) {
    throw new Error('缺少有效文章链接');
  }
  if (recoverySourceJobId !== undefined) {
    await readExactRecoverySourceJob(recoverySourceJobId, normalizedUrls);
  }

  const activeJob = Array.from(jobs.values()).find(job => job.status === 'queued' || job.status === 'running');
  if (activeJob) {
    return activeJob;
  }

  const id = crypto.randomUUID().replaceAll('-', '');
  const job: ArticleLibraryExportJob = {
    id,
    mode: 'single',
    syncFromTimestamp: null,
    syncToTimestamp: null,
    targetUrls: normalizedUrls,
    ...(recoverySourceJobId !== undefined ? { recoverySourceJobId } : {}),
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    message: '单篇导出任务已创建，等待后台执行',
    outputDir: LIBRARY_ROOT,
    zipPath: null,
    snapshotCreatedAt: null,
    totalAccounts: 0,
    scannedArticles: 0,
    totalCandidates: 0,
    processedCandidates: 0,
    exportedCount: 0,
    skippedExistingCount: 0,
    failedCount: 0,
    failureSamples: [],
  };

  jobs.set(id, job);
  latestJobId = id;
  await ensureDir(getJobDir(id));
  await writeFile(getJobFailureLogPath(id), '', 'utf8');
  await persistJob(job);
  setTimeout(() => {
    void runJob(id).catch(error => {
      console.error('单篇文章库导出后台任务异常', error);
    });
  }, 0);
  return job;
}

export function getArticleLibraryExportJob(jobId: string) {
  return jobs.get(jobId) || null;
}

export function getLatestArticleLibraryExportJob() {
  return latestJobId ? jobs.get(latestJobId) || null : null;
}

export async function getArticleLibraryExportZip(jobId: string) {
  const job = getArticleLibraryExportJob(jobId);
  if (!job?.zipPath) {
    return null;
  }
  return {
    job,
    filename: `article-library-export-${job.mode}-${job.id}.zip`,
    buffer: await readFile(job.zipPath),
  };
}

export async function hydrateArticleLibraryExportJobsFromDisk() {
  await ensureDir(JOBS_ROOT);
  const entries = await readdir(JOBS_ROOT, { withFileTypes: true });
  const loaded: ArticleLibraryExportJob[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(JOBS_ROOT, entry.name, 'job.json');
    try {
      const job = await readJsonWithFallback<ArticleLibraryExportJob>(jobPath);
      job.createdAt ||= new Date((await stat(jobPath)).mtimeMs).toISOString();
      job.syncFromTimestamp ??= null;
      job.syncToTimestamp ??= null;
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.message = '任务因服务重启中断，请重新发起';
        await persistJob(job);
      }
      jobs.set(job.id, job);
      loaded.push(job);
    } catch {}
  }

  loaded.sort(compareCreatedAtDesc);
  latestJobId = loaded[0]?.id || null;
}

function previewCachePath(
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  const fromSuffix = syncFromTimestamp === null ? 'all-from' : `${syncFromTimestamp}`;
  const toSuffix = syncToTimestamp === null ? 'all-to' : `${syncToTimestamp}`;
  return path.join(PREVIEW_CACHE_ROOT, `${mode}-${fromSuffix}-${toSuffix}.json`);
}

async function readPreviewCache(
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  try {
    const preview = await readJsonWithFallback<ArticleLibraryExportPreview>(
      previewCachePath(mode, syncFromTimestamp, syncToTimestamp),
    );
    const createdAt = Date.parse(preview.createdAt || '');
    if (Number.isNaN(createdAt) || Date.now() - createdAt > PREVIEW_CACHE_TTL_MS) {
      return null;
    }
    return preview;
  } catch {
    return null;
  }
}

async function writePreviewCache(
  preview: ArticleLibraryExportPreview,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  await ensureDir(PREVIEW_CACHE_ROOT);
  await writeFile(
    previewCachePath(preview.mode, syncFromTimestamp, syncToTimestamp),
    JSON.stringify(preview, null, 2),
    'utf8',
  );
}

async function persistPreviewJob(job: ArticleLibraryExportPreviewJob) {
  await persistJobJson(`preview:${job.id}`, path.join(PREVIEW_JOBS_ROOT, job.id, 'job.json'), job);
}

async function updatePreviewJob(jobId: string, patch: Partial<ArticleLibraryExportPreviewJob>) {
  const current = previewJobs.get(jobId);
  if (!current) return;
  const next = { ...current, ...patch };
  previewJobs.set(jobId, next);
  await persistPreviewJob(next);
}

async function runPreviewJob(jobId: string) {
  const job = previewJobs.get(jobId);
  if (!job) return;

  try {
    await updatePreviewJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      message: '正在后台扫描系统内已同步文章',
    });

    const cached = await readPreviewCache(job.mode, job.syncFromTimestamp, job.syncToTimestamp);
    if (cached) {
      await updatePreviewJob(jobId, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        message: '已命中 10 分钟内的预估缓存',
        preview: cached,
      });
      return;
    }

    const preview = await previewArticleLibraryExport(job.mode, job.syncFromTimestamp, job.syncToTimestamp);
    await writePreviewCache(preview, job.syncFromTimestamp, job.syncToTimestamp);
    await updatePreviewJob(jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      message: '预估完成',
      preview,
    });
  } catch (error) {
    await updatePreviewJob(jobId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      message: `预估失败：${(error as Error).message}`,
    });
  }
}

export async function startArticleLibraryExportPreviewJob(
  mode: ArticleLibraryExportMode,
  syncFromTimestamp: number | null = null,
  syncToTimestamp: number | null = null,
) {
  await ensureDir(PREVIEW_JOBS_ROOT);
  await ensureDir(PREVIEW_CACHE_ROOT);

  const cached = await readPreviewCache(mode, syncFromTimestamp, syncToTimestamp);
  if (cached) {
    const cachedJob: ArticleLibraryExportPreviewJob = {
      id: crypto.randomUUID().replaceAll('-', ''),
      mode,
      syncFromTimestamp,
      syncToTimestamp,
      status: 'completed',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: '已命中 10 分钟内的预估缓存',
      preview: cached,
    };
    previewJobs.set(cachedJob.id, cachedJob);
    latestPreviewJobId = cachedJob.id;
    await persistPreviewJob(cachedJob);
    return cachedJob;
  }

  const activeJob = Array.from(previewJobs.values()).find(
    job =>
      job.mode === mode
      && job.syncFromTimestamp === syncFromTimestamp
      && job.syncToTimestamp === syncToTimestamp
      && (job.status === 'queued' || job.status === 'running'),
  );
  if (activeJob) {
    return activeJob;
  }

  const job: ArticleLibraryExportPreviewJob = {
    id: crypto.randomUUID().replaceAll('-', ''),
    mode,
    syncFromTimestamp,
    syncToTimestamp,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    message: '预估任务已创建，等待后台执行',
    preview: null,
  };

  previewJobs.set(job.id, job);
  latestPreviewJobId = job.id;
  await persistPreviewJob(job);
  setTimeout(() => {
    void runPreviewJob(job.id).catch(error => {
      console.error('文章库导出预估后台任务异常', error);
    });
  }, 0);
  return job;
}

export function getArticleLibraryExportPreviewJob(jobId: string) {
  return previewJobs.get(jobId) || null;
}

export function getLatestArticleLibraryExportPreviewJob() {
  return latestPreviewJobId ? previewJobs.get(latestPreviewJobId) || null : null;
}

export async function hydrateArticleLibraryExportPreviewJobsFromDisk() {
  await ensureDir(PREVIEW_JOBS_ROOT);
  const entries = await readdir(PREVIEW_JOBS_ROOT, { withFileTypes: true });
  const loaded: ArticleLibraryExportPreviewJob[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(PREVIEW_JOBS_ROOT, entry.name, 'job.json');
    try {
      const job = await readJsonWithFallback<ArticleLibraryExportPreviewJob>(jobPath);
      job.createdAt ||= new Date((await stat(jobPath)).mtimeMs).toISOString();
      job.syncFromTimestamp ??= null;
      job.syncToTimestamp ??= null;
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.message = '预估任务因服务重启中断，请重新发起';
        await persistPreviewJob(job);
      }
      previewJobs.set(job.id, job);
      loaded.push(job);
    } catch {}
  }

  loaded.sort(compareCreatedAtDesc);
  latestPreviewJobId = loaded[0]?.id || null;
}
