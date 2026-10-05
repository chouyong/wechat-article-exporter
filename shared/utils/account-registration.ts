/**
 * 将微信搜索结果转换为本地公众号登记记录。
 *
 * 登记只保存账号身份和空的同步计数，不请求文章接口。文章抓取由用户明确点击
 * “同步”后执行，这样微信文章接口的频控不会阻断账号添加，也不会留下半成功状态。
 */
export interface AccountRegistrationInput {
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
}

export interface AccountRegistration {
  fakeid: string;
  nickname?: string;
  round_head_img?: string;
  completed: boolean;
  count: number;
  articles: number;
  total_count: number;
}

export function createAccountRegistration(account: AccountRegistrationInput): AccountRegistration {
  const fakeid = account.fakeid.trim();
  if (!fakeid) {
    throw new Error('公众号缺少有效 fakeid，无法添加');
  }

  return {
    fakeid,
    nickname: account.nickname?.trim() || undefined,
    round_head_img: account.round_head_img?.trim() || undefined,
    completed: false,
    count: 0,
    articles: 0,
    total_count: 0,
  };
}
