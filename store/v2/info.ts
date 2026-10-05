import { getCurrentAccountOwnerKey } from '#shared/utils/account-session';
import { db } from './db';

export interface MpAccount {
  fakeid: string;
  /** 登录公众号身份的本地缓存作用域；防止切换账号后复用旧账号列表。 */
  ownerKey?: string;
  completed: boolean;
  count: number;
  articles: number;

  // 公众号昵称
  nickname?: string;
  // 公众号头像
  round_head_img?: string;

  // 公众号文章总数
  total_count: number;
  create_time?: number;
  update_time?: number;

  // 最后更新时间
  last_update_time?: number;
}

/**
 * 更新 account 缓存
 * @param mpAccount
 */
export async function updateInfoCache(mpAccount: MpAccount): Promise<boolean> {
  const ownerKey = getCurrentAccountOwnerKey();
  if (!ownerKey) return false;

  return db.transaction('rw', 'info', async () => {
    let infoCache = await db.info.get(mpAccount.fakeid);
    // 带有 ownerKey 的缓存行属于另一个登录主体时，只允许当前主体通过
    // “明确重新添加”流程接管无 ownerKey 的输入；旧主体的行不能继续写入。
    if (infoCache?.ownerKey && infoCache.ownerKey !== ownerKey && mpAccount.ownerKey) {
      return false;
    }
    if (infoCache) {
      if (mpAccount.completed) {
        infoCache.completed = mpAccount.completed;
      }
      infoCache.count += mpAccount.count;
      infoCache.articles += mpAccount.articles;
      infoCache.nickname = mpAccount.nickname;
      infoCache.round_head_img = mpAccount.round_head_img;
      infoCache.total_count = mpAccount.total_count;
      infoCache.ownerKey = ownerKey;
      infoCache.update_time = Math.round(Date.now() / 1000);
    } else {
      infoCache = {
        fakeid: mpAccount.fakeid,
        ownerKey,
        completed: mpAccount.completed,
        count: mpAccount.count,
        articles: mpAccount.articles,
        nickname: mpAccount.nickname,
        round_head_img: mpAccount.round_head_img,
        total_count: mpAccount.total_count,
        create_time: Math.round(Date.now() / 1000),
        update_time: Math.round(Date.now() / 1000),
      };
    }
    db.info.put(infoCache);
    return true;
  });
}

export async function updateLastUpdateTime(fakeid: string): Promise<boolean> {
  const ownerKey = getCurrentAccountOwnerKey();
  if (!ownerKey) return false;

  return db.transaction('rw', 'info', async () => {
    let infoCache = await db.info.get(fakeid);
    if (infoCache?.ownerKey === ownerKey) {
      infoCache.last_update_time = Math.round(Date.now() / 1000);
      db.info.put(infoCache);
    }
    return true;
  });
}

/**
 * 获取 info 缓存
 * @param fakeid
 */
export async function getInfoCache(fakeid: string): Promise<MpAccount | undefined> {
  const ownerKey = getCurrentAccountOwnerKey();
  if (!ownerKey) return undefined;
  const infoCache = await db.info.get(fakeid);
  return infoCache?.ownerKey === ownerKey ? infoCache : undefined;
}

export async function getAllInfo(): Promise<MpAccount[]> {
  const ownerKey = getCurrentAccountOwnerKey();
  if (!ownerKey) return [];
  const infos = await db.info.toArray();
  return infos.filter(info => info.ownerKey === ownerKey);
}

// 获取公众号的名称
export async function getAccountNameByFakeid(fakeid: string): Promise<string | null> {
  const account = await getInfoCache(fakeid);
  if (!account) {
    return null;
  }

  return account.nickname || null;
}

// 批量导入公众号
export async function importMpAccounts(mpAccounts: MpAccount[]): Promise<void> {
  for (const mpAccount of mpAccounts) {
    // 导入时需要把相关数量置空
    mpAccount.completed = false;
    mpAccount.count = 0;
    mpAccount.articles = 0;
    mpAccount.total_count = 0;
    mpAccount.create_time = undefined;
    mpAccount.update_time = undefined;
    mpAccount.last_update_time = undefined;
    await updateInfoCache(mpAccount);
  }
}
