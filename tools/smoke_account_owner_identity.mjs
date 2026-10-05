// 登录主体与公众号 fakeid 绑定的离线回归 smoke。
// 无网络、无凭据、无数据库；跨主体时必须在 appmsgpublish 之前阻断。

import assert from 'node:assert/strict';

const session = await import('../shared/utils/account-session.ts');
const identity = await import('../server/utils/wechat-account-identity.ts');
const { createAccountOwnerKey, isAccountOwnedBy } = session;
const { extractLoginAccountIdentity } = identity;

let passed = 0;
function check(description, condition) {
  assert.ok(condition, description);
  passed += 1;
}

const current = { nickname: '一片柳', avatar: 'https://example.com/a.png', fakeid: 'MzYxMDAwMDAwMA==' };
const ownerKey = createAccountOwnerKey(current);
check('登录主体作用域包含公众号 fakeid', ownerKey.includes(current.fakeid));
check(
  '当前登录公众号可以同步自己的 fakeid',
  isAccountOwnedBy({ ownerKey, fakeid: current.fakeid }, ownerKey, current.fakeid)
);
check(
  '同一登录作用域下可以同步另一个目标公众号',
  isAccountOwnedBy({ ownerKey, fakeid: 'MzYyMDAwMDAwMA==' }, ownerKey, current.fakeid)
);
check(
  '旧主体作用域必须被阻断',
  !isAccountOwnedBy(
    { ownerKey: createAccountOwnerKey({ ...current, fakeid: 'MzYyMDAwMDAwMA==' }), fakeid: current.fakeid },
    ownerKey,
    current.fakeid
  )
);

const html = `
  <script>
    window.cgiData = {
      user_info: { nick_name: '一片柳', head_img: 'https://example.com/a.png', fakeid: '${current.fakeid}' }
    };
  </script>
`;
const parsed = extractLoginAccountIdentity(html);
check('从公众号主页解析昵称', parsed.nickname === current.nickname);
check('从公众号主页解析头像', parsed.avatar === current.avatar);
check('从公众号主页解析 fakeid', parsed.fakeid === current.fakeid);

let articleRequests = 0;
function syncAccount(account, ownerIdentity) {
  if (!isAccountOwnedBy(account, ownerIdentity.ownerKey, ownerIdentity.fakeid)) {
    throw new Error('当前登录会话与所选公众号缓存不一致，请重新登录并重新添加该公众号后再同步');
  }
  articleRequests += 1;
}

const currentOwner = { ...current, ownerKey };

assert.throws(
  () =>
    syncAccount(
      { ownerKey: createAccountOwnerKey({ ...current, fakeid: 'MzYyMDAwMDAwMA==' }), fakeid: current.fakeid },
      currentOwner
    ),
  /当前登录会话与所选公众号缓存不一致/
);
check('跨主体阻断发生在文章接口之前', articleRequests === 0);
syncAccount({ ownerKey, fakeid: 'MzYyMDAwMDAwMA==' }, currentOwner);
check('同一登录作用域的目标公众号不会被错误阻断', articleRequests === 1);
syncAccount({ ownerKey, fakeid: current.fakeid }, currentOwner);
check('登录主体公众号也允许进入文章接口', articleRequests === 2);

console.log(`✅ smoke_account_owner_identity: ${passed} 项断言全部通过`);
