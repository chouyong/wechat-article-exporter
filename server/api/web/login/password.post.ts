import dayjs from 'dayjs';
import { readBody } from 'h3';
import { request } from '#shared/utils/request';
import { getCookieFromResponse, getCookiesFromRequest } from '~/server/utils/CookieStore';
import { finalizeMpLoginResponse, proxyMpRequest } from '~/server/utils/proxy-request';
import {
  buildPasswordLoginPayload,
  mergeCookieHeaders,
  shouldFollowLegacyLogin,
} from '~/server/utils/wechat-password-login';

interface PasswordLoginBody {
  username?: string;
  password?: string;
  verify_ticket?: string;
  rand_str?: string;
}

interface LoginAccount {
  nickname: string;
  avatar: string;
  expires: string;
  err?: string;
}

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ err: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default defineEventHandler(async event => {
  const body = await readBody<PasswordLoginBody>(event);
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  let payload: ReturnType<typeof buildPasswordLoginPayload>;
  try {
    payload = buildPasswordLoginPayload({
      username,
      password,
      verifyTicket: body?.verify_ticket,
      randStr: body?.rand_str,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : '登录参数无效');
  }

  const initialCookie = getCookiesFromRequest(event);
  const startResponse = await proxyMpRequest({
    event,
    method: 'POST',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/bizlogin',
    query: { action: 'startlogin' },
    body: payload,
    cookie: initialCookie,
    action: 'start_login',
    sensitive: true,
  });

  const startBody = await startResponse
    .clone()
    .json()
    .catch(() => null);
  if (!startBody || startBody?.base_resp?.ret !== 0) {
    return new Response(JSON.stringify(startBody || { err: '微信登录接口返回无效响应' }), {
      status: startResponse.status >= 400 ? startResponse.status : 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let finalResponse: Response;
  if (shouldFollowLegacyLogin(startBody)) {
    finalResponse = await proxyMpRequest({
      event,
      method: 'POST',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/login',
      query: { loginhook: 4 },
      body: payload,
      cookie: mergeCookieHeaders(initialCookie, startResponse.headers.getSetCookie()),
      action: 'login',
      sensitive: true,
    });
  } else if (typeof startBody.redirect_url === 'string' && startBody.redirect_url) {
    // 新版灰度流程可能直接在 startlogin 返回最终 redirect_url。
    // 复用统一的 CookieStore/auth-key 封装，避免落盘分支不一致。
    finalResponse = await finalizeMpLoginResponse(startResponse);
  } else {
    return errorResponse('微信账号密码登录需要完成验证码或安全确认，请改用二维码登录。', 409);
  }

  const authKey = getCookieFromResponse('auth-key', finalResponse);
  if (!authKey) {
    return errorResponse('登录未完成，请改用二维码登录。', 401);
  }

  const { nick_name, head_img } = await request(`/api/web/mp/info`, {
    headers: { Cookie: `auth-key=${authKey}` },
  });
  if (!nick_name) {
    return errorResponse('登录成功但无法读取公众号身份，请稍后重试。', 502);
  }

  const account: LoginAccount = {
    nickname: nick_name,
    avatar: head_img,
    expires: dayjs().add(4, 'days').toString(),
  };
  const responseHeaders = new Headers(finalResponse.headers);
  responseHeaders.set('Content-Type', 'application/json');
  const responseBody = JSON.stringify(account);
  responseHeaders.set('Content-Length', new TextEncoder().encode(responseBody).length.toString());
  return new Response(responseBody, { status: finalResponse.status, headers: responseHeaders });
});
