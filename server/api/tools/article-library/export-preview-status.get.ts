import {
  getArticleLibraryExportPreviewJob,
  getLatestArticleLibraryExportPreviewJob,
} from '~/server/utils/article-library-export';

export default defineEventHandler(event => {
  const query = getQuery<{ id?: string }>(event);
  const job = query.id ? getArticleLibraryExportPreviewJob(query.id) : getLatestArticleLibraryExportPreviewJob();

  if (!job) {
    return { found: false };
  }

  return {
    found: true,
    job,
  };
});
