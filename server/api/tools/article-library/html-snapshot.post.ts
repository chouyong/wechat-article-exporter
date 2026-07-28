import { z } from 'zod';
import { updateArticleLibraryHtmlSnapshot } from '~/server/utils/article-library-export';

const itemSchema = z.object({
  fakeid: z.string(),
  url: z.string(),
  title: z.string(),
  commentID: z.string().nullable().optional(),
  html: z.string(),
});

const schema = z.object({
  items: z.array(itemSchema).default([]),
});

export default defineEventHandler(async event => {
  const body = await readBody(event);
  const payload = schema.parse(body || {});
  const result = await updateArticleLibraryHtmlSnapshot(payload.items);
  return {
    ok: true,
    updated: result.updated,
  };
});
