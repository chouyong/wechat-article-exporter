import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractWechatPagePublishedTime, resolveWechatPublishedTime } from '../server/utils/wechat-published-time.ts';

const fallbackAt = new Date('2026-07-24T14:00:46.000Z');
const pageCases = [
  ['4HCMtIELe8Q44Bb3Ap3IJw', '2026-07-26 15:49', '2026-07-26T07:49:00.000Z'],
  ['KSh85uXIgTgAIzRm3KGrcQ', '2026-07-26 08:37', '2026-07-26T00:37:00.000Z'],
  ['qaJsoasy39G18NiTJjytkA', '2026-07-25 14:36', '2026-07-25T06:36:00.000Z'],
  ['Xl98I-82ys-c8IqcKmwWfA', '2026-07-25 07:53', '2026-07-24T23:53:00.000Z'],
] as const;

for (const [, pageMinute, expectedIso] of pageCases) {
  const resolved = resolveWechatPublishedTime(
    `<script>var createTime = '${pageMinute}'; create_time: '${pageMinute}'</script>`,
    '2026-01-01 00:00:01',
    fallbackAt
  );
  assert.equal(resolved.source, 'page');
  assert.equal(resolved.publishedRaw, `${pageMinute}:00`);
  assert.equal(resolved.publishedAt?.toISOString(), expectedIso);
}

const objectField = extractWechatPagePublishedTime(
  '<script>window.meta = { "create_time": "2026-07-25 07:53" };</script>'
);
assert.equal(objectField?.publishedRaw, '2026-07-25 07:53:00');

for (const htmlText of [
  '<script>var createTime = "2026-02-30 08:00";</script>',
  '<script>var createTime = "not-a-date";</script>',
  '<html><body>no publication time</body></html>',
]) {
  const resolved = resolveWechatPublishedTime(htmlText, '2026-07-24 22:00:46', fallbackAt);
  assert.equal(resolved.source, 'fallback');
  assert.equal(resolved.publishedRaw, '2026-07-24 22:00:46');
  assert.equal(resolved.publishedAt, fallbackAt);
}

const expectedById = new Map<string, string>(pageCases.map(([id, pageMinute]) => [id, `${pageMinute}:00`]));
for (const htmlPath of process.argv.slice(2)) {
  const id = /^wechat-(.+)\.html$/.exec(path.basename(htmlPath))?.[1] || '';
  const expected = expectedById.get(id);
  assert.ok(expected, `未知页面 fixture: ${htmlPath}`);
  const parsed = extractWechatPagePublishedTime(await readFile(htmlPath, 'utf8'));
  assert.equal(parsed?.publishedRaw, expected);
}

console.log(`微信公众号页面发布时间解析回归：通过（真实页面 ${process.argv.length - 2} 篇）`);
