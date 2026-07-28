import { reconcileArticleLibraryExportIndex } from '~/server/utils/article-library-export';

export default defineEventHandler(async () => {
  const result = await reconcileArticleLibraryExportIndex();
  return {
    ok: true,
    ...result,
  };
});
