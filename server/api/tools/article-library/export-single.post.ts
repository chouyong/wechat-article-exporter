import { z } from 'zod';
import { startSingleArticleLibraryExportJob } from '~/server/utils/article-library-export';

const schema = z
  .object({
    url: z.string().min(1).optional(),
    urls: z.array(z.string().min(1)).min(1).optional(),
    recoverySourceJobId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .refine(payload => Boolean(payload.url || payload.urls?.length), {
    message: 'url 或 urls 至少传一个',
  });

export default defineEventHandler(async event => {
  const body = await readBody(event);
  const payload = schema.parse(body || {});
  const urls = payload.urls?.length ? payload.urls : [payload.url as string];
  return await startSingleArticleLibraryExportJob(urls, payload.recoverySourceJobId);
});
