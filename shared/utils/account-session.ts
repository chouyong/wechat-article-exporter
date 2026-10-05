/**
 * 登录公众号身份与浏览器本地缓存的作用域。
 *
 * IndexedDB 账号缓存原先是全局的；登录另一个公众号账号后，旧账号的关注列表仍会
 * 出现在页面，随后拿新会话去同步旧 fakeid。这会把“账号切换”误表现成微信接口错误。
 * 作用域使用登录响应中的昵称、头像和公众号 fakeid，不保存 token、Cookie 或 auth-key。
 */

export interface AccountOwnerIdentity {
  nickname: string;
  avatar: string;
  /** 当前登录主体的 fakeid；用于区分登录作用域，不限制可抓取的目标公众号。 */
  fakeid: string;
}

export interface AccountOwnerScoped {
  ownerKey?: string;
  fakeid?: string;
}

export const ACCOUNT_OWNER_STORAGE_KEY = 'wechat-article-exporter:account-owner:v1';
export const ACCOUNT_OWNER_FAKEID_STORAGE_KEY = 'wechat-article-exporter:account-fakeid:v1';

export function createAccountOwnerKey(identity: AccountOwnerIdentity): string {
  return `v2:${identity.nickname.trim()}:${identity.avatar.trim()}:${identity.fakeid.trim()}`;
}

export function getCurrentAccountOwnerKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(ACCOUNT_OWNER_STORAGE_KEY)?.trim();
  return value || null;
}

export function getCurrentAccountOwnerFakeid(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(ACCOUNT_OWNER_FAKEID_STORAGE_KEY)?.trim();
  return value || null;
}

export function setCurrentAccountOwnerIdentity(identity: AccountOwnerIdentity | null): void {
  if (typeof localStorage === 'undefined') return;
  const fakeid = identity?.fakeid?.trim();
  if (identity && fakeid) {
    localStorage.setItem(ACCOUNT_OWNER_STORAGE_KEY, createAccountOwnerKey(identity));
    localStorage.setItem(ACCOUNT_OWNER_FAKEID_STORAGE_KEY, fakeid);
  } else {
    localStorage.removeItem(ACCOUNT_OWNER_STORAGE_KEY);
    localStorage.removeItem(ACCOUNT_OWNER_FAKEID_STORAGE_KEY);
  }
}

/**
 * 只有当前登录会话登记的公众号才允许进入文章同步请求。
 *
 * 登录主体的 fakeid 只用于生成会话作用域。公众号搜索/添加功能支持在同一
 * 登录会话下选择其他目标公众号，因此不能把目标账号 fakeid 与登录主体
 * fakeid 强行比较；这里只校验缓存 ownerKey，防止旧登录会话复用缓存。
 */
export function isAccountOwnedBy(
  account: AccountOwnerScoped,
  ownerKey: string | null,
  _ownerFakeid?: string | null
): boolean {
  return !!ownerKey && account.ownerKey === ownerKey;
}
