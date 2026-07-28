import { getArticleLibraryExportJob, getLatestArticleLibraryExportJob } from '~/server/utils/article-library-export';

export default defineEventHandler(event => {
  const query = getQuery<{ id?: string }>(event);
  const job = query.id ? getArticleLibraryExportJob(query.id) : getLatestArticleLibraryExportJob();

  if (!job) {
    return { found: false };
  }

  return {
    found: true,
    job,
  };
});
