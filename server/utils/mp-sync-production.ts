import { mkdir, readFile, rename, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { listMpAccounts, recordMpAccountSyncResult } from './mp-account-registry.ts';
import { createAppmsgpublishPageFetcher } from './mp-appmsgpublish-fetcher.ts';
import { createSyncJob, getSyncJob, isCancelRequested } from './mp-sync-job-registry.ts';
import { type RunSyncJobDeps, recoverInterruptedJobs, runSyncJobPool } from './mp-sync-runner.ts';

let activeJobId: string | null = null;

function stagingRoot() {
  return path.resolve(process.env.MP_SYNC_STAGING_DIR || '.data/mp-sync-staging');
}

function productionRoot() {
  return path.resolve(process.env.MP_SYNC_PRODUCTION_DIR || '.data/mp-sync-production');
}

function articleDir() {
  return path.resolve(process.env.MP_SYNC_ARTICLE_LIBRARY_DIR || path.join(productionRoot(), 'articles'));
}

function manifestPath() {
  return path.resolve(process.env.MP_SYNC_MANIFEST_PATH || path.join(productionRoot(), 'manifest.sqlite'));
}

type StagedArticle = {
  aid: string;
  link: string;
  title?: string;
  authorName?: string;
  digest?: string;
  createTime: number;
  updateTime?: number;
  isDeleted?: boolean;
};

type StagedSnapshot = { jobId: string; generatedAt: string; accounts: Record<string, StagedArticle[]> };

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'article';
}

function articleId(accountId: string, article: StagedArticle) {
  return `wechat-${safeSegment(accountId)}-${safeSegment(article.aid)}`;
}

function pointId(id: string) {
  const digest = sha256(id);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function articleMarkdown(accountId: string, article: StagedArticle, id: string) {
  const published = new Date(article.createTime * 1000).toISOString();
  const title = article.title?.trim() || id;
  const digest = article.digest?.trim() || '';
  return `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\nsource: ${JSON.stringify(article.link)}\nsource_url: ${JSON.stringify(article.link)}\nsource_type: wechat\naccount_id: ${JSON.stringify(accountId)}\npublished: ${published}\nstatus: raw\ntopics: []\nentities: []\nquality_score: 0\n---\n\n${digest}\n`;
}

async function embed(text: string): Promise<number[]> {
  const endpoint = (process.env.MP_SYNC_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.MP_SYNC_EMBEDDING_MODEL || 'bge-m3';
  const response = await fetch(`${endpoint}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!response.ok) throw new Error(`embedding backend HTTP ${response.status}`);
  const body = (await response.json()) as { embeddings?: unknown };
  const vector = Array.isArray(body.embeddings) && Array.isArray(body.embeddings[0]) ? body.embeddings[0] : body.embeddings;
  if (!Array.isArray(vector) || !vector.every(value => typeof value === 'number' && Number.isFinite(value)))
    throw new Error('embedding backend returned invalid vector');
  return vector as number[];
}

async function qdrantUpsert(points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>) {
  const endpoint = (process.env.MP_SYNC_QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
  const collection = process.env.MP_SYNC_QDRANT_COLLECTION || 'kb_wechat_articles_bge_m3_v2';
  const expectedDimension = Number(process.env.MP_SYNC_QDRANT_DIMENSION || 1024);
  if (!points.length) return { endpoint, collection, ids: [] as string[] };
  if (points.some(point => point.vector.length !== expectedDimension))
    throw new Error(`qdrant dimension mismatch: expected ${expectedDimension}`);
  const response = await fetch(`${endpoint}/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!response.ok) throw new Error(`qdrant upsert HTTP ${response.status}`);
  return { endpoint, collection, ids: points.map(point => point.id) };
}

async function qdrantDelete(endpoint: string, collection: string, ids: string[]) {
  if (!ids.length) return;
  try {
    await fetch(`${endpoint}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ points: ids }),
    });
  } catch {
    // Rollback remains fail-closed and evidence records the original commit failure.
  }
}

/** 将 staging snapshot 原子提交到文章库、manifest.sqlite 和 Qdrant；任何依赖缺失均拒绝成功。 */
export async function commitStagedSyncJob(jobId: string) {
  const stagingDir = path.join(stagingRoot(), jobId);
  const snapshot = JSON.parse(await readFile(path.join(stagingDir, 'snapshot.json'), 'utf8')) as StagedSnapshot;
  if (snapshot.jobId !== jobId || !snapshot.accounts || typeof snapshot.accounts !== 'object')
    throw new Error('staging snapshot schema mismatch');
  const all = Object.entries(snapshot.accounts).flatMap(([fakeid, articles]) => {
    if (!Array.isArray(articles)) throw new Error(`staging account ${fakeid} is not an array`);
    return articles.map(article => ({ fakeid, article }));
  });
  const root = articleDir();
  const manifest = manifestPath();
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(manifest), { recursive: true });
  const backupDir = path.join(productionRoot(), 'rollback', jobId);
  await mkdir(backupDir, { recursive: true });
  const manifestBackup = path.join(backupDir, 'manifest.sqlite');
  let db: DatabaseSync | null = null;
  const changedFiles: Array<{ target: string; backup?: string }> = [];
  const qdrantPoints: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
  let qdrantCommit: { endpoint: string; collection: string; ids: string[] } | null = null;
  try {
    try { await copyFile(manifest, manifestBackup); } catch { /* first commit has no manifest */ }
    db = new DatabaseSync(manifest);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(`CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL, account_id TEXT, raw_path TEXT, inbox_path TEXT, library_path TEXT, content_hash TEXT, quick_hash TEXT, status TEXT NOT NULL, tier_used TEXT, quality_score INTEGER DEFAULT 0, imported_at TEXT, updated_at TEXT, published TEXT, topics_json TEXT, entities_json TEXT, embedding_id TEXT); CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_type);`);
    db.exec('BEGIN IMMEDIATE;');
    for (const { fakeid, article } of all) {
      if (!article || typeof article.link !== 'string' || !article.link.startsWith('https://mp.weixin.qq.com/')) throw new Error('staging article source URL invalid');
      if (!Number.isFinite(article.createTime)) throw new Error('staging article createTime invalid');
      const existing = db.prepare('SELECT id, library_path, content_hash, embedding_id FROM articles WHERE source_url = ?').get(article.link) as Record<string, unknown> | undefined;
      const id = existing?.id ? String(existing.id) : articleId(fakeid, article);
      const content = articleMarkdown(fakeid, article, id);
      const contentHash = `sha256:${sha256(content)}`;
      const target = existing?.library_path ? String(existing.library_path) : path.join(root, `${id}.md`);
      if (!path.isAbsolute(target)) throw new Error(`manifest article path is not absolute: ${article.link}`);
      if (existing?.content_hash !== contentHash) {
        const backup = path.join(backupDir, `${safeSegment(id)}.md`);
        try { await copyFile(target, backup); changedFiles.push({ target, backup }); } catch { changedFiles.push({ target }); }
        await writeFile(`${target}.tmp`, content, 'utf8');
        await rename(`${target}.tmp`, target);
        const vector = await embed(`${article.title || id}\n${article.digest || ''}`);
        const vectorId = pointId(id);
        qdrantPoints.push({ id: vectorId, vector, payload: { article_id: id, source_url: article.link, title: article.title || id, account_id: fakeid, content_hash: contentHash } });
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO articles (id, source_url, source_type, account_id, raw_path, library_path, content_hash, quick_hash, status, quality_score, imported_at, updated_at, published, topics_json, entities_json, embedding_id) VALUES (?, ?, 'wechat', ?, ?, ?, ?, ?, 'raw', 0, ?, ?, ?, '[]', '[]', ?) ON CONFLICT(source_url) DO UPDATE SET id=excluded.id, account_id=excluded.account_id, raw_path=excluded.raw_path, library_path=excluded.library_path, content_hash=excluded.content_hash, quick_hash=excluded.quick_hash, status=excluded.status, updated_at=excluded.updated_at, published=excluded.published, topics_json=excluded.topics_json, entities_json=excluded.entities_json, embedding_id=excluded.embedding_id`).run(id, article.link, fakeid, target, target, contentHash, sha256(content).slice(0, 16), now, now, new Date(article.createTime * 1000).toISOString(), `${process.env.MP_SYNC_EMBEDDING_MODEL || 'bge-m3'}::article-clean-bge-m3-v1::2::${contentHash}`);
      }
    }
    qdrantCommit = await qdrantUpsert(qdrantPoints);
    db.exec('COMMIT;');
    const commitEvidence = { jobId, committedAt: new Date().toISOString(), articleCount: all.length, changedCount: qdrantPoints.length, qdrant: { collection: qdrantCommit.collection, pointCount: qdrantCommit.ids.length }, rollbackManifest: manifestBackup };
    await writeFile(path.join(backupDir, 'commit.json'), JSON.stringify(commitEvidence, null, 2), 'utf8');
    await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify({ jobId, status: 'committed', articleCount: all.length, changedCount: qdrantPoints.length, commitEvidence }, null, 2), 'utf8');
    return { jobId, articleCount: all.length, changedCount: qdrantPoints.length, manifest, articleDir: root, qdrant: { collection: qdrantCommit.collection, pointCount: qdrantCommit.ids.length }, rollbackDir: backupDir };
  } catch (error) {
    try { db?.exec('ROLLBACK;'); } catch { /* no active transaction */ }
    await qdrantDelete(qdrantCommit?.endpoint || (process.env.MP_SYNC_QDRANT_URL || 'http://127.0.0.1:6333'), qdrantCommit?.collection || (process.env.MP_SYNC_QDRANT_COLLECTION || 'kb_wechat_articles_bge_m3_v2'), qdrantCommit?.ids || qdrantPoints.map(point => point.id));
    for (const file of changedFiles.reverse()) {
      try { if (file.backup) await copyFile(file.backup, file.target); else await rm(file.target, { force: true }); } catch { /* evidence remains fail-closed */ }
    }
    try { if (await readFile(manifestBackup).then(() => true).catch(() => false)) await copyFile(manifestBackup, manifest); } catch { /* first commit leaves schema only */ }
    throw error;
  } finally {
    db?.close();
  }
}

async function writeStaging(jobId: string, articles: Map<string, unknown[]>) {
  const dir = path.join(stagingRoot(), jobId);
  await mkdir(dir, { recursive: true });
  const payload = { jobId, generatedAt: new Date().toISOString(), accounts: Object.fromEntries(articles) };
  const tmp = path.join(dir, 'snapshot.json.tmp');
  const out = path.join(dir, 'snapshot.json');
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  await rename(tmp, out);
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      jobId,
      status: 'staged',
      articleCount: [...articles.values()].reduce((n, xs) => n + xs.length, 0),
      rollback: out,
    }),
    'utf8'
  );
}

export function getActiveSyncJobId() {
  return activeJobId;
}

export async function startMpSyncJob(jobId: string, authKey: string) {
  if (activeJobId && activeJobId !== jobId) throw new Error(`another sync job is active: ${activeJobId}`);
  activeJobId = jobId;
  const articles = new Map<string, unknown[]>();
  const fetchPage = createAppmsgpublishPageFetcher({ authKey });
  const deps: RunSyncJobDeps = {
    fetchPage,
    onArticles: (_id, fakeid, newArticles) => {
      articles.set(fakeid, [...newArticles]);
    },
    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
    timeoutMs: 30000,
    beforeFinalize: async id => {
      if (process.env.MP_SYNC_PRODUCTION_ENABLED === '1') {
        await writeStaging(id, articles);
        await commitStagedSyncJob(id);
      }
    },
  };
  try {
    const result = await runSyncJobPool(jobId, deps);
    for (const account of result.accounts)
      recordMpAccountSyncResult({
        fakeid: account.fakeid,
        status: account.status,
        lastArticleTime: account.lastArticleTime,
        errorCode: account.errorKind,
        errorMessage: account.errorMessage,
      });
    await writeStaging(jobId, articles);
    return result;
  } finally {
    activeJobId = null;
  }
}

export async function recoverMpSyncJobs(authKey: string) {
  let recoveryJobId: string | null = null;
  let recoveryArticles = new Map<string, unknown[]>();
  const fetchPage = createAppmsgpublishPageFetcher({ authKey });
  return recoverInterruptedJobs({
    fetchPage,
    onArticles: (jobId, fakeid, newArticles) => {
      if (recoveryJobId === jobId) recoveryArticles.set(fakeid, [...newArticles]);
    },
    retry: { maxAttempts: 3 },
    timeoutMs: 30000,
    beforeFinalize: async id => {
      if (process.env.MP_SYNC_PRODUCTION_ENABLED !== '1' || isCancelRequested(id)) return;
      try {
        await writeStaging(id, recoveryArticles);
        await commitStagedSyncJob(id);
      } finally {
        recoveryJobId = null;
        recoveryArticles = new Map<string, unknown[]>();
      }
    },
  }, {
    onJobStart: jobId => {
      recoveryJobId = jobId;
      recoveryArticles = new Map<string, unknown[]>();
    },
    onJobComplete: async (jobId, outcome) => {
      // 取消路径不会进入 beforeFinalize；非生产模式也不会进入提交屏障；统一清理归属状态。
      if (outcome === 'cancelled' || recoveryJobId === jobId) {
        recoveryJobId = null;
        recoveryArticles = new Map<string, unknown[]>();
      }
    },
  });
}

export function createIncrementalJob(idempotencyKey?: string | null) {
  const accounts = listMpAccounts({ enabled: true, page: 1, pageSize: 500 }).items;
  return createSyncJob({
    mode: 'incremental',
    idempotencyKey,
    requestedSince: null,
    accounts: accounts.map(a => ({ fakeid: a.fakeid, priority: a.priority, sinceTime: a.last_article_time ?? 0 })),
  });
}
