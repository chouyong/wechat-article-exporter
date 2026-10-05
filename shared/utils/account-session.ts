/**
 * 登录公众号身份与浏览器本地缓存的作用域。
 *
 * IndexedDB 账号缓存原先是全局的；登录另一个公众号账号后，旧账号的关注列表仍会
 * 出现在页面，随后拿新会话去同步旧 fakeid。这会把“账号切换”误表现成微信接口错误。
 * 作用域只使用登录响应中的昵称和头像地址，不保存 token、Cookie 或 auth-key。
 */

export interface AccountOwnerIdentity {
  nickname: string;
  avatar: string;
}

export interface AccountOwnerScoped {
  ownerKey?: string;
}

export const ACCOUNT_OWNER_STORAGE_KEY = 'wechat-article-exporter:account-owner:v1';

export function createAccountOwnerKey(identity: AccountOwnerIdentity): string {
  return `v1:${identity.nickname.trim()}:${identity.avatar.trim()}`;
}

export function getCurrentAccountOwnerKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(ACCOUNT_OWNER_STORAGE_KEY)?.trim();
  return value || null;
}

export function setCurrentAccountOwnerKey(ownerKey: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (ownerKey) {
    localStorage.setItem(ACCOUNT_OWNER_STORAGE_KEY, ownerKey);
  } else {
    localStorage.removeItem(ACCOUNT_OWNER_STORAGE_KEY);
  }
}

/** 只有当前登录主体登记的公众号才允许进入文章同步请求。 */
export function isAccountOwnedBy(account: AccountOwnerScoped, ownerKey: string | null): boolean {
  return !!ownerKey && account.ownerKey === ownerKey;
}
