/**
 * 获取登录用户信息接口
 *
 * 备注：
 * 这个接口用于后端登录成功之后调用，非客户端直接调用。
 * 除昵称和头像外，必须返回当前登录公众号的 fakeid，作为文章接口的主体边界。
 */

import type { H3Event } from 'h3';
import { getTokenFromStore } from '~/server/utils/CookieStore';
import { proxyMpRequest } from '~/server/utils/proxy-request';
import { extractLoginAccountIdentity } from '~/server/utils/wechat-account-identity';

interface SearchBizItem {
  fakeid?: string;
  nickname?: string;
  round_head_img?: string;
}

interface SearchBizResponse {
  base_resp?: { ret?: number };
  list?: SearchBizItem[];
}

function normalizeAvatar(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase().split('?')[0];
  }
}

function findExactSearchIdentity(items: SearchBizItem[], nickname: string, avatar: string): string {
  const exact = items.filter(item => item.nickname?.trim() === nickname.trim() && item.fakeid?.trim());
  if (exact.length === 1) return exact[0].fakeid!.trim();

  const avatarKey = normalizeAvatar(avatar);
  if (!avatarKey) return '';
  const avatarMatches = exact.filter(item => normalizeAvatar(item.round_head_img || '') === avatarKey);
  return avatarMatches.length === 1 ? avatarMatches[0].fakeid!.trim() : '';
}

async function resolveFakeidFromSearch(
  event: H3Event,
  token: string,
  nickname: string,
  avatar: string
): Promise<string> {
  if (!nickname) return '';

  try {
    const response = (await proxyMpRequest({
      event,
      method: 'GET',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/searchbiz',
      query: {
        action: 'search_biz',
        begin: 0,
        count: 20,
        query: nickname,
        token,
        lang: 'zh_CN',
        f: 'json',
        ajax: 1,
      },
      parseJson: true,
    })) as SearchBizResponse;

    if (response?.base_resp?.ret !== 0 || !Array.isArray(response.list)) return '';
    return findExactSearchIdentity(response.list, nickname, avatar);
  } catch {
    return '';
  }
}

export default defineEventHandler(async event => {
  const token = await getTokenFromStore(event);
  if (!token) {
    return { nick_name: '', head_img: '', fakeid: '', error: '未登录或登录已过期，请重新扫码登录' };
  }

  const html: string = await proxyMpRequest({
    event,
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/home',
    query: {
      t: 'home/index',
      token: token,
      lang: 'zh_CN',
    },
  }).then(resp => resp.text());

  const identity = extractLoginAccountIdentity(html);
  const fakeid = identity.fakeid || (await resolveFakeidFromSearch(event, token, identity.nickname, identity.avatar));

  return {
    nick_name: identity.nickname,
    head_img: identity.avatar,
    fakeid,
  };
});
