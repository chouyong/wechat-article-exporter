/**
 * 公众号文章同步的客户端调度和错误提示合同。
 *
 * 微信 /appmsgpublish 对并发和连续请求都很敏感。批量同步必须保持单请求在飞，
 * 让页面上的频率设置只控制同一账号的分页间隔，避免多个账号并发把微信接口打到
 * 200013 频控。
 */

/** 批量同步的最大并发数；固定为 1，避免并发请求触发微信频控。 */
export const ACCOUNT_SYNC_CONCURRENCY = 1 as const;

/** 微信 200013/freq control 的错误识别。只依据有限的错误文本，不读取任何凭据。 */
export function isFrequencyControlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:^|\D)200013(?:\D|$)/.test(message) || /freq\s*control/i.test(message);
}

/** 把底层错误转换成用户可执行的提示；未知错误保留原始短消息用于排查。 */
export function formatAccountSyncError(error: unknown): string {
  if (isFrequencyControlError(error)) {
    return '微信接口暂时触发频控（200013），本次同步已停止。请稍后再重试（建议等待几分钟），避免连续点击同步。';
  }

  const message = error instanceof Error ? error.message.trim() : String(error ?? '').trim();
  return message || '同步失败，请稍后重试。';
}

/**
 * 串行同步账号队列。
 *
 * 取消探针在每个账号开始前检查；当前账号失败直接向上抛出，后续账号不会启动，
 * 由调用方统一呈现失败状态，保持 fail-closed。
 */
export async function runAccountSyncBatch<T>(
  accounts: readonly T[],
  syncAccount: (account: T) => Promise<unknown>,
  isCanceled: () => boolean = () => false
): Promise<void> {
  for (const account of accounts) {
    if (isCanceled()) {
      throw new Error('已取消同步');
    }
    await syncAccount(account);
  }
}
