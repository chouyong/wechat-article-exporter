export default defineEventHandler(async event => {
  throw createError({
    statusCode: 410,
    statusMessage: 'wechat-rss account import disabled',
  });
});
