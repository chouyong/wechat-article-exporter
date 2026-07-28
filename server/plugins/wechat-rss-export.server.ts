import {
  hydrateArticleLibraryExportJobsFromDisk,
  hydrateArticleLibraryExportPreviewJobsFromDisk,
} from '~/server/utils/article-library-export';

export default defineNitroPlugin(async () => {
  await hydrateArticleLibraryExportJobsFromDisk();
  await hydrateArticleLibraryExportPreviewJobsFromDisk();
});
