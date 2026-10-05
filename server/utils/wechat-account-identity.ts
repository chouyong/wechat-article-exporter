/**
 * 从微信公众号后台主页提取当前登录主体的公开身份。
 *
 * 该模块只处理页面中的昵称、头像和公众号 fakeid，不接触 token、Cookie 或密码。
 * fakeid 是同步文章接口的主体边界；无法提取时必须返回空值，由登录流程 fail-closed。
 */

export interface LoginAccountIdentity {
  nickname: string;
  avatar: string;
  fakeid: string;
}

function normalizeHtml(html: string): string {
  return html
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('\\"', '"');
}

function extractField(html: string, names: readonly string[]): string {
  const normalized = normalizeHtml(html);
  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:wx\\.cgiData\\.|window\\.cgiData\\.)?${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'i'),
      new RegExp(`(?:["']${escapedName}["']|\\b${escapedName}\\b)\\s*:\\s*(["'])(.*?)\\1`, 'i'),
      new RegExp(`(?:["']${escapedName}["']|\\b${escapedName}\\b)\\s*=\\s*([^,;\\s}]+)`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      const value = match?.[2] ?? match?.[1];
      if (value?.trim()) return value.trim();
    }
  }
  return '';
}

function normalizeFakeid(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /^(?:undefined|null|false)$/i.test(normalized)) return '';
  return normalized;
}

export function extractLoginAccountIdentity(html: string): LoginAccountIdentity {
  const nickname = extractField(html, ['nick_name', 'nickname']);
  const avatar = extractField(html, ['head_img', 'headImg', 'avatar', 'round_head_img']);

  // 优先使用主页明确的公众号标识。不同后台版本的字段名略有差异，
  // 但不能用泛化的 biz 字段兜底，否则可能误取页面中其它文章的 biz。
  const fakeid = normalizeFakeid(extractField(html, ['fakeid', 'fake_id', 'bizuin', 'mp_bizuin', '__biz']));

  return { nickname, avatar, fakeid };
}
