import { classifyAppmsgpublishError, parseAppmsgpublishResponse } from './mp-appmsgpublish-parse.ts';
import type { PageFetcher } from './mp-sync-service.ts';

const ENDPOINT = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

export interface AppmsgpublishFetcherOptions {
  authKey: string;
  fetchImpl?: typeof fetch;
  credentialProvider?: () => Promise<{ cookie: string | null; token: string | null }>;
}

/** C3-7b live PageFetcher。凭据只从服务端 CookieStore 读取，绝不进入错误消息或返回对象。 */
export function createAppmsgpublishPageFetcher(options: AppmsgpublishFetcherOptions): PageFetcher {
  const authKey = options.authKey.trim();
  if (!authKey) throw new Error('appmsgpublish fetcher requires authKey');
  const fetchImpl = options.fetchImpl ?? fetch;

  return async ({ fakeid, begin, size }) => {
    const credentials = options.credentialProvider
      ? await options.credentialProvider()
      : await (async () => {
          const { cookieStore } = await import('./CookieStore.ts');
          return Promise.all([cookieStore.getCookie(authKey), cookieStore.getToken(authKey)]).then(
            ([cookie, token]) => ({ cookie, token })
          );
        })();
    const { cookie, token } = credentials;
    if (!cookie || !token) {
      throw classifyAppmsgpublishError({ httpStatus: 401 });
    }
    const query = new URLSearchParams({
      sub: 'list',
      search_field: '7',
      begin: String(begin),
      count: String(size),
      query: '',
      fakeid,
      type: '101_1',
      free_publish_type: '1',
      sub_action: 'list_ex',
      token,
      lang: 'zh_CN',
      f: 'json',
      ajax: '1',
    });
    let response: Response;
    try {
      response = await fetchImpl(`${ENDPOINT}?${query.toString()}`, {
        method: 'GET',
        headers: {
          Referer: 'https://mp.weixin.qq.com/',
          Origin: 'https://mp.weixin.qq.com',
          'User-Agent': USER_AGENT,
          Cookie: cookie,
          Accept: 'application/json',
        },
      });
    } catch (cause) {
      throw classifyAppmsgpublishError({ cause });
    }

    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch {
      /* HTTP classifier below remains fail-closed. */
    }
    if (!response.ok) {
      const errMsg =
        body && typeof body === 'object' && typeof (body as Record<string, unknown>).base_resp === 'object'
          ? ((body as Record<string, unknown>).base_resp as Record<string, unknown>).err_msg
          : undefined;
      throw classifyAppmsgpublishError({
        httpStatus: response.status,
        errMsg: typeof errMsg === 'string' ? errMsg : undefined,
      });
    }
    return parseAppmsgpublishResponse(body);
  };
}
