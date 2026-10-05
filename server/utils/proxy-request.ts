import dayjs from 'dayjs';
import type { H3Event } from 'h3';
import { parseCookies } from 'h3';
import { v4 as uuidv4 } from 'uuid';
import { isDev, USER_AGENT } from '~/config';
import type { RequestOptions } from '~/server/types';
import { cookieStore, getCookieFromStore } from '~/server/utils/CookieStore';
import { logRequest, logResponse } from '~/server/utils/logger';

/**
 * 代理微信公众号请求
 * @description 备注：只有登录请求(`action=login`)中的 `set-cookie` 才会被写入到 CookieStore 中
 * @param options 请求参数
 */
export async function proxyMpRequest(options: RequestOptions) {
  const runtimeConfig = useRuntimeConfig();

  const headers = new Headers({
    Referer: 'https://mp.weixin.qq.com/',
    Origin: 'https://mp.weixin.qq.com',
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity', // 禁用压缩，避免出现response.clone() bug
  });

  // 优先读取参数中的 cookie，若无则从 CookieStore 中读取
  const cookie: string | null = options.cookie || (await getCookieFromStore(options.event));
  if (cookie) {
    headers.set('Cookie', cookie);
  }

  const requestInit: RequestInit = {
    method: options.method,
    headers: headers,
    redirect: options.redirect || 'follow',
  };

  // 处理参数
  if (options.query) {
    options.endpoint += '?' + new URLSearchParams(options.query as Record<string, string>).toString();
  }
  if (options.method === 'POST' && options.body) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    requestInit.body = new URLSearchParams(options.body as Record<string, string>).toString();
  }

  // 构造请求
  const request = new Request(options.endpoint, requestInit);

  // 记录请求报文
  const requestId = uuidv4().replace(/-/g, '');
  if (process.env.NUXT_DEBUG_MP_REQUEST && isDev && !options.sensitive) {
    await logRequest(requestId, request.clone());
  }

  // 转发请求
  const mpResponse = await fetch(request);

  // 记录响应报文
  if (process.env.NUXT_DEBUG_MP_REQUEST && isDev && !options.sensitive) {
    await logResponse(requestId, mpResponse.clone());
  }

  let setCookies: string[] = [];

  // 处理登录请求的 uuid cookie
  if (options.action === 'start_login') {
    // 提取出 uuid 这个 cookie，并透传给客户端
    setCookies = mpResponse.headers.getSetCookie().filter(cookie => cookie.startsWith('uuid='));
  }

  // 处理登录成功请求的 cookie
  // 只有登录请求才会将 Cookie 数据写入 CookieStore
  // 返回给客户端的一个 auth-key 的 cookie
  else if (options.action === 'login') {
    return finalizeMpLoginResponse(mpResponse);
  }

  // 处理切换公众号的请求
  else if (options.action === 'switch_account') {
    const authKey = getAuthKeyFromRequest(options.event);
    if (authKey) {
      setCookies = ['switch_account=1'];
    }
  }

  // 这里是否需要执行？
  // 更新 CookieStore 中的 cookie
  else {
    // updateCookies(options.event, mpResponse.headers.getSetCookie());
  }

  // 构造返回给客户端的响应
  const responseHeaders = new Headers(mpResponse.headers);
  responseHeaders.delete('set-cookie');
  setCookies.forEach(setCookie => {
    responseHeaders.append('set-cookie', setCookie);
  });

  const finalResponse = new Response(mpResponse.body, {
    status: mpResponse.status,
    statusText: mpResponse.statusText,
    headers: responseHeaders,
  });

  if (!options.parseJson) {
    return finalResponse;
  } else {
    return finalResponse.json();
  }
}

/**
 * 完成微信登录响应的凭据落盘和 auth-key 响应封装。
 * 账号密码登录存在 startlogin → loginhook=4 两跳，第一跳不应直接写入凭据，
 * 因此将这段逻辑单独导出给两种登录流程共同使用。
 */
export async function finalizeMpLoginResponse(mpResponse: Response): Promise<Response> {
  try {
    const authKey = crypto.randomUUID().replace(/-/g, '');
    const body = await mpResponse.clone().json();
    const redirectUrl = body?.redirect_url;
    if (!redirectUrl || typeof redirectUrl !== 'string') {
      throw new Error('登录响应缺少 redirect_url');
    }

    const token = new URL(`http://localhost${redirectUrl}`).searchParams.get('token');
    if (!token) {
      throw new Error('登录响应缺少 token');
    }

    const success = await cookieStore.setCookie(authKey, token, mpResponse.headers.getSetCookie());
    if (!success) {
      throw new Error('cookie 写入 KV 存储失败');
    }

    const responseHeaders = new Headers(mpResponse.headers);
    responseHeaders.delete('set-cookie');
    responseHeaders.append(
      'set-cookie',
      `auth-key=${authKey}; Path=/; Expires=${dayjs().add(4, 'days').toString()}; Secure; HttpOnly`
    );
    responseHeaders.append(
      'set-cookie',
      `uuid=EXPIRED; Path=/; Expires=${dayjs().subtract(1, 'days').toString()}; Secure; HttpOnly`
    );

    return new Response(mpResponse.body, {
      status: mpResponse.status,
      statusText: mpResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('登录处理失败:', error instanceof Error ? error.name : 'unknown_error');
    return new Response(JSON.stringify({ base_resp: { ret: -1, err_msg: '登录处理失败' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export function getAuthKeyFromRequest(event: H3Event): string {
  let authKey = getRequestHeader(event, 'X-Auth-Key');
  if (!authKey) {
    const cookies = parseCookies(event);
    authKey = cookies['auth-key'];
  }

  return authKey;
}

// function updateCookies(event: H3Event, cookies: string[]): void {
//   const authKey = getAuthKeyFromRequest(event);
//   if (authKey) {
//     cookieStore.updateCookie(authKey, cookies);
//   }
// }
