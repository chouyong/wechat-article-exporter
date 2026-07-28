import { getArticleLibraryExportZip } from '~/server/utils/article-library-export';

export default defineEventHandler(async event => {
  const query = getQuery<{ id?: string }>(event);
  const jobId = (query.id || '').trim();

  if (!jobId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'missing job id',
    });
  }

  const result = await getArticleLibraryExportZip(jobId);
  if (!result) {
    throw createError({
      statusCode: 404,
      statusMessage: 'export zip not found',
    });
  }

  setHeader(event, 'Content-Type', 'application/zip');
  setHeader(event, 'Content-Disposition', `attachment; filename="${result.filename}"`);
  return result.buffer;
});
