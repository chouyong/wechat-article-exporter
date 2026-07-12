import { createError } from 'h3';
import { z } from 'zod';
import { MAX_EPOCH_SECONDS } from '~/server/utils/mp-account-registry';
import type { MpAccountSource, MpAccountUpsertInput } from '~/server/utils/mp-account-registry';

/**
 * 用 zod schema 校验输入；失败时抛出 HTTP 400（而非让 ZodError 冒泡成 500）。
 * mp-accounts 各端点统一走此函数，保证「输入非法 → 400」的契约。
 */
export function parseOr400<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map(issue => issue.message).join('; '),
    });
  }
  return parsed.data;
}

const sourceSchema = z.enum(['browser_import', 'manual', 'api', 'auto_detect']);

// epoch 秒字段共用约束：非负整数且 ≤ MAX_EPOCH_SECONDS（可转换为 JS Date 的上界）。
// 越界值经此 schema 落 invalidItems/400，而非在 repository 的 epochToIso 处冒泡 500
// （Codex C1-F1 §3.3.1）。last_article_time 虽当前不经 Date 转换，同为 epoch 秒，
// 用同一口径约束以保持契约一致；真实数据（~1.7e9）远低于上界，零影响。
const epochSecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_EPOCH_SECONDS, { message: `epoch 秒超出可转换范围（> ${MAX_EPOCH_SECONDS}）` })
  .nullable()
  .optional();

export const mpAccountInputSchema = z.object({
  fakeid: z.string().trim().min(1).max(256),
  nickname: z.string().max(512).nullable().optional(),
  alias: z.string().max(512).nullable().optional(),
  avatar_url: z.string().max(4096).nullable().optional(),
  round_head_img: z.string().max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-100000).max(100000).optional(),
  starred: z.boolean().nullable().optional(),
  source: sourceSchema.optional(),
  reported_total_count: z.number().int().nonnegative().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  last_article_time: epochSecondsSchema,
  last_synced_at: z.string().datetime({ offset: true }).nullable().optional(),
  last_update_time: epochSecondsSchema,
});

export const mpAccountBatchSchema = z.object({
  accounts: z.array(z.unknown()).max(5000),
  dryRun: z.boolean().default(false),
});

export function parseMpAccountInputs(accounts: unknown[], defaultSource: MpAccountSource) {
  const valid: MpAccountUpsertInput[] = [];
  const invalidItems: Array<{ index: number; reason: string }> = [];
  accounts.forEach((account, index) => {
    const parsed = mpAccountInputSchema.safeParse(account);
    if (parsed.success) valid.push({ ...parsed.data, source: parsed.data.source ?? defaultSource });
    else invalidItems.push({ index, reason: parsed.error.issues.map(issue => issue.message).join('; ') });
  });
  return { valid, invalidItems };
}
