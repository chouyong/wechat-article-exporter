const LOCAL_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://127.0.0.1:3002',
  'http://localhost:3002',
]);

export default defineEventHandler(event => {
  const origin = getRequestHeader(event, 'origin');
  if (origin && LOCAL_BROWSER_ORIGINS.has(origin)) {
    setResponseHeader(event, 'access-control-allow-origin', origin);
    setResponseHeader(event, 'vary', 'Origin');
  }
  setResponseHeader(event, 'access-control-allow-methods', 'POST, OPTIONS');
  setResponseHeader(event, 'access-control-allow-headers', 'content-type');
  setResponseStatus(event, 204);
  return null;
});
