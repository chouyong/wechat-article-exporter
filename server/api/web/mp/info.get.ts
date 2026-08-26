/**
 * 获取登录用户信息接口
 *
 * 备注：
 * 这个接口用于后端登录成功之后调用，非客户端直接调用
 */

import { getTokenFromStore } from '~/server/utils/CookieStore';
import { proxyMpRequest } from '~/server/utils/proxy-request';

function extractAccountField(html: string, names: string[]): string {
  // 微信页面在不同版本中会返回 JS 赋值、JSON 或 HTML 转义的 JSON。
  const normalized = html
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('\\\\"', '"');
  const field = names.join('|');
  const patterns = [
    new RegExp(`(?:wx\\.cgiData\\.)?(?:${field})\\s*=\\s*["']([^"']+)["']`, 'i'),
    new RegExp(`["'](?:${field})["']\\s*:\\s*["']([^"']+)["']`, 'i'),
    new RegExp(`\\b(?:${field})\\b\\s*[:=]\\s*["']([^"']+)["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

export default defineEventHandler(async event => {
  const token = await getTokenFromStore(event);
  if (!token) {
    return { nick_name: '', head_img: '', error: '未登录或登录已过期，请重新扫码登录' };
  }

  const html: string = await proxyMpRequest({
    event: event,
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/home',
    query: {
      t: 'home/index',
      token: token,
      lang: 'zh_CN',
    },
  }).then(resp => resp.text());

  const nick_name = extractAccountField(html, ['nick_name', 'nickname']);
  const head_img = extractAccountField(html, ['head_img', 'headImg', 'avatar']);

  return {
    nick_name: nick_name,
    head_img: head_img,
  };
});
