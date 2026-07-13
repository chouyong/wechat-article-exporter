// 纯离线 smoke：C2-A dry-run 导入逻辑（shared/utils/mp-account-import）。
// 注入 fake request，无 Vue/Nuxt/IndexedDB/网络。覆盖用户列出的 8 个验证场景。
//
// 运行：node tools/smoke_mp_account_import.mjs

import assert from 'node:assert/strict';

const m = await import('../shared/utils/mp-account-import.ts');
const { mapToImportInputs, summarizeDryRun, classifyImportError, decideDryRun, runDryRunCore, stripImportedFromQuery } =
  m;

let passed = 0;
function check(desc, cond) {
  assert.ok(cond, desc);
  passed += 1;
}

// 记录 fake request 的调用（用于断言是否发请求、payload、dryRun 标志）。
function fakeRequest(resp) {
  const calls = [];
  const fn = async payload => {
    calls.push(payload);
    return resp;
  };
  return { fn, calls };
}
const OK_RESP = {
  inserted: 2,
  updated: 1,
  unchanged: 3,
  invalid: 1,
  invalidItems: [{ index: 4, reason: 'fakeid 缺失' }],
};

try {
  // ── 场景 1：IndexedDB 有效数据成功发起 dry-run ────────────────────────
  {
    const { fn, calls } = fakeRequest(OK_RESP);
    const accounts = [
      { fakeid: 'a1', nickname: '甲', total_count: 10 },
      { fakeid: 'a2', nickname: '乙' },
    ];
    const out = await runDryRunCore(accounts, { request: fn });
    check('1. 有效数据 → success', out.kind === 'success');
    check('1. 发起了 1 次请求', calls.length === 1);
    check('1. summary.total=2', out.summary.total === 2);
  }

  // ── 场景 2：空数据不请求服务端 ────────────────────────────────────────
  {
    const { fn, calls } = fakeRequest(OK_RESP);
    const out = await runDryRunCore([], { request: fn });
    check('2a. 空数组 → empty', out.kind === 'empty');
    check('2a. 未发请求', calls.length === 0);
    const { fn: fn2, calls: calls2 } = fakeRequest(OK_RESP);
    const out2 = await runDryRunCore([{ fakeid: '   ' }, { fakeid: '' }], { request: fn2 });
    check('2b. 全空白 fakeid → empty', out2.kind === 'empty');
    check('2b. 未发请求', calls2.length === 0);
  }

  // ── 场景 3：字段映射正确 ──────────────────────────────────────────────
  {
    const mapped = mapToImportInputs([
      {
        fakeid: '  f1  ',
        nickname: '甲',
        round_head_img: 'http://x/a.png',
        total_count: 100,
        last_update_time: 1700000000,
        // 以下字段服务端不认，应被丢弃：
        completed: true,
        count: 5,
        articles: 3,
        create_time: 111,
        update_time: 222,
      },
      { fakeid: '', nickname: '空 fakeid 应过滤' },
    ]);
    check('3. 过滤空 fakeid 后只剩 1 条', mapped.length === 1);
    check('3. fakeid 去空白', mapped[0].fakeid === 'f1');
    check(
      '3. 保留 nickname/round_head_img/total_count/last_update_time',
      mapped[0].nickname === '甲' &&
        mapped[0].round_head_img === 'http://x/a.png' &&
        mapped[0].total_count === 100 &&
        mapped[0].last_update_time === 1700000000
    );
    check(
      '3. 丢弃服务端不认字段',
      !('completed' in mapped[0]) &&
        !('count' in mapped[0]) &&
        !('articles' in mapped[0]) &&
        !('create_time' in mapped[0]) &&
        !('update_time' in mapped[0])
    );
  }

  // ── 场景 4：冲突/跳过/可导入统计正确展示 ──────────────────────────────
  {
    const s = summarizeDryRun(OK_RESP, 7);
    check('4. importable = inserted+updated = 3', s.importable === 3);
    check(
      '4. inserted=2 updated=1 unchanged=3 invalid=1',
      s.inserted === 2 && s.updated === 1 && s.unchanged === 3 && s.invalid === 1
    );
    check('4. hasConflicts=true（有 updated/invalid）', s.hasConflicts === true);
    check('4. invalidItems 透传', s.invalidItems.length === 1 && s.invalidItems[0].index === 4);
    const clean = summarizeDryRun({ inserted: 5, updated: 0, unchanged: 2, invalid: 0 }, 7);
    check('4. 无 updated/invalid → hasConflicts=false', clean.hasConflicts === false && clean.importable === 5);
  }

  // ── 场景 5：API 错误可恢复分类 ────────────────────────────────────────
  {
    check(
      '5. 400 不可靠重试',
      classifyImportError({ statusCode: 400, data: { message: 'bad' } }).recoverable === false
    );
    check(
      '5. 401 可恢复(auth)',
      classifyImportError({ statusCode: 401 }).recoverable === true &&
        classifyImportError({ statusCode: 401 }).kind === 'auth_required'
    );
    check('5. 429 可恢复', classifyImportError({ statusCode: 429 }).recoverable === true);
    check('5. 500 可恢复', classifyImportError({ statusCode: 500 }).recoverable === true);
    check(
      '5. 网络错误可恢复',
      classifyImportError(new Error('fetch failed')).recoverable === true &&
        classifyImportError(new Error('fetch failed')).kind === 'network'
    );
    check('5. 超时可恢复', classifyImportError({ name: 'AbortError' }).recoverable === true);
    // runDryRunCore 捕获抛错 → error outcome，不抛出
    const throwing = async () => {
      const e = new Error('boom');
      e.statusCode = 500;
      throw e;
    };
    const out = await runDryRunCore([{ fakeid: 'x' }], { request: throwing });
    check('5. 请求抛错 → error outcome（不抛出）', out.kind === 'error' && out.error.recoverable === true);
  }

  // ── 场景 6：重复点击不会并发重复提交 ──────────────────────────────────
  {
    check('6. decideDryRun busy', decideDryRun(3, true) === 'busy');
    check('6. decideDryRun empty', decideDryRun(0, false) === 'empty');
    check('6. decideDryRun send', decideDryRun(3, false) === 'send');
    const { fn, calls } = fakeRequest(OK_RESP);
    const out = await runDryRunCore([{ fakeid: 'x' }], { request: fn, isBusy: true });
    check('6. isBusy=true → busy 且未发请求', out.kind === 'busy' && calls.length === 0);
  }

  // ── 场景 7：dry-run 不触发正式写入（客户端始终发 dryRun:true）────────
  {
    const { fn, calls } = fakeRequest(OK_RESP);
    await runDryRunCore([{ fakeid: 'x' }], { request: fn });
    check('7. payload.dryRun === true', calls[0].dryRun === true);
    check('7. 绝不发 dryRun:false', calls[0].dryRun !== false);
    check('7. payload.accounts 为映射后数组', Array.isArray(calls[0].accounts) && calls[0].accounts[0].fakeid === 'x');
  }

  // ── 场景 8：移除 imported 时保留其它 query 参数（导航去参根因修复）──
  {
    const q = stripImportedFromQuery({ imported: '5', foo: 'bar', page: '2' });
    check('8. 移除 imported', !('imported' in q));
    check('8. 保留 foo/page', q.foo === 'bar' && q.page === '2');
    check('8. 空 query 安全', Object.keys(stripImportedFromQuery(null)).length === 0);
    check('8. 无其它参数时返回空对象', Object.keys(stripImportedFromQuery({ imported: '9' })).length === 0);
  }

  console.log(`\nPASS smoke_mp_account_import: ${passed} assertions`);
} catch (err) {
  console.error('FAIL smoke_mp_account_import:', err && err.stack ? err.stack : err);
  process.exit(1);
}
