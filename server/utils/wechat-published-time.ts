export interface WechatPublishedTime {
  publishedRaw: string;
  publishedAt: Date | null;
  source: 'page' | 'fallback';
}

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

const PAGE_PUBLISHED_PATTERNS = [
  /\b(?:var|let|const)\s+createTime\s*=\s*(['"])(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\1/,
  /(?:\bcreate_time\b|['"]create_time['"])\s*:\s*(['"])(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\1/,
];

function parseShanghaiMinute(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;

  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return null;

  const publishedAt = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:00+08:00`);
  if (Number.isNaN(publishedAt.getTime())) return null;

  return {
    publishedRaw: `${value}:00`,
    publishedAt,
    source: 'page' as const,
  };
}

export function extractWechatPagePublishedTime(htmlText: string): WechatPublishedTime | null {
  for (const pattern of PAGE_PUBLISHED_PATTERNS) {
    const value = pattern.exec(htmlText)?.[2];
    if (!value) continue;
    const parsed = parseShanghaiMinute(value);
    if (parsed) return parsed;
  }
  return null;
}

export function formatWechatPublishedTime(publishedAt: Date | null, fallbackRaw = '') {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return fallbackRaw;
  return new Date(publishedAt.getTime() + SHANGHAI_UTC_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

export function buildWechatPublishedFrontmatterLine(publishedAt: Date | null, fallbackRaw = '') {
  const published = formatWechatPublishedTime(publishedAt, fallbackRaw)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
  return `published: "${published}"`;
}

export function resolveWechatPublishedTime(
  htmlText: string,
  fallbackRaw: string,
  fallbackAt: Date | null
): WechatPublishedTime {
  return (
    extractWechatPagePublishedTime(htmlText) || {
      publishedRaw: fallbackRaw,
      publishedAt: fallbackAt,
      source: 'fallback',
    }
  );
}
