/**
 * 获取文章列表接口
 */

import { getTokenFromStore } from '~/server/utils/CookieStore';
import { buildAppmsgpublishParams } from '~/server/utils/mp-appmsgpublish-params';
import { proxyMpRequest } from '~/server/utils/proxy-request';

interface AppMsgPublishQuery {
  begin?: number | string;
  size?: number | string;
  id?: string;
  keyword?: string;
}

export default defineEventHandler(async event => {
  const token = await getTokenFromStore(event);
  if (!token) {
    return { base_resp: { ret: -1, err_msg: '未登录或登录已过期，请重新扫码登录' } };
  }

  const query = getQuery<AppMsgPublishQuery>(event);
  let params: Record<string, string | number>;
  try {
    params = buildAppmsgpublishParams({
      fakeid: query.id ?? '',
      token,
      begin: query.begin,
      size: query.size,
      keyword: query.keyword,
    });
  } catch (error) {
    return {
      base_resp: {
        ret: -1,
        err_msg: error instanceof Error ? error.message : '文章列表请求参数无效',
      },
    };
  }

  return proxyMpRequest({
    event: event,
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish',
    query: params,
    parseJson: true,
  }).catch(e => {
    console.error(e);
    return {
      base_resp: {
        ret: -1,
        err_msg: '获取文章列表接口失败，请重试',
      },
    };
  });
});
