import { z } from 'zod';
import { startArticleLibraryExportPreviewJob } from '~/server/utils/article-library-export';

const schema = z.object({
  mode: z.enum(['full', 'recent-3d', 'failed-only', 'cached-only']).default('full'),
  syncFromTimestamp: z.number().int().nullable().optional(),
  syncToTimestamp: z.number().int().nullable().optional(),
});

export default defineEventHandler(async event => {
  const body = await readBody(event);
  const payload = schema.parse(body || {});
  return await startArticleLibraryExportPreviewJob(
    payload.mode,
    payload.syncFromTimestamp ?? null,
    payload.syncToTimestamp ?? null,
  );
});
