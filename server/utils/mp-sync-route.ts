import type { H3Event } from 'h3';

/** Nitro 在不同构建器版本中可能把 `[id]` 动态参数暴露为 `id` 或 `_id`。 */
export function getMpSyncRouteId(event: H3Event): string {
  const routeParam = (
    getRouterParam(event, 'id') ||
    getRouterParam(event, '_id') ||
    event.context.params?.id ||
    event.context.params?._id ||
    ''
  ).trim();
  if (routeParam) return routeParam;

  // 某些 Nitro 产物会保留动态路由但不填充 context.params；从已匹配的
  // 请求路径恢复最后一个安全段，避免详情/事件/重试/取消接口误报 404。
  const pathname = String(event.node.req.url || '').split('?', 1)[0];
  const segments = pathname.split('/').filter(Boolean);
  if (segments.at(-1) === 'events') segments.pop();
  return String(segments.at(-1) || '').trim();
}
