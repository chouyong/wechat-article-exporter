import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databasePath =
  process.env.MP_SYNC_DB_PATH || path.join(os.tmpdir(), `mp-account-registry-smoke-${process.pid}.sqlite`);
if (!path.basename(databasePath).includes('mp-account-registry-smoke')) {
  throw new Error('smoke database path must contain mp-account-registry-smoke');
}
process.env.MP_SYNC_DB_PATH = databasePath;

const registry = await import('../server/utils/mp-account-registry.ts');
const cleanup = () => {
  registry.closeMpAccountRegistry();
  for (const suffix of ['', '-shm', '-wal']) {
    const target = `${databasePath}${suffix}`;
    if (existsSync(target)) rmSync(target);
  }
};

try {
  cleanup();
  registry.initializeMpAccountRegistry();

  const preview = registry.upsertMpAccounts(
    [
      { fakeid: 'account-a', nickname: '甲', alias: 'manual-alias', source: 'browser_import' },
      { fakeid: 'account-b', nickname: '乙', enabled: false, priority: 3 },
    ],
    { dryRun: true }
  );
  assert.equal(preview.inserted, 2);
  assert.equal(registry.listMpAccounts().total, 0);

  const inserted = registry.upsertMpAccounts([
    { fakeid: 'account-a', nickname: '甲', alias: 'manual-alias', source: 'browser_import' },
    { fakeid: 'account-b', nickname: '乙', enabled: false, priority: 3 },
  ]);
  assert.equal(inserted.inserted, 2);
  assert.equal(registry.listMpAccounts().total, 2);

  const repeated = registry.upsertMpAccounts([
    { fakeid: 'account-a', nickname: '甲', source: 'browser_import' },
    { fakeid: 'account-b', nickname: '乙', enabled: false, priority: 3 },
  ]);
  assert.equal(repeated.unchanged, 2);
  assert.equal(registry.getMpAccount('account-a').alias, 'manual-alias');

  const duplicatePreview = registry.upsertMpAccounts(
    [
      { fakeid: 'account-c', nickname: '旧名' },
      { fakeid: 'account-c', nickname: '新名' },
    ],
    { dryRun: true }
  );
  assert.equal(duplicatePreview.inserted, 1);
  assert.equal(registry.listMpAccounts().total, 2);

  const updated = registry.upsertMpAccounts([
    { fakeid: 'account-a', nickname: '甲-更新', round_head_img: 'https://example.com/a.png' },
  ]);
  assert.equal(updated.updated, 1);
  assert.equal(registry.getMpAccount('account-a').source, 'browser_import');
  registry.upsertMpAccounts([{ fakeid: 'account-a', alias: null }]);
  assert.equal(registry.getMpAccount('account-a').alias, null);

  const patched = registry.patchMpAccount('account-a', { starred: true, priority: 10 });
  assert.equal(patched.starred, true);
  assert.equal(patched.priority, 10);
  assert.equal(registry.listMpAccounts({ starred: true }).total, 1);
  assert.equal(registry.listMpAccounts({ search: '更新' }).items[0].fakeid, 'account-a');

  registry.closeMpAccountRegistry();
  registry.initializeMpAccountRegistry();
  assert.equal(registry.listMpAccounts().total, 2);
  console.log('PASS smoke_mp_account_registry: 16 assertions');
} finally {
  cleanup();
}
