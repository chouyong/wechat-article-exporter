import { createHash } from 'node:crypto';

/** 微信公众平台当前网页登录脚本只对密码前 16 个字符做摘要。 */
export const WECHAT_PASSWORD_MAX_LENGTH = 16;

export interface PasswordLoginInput {
  username: string;
  password: string;
  verifyTicket?: string;
  randStr?: string;
  userlang?: string;
  redirectUrl?: string;
}

export interface PasswordLoginPayload {
  username: string;
  pwd: string;
  verify_ticket: string;
  rand_str: string;
  f: 'json';
  userlang: string;
  redirect_url: string;
}

/** 生成微信网页登录所需的密码摘要；不返回或持久化明文密码。 */
export function hashWechatPassword(password: string): string {
  return createHash('md5').update(password.slice(0, WECHAT_PASSWORD_MAX_LENGTH), 'utf8').digest('hex');
}

/** 构造官方登录页使用的 startlogin 请求体。 */
export function buildPasswordLoginPayload(input: PasswordLoginInput): PasswordLoginPayload {
  const username = input.username.trim();
  if (!username) {
    throw new Error('账号不能为空');
  }
  if (!input.password) {
    throw new Error('密码不能为空');
  }

  return {
    username,
    pwd: hashWechatPassword(input.password),
    verify_ticket: input.verifyTicket?.trim() || '',
    rand_str: input.randStr?.trim() || '',
    f: 'json',
    userlang: input.userlang?.trim() || 'zh_CN',
    redirect_url: input.redirectUrl?.trim() || '',
  };
}

/** 官方 startlogin 返回 grey=0 时，还需要补发旧 loginhook=4 请求。 */
export function shouldFollowLegacyLogin(response: unknown): boolean {
  return !!response && typeof response === 'object' && (response as { grey?: unknown }).grey === 0;
}

/** 把登录流程中微信返回的 Set-Cookie 合并进下一跳请求，不保留 Path 等属性。 */
export function mergeCookieHeaders(baseCookie: string, setCookies: readonly string[]): string {
  const cookies = new Map<string, string>();
  for (const part of baseCookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }

  for (const header of setCookies) {
    const firstPart = header.split(';', 1)[0] || '';
    const separator = firstPart.indexOf('=');
    if (separator <= 0) continue;
    const name = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }

  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}
