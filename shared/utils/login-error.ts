/**
 * 从 $fetch/FetchError 中提取服务端返回的业务错误。
 *
 * 非 2xx 响应的通用 message（例如 `401 Unauthorized`）不包含微信返回的
 * 具体原因。Nuxt $fetch 在不同调用路径下会把响应体放在 `data`、
 * `response._data` 或 `response.data`，所以这里集中兼容这些结构。
 */
function readBusinessError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const error = (value as { err?: unknown }).err;
  return typeof error === 'string' && error.trim() ? error : undefined;
}

export function getLoginErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const candidate = error as {
      data?: unknown;
      response?: { _data?: unknown; data?: unknown };
      message?: unknown;
    };

    const businessError =
      readBusinessError(candidate.data) ||
      readBusinessError(candidate.response?._data) ||
      readBusinessError(candidate.response?.data);
    if (businessError) {
      return businessError;
    }

    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message;
    }
  }

  return fallback;
}
