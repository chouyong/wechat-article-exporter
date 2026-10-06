/**
 * 构造微信公众号 appmsgpublish 请求参数。
 *
 * 文章列表的目标公众号必须来自当前页面选中的 fakeid；不能用登录主体
 * fakeid、旧缓存值或未定义值替换它。参数在进入代理前统一校验，避免把
 * `undefined` 这类字符串发给微信后再被误判为频控。
 */
export interface AppmsgpublishParamsInput {
  fakeid: string;
  token: string;
  begin?: number | string;
  size?: number | string;
  keyword?: string;
}

export interface AppmsgpublishParams {
  sub: 'list' | 'search';
  search_field: '7';
  begin: number;
  count: number;
  query: string;
  fakeid: string;
  type: '101_1';
  free_publish_type: 1;
  sub_action: 'list_ex';
  token: string;
  lang: 'zh_CN';
  f: 'json';
  ajax: 1;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`appmsgpublish ${field} 不能为空`);
  return normalized;
}

function normalizeNonNegativeInteger(value: number | string | undefined, fallback: number, field: string): number {
  const normalized = value === undefined || value === '' ? fallback : typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`appmsgpublish ${field} 必须是非负整数`);
  }
  return normalized;
}

export function buildAppmsgpublishParams(input: AppmsgpublishParamsInput): AppmsgpublishParams {
  const fakeid = requireText(input.fakeid, 'fakeid');
  const token = requireText(input.token, 'token');
  const begin = normalizeNonNegativeInteger(input.begin, 0, 'begin');
  const count = normalizeNonNegativeInteger(input.size, 20, 'size');
  if (count === 0 || count > 20) {
    throw new Error('appmsgpublish size 必须在 1 到 20 之间');
  }

  const query = input.keyword?.trim() || '';
  return {
    sub: query ? 'search' : 'list',
    // 微信当前 web 端列表请求也使用 search_field=7；统一两条调用链，避免
    // 页面端与服务端同步器因参数分叉得到不同的上游行为。
    search_field: '7',
    begin,
    count,
    query,
    fakeid,
    type: '101_1',
    free_publish_type: 1,
    sub_action: 'list_ex',
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: 1,
  };
}
