// 微信账号/密码登录协议的离线回归 smoke。
// 不访问微信、不提交真实凭据；只验证请求构造、密码摘要和 Cookie 合并边界。

import assert from 'node:assert/strict';

const mod = await import('../server/utils/wechat-password-login.ts');
const {
  WECHAT_PASSWORD_MAX_LENGTH,
  buildPasswordLoginPayload,
  hashWechatPassword,
  mergeCookieHeaders,
  shouldFollowLegacyLogin,
} = mod;

let passed = 0;
function check(description, condition) {
  assert.ok(condition, description);
  passed += 1;
}

check('微信密码使用 UTF-8 MD5 摘要', hashWechatPassword('password') === '5f4dcc3b5aa765d61d8327deb882cf99');
check(
  '微信密码最多取前 16 个字符',
  hashWechatPassword('1234567890123456-extra') === hashWechatPassword('1234567890123456')
);

const payload = buildPasswordLoginPayload({
  username: 'owner@example.com',
  password: 'secret-value',
  verifyTicket: 'ticket',
  randStr: 'rand',
});
check('账号密码请求包含官方字段', payload.username === 'owner@example.com' && payload.verify_ticket === 'ticket');
check(
  '请求体不包含明文密码字段',
  !Object.prototype.hasOwnProperty.call(payload, 'password') && !JSON.stringify(payload).includes('secret-value')
);
check('请求体密码字段是摘要', payload.pwd === hashWechatPassword('secret-value'));
check('密码长度上限与官方流程一致', WECHAT_PASSWORD_MAX_LENGTH === 16);
check('灰度标记为 0 时进入旧登录提交', shouldFollowLegacyLogin({ grey: 0 }) === true);
check('非 0 灰度标记不重复提交', shouldFollowLegacyLogin({ grey: 1 }) === false);

const merged = mergeCookieHeaders('uuid=old; auth-key=old-key', ['uuid=new; Path=/', 'session=next; HttpOnly']);
check('登录响应 Cookie 覆盖同名旧值并保留新值', merged === 'uuid=new; auth-key=old-key; session=next');

assert.throws(() => buildPasswordLoginPayload({ username: '', password: 'secret' }), /账号不能为空/);
assert.throws(() => buildPasswordLoginPayload({ username: 'owner', password: '' }), /密码不能为空/);
check('账号和密码输入校验失败关闭', true);

console.log(`✅ smoke_wechat_password_login: ${passed} 项断言全部通过`);
