// 真实 HTTP 集成测试：mp-accounts 服务端账号注册表 API
//
// 与 tools/smoke_mp_account_registry.mjs（仓库层直调函数）不同，本脚本：
//   1. 依赖已构建的 Nitro 产物 .output/server/index.mjs（先跑 `yarn build`）。
//   2. 用隔离的临时 SQLite 数据目录 + 随机空闲端口，启动真实生产 server 子进程。
//   3. 通过 HTTP 覆盖 handoff 要求的契约：invalid 混批 / 分页过滤 / 资源 404 /
//      空 patch / 重复导入幂等 / dry-run 无副作用 / export 结构。
//   4. 断言 status code + 响应体 + 最终持久化状态；finally 里可靠杀进程树 + 删临时目录。
//
// 无新增依赖：仅用 Node 内置 fetch / node:net / node:child_process / node:assert。
// 运行：先 `yarn build`，再 `node tools/smoke_mp_account_api_http.mjs`
//   （Node 22.x 需 `--experimental-sqlite`；Node ≥23 免 flag。子进程一律带该 flag，向前兼容。）

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(repoRoot, '.output', 'server', 'index.mjs');

// 临时数据根：优先 D:/tmp（本机约定），回退到系统 tmp。
const tmpRoot = existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir();
const dataDir = path.join(tmpRoot, `mp-account-http-smoke-${process.pid}-${Date.now()}`);
const dbPath = path.join(dataDir, 'mp-sync.sqlite');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // 杀整棵进程树（Nitro/listhen 可能派生子进程）。
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function waitForReady(baseUrl, child, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server 在就绪前退出，exitCode=${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/tools/mp-accounts`);
      if (res.status === 200) return;
    } catch {
      // 连接被拒 = 还没起来，继续轮询
    }
    await sleep(300);
  }
  throw new Error(`server 在 ${timeoutMs}ms 内未就绪`);
}

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
}

async function main() {
  if (!existsSync(serverEntry)) {
    throw new Error(`未找到 ${serverEntry}，请先运行 \`yarn build\``);
  }
  mkdirSync(dataDir, { recursive: true });
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = `${baseUrl}/api/tools/mp-accounts`;

  const child = spawn(process.execPath, ['--experimental-sqlite', serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      // 隔离：账号库指向临时文件，KV 走内存，绝不触碰仓库真实 .data
      MP_SYNC_DB_PATH: dbPath,
      NITRO_KV_DRIVER: 'memory',
      TEMP: tmpRoot,
      TMP: tmpRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', d => {
    serverLog += d.toString();
  });
  child.stderr.on('data', d => {
    serverLog += d.toString();
  });

  try {
    try {
      await waitForReady(baseUrl, child);
    } catch (e) {
      throw new Error(`${e.message}\n--- server 输出 ---\n${serverLog.slice(-2000)}`);
    }

    const req = async (method, urlPath, body) => {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json = null;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json };
    };

    // ── 用例 1：invalid 混批 ─────────────────────────────────────────────
    const batch1 = await req('POST', '/api/tools/mp-accounts/batch', {
      accounts: [
        { fakeid: 'http-a', nickname: '甲', priority: 5 },
        { nickname: 'missing-fakeid' }, // 无 fakeid → invalid
        { fakeid: 'http-b', nickname: '乙', enabled: false, starred: true, priority: 1 },
        { fakeid: '   ', nickname: 'blank-fakeid' }, // 空白 fakeid → invalid
      ],
      dryRun: false,
    });
    check('1. batch 混批 → 200', batch1.status === 200);
    check('1. batch 混批 → inserted=2', batch1.json.inserted === 2);
    check('1. batch 混批 → invalid=2', batch1.json.invalid === 2);
    check(
      '1. batch 混批 → invalidItems 有下标+原因',
      Array.isArray(batch1.json.invalidItems) &&
        batch1.json.invalidItems.length === 2 &&
        typeof batch1.json.invalidItems[0].index === 'number' &&
        typeof batch1.json.invalidItems[0].reason === 'string'
    );
    const afterBatch1 = await req('GET', '/api/tools/mp-accounts');
    check('1. 合法项落库 → total=2', afterBatch1.json.total === 2);

    // ── 用例 2：分页 + 过滤 ──────────────────────────────────────────────
    const batch2 = await req('POST', '/api/tools/mp-accounts/batch', {
      accounts: [
        { fakeid: 'http-c', nickname: '丙', priority: 3 },
        { fakeid: 'http-d', nickname: '丁', priority: 0, starred: false },
        { fakeid: 'http-e', nickname: '戊-特', priority: 9 },
      ],
    });
    check('2. 追加 3 条 → inserted=3', batch2.json.inserted === 3);

    const page1 = await req('GET', '/api/tools/mp-accounts?pageSize=2&page=1');
    check('2. 分页 total=5', page1.json.total === 5);
    check('2. 分页 pageSize=2 → items=2', page1.json.items.length === 2);
    check('2. 排序 priority desc → 首条 http-e(9)', page1.json.items[0].fakeid === 'http-e');
    const page3 = await req('GET', '/api/tools/mp-accounts?pageSize=2&page=3');
    check('2. 分页 page=3 → items=1', page3.json.items.length === 1);

    const fEnabled = await req('GET', '/api/tools/mp-accounts?enabled=false');
    check(
      '2. enabled=false → total=1 (http-b)',
      fEnabled.json.total === 1 && fEnabled.json.items[0].fakeid === 'http-b'
    );
    const fStarred = await req('GET', '/api/tools/mp-accounts?starred=true');
    check(
      '2. starred=true → total=1 (http-b)',
      fStarred.json.total === 1 && fStarred.json.items[0].fakeid === 'http-b'
    );
    const fMinPri = await req('GET', '/api/tools/mp-accounts?minPriority=5');
    check('2. minPriority=5 → total=2', fMinPri.json.total === 2);
    const fSearch = await req('GET', `/api/tools/mp-accounts?search=${encodeURIComponent('特')}`);
    check('2. search=特 → 命中 http-e', fSearch.json.total === 1 && fSearch.json.items[0].fakeid === 'http-e');

    // ── 用例 3：PATCH 404 / 空 patch 400 / 正常 patch ────────────────────
    const patch404 = await req('PATCH', '/api/tools/mp-accounts/does-not-exist', { enabled: false });
    check('3. PATCH 不存在 → 404', patch404.status === 404);
    const patchEmpty = await req('PATCH', '/api/tools/mp-accounts/http-a', {});
    check('3. PATCH 空 body → 400', patchEmpty.status === 400);
    const patchOk = await req('PATCH', '/api/tools/mp-accounts/http-a', { priority: 10, starred: true });
    check('3. PATCH 有效 → 200', patchOk.status === 200);
    check(
      '3. PATCH 生效 priority=10/starred=true',
      patchOk.json.account.priority === 10 && patchOk.json.account.starred === true
    );

    // ── 用例 4：import-browser 重复导入幂等 ──────────────────────────────
    const impPayload = {
      accounts: [
        {
          fakeid: 'imp-1',
          nickname: '导入甲',
          round_head_img: 'https://example.com/a.png',
          total_count: 100,
          last_update_time: 1700000000,
        },
      ],
    };
    const imp1 = await req('POST', '/api/tools/mp-accounts/import-browser', impPayload);
    check('4. 首次导入 → inserted=1', imp1.json.inserted === 1);
    const afterImp1 = await req('GET', '/api/tools/mp-accounts');
    check('4. 导入后 total=6', afterImp1.json.total === 6);
    const imp2 = await req('POST', '/api/tools/mp-accounts/import-browser', impPayload);
    check('4. 重复导入 → unchanged=1/inserted=0', imp2.json.unchanged === 1 && imp2.json.inserted === 0);
    const afterImp2 = await req('GET', '/api/tools/mp-accounts');
    check('4. 重复导入后 total 仍=6（幂等）', afterImp2.json.total === 6);

    // ── 用例 5：dry-run 无副作用 ─────────────────────────────────────────
    const dry = await req('POST', '/api/tools/mp-accounts/batch', {
      accounts: [{ fakeid: 'dry-1', nickname: '预览' }],
      dryRun: true,
    });
    check('5. dry-run → inserted=1/dryRun=true', dry.json.inserted === 1 && dry.json.dryRun === true);
    const afterDry = await req('GET', '/api/tools/mp-accounts');
    check('5. dry-run 后 total 仍=6（无写入）', afterDry.json.total === 6);

    // ── 用例 6：export 结构 + 字段映射 ──────────────────────────────────
    const exp = await req('GET', '/api/tools/mp-accounts/export');
    check('6. export → 200', exp.status === 200);
    check(
      '6. export.generatedAt 为 ISO 字符串',
      typeof exp.json.generatedAt === 'string' && !Number.isNaN(Date.parse(exp.json.generatedAt))
    );
    check('6. export.accounts 长度=6', Array.isArray(exp.json.accounts) && exp.json.accounts.length === 6);
    check('6. dry-1 未进 export', !exp.json.accounts.some(a => a.fakeid === 'dry-1'));
    const imp1rec = exp.json.accounts.find(a => a.fakeid === 'imp-1');
    check('6. 字段映射 round_head_img→avatar_url', imp1rec && imp1rec.avatar_url === 'https://example.com/a.png');
    check('6. 字段映射 total_count→reported_total_count', imp1rec && imp1rec.reported_total_count === 100);
    check(
      '6. 字段映射 last_update_time→last_synced_at(ISO)',
      imp1rec && imp1rec.last_synced_at === new Date(1700000000 * 1000).toISOString()
    );
    check('6. source 归一 browser_import', imp1rec && imp1rec.source === 'browser_import');

    console.log(`PASS smoke_mp_account_api_http: ${passed} assertions`);
  } finally {
    killTree(child);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败（WAL 句柄偶发占用）
    }
  }
}

main().catch(err => {
  console.error('FAIL smoke_mp_account_api_http:', err.message);
  process.exit(1);
});
