import { type CookieEntity } from '~/server/utils/CookieStore';

export type CookieKVKey = string;

export interface CookieKVValue {
  token: string;
  cookies: CookieEntity[];
  issuedAt?: string;
  expiresAt?: string;
}

export async function setMpCookie(key: CookieKVKey, data: CookieKVValue): Promise<boolean> {
  const kv = useStorage('kv');
  try {
    const now = new Date();
    await kv.set<CookieKVValue>(
      `cookie:${key}`,
      {
        ...data,
        issuedAt: data.issuedAt ?? now.toISOString(),
        expiresAt: data.expiresAt ?? new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        // https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys
        expirationTtl: 60 * 60 * 24 * 4, // 4 days
      }
    );
    return true;
  } catch (err) {
    console.error('kv.set call failed:', err);
    return false;
  }
}

export async function deleteMpCookie(key: CookieKVKey): Promise<void> {
  const kv = useStorage('kv');
  await kv.remove(`cookie:${key}`);
}

export async function getMpCookie(key: CookieKVKey): Promise<CookieKVValue | null> {
  const kv = useStorage('kv');
  return await kv.get<CookieKVValue>(`cookie:${key}`);
}
