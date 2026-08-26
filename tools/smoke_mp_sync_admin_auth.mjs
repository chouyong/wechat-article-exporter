import assert from 'node:assert/strict';
import { isMpSyncAdminAuthorized } from '../server/utils/mp-sync-admin-auth.ts';

let passed = 0;
function check(description, condition) {
  assert.ok(condition, description);
  passed += 1;
}

check('缺服务端 token 时拒绝', !isMpSyncAdminAuthorized(undefined, 'client-token'));
check('缺客户端 token 时拒绝', !isMpSyncAdminAuthorized('server-token', undefined));
check('不同长度 token 时拒绝', !isMpSyncAdminAuthorized('server-token', 'short'));
check('相同长度错误 token 时拒绝', !isMpSyncAdminAuthorized('server-token', 'server-tokem'));
check('精确 token 时放行', isMpSyncAdminAuthorized('server-token', 'server-token'));
check('首尾空白规范化后精确 token 时放行', isMpSyncAdminAuthorized(' server-token ', 'server-token '));

console.log('\nPASS smoke_mp_sync_admin_auth: ' + passed + ' assertions');
