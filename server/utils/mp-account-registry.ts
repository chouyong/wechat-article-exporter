import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MpAccountSource = 'browser_import' | 'manual' | 'api' | 'auto_detect';

export interface MpAccountUpsertInput {
  fakeid: string;
  nickname?: string | null;
  alias?: string | null;
  avatar_url?: string | null;
  round_head_img?: string | null;
  enabled?: boolean;
  priority?: number;
  starred?: boolean | null;
  source?: MpAccountSource;
  reported_total_count?: number | null;
  total_count?: number | null;
  last_article_time?: number | null;
  last_synced_at?: string | null;
  last_update_time?: number | null;
}

export interface MpAccountPatch {
  nickname?: string | null;
  alias?: string | null;
  avatar_url?: string | null;
  enabled?: boolean;
  priority?: number;
  starred?: boolean | null;
}

export interface MpAccountRecord {
  fakeid: string;
  nickname: string | null;
  alias: string | null;
  avatar_url: string | null;
  enabled: boolean;
  priority: number;
  starred: boolean | null;
  source: MpAccountSource;
  reported_total_count: number | null;
  last_article_time: number | null;
  last_synced_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface MpAccountListOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  enabled?: boolean;
  starred?: boolean | null;
  minPriority?: number;
}

export interface MpAccountBatchResult {
  inserted: number;
  updated: number;
  unchanged: number;
  changes: Array<{ fakeid: string; action: 'inserted' | 'updated' | 'unchanged' }>;
  dryRun: boolean;
}

type SqliteRow = Record<string, unknown>;

const SCHEMA_VERSION = 1;
const DEFAULT_DB_PATH = path.resolve(process.cwd(), '.data', 'kv', 'mp-sync.sqlite');

/**
 * 合法 epoch 秒上界。JS Date 可表示范围是 ±8.64e15 ms（约 ±271821 年）；epoch 秒 * 1000
 * 必须落在此范围内，否则 `new Date(sec * 1000).toISOString()` 抛原生 RangeError。
 * 作为「可转换 epoch 秒」的单一事实源：API schema（mp-account-api.ts）与本模块
 * epochToIso() 共用，保证两层校验口径一致（Codex C1-F1）。
 */
export const MAX_EPOCH_SECONDS = 8_640_000_000_000; // 8.64e12 秒；* 1000 = 8.64e15 ms = Date 上界

let database: DatabaseSync | null = null;
let openedPath: string | null = null;

function resolveDatabasePath(databasePath?: string) {
  return path.resolve(databasePath || process.env.MP_SYNC_DB_PATH || DEFAULT_DB_PATH);
}

function openDatabase(databasePath?: string) {
  const resolvedPath = resolveDatabasePath(databasePath);
  if (database && openedPath === resolvedPath) return database;
  database?.close();
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  database = new DatabaseSync(resolvedPath);
  openedPath = resolvedPath;
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  return database;
}

function migrate(db: DatabaseSync) {
  const versionRow = db.prepare('PRAGMA user_version').get() as SqliteRow | undefined;
  const currentVersion = Number(versionRow?.user_version || 0);
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`mp account registry schema ${currentVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (currentVersion < 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS mp_accounts (
        fakeid TEXT PRIMARY KEY,
        nickname TEXT,
        alias TEXT,
        avatar_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 0,
        starred INTEGER CHECK (starred IS NULL OR starred IN (0, 1)),
        source TEXT NOT NULL CHECK (source IN ('browser_import', 'manual', 'api', 'auto_detect')),
        reported_total_count INTEGER,
        last_article_time INTEGER,
        last_synced_at TEXT,
        last_success_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mp_accounts_enabled_priority
        ON mp_accounts(enabled, priority DESC, nickname);
      CREATE INDEX IF NOT EXISTS idx_mp_accounts_starred
        ON mp_accounts(starred, priority DESC);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

export function initializeMpAccountRegistry(databasePath?: string) {
  const db = openDatabase(databasePath);
  migrate(db);
  return resolveDatabasePath(databasePath);
}

export function closeMpAccountRegistry() {
  database?.close();
  database = null;
  openedPath = null;
}

function getDatabase() {
  initializeMpAccountRegistry();
  return database as DatabaseSync;
}

function nullableText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value.trim() || null;
}

function epochToIso(value: number | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // 防御纵深：越界 / 非有限 epoch（绕过 API 校验的内部调用）降级为 null，
  // 不再让 new Date().toISOString() 抛原生 RangeError 拖垮整批 upsert（Codex C1-F1 §3.3.2）。
  if (!Number.isFinite(value) || Math.abs(value) > MAX_EPOCH_SECONDS) return null;
  return new Date(value * 1000).toISOString();
}

function fromRow(row: SqliteRow): MpAccountRecord {
  return {
    fakeid: String(row.fakeid),
    nickname: row.nickname === null ? null : String(row.nickname),
    alias: row.alias === null ? null : String(row.alias),
    avatar_url: row.avatar_url === null ? null : String(row.avatar_url),
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority),
    starred: row.starred === null ? null : Number(row.starred) === 1,
    source: String(row.source) as MpAccountSource,
    reported_total_count: row.reported_total_count === null ? null : Number(row.reported_total_count),
    last_article_time: row.last_article_time === null ? null : Number(row.last_article_time),
    last_synced_at: row.last_synced_at === null ? null : String(row.last_synced_at),
    last_success_at: row.last_success_at === null ? null : String(row.last_success_at),
    last_error_code: row.last_error_code === null ? null : String(row.last_error_code),
    last_error_message: row.last_error_message === null ? null : String(row.last_error_message),
    consecutive_failures: Number(row.consecutive_failures),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function selectAccount(db: DatabaseSync, fakeid: string) {
  const row = db.prepare('SELECT * FROM mp_accounts WHERE fakeid = ?').get(fakeid) as SqliteRow | undefined;
  return row ? fromRow(row) : null;
}

export function getMpAccount(fakeid: string) {
  return selectAccount(getDatabase(), fakeid.trim());
}

function nextRecord(input: MpAccountUpsertInput, existing: MpAccountRecord | null, now: string): MpAccountRecord {
  const legacyLastSyncedAt = epochToIso(input.last_update_time);
  const has = (key: keyof MpAccountUpsertInput) => Object.prototype.hasOwnProperty.call(input, key);
  const avatarInput = has('avatar_url') ? input.avatar_url : input.round_head_img;
  return {
    fakeid: input.fakeid.trim(),
    nickname: has('nickname') ? (nullableText(input.nickname) ?? null) : (existing?.nickname ?? null),
    alias: has('alias') ? (nullableText(input.alias) ?? null) : (existing?.alias ?? null),
    avatar_url:
      has('avatar_url') || has('round_head_img') ? (nullableText(avatarInput) ?? null) : (existing?.avatar_url ?? null),
    enabled: input.enabled ?? existing?.enabled ?? true,
    priority: input.priority ?? existing?.priority ?? 0,
    starred: input.starred === undefined ? (existing?.starred ?? null) : input.starred,
    source: existing?.source ?? input.source ?? 'api',
    reported_total_count: has('reported_total_count')
      ? (input.reported_total_count ?? null)
      : has('total_count')
        ? (input.total_count ?? null)
        : (existing?.reported_total_count ?? null),
    last_article_time:
      input.last_article_time === undefined ? (existing?.last_article_time ?? null) : input.last_article_time,
    last_synced_at:
      input.last_synced_at === undefined
        ? (legacyLastSyncedAt ?? existing?.last_synced_at ?? null)
        : input.last_synced_at,
    last_success_at: existing?.last_success_at ?? null,
    last_error_code: existing?.last_error_code ?? null,
    last_error_message: existing?.last_error_message ?? null,
    consecutive_failures: existing?.consecutive_failures ?? 0,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function comparable(record: MpAccountRecord) {
  const { updated_at: _updatedAt, ...rest } = record;
  return JSON.stringify(rest);
}

function insertAccount(db: DatabaseSync, record: MpAccountRecord) {
  db.prepare(`
    INSERT INTO mp_accounts (
      fakeid, nickname, alias, avatar_url, enabled, priority, starred, source,
      reported_total_count, last_article_time, last_synced_at, last_success_at,
      last_error_code, last_error_message, consecutive_failures, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.fakeid,
    record.nickname,
    record.alias,
    record.avatar_url,
    record.enabled ? 1 : 0,
    record.priority,
    record.starred === null ? null : record.starred ? 1 : 0,
    record.source,
    record.reported_total_count,
    record.last_article_time,
    record.last_synced_at,
    record.last_success_at,
    record.last_error_code,
    record.last_error_message,
    record.consecutive_failures,
    record.created_at,
    record.updated_at
  );
}

function updateAccount(db: DatabaseSync, record: MpAccountRecord) {
  db.prepare(`
    UPDATE mp_accounts SET
      nickname = ?, alias = ?, avatar_url = ?, enabled = ?, priority = ?, starred = ?,
      source = ?, reported_total_count = ?, last_article_time = ?, last_synced_at = ?,
      last_success_at = ?, last_error_code = ?, last_error_message = ?,
      consecutive_failures = ?, updated_at = ?
    WHERE fakeid = ?
  `).run(
    record.nickname,
    record.alias,
    record.avatar_url,
    record.enabled ? 1 : 0,
    record.priority,
    record.starred === null ? null : record.starred ? 1 : 0,
    record.source,
    record.reported_total_count,
    record.last_article_time,
    record.last_synced_at,
    record.last_success_at,
    record.last_error_code,
    record.last_error_message,
    record.consecutive_failures,
    record.updated_at,
    record.fakeid
  );
}

export function upsertMpAccounts(
  inputs: MpAccountUpsertInput[],
  options: { dryRun?: boolean } = {}
): MpAccountBatchResult {
  const db = getDatabase();
  const result: MpAccountBatchResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    changes: [],
    dryRun: options.dryRun ?? false,
  };
  const uniqueInputs = new Map<string, MpAccountUpsertInput>();
  for (const input of inputs) {
    const fakeid = input.fakeid.trim();
    if (fakeid) uniqueInputs.set(fakeid, { ...input, fakeid });
  }
  if (!result.dryRun) db.exec('BEGIN IMMEDIATE;');
  try {
    for (const [fakeid, input] of uniqueInputs) {
      const existing = selectAccount(db, fakeid);
      const record = nextRecord(input, existing, new Date().toISOString());
      if (!existing) {
        result.inserted += 1;
        result.changes.push({ fakeid, action: 'inserted' });
        if (!result.dryRun) insertAccount(db, record);
      } else if (comparable(existing) === comparable(record)) {
        result.unchanged += 1;
        result.changes.push({ fakeid, action: 'unchanged' });
      } else {
        result.updated += 1;
        result.changes.push({ fakeid, action: 'updated' });
        if (!result.dryRun) updateAccount(db, record);
      }
    }
    if (!result.dryRun) db.exec('COMMIT;');
    return result;
  } catch (error) {
    if (!result.dryRun) db.exec('ROLLBACK;');
    throw error;
  }
}

export function patchMpAccount(fakeid: string, patch: MpAccountPatch) {
  const db = getDatabase();
  const existing = selectAccount(db, fakeid.trim());
  if (!existing) return null;
  const record: MpAccountRecord = {
    ...existing,
    nickname: patch.nickname === undefined ? existing.nickname : (nullableText(patch.nickname) ?? null),
    alias: patch.alias === undefined ? existing.alias : (nullableText(patch.alias) ?? null),
    avatar_url: patch.avatar_url === undefined ? existing.avatar_url : (nullableText(patch.avatar_url) ?? null),
    enabled: patch.enabled ?? existing.enabled,
    priority: patch.priority ?? existing.priority,
    starred: patch.starred === undefined ? existing.starred : patch.starred,
    updated_at: new Date().toISOString(),
  };
  if (comparable(existing) !== comparable(record)) updateAccount(db, record);
  return selectAccount(db, existing.fakeid);
}

function escapeLike(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function listMpAccounts(options: MpAccountListOptions = {}) {
  const db = getDatabase();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, options.pageSize ?? 50));
  const conditions: string[] = [];
  const parameters: Array<string | number | null> = [];
  const search = options.search?.trim();
  if (search) {
    conditions.push(`(fakeid LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\' OR alias LIKE ? ESCAPE '\\')`);
    const pattern = `%${escapeLike(search)}%`;
    parameters.push(pattern, pattern, pattern);
  }
  if (options.enabled !== undefined) {
    conditions.push('enabled = ?');
    parameters.push(options.enabled ? 1 : 0);
  }
  if (options.starred !== undefined) {
    if (options.starred === null) conditions.push('starred IS NULL');
    else {
      conditions.push('starred = ?');
      parameters.push(options.starred ? 1 : 0);
    }
  }
  if (options.minPriority !== undefined) {
    conditions.push('priority >= ?');
    parameters.push(options.minPriority);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM mp_accounts ${where}`).get(...parameters) as SqliteRow;
  const rows = db
    .prepare(`
      SELECT * FROM mp_accounts ${where}
      ORDER BY priority DESC, COALESCE(nickname, alias, fakeid) COLLATE NOCASE, fakeid
      LIMIT ? OFFSET ?
    `)
    .all(...parameters, pageSize, (page - 1) * pageSize) as SqliteRow[];
  return { items: rows.map(fromRow), total: Number(countRow.total), page, pageSize };
}

export function exportMpAccounts() {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM mp_accounts ORDER BY priority DESC, fakeid').all() as SqliteRow[];
  return rows.map(fromRow);
}
