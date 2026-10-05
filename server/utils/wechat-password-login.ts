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

export interface PasswordLoginFailure {
  status: number;
  message: string;
  code?: number;
}

/** 将微信登录错误转换成前端可执行的状态和提示，不暴露原始请求内容。 */
export function classifyPasswordLoginFailure(response: unknown, upstreamStatus = 400): PasswordLoginFailure {
  const baseResp = response && typeof response === 'object' ? (response as { base_resp?: unknown }).base_resp : null;
  const details = baseResp && typeof baseResp === 'object' ? (baseResp as Record<string, unknown>) : {};
  const rawCode = details.ret;
  const code = typeof rawCode === 'number' ? rawCode : Number(rawCode);
  const errMsg = typeof details.err_msg === 'string' ? details.err_msg : '';

  if (code === 200002 || code === 200023) {
    return {
      status: 401,
      code,
      message: '账号或密码错误，请使用微信公众平台的邮箱或微信号登录；手机号不能作为登录账号。',
    };
  }

  if (code === 200008) {
    return { status: 409, code, message: '微信要求完成验证码或安全确认，请改用二维码登录。' };
  }

  if (code === 200007 || code === 200138) {
    return { status: 429, code, message: '微信暂时限制了登录请求，请稍后再试或改用二维码登录。' };
  }

  return {
    status: upstreamStatus >= 400 ? upstreamStatus : 502,
    ...(Number.isFinite(code) ? { code } : {}),
    message: errMsg || '微信登录接口返回无效响应，请改用二维码登录。',
  };
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
