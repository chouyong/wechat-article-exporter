import { z } from 'zod';
import { updateArticleLibrarySnapshot } from '~/server/utils/article-library-export';

const accountSchema = z.object({
  fakeid: z.string(),
  nickname: z.string().optional(),
  round_head_img: z.string().optional(),
  total_count: z.number().optional(),
  completed: z.boolean().optional(),
  count: z.number().optional(),
  articles: z.number().optional(),
  create_time: z.number().optional(),
  update_time: z.number().optional(),
  last_update_time: z.number().optional(),
});

const articleSchema = z.object({
  fakeid: z.string(),
  aid: z.string(),
  link: z.string(),
  title: z.string(),
  author_name: z.string().optional(),
  digest: z.string().optional(),
  create_time: z.number(),
  update_time: z.number(),
  is_deleted: z.boolean().optional(),
});

const schema = z.object({
  accounts: z.array(accountSchema).default([]),
  articles: z.array(articleSchema).default([]),
});

export default defineEventHandler(async event => {
  const body = await readBody(event);
  const payload = schema.parse(body || {});
  const snapshot = await updateArticleLibrarySnapshot(payload);
  return {
    ok: true,
    createdAt: snapshot.createdAt,
    accounts: snapshot.accounts.length,
    articles: snapshot.articles.length,
  };
});
