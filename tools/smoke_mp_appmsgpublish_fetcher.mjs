import assert from 'node:assert/strict';
import { createAppmsgpublishPageFetcher } from '../server/utils/mp-appmsgpublish-fetcher.ts';
import { SyncFetchError } from '../server/utils/mp-sync-service.ts';

const calls = [];
const raw = {
  base_resp: { ret: 0 },
  publish_page: JSON.stringify({
    publish_list: [
      {
        publish_info: JSON.stringify({
          appmsgex: [{ aid: 'a1', link: 'https://mp.weixin.qq.com/s?a=1', create_time: 10 }],
        }),
      },
    ],
  }),
};
const fetcher = createAppmsgpublishPageFetcher({
  authKey: 'offline-key',
  credentialProvider: async () => ({ cookie: 'slave_sid=COOKIE', token: '123' }),
  fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
const page = await fetcher({ fakeid: 'fake-1', begin: 20, size: 5 });
assert.equal(page.articles[0].aid, 'a1');
assert.match(calls[0].url, /fakeid=fake-1/);
assert.match(calls[0].url, /begin=20/);
assert.match(calls[0].url, /token=123/);
assert.equal(calls[0].init.headers.Cookie, 'slave_sid=COOKIE');

const authFetcher = createAppmsgpublishPageFetcher({
  authKey: 'offline-key',
  credentialProvider: async () => ({ cookie: null, token: null }),
  fetchImpl: async () => {
    throw new Error('must not call');
  },
});
await assert.rejects(
  () => authFetcher({ fakeid: 'f', begin: 0, size: 5 }),
  e => e instanceof SyncFetchError && e.kind === 'auth_required'
);

const httpFetcher = createAppmsgpublishPageFetcher({
  authKey: 'offline-key',
  credentialProvider: async () => ({ cookie: 'c', token: 't' }),
  fetchImpl: async () =>
    new Response(JSON.stringify({ base_resp: { ret: 0, err_msg: 'Cookie=SECRET' } }), { status: 401 }),
});
await assert.rejects(
  () => httpFetcher({ fakeid: 'f', begin: 0, size: 5 }),
  e => e instanceof SyncFetchError && e.kind === 'auth_required' && !/SECRET|Cookie=/i.test(e.message)
);

console.log('✅ smoke_mp_appmsgpublish_fetcher: 6 项断言全部通过');
