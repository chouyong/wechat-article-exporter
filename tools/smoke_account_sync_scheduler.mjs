// 公众号同步调度与错误提示的离线回归 smoke。
// 无网络、无凭据、无数据库；用于锁定频控保护和用户可见错误语义。

import assert from 'node:assert/strict';

const mod = await import('../shared/utils/account-sync.ts');
const session = await import('../shared/utils/account-session.ts');
const registration = await import('../shared/utils/account-registration.ts');
const { ACCOUNT_SYNC_CONCURRENCY, formatAccountSyncError, isFrequencyControlError, runAccountSyncBatch } = mod;
const { createAccountOwnerKey, isAccountOwnedBy } = session;
const { createAccountRegistration } = registration;

let passed = 0;
function check(description, condition) {
  assert.ok(condition, description);
  passed += 1;
}

check('批量同步固定串行，避免并发触发微信频控', ACCOUNT_SYNC_CONCURRENCY === 1);
const ownerAIdentity = { nickname: '一片柳', avatar: 'avatar-a', fakeid: 'MzYxMDAwMDAwMA==' };
const ownerBIdentity = { nickname: '另一账号', avatar: 'avatar-b', fakeid: 'MzYyMDAwMDAwMA==' };
const ownerA = createAccountOwnerKey(ownerAIdentity);
const ownerB = createAccountOwnerKey(ownerBIdentity);
check('登录身份生成稳定的本地缓存作用域', ownerA === createAccountOwnerKey({ ...ownerAIdentity }));
check('不同登录身份不会共享公众号缓存作用域', ownerA !== ownerB);
check(
  '同步前允许当前登录主体自己的账号行',
  isAccountOwnedBy({ ownerKey: ownerA, fakeid: ownerAIdentity.fakeid }, ownerA, ownerAIdentity.fakeid)
);
check(
  '同步前拒绝缺少主体作用域的旧账号行',
  !isAccountOwnedBy({ ownerKey: undefined, fakeid: ownerAIdentity.fakeid }, ownerA, ownerAIdentity.fakeid)
);
check(
  '同步前拒绝缺少主体 fakeid 的旧账号行',
  !isAccountOwnedBy({ ownerKey: ownerA, fakeid: ownerAIdentity.fakeid }, ownerA, null)
);
check(
  '同步前拒绝另一个登录主体的账号行',
  !isAccountOwnedBy({ ownerKey: ownerB, fakeid: ownerBIdentity.fakeid }, ownerA, ownerAIdentity.fakeid)
);
check(
  '同步前拒绝同一作用域下的跨公众号 fakeid',
  !isAccountOwnedBy({ ownerKey: ownerA, fakeid: ownerBIdentity.fakeid }, ownerA, ownerAIdentity.fakeid)
);
check('200013/freq control 被识别为频控', isFrequencyControlError(new Error('200013:freq control')));
check(
  '频控错误提示包含中文原因和停止重试建议',
  /频控/.test(formatAccountSyncError(new Error('200013:freq control'))) &&
    /停止/.test(formatAccountSyncError(new Error('200013:freq control'))) &&
    /稍后/.test(formatAccountSyncError(new Error('200013:freq control')))
);

const addedAccount = createAccountRegistration({
  fakeid: 'fakeid-new-account',
  nickname: '一片柳',
  round_head_img: 'https://example.com/avatar.png',
});
check('添加账号只生成未同步的本地登记数据', addedAccount.completed === false && addedAccount.total_count === 0);
check(
  '添加账号保留搜索结果的身份字段',
  addedAccount.fakeid === 'fakeid-new-account' && addedAccount.nickname === '一片柳'
);

const active = new Set();
let maxActive = 0;
const order = [];
await runAccountSyncBatch([{ fakeid: 'a' }, { fakeid: 'b' }, { fakeid: 'c' }], async account => {
  check(`账号 ${account.fakeid} 开始时没有并发请求`, active.size === 0);
  active.add(account.fakeid);
  maxActive = Math.max(maxActive, active.size);
  order.push(`start:${account.fakeid}`);
  await Promise.resolve();
  order.push(`end:${account.fakeid}`);
  active.delete(account.fakeid);
});
check('批量同步最大并发数为 1', maxActive === 1);
check('批量同步按队列顺序完成', order.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c');

let canceledCalls = 0;
await assert.rejects(
  () =>
    runAccountSyncBatch(
      [{ fakeid: 'a' }, { fakeid: 'b' }],
      async () => {
        canceledCalls += 1;
      },
      () => canceledCalls > 0
    ),
  /已取消同步/
);
check('取消后不再启动后续账号', canceledCalls === 1);

console.log(`✅ smoke_account_sync_scheduler: ${passed} 项断言全部通过`);
