<script setup lang="ts">
import type {
  ColDef,
  FilterChangedEvent,
  GetRowIdParams,
  GridApi,
  GridOptions,
  GridReadyEvent,
  ICellRendererParams,
  SelectionChangedEvent,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { defu } from 'defu';
import type { PreviewArticle } from '#components';
import { durationToSeconds, formatItemShowType, formatTimeStamp, sleep } from '#shared/utils/helpers';
import { validateHTMLContent } from '#shared/utils/html';
import { request } from '#shared/utils/request';
import GridAlbum from '~/components/grid/Album.vue';
import GridArticleActions from '~/components/grid/ArticleActions.vue';
import GridCoverTooltip from '~/components/grid/CoverTooltip.vue';
import GridStatusBar from '~/components/grid/StatusBar.vue';
import AccountSelectorForArticle from '~/components/selector/AccountSelectorForArticle.vue';
import toastFactory from '~/composables/toast';
import { isDev, websiteName } from '~/config';
import { sharedGridOptions } from '~/config/shared-grid-options';
import { articleDeleted, getArticleCache, updateArticleStatus } from '~/store/v2/article';
import { getCommentCache } from '~/store/v2/comment';
import { getDebugCache } from '~/store/v2/debug';
import { getAllHtmlCache, getHtmlCache } from '~/store/v2/html';
import { getAllInfo, type MpAccount } from '~/store/v2/info';
import { getMetadataCache, type Metadata } from '~/store/v2/metadata';
import type { Preferences } from '~/types/preferences';
import type { AppMsgExWithFakeID } from '~/types/types';
import type { ArticleMetadata } from '~/utils/download/types';
import { createBooleanColumnFilterParams, createDateColumnFilterParams } from '~/utils/grid';

useHead({
  title: `文章下载 | ${websiteName}`,
});

const toast = toastFactory();

// 当前页面的数据模型
interface Article extends AppMsgExWithFakeID, Partial<ArticleMetadata> {
  /**
   * 文章内容是否已下载
   */
  contentDownload: boolean;

  /**
   * 留言内容是否已下载
   */
  commentDownload: boolean;
}

let globalRowData: Article[] = [];

const columnDefs = ref<ColDef[]>([
  {
    headerName: 'ID',
    field: 'aid',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '链接',
    field: 'link',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    minWidth: 150,
    initialHide: true,
    cellClass: 'font-mono',
  },
  {
    headerName: '标题',
    field: 'title',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    tooltipField: 'title',
    minWidth: 200,
  },
  {
    headerName: '封面',
    field: 'cover',
    sortable: false,
    filter: false,
    cellRenderer: (params: ICellRendererParams) => {
      return `<img alt="" src="${params.value}" style="height: 40px; width: 40px; object-fit: cover;" />`;
    },
    tooltipField: 'cover',
    tooltipComponent: GridCoverTooltip,
    minWidth: 80,
    hide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '摘要',
    field: 'digest',
    cellDataType: 'text',
    filter: 'agTextColumnFilter',
    tooltipField: 'digest',
    minWidth: 200,
    initialHide: true,
  },
  {
    headerName: '创建时间',
    field: 'create_time',
    valueFormatter: p => formatTimeStamp(p.value),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('create_time') * 1000);
    },
    minWidth: 180,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '发布时间',
    field: 'update_time',
    valueFormatter: p => formatTimeStamp(p.value),
    filter: 'agDateColumnFilter',
    filterParams: createDateColumnFilterParams(),
    filterValueGetter: (params: ValueGetterParams) => {
      return new Date(params.getValue('update_time') * 1000);
    },
    minWidth: 180,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '是否已删除',
    field: 'is_deleted',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已删除', '未删除'),
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '文章状态',
    field: '_status',
    valueFormatter: p => p.value,
    filter: 'agSetColumnFilter',
    filterParams: {
      valueFormatter: (p: ValueFormatterParams) => p.value,
    },
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '内容已下载',
    field: 'contentDownload',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已下载', '未下载'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    field: 'commentDownload',
    headerName: '留言已下载',
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('已下载', '未下载'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '阅读',
    field: 'readNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '点赞',
    field: 'oldLikeNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '分享',
    field: 'shareNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '喜欢',
    field: 'likeNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '留言',
    field: 'commentNum',
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 100,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    field: 'author_name',
    headerName: '作者',
    cellDataType: 'text',
    filter: 'agSetColumnFilter',
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '是否原创',
    valueGetter: p => p.data && p.data.copyright_stat === 1 && p.data.copyright_type === 1,
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('原创', '非原创'),
    minWidth: 150,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '是否付费',
    field: 'is_pay_subscribe',
    valueGetter: p => p.data && p.data.is_pay_subscribe === 1,
    cellDataType: 'boolean',
    filter: 'agSetColumnFilter',
    filterParams: createBooleanColumnFilterParams('付费', '免费'),
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '付费金额',
    field: 'wecoin_count',
    valueFormatter: p => (p.value ? `${p.value} 微币` : ''),
    cellDataType: 'number',
    filter: 'agNumberColumnFilter',
    minWidth: 120,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '文章类型',
    field: 'item_show_type',
    valueFormatter: p => formatItemShowType(p.value),
    filter: 'agSetColumnFilter',
    filterParams: {
      valueFormatter: (p: ValueFormatterParams) => formatItemShowType(p.value),
    },
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center',
  },
  {
    headerName: '媒体时长',
    field: 'media_duration',
    valueGetter: params => durationToSeconds(params.data.media_duration), // 用于排序和过滤
    valueFormatter: params => params.data.media_duration,
    filter: 'agNumberColumnFilter',
    comparator: (a, b) => a - b,
    minWidth: 150,
    initialHide: true,
    cellClass: 'flex justify-center items-center font-mono',
  },
  {
    headerName: '所属合集',
    field: 'appmsg_album_infos',
    cellRenderer: GridAlbum,
    sortable: false,
    filter: false,
    valueFormatter: p => p.value.map((album: any) => album.title).join(','),
    minWidth: 150,
    initialHide: true,
  },
  {
    headerName: '操作',
    field: 'link',
    sortable: false,
    filter: false,
    cellRenderer: GridArticleActions,
    cellRendererParams: {
      onPreview: (params: ICellRendererParams) => {
        preview(params.data);
      },
      onGotoLink: (params: ICellRendererParams) => {
        window.open(params.value, '_blank');
      },
    },
    maxWidth: 100,
    pinned: 'right',
    cellClass: 'flex justify-center items-center',
  },
]);

// 注意，`defu`函数最左边的参数优先级最高
const gridOptions: GridOptions = defu(
  {
    getRowId: (params: GetRowIdParams) => `${params.data.fakeid}:${params.data.aid}`,
    statusBar: {
      statusPanels: [
        {
          statusPanel: GridStatusBar,
          align: 'left',
        },
      ],
    },
  },
  sharedGridOptions
);

const gridApi = shallowRef<GridApi | null>(null);
function onGridReady(params: GridReadyEvent) {
  gridApi.value = params.api;

  restoreColumnState();
}

function onColumnStateChange() {
  if (gridApi.value) {
    saveColumnState();
  }
}
function saveColumnState() {
  const state = gridApi.value?.getColumnState();
  localStorage.setItem('agGridColumnState', JSON.stringify(state));
}

function restoreColumnState() {
  const stateStr = localStorage.getItem('agGridColumnState');
  if (stateStr) {
    const state = JSON.parse(stateStr);
    gridApi.value?.applyColumnState({
      state,
      applyOrder: true,
    });
  }
}

function onFilterChanged(event: FilterChangedEvent) {
  event.api.deselectAll();
}

const preferences = usePreferences();
const hideDeleted = computed(() => (preferences.value as unknown as Preferences).hideDeleted);
const { getSyncTimestamp, isSyncAll } = useSyncDeadline();

const previewArticleRef = ref<typeof PreviewArticle | null>(null);

function preview(article: Article) {
  previewArticleRef.value!.open(article);
}

const loading = ref(false);

const selectedAccounts = ref<MpAccount[]>([]);
const hasSelectedAccounts = computed(() => selectedAccounts.value.length > 0);
const hasSingleSelectedAccount = computed(() => selectedAccounts.value.length === 1);

watch(selectedAccounts, newVal => {
  switchTableData(newVal).catch(() => {});
});

async function switchTableData(accounts: MpAccount[]) {
  loading.value = true;
  try {
    const articles: Article[] = [];
    for (const account of accounts) {
      const data = await getArticleCache(account.fakeid, Math.floor(Date.now() / 1000));
      for (const article of data) {
        const contentDownload = (await getHtmlCache(article.link)) !== undefined;
        const commentDownload = (await getCommentCache(article.link)) !== undefined;
        const metadata = await getMetadataCache(article.link);
        if (metadata) {
          articles.push({
            ...metadata,
            ...article,
            contentDownload: contentDownload,
            commentDownload: commentDownload,
          });
        } else {
          articles.push({
            ...article,
            contentDownload: contentDownload,
            commentDownload: commentDownload,
          });
        }
      }
    }

    await sleep(200);
    globalRowData = articles.filter(article => (hideDeleted.value ? !article.is_deleted : true));
    gridApi.value?.setGridOption('rowData', globalRowData);
  } finally {
    loading.value = false;
  }
}

function updateRow(article: Article) {
  const rowNode = gridApi.value?.getRowNode(`${article.fakeid}:${article.aid}`);
  if (rowNode) {
    rowNode.updateData(article);
  }
}

const selectedArticles = shallowRef<Article[]>([]);
function onSelectionChanged(event: SelectionChangedEvent) {
  selectedArticles.value = (event.selectedNodes || []).map(node => node.data);
}
function refreshSelectedArticles() {
  triggerRef(selectedArticles);
}
const selectedArticleUrls = computed(() => {
  return selectedArticles.value.map(article => article.link);
});
const contentNotDownloadedCount = computed(() => {
  return selectedArticles.value.filter(article => !article.contentDownload).length;
});

const {
  loading: downloadBtnLoading,
  completed_count: downloadCompletedCount,
  total_count: downloadTotalCount,
  download,
  stop: stopDownload,
} = useDownloader({
  onContent(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.contentDownload = true;
      article._status = '正常';
      updateRow(article);
      refreshSelectedArticles();

      updateArticleStatus(url, '正常');

      // 修复之前代码逻辑错误导致的数据库状态被误设置为【已删除】
      article.is_deleted = false;
      articleDeleted(url, false);
    } else {
      console.warn(`${url} not found in table data when update contentDownload`);
    }
  },
  onStatusChange(url: string, status: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article._status = status;
      updateRow(article);
      refreshSelectedArticles();

      updateArticleStatus(url, status);
    }
  },
  onDelete(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.is_deleted = true;
      article._status = '已删除';
      updateRow(article);
      refreshSelectedArticles();

      updateArticleStatus(url, '已删除');
      articleDeleted(url);
    }
  },
  onMetadata(url: string, metadata: Metadata) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.readNum = metadata.readNum;
      article.oldLikeNum = metadata.oldLikeNum;
      article.shareNum = metadata.shareNum;
      article.likeNum = metadata.likeNum;
      article.commentNum = metadata.commentNum;

      if ((preferences.value as unknown as Preferences).downloadConfig.metadataOverrideContent) {
        // 如果同步下载文章内容，则更新相关字段
        article.contentDownload = true;
        article._status = '正常';
        updateArticleStatus(url, '正常');

        // 修复之前代码逻辑错误导致的数据库状态被误设置为【已删除】
        article.is_deleted = false;
        articleDeleted(url, false);
      }

      updateRow(article);
      refreshSelectedArticles();
    } else {
      console.warn(`${url} not found in table data when update metadata`);
    }
  },
  onComment(url: string) {
    const article = globalRowData.find(article => article.link === url);
    if (article) {
      article.commentDownload = true;
      updateRow(article);
      refreshSelectedArticles();
    } else {
      console.warn(`${url} not found in table data when update commentDownload`);
    }
  },
});

const {
  loading: exportBtnLoading,
  phase: exportPhase,
  completed_count: exportCompletedCount,
  total_count: exportTotalCount,
  exportFile,
} = useExporter();

const bulkMarkdownLoading = ref(false);
const bulkPreviewLoading = ref(false);
const bulkExportJobId = ref('');
const bulkPreviewJobId = ref('');
const bulkExportStatusText = ref('');
const bulkExportDownloadUrl = ref('');
const bulkPreviewText = ref('');
const bulkPreviewReadyToExport = ref(false);
const bulkPreviewMode = ref<BulkMarkdownMode | null>(null);
const reconcileIndexLoading = ref(false);
const singleArticleExportUrl = ref('');
const singleArticleExportLoading = ref(false);
const singleArticleExportJobId = ref('');
const singleArticleExportStatusText = ref('');
const singleArticleExportDownloadUrl = ref('');
let bulkExportPollTimer: number | null = null;
let bulkPreviewPollTimer: number | null = null;
let singleArticleExportPollTimer: number | null = null;

type BulkMarkdownMode = 'full' | 'recent-3d' | 'failed-only' | 'cached-only';
type ArticleLibraryExportMode = BulkMarkdownMode | 'single';

interface BulkExportJob {
  id: string;
  mode: ArticleLibraryExportMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message: string;
  snapshotCreatedAt: string | null;
  totalAccounts: number;
  scannedArticles: number;
  totalCandidates: number;
  processedCandidates: number;
  exportedCount: number;
  skippedExistingCount: number;
  failedCount: number;
  failureSamples: Array<{ url: string; reason: string }>;
}

interface BulkExportPreview {
  mode: BulkMarkdownMode;
  snapshotCreatedAt: string | null;
  totalAccounts: number;
  scannedArticles: number;
  totalCandidates: number;
  cachedCandidateCount: number;
  uncachedCandidateCount: number;
  totalCachedCount: number;
  estimatedExportCount: number;
  estimatedSkipCount: number;
}

interface BulkExportPreviewJob {
  id: string;
  mode: BulkMarkdownMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  message: string;
  preview: BulkExportPreview | null;
}

interface ReconcileIndexResult {
  ok: boolean;
  scannedCount: number;
  totalIndexCount: number;
  added: number;
  updated: number;
}

interface ArticleLibraryHtmlSnapshotItem {
  fakeid: string;
  url: string;
  title: string;
  commentID: string | null;
  html: string;
}

interface ArticleLibrarySnapshotSyncResult {
  accounts: number;
  articles: number;
  htmls: number;
  htmlUploaded: number;
  htmlFailed: number;
}

function getExportModeLabel(mode: ArticleLibraryExportMode) {
  if (mode === 'full') return '首次全量（后台）';
  if (mode === 'recent-3d') return '最近 3 天增量（后台）';
  if (mode === 'failed-only') return '仅重跑失败文章（后台）';
  if (mode === 'cached-only') return '仅导出已缓存正文（后台）';
  return '单篇重导';
}

function updateArticleLibrarySnapshotSyncText(text: string) {
  bulkPreviewText.value = text;
  bulkExportStatusText.value = text;
}

async function uploadArticleLibraryHtmlSnapshotItems(items: ArticleLibraryHtmlSnapshotItem[]): Promise<number> {
  if (items.length === 0) {
    return 0;
  }

  await request<{ updated?: number }>('/api/tools/article-library/html-snapshot', {
    method: 'POST',
    body: { items },
  });

  return items.length;
}

async function uploadArticleLibraryHtmlSnapshotBatch(items: ArticleLibraryHtmlSnapshotItem[]): Promise<{ uploaded: number; failed: number }> {
  if (items.length === 0) {
    return { uploaded: 0, failed: 0 };
  }

  try {
    const uploaded = await uploadArticleLibraryHtmlSnapshotItems(items);
    return { uploaded, failed: 0 };
  } catch (error) {
    if (items.length === 1) {
      console.error('同步正文缓存失败：', items[0]?.url, error);
      return { uploaded: 0, failed: 1 };
    }

    const middle = Math.ceil(items.length / 2);
    const left = await uploadArticleLibraryHtmlSnapshotBatch(items.slice(0, middle));
    const right = await uploadArticleLibraryHtmlSnapshotBatch(items.slice(middle));
    return {
      uploaded: left.uploaded + right.uploaded,
      failed: left.failed + right.failed,
    };
  }
}

async function syncArticleLibrarySnapshot(): Promise<ArticleLibrarySnapshotSyncResult> {
  const accounts = await getAllInfo();
  const articles: AppMsgExWithFakeID[] = [];

  for (const account of accounts) {
    const accountArticles = await getArticleCache(account.fakeid, Math.floor(Date.now() / 1000));
    articles.push(...accountArticles);
  }

  await request('/api/tools/article-library/snapshot', {
    method: 'POST',
    body: {
      accounts,
      articles,
    },
  });

  const htmlAssets = await getAllHtmlCache();
  const batchSize = 20;
  let htmlUploaded = 0;
  let htmlFailed = 0;
  for (let i = 0; i < htmlAssets.length; i += batchSize) {
    const batch = htmlAssets.slice(i, i + batchSize);
    const items: ArticleLibraryHtmlSnapshotItem[] = [];

    for (const asset of batch) {
      try {
        items.push({
          fakeid: asset.fakeid,
          url: asset.url,
          title: asset.title,
          commentID: asset.commentID,
          html: await asset.file.text(),
        });
      } catch (error) {
        htmlFailed += 1;
        console.error('读取正文缓存失败：', asset.url, error);
      }
    }

    const progressText = `正在同步正文缓存 ${Math.min(i + batch.length, htmlAssets.length)}/${htmlAssets.length}`;
    updateArticleLibrarySnapshotSyncText(
      htmlFailed > 0 ? `${progressText}，已跳过 ${htmlFailed} 条异常缓存` : progressText,
    );

    const result = await uploadArticleLibraryHtmlSnapshotBatch(items);
    htmlUploaded += result.uploaded;
    htmlFailed += result.failed;

    updateArticleLibrarySnapshotSyncText(
      `正在同步正文缓存 ${Math.min(i + batch.length, htmlAssets.length)}/${htmlAssets.length}，已上传 ${htmlUploaded}，失败 ${htmlFailed}`,
    );
  }

  return {
    accounts: accounts.length,
    articles: articles.length,
    htmls: htmlAssets.length,
    htmlUploaded,
    htmlFailed,
  };
}

function clearBulkExportPollTimer() {
  if (bulkExportPollTimer !== null) {
    window.clearInterval(bulkExportPollTimer);
    bulkExportPollTimer = null;
  }
}

function clearBulkPreviewPollTimer() {
  if (bulkPreviewPollTimer !== null) {
    window.clearInterval(bulkPreviewPollTimer);
    bulkPreviewPollTimer = null;
  }
}

function clearSingleArticleExportPollTimer() {
  if (singleArticleExportPollTimer !== null) {
    window.clearInterval(singleArticleExportPollTimer);
    singleArticleExportPollTimer = null;
  }
}

async function refreshBulkExportStatus(jobId?: string) {
  const response = await request<{ found: boolean; job?: BulkExportJob }>(`/api/tools/article-library/export-status${jobId ? `?id=${jobId}` : ''}`);
  if (!response?.found || !response.job) {
    return null;
  }
  const job = response.job;
  bulkExportJobId.value = job.id;
  const progressTotal = job.totalCandidates || job.scannedArticles || 0;
  bulkExportStatusText.value =
    `${job.message}（已处理 ${job.processedCandidates}/${progressTotal}，`
    + `已导出 ${job.exportedCount}，跳过 ${job.skippedExistingCount}，失败 ${job.failedCount}）`;
  if (job.status === 'completed') {
    bulkMarkdownLoading.value = false;
    bulkExportDownloadUrl.value = job.exportedCount > 0
      ? `/api/tools/article-library/export-download?id=${job.id}`
      : '';
    if (job.exportedCount === 0) {
      bulkPreviewReadyToExport.value = false;
    }
    clearBulkExportPollTimer();
  } else if (job.status === 'failed') {
    bulkMarkdownLoading.value = false;
    bulkExportDownloadUrl.value = '';
    clearBulkExportPollTimer();
  } else {
    bulkMarkdownLoading.value = true;
  }
  return job;
}

function startBulkExportPolling(jobId: string) {
  clearBulkExportPollTimer();
  bulkExportPollTimer = window.setInterval(async () => {
    try {
      const job = await refreshBulkExportStatus(jobId);
      if (!job) return;
      if (job.status === 'completed') {
        if (job.exportedCount > 0) {
          toast.success('后台 Markdown 导出完成', `已导出 ${job.exportedCount} 篇，打包文件已可下载`);
        } else {
          toast.info('后台 Markdown 导出完成', job.message);
        }
      } else if (job.status === 'failed') {
        toast.error('后台 Markdown 导出失败', job.message);
      }
    } catch (error) {
      console.error('refresh bulk export status failed:', error);
    }
  }, 3000);
}

async function downloadBulkExportZip() {
  const url = bulkExportDownloadUrl.value;
  if (!url) return;

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function reconcileArticleLibraryExportIndex() {
  if (reconcileIndexLoading.value || bulkMarkdownLoading.value || bulkPreviewLoading.value) {
    toast.warning('提示', '当前已有后台任务在运行，请稍后再试');
    return;
  }

  reconcileIndexLoading.value = true;
  bulkPreviewReadyToExport.value = false;
  bulkPreviewMode.value = null;
  bulkPreviewText.value = '正在补全已导出文章索引';

  try {
    const result = await request<ReconcileIndexResult>('/api/tools/article-library/reconcile-index', {
      method: 'POST',
      body: {},
    });
    bulkPreviewText.value =
      `已补全导出索引：扫描 ${result.scannedCount} 篇 Markdown，当前索引 ${result.totalIndexCount} 条，新增 ${result.added} 条，更新 ${result.updated} 条`;
    bulkExportStatusText.value = '已补全导出索引，建议重新执行一次“先扫描预估数量”以刷新结果';
    toast.success('导出索引补全完成', `新增 ${result.added} 条，更新 ${result.updated} 条`);
  } catch (error) {
    bulkPreviewText.value = '';
    toast.error('导出索引补全失败', (error as Error).message);
  } finally {
    reconcileIndexLoading.value = false;
  }
}

async function exportBulkMarkdown(mode: BulkMarkdownMode) {
  if (downloadBtnLoading.value || exportBtnLoading.value || bulkMarkdownLoading.value) {
    toast.warning('提示', '当前已有抓取或导出任务在运行，请稍后再试');
    return;
  }

  bulkMarkdownLoading.value = true;
  bulkPreviewReadyToExport.value = false;
  bulkExportDownloadUrl.value = '';
  bulkExportStatusText.value = '正在创建后台导出任务';

  try {
    const snapshot = await syncArticleLibrarySnapshot();
    bulkExportStatusText.value = `已同步系统快照：${snapshot.accounts} 个公众号，${snapshot.articles} 篇文章；本地正文缓存本次读取 ${snapshot.htmls} 条，已上传 ${snapshot.htmlUploaded} 条，失败 ${snapshot.htmlFailed} 条；正在创建后台导出任务`;

    const job = await request<BulkExportJob>('/api/tools/article-library/export', {
      method: 'POST',
      body: {
        mode,
        syncToTimestamp: isSyncAll() ? null : getSyncTimestamp(),
      },
    });

    bulkExportJobId.value = job.id;
    await refreshBulkExportStatus(job.id);
    startBulkExportPolling(job.id);

    toast.info('后台任务已启动', `${getExportModeLabel(mode)}。你现在可以离开这个页面，稍后回来下载结果。`);
  } catch (error) {
    bulkMarkdownLoading.value = false;
    toast.error('批量导出失败', (error as Error).message);
  }
}

async function previewBulkMarkdown(mode: BulkMarkdownMode) {
  if (downloadBtnLoading.value || exportBtnLoading.value || bulkMarkdownLoading.value || bulkPreviewLoading.value) {
    toast.warning('提示', '当前已有任务在运行，请稍后再试');
    return;
  }

  bulkPreviewLoading.value = true;
  bulkPreviewReadyToExport.value = false;
  bulkPreviewMode.value = mode;
  bulkPreviewText.value = '正在同步系统快照并创建后台预估任务';

  try {
    const snapshot = await syncArticleLibrarySnapshot();
    bulkPreviewText.value = `已同步系统快照：${snapshot.accounts} 个公众号，${snapshot.articles} 篇文章；本地正文缓存本次读取 ${snapshot.htmls} 条，已上传 ${snapshot.htmlUploaded} 条，失败 ${snapshot.htmlFailed} 条；正在后台预估`;

    const job = await request<BulkExportPreviewJob>('/api/tools/article-library/export-preview', {
      method: 'POST',
      body: {
        mode,
        syncToTimestamp: isSyncAll() ? null : getSyncTimestamp(),
      },
    });
    bulkPreviewJobId.value = job.id;
    await refreshBulkPreviewStatus(job.id);
    startBulkPreviewPolling(job.id);
    toast.info('后台预估已启动', '你现在可以继续操作，结果出来后页面会自动更新。');
  } catch (error) {
    bulkPreviewText.value = '';
    toast.error('预估失败', (error as Error).message);
  }
}

async function refreshBulkPreviewStatus(jobId?: string) {
  const response = await request<{ found: boolean; job?: BulkExportPreviewJob }>(`/api/tools/article-library/export-preview-status${jobId ? `?id=${jobId}` : ''}`);
  if (!response?.found || !response.job) {
    return null;
  }

  const job = response.job;
  bulkPreviewJobId.value = job.id;
  if (job.preview) {
    bulkPreviewMode.value = job.preview.mode;
    if (job.mode === 'cached-only') {
      bulkPreviewText.value =
        `仅导出已缓存正文 预估：服务端当前累计 ${job.preview.totalCachedCount} 篇正文缓存；`
        + `本次候选 ${job.preview.totalCandidates} 篇，其中命中缓存 ${job.preview.cachedCandidateCount} 篇，未命中缓存 ${job.preview.uncachedCandidateCount} 篇；`
        + `预计导出 ${job.preview.estimatedExportCount} 篇，预计跳过 ${job.preview.estimatedSkipCount} 篇`;
    } else {
      bulkPreviewText.value =
        `${getExportModeLabel(job.mode)} 预估：基于系统内 ${job.preview.totalAccounts} 个公众号、${job.preview.scannedArticles} 篇已同步文章，`
        + `筛出 ${job.preview.totalCandidates} 篇候选，预计导出 ${job.preview.estimatedExportCount} 篇，预计跳过 ${job.preview.estimatedSkipCount} 篇`;
    }
  } else {
    bulkPreviewText.value = job.message;
  }

  if (job.status === 'completed') {
    bulkPreviewLoading.value = false;
    bulkPreviewReadyToExport.value = !!job.preview && job.preview.estimatedExportCount > 0;
    clearBulkPreviewPollTimer();
  } else if (job.status === 'failed') {
    bulkPreviewLoading.value = false;
    bulkPreviewReadyToExport.value = false;
    clearBulkPreviewPollTimer();
  } else {
    bulkPreviewLoading.value = true;
    bulkPreviewReadyToExport.value = false;
  }

  return job;
}

function startBulkPreviewPolling(jobId: string) {
  clearBulkPreviewPollTimer();
  bulkPreviewPollTimer = window.setInterval(async () => {
    try {
      const job = await refreshBulkPreviewStatus(jobId);
      if (!job) return;
      if (job.status === 'completed') {
        if (job.preview) {
          toast.success('后台预估完成', bulkPreviewText.value);
        } else {
          toast.info('后台预估完成', job.message);
        }
      } else if (job.status === 'failed') {
        toast.error('后台预估失败', job.message);
      }
    } catch (error) {
      console.error('refresh bulk preview status failed:', error);
    }
  }, 3000);
}

async function exportUsingPreview() {
  if (!bulkPreviewMode.value) {
    toast.warning('提示', '当前没有可复用的预估结果，请先执行一次预估');
    return;
  }
  await exportBulkMarkdown(bulkPreviewMode.value);
}

async function refreshSingleArticleExportStatus(jobId?: string) {
  const response = await request<{ found: boolean; job?: BulkExportJob }>(`/api/tools/article-library/export-status${jobId ? `?id=${jobId}` : ''}`);
  if (!response?.found || !response.job) {
    return null;
  }

  const job = response.job;
  if (job.mode !== 'single') {
    return null;
  }

  singleArticleExportJobId.value = job.id;
  singleArticleExportStatusText.value = `${job.message}（已导出 ${job.exportedCount}，跳过 ${job.skippedExistingCount}，失败 ${job.failedCount}）`;

  if (job.status === 'completed') {
    singleArticleExportLoading.value = false;
    singleArticleExportDownloadUrl.value = job.exportedCount > 0
      ? `/api/tools/article-library/export-download?id=${job.id}`
      : '';
    clearSingleArticleExportPollTimer();
  } else if (job.status === 'failed') {
    singleArticleExportLoading.value = false;
    singleArticleExportDownloadUrl.value = '';
    clearSingleArticleExportPollTimer();
  } else {
    singleArticleExportLoading.value = true;
    singleArticleExportDownloadUrl.value = '';
  }

  return job;
}

function startSingleArticleExportPolling(jobId: string) {
  clearSingleArticleExportPollTimer();
  singleArticleExportPollTimer = window.setInterval(async () => {
    try {
      const job = await refreshSingleArticleExportStatus(jobId);
      if (!job) return;
      if (job.status === 'completed') {
        if (job.exportedCount > 0) {
          toast.success('单篇重导完成', '导出包已可下载');
        } else {
          toast.info('单篇重导完成', job.message);
        }
      } else if (job.status === 'failed') {
        toast.error('单篇重导失败', job.message);
      }
    } catch (error) {
      console.error('refresh single article export status failed:', error);
    }
  }, 3000);
}

async function exportSingleArticleMarkdown() {
  const url = singleArticleExportUrl.value.trim();
  if (!url) {
    toast.warning('提示', '请先输入公众号文章链接');
    return;
  }

  if (!/^https:\/\/mp\.weixin\.qq\.com\/s\//.test(url)) {
    toast.warning('提示', '目前只支持 mp.weixin.qq.com/s/ 文章链接');
    return;
  }

  if (downloadBtnLoading.value || exportBtnLoading.value || bulkMarkdownLoading.value || bulkPreviewLoading.value || singleArticleExportLoading.value) {
    toast.warning('提示', '当前已有任务在运行，请稍后再试');
    return;
  }

  singleArticleExportLoading.value = true;
  singleArticleExportDownloadUrl.value = '';
  singleArticleExportStatusText.value = '正在创建单篇重导任务';

  try {
    const job = await request<BulkExportJob>('/api/tools/article-library/export-single', {
      method: 'POST',
      body: { url },
    });

    singleArticleExportJobId.value = job.id;
    await refreshSingleArticleExportStatus(job.id);
    startSingleArticleExportPolling(job.id);
    toast.info('单篇重导已启动', '后台任务已创建，完成后可直接下载打包结果。');
  } catch (error) {
    singleArticleExportLoading.value = false;
    toast.error('单篇重导失败', (error as Error).message);
  }
}

function fillSingleArticleUrlFromSelection() {
  if (selectedArticles.value.length !== 1) {
    toast.warning('提示', '请先在表格中只选中 1 篇文章');
    return;
  }

  singleArticleExportUrl.value = selectedArticles.value[0].link;
}

async function downloadSingleArticleExportZip() {
  const url = singleArticleExportDownloadUrl.value;
  if (!url) return;

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

onMounted(async () => {
  try {
    const job = await refreshBulkExportStatus();
    if (job && (job.status === 'queued' || job.status === 'running')) {
      startBulkExportPolling(job.id);
    }

    const previewJob = await refreshBulkPreviewStatus();
    if (previewJob && (previewJob.status === 'queued' || previewJob.status === 'running')) {
      startBulkPreviewPolling(previewJob.id);
    }

    const latestSingleJob = await refreshSingleArticleExportStatus();
    if (latestSingleJob && (latestSingleJob.status === 'queued' || latestSingleJob.status === 'running')) {
      startSingleArticleExportPolling(latestSingleJob.id);
    }
  } catch (error) {
    console.error('init bulk export status failed:', error);
  }
});

onBeforeUnmount(() => {
  clearBulkExportPollTimer();
  clearBulkPreviewPollTimer();
  clearSingleArticleExportPollTimer();
});

async function debug() {
  const cache = await getDebugCache('https://mp.weixin.qq.com/s/0IEaqpJIBGykHFKqj-7xqw');
  console.log(cache);
  if (cache) {
    const html = await cache.file.text();
    console.log(html);
    const result = validateHTMLContent(html);
    console.log(result);
  }
}

const copied = ref(false);
function copyWechatLink() {
  const account = selectedAccounts.value[0];
  if (!account) {
    return;
  }
  const link = `https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=${account.fakeid}&scene=124#wechat_redirect`;
  navigator.clipboard.writeText(link);

  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 1000);
}
</script>

<template>
  <div class="h-full">
    <Teleport defer to="#title">
      <h1 class="text-[28px] leading-[34px] text-slate-12 dark:text-slate-50 font-bold">文章下载</h1>
    </Teleport>

    <div class="flex flex-col h-full divide-y divide-gray-200">
      <!-- 顶部筛选与操作区 -->
      <header class="flex flex-col items-start lg:flex-row lg:items-center lg:justify-between gap-2 px-3 py-2">
        <div class="flex flex-col xl:flex-row gap-2">
          <div class="flex space-x-3">
            <AccountSelectorForArticle v-model="selectedAccounts" class="w-80" />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <UInput
              v-model="singleArticleExportUrl"
              size="sm"
              class="w-[420px] max-w-full"
              placeholder="粘贴 mp.weixin.qq.com/s/ 文章链接后单篇重导"
            />
            <UButton
              color="gray"
              variant="soft"
              icon="i-lucide:crosshair"
              :disabled="selectedArticles.length !== 1"
              @click="fillSingleArticleUrlFromSelection"
            >
              使用选中
            </UButton>
            <UButton
              color="amber"
              icon="i-lucide:rotate-cw"
              :loading="singleArticleExportLoading"
              :disabled="bulkMarkdownLoading || bulkPreviewLoading || downloadBtnLoading || exportBtnLoading"
              @click="exportSingleArticleMarkdown"
            >
              {{ singleArticleExportLoading ? '单篇重导中' : '单篇重导' }}
            </UButton>
            <UButton
              v-if="singleArticleExportDownloadUrl"
              color="green"
              icon="i-lucide:download"
              @click="downloadSingleArticleExportZip"
            >
              下载单篇导出包
            </UButton>
          </div>
            <ButtonGroup
              :items="[
                { label: '首次全量', event: 'bulk-preview-markdown-full' },
                { label: '最近 3 天增量', event: 'bulk-preview-markdown-recent' },
                { label: '仅重跑失败文章', event: 'bulk-preview-markdown-failed' },
                { label: '仅导出已缓存正文', event: 'bulk-preview-markdown-cached' },
              ]"
              @bulk-preview-markdown-full="previewBulkMarkdown('full')"
              @bulk-preview-markdown-recent="previewBulkMarkdown('recent-3d')"
              @bulk-preview-markdown-failed="previewBulkMarkdown('failed-only')"
              @bulk-preview-markdown-cached="previewBulkMarkdown('cached-only')"
            >
            <UButton
              color="blue"
              icon="i-lucide:scan-search"
              :loading="bulkPreviewLoading"
              :disabled="downloadBtnLoading || exportBtnLoading || bulkMarkdownLoading"
              :label="bulkPreviewLoading ? '扫描预估中' : '先扫描预估数量'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>
            <ButtonGroup
              :items="[
                { label: '首次全量（后台）', event: 'bulk-export-markdown-full' },
                { label: '最近 3 天增量（后台）', event: 'bulk-export-markdown-recent' },
                { label: '仅重跑失败文章（后台）', event: 'bulk-export-markdown-failed' },
                { label: '仅导出已缓存正文（后台）', event: 'bulk-export-markdown-cached' },
              ]"
              @bulk-export-markdown-full="exportBulkMarkdown('full')"
              @bulk-export-markdown-recent="exportBulkMarkdown('recent-3d')"
              @bulk-export-markdown-failed="exportBulkMarkdown('failed-only')"
              @bulk-export-markdown-cached="exportBulkMarkdown('cached-only')"
            >
            <UButton
              color="black"
              icon="i-lucide:files"
              :loading="bulkMarkdownLoading"
              :disabled="downloadBtnLoading || exportBtnLoading"
              :label="bulkMarkdownLoading ? '后台导出 Markdown 进行中' : '后台导出 Markdown'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>
          <UButton
            v-if="bulkExportDownloadUrl"
            color="green"
            icon="i-lucide:download"
            @click="downloadBulkExportZip"
          >
            下载后台导出包
          </UButton>
          <UButton
            color="gray"
            variant="soft"
            icon="i-lucide:wrench"
            :loading="reconcileIndexLoading"
            :disabled="downloadBtnLoading || exportBtnLoading || bulkMarkdownLoading || bulkPreviewLoading"
            @click="reconcileArticleLibraryExportIndex"
          >
            {{ reconcileIndexLoading ? '补全索引中' : '补全导出索引' }}
          </UButton>
          <UButton v-if="downloadBtnLoading" color="black" @click="stopDownload">停止</UButton>
          <ButtonGroup
            :items="[
              { label: '文章内容', event: 'download-article-html' },
              { label: '阅读量 (需要Credential)', event: 'download-article-metadata' },
              { label: '留言内容 (需要Credential)', event: 'download-article-comment' },
            ]"
            @download-article-html="download('html', selectedArticleUrls)"
            @download-article-metadata="download('metadata', selectedArticleUrls)"
            @download-article-comment="download('comment', selectedArticleUrls)"
          >
            <UButton
              :loading="downloadBtnLoading"
              :disabled="!hasSelectedAccounts"
              color="white"
              class="font-mono"
              :label="downloadBtnLoading ? `抓取中 ${downloadCompletedCount}/${downloadTotalCount}` : '抓取'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <ButtonGroup
            :items="[
              { label: 'Excel', event: 'export-article-excel' },
              { label: 'JSON', event: 'export-article-json' },
              { label: 'HTML', event: 'export-article-html' },
              { label: 'Txt', event: 'export-article-text' },
              { label: 'Markdown', event: 'export-article-markdown' },
              { label: 'Word (内测中)', event: 'export-article-word' },
              { label: 'PDF (内测中)', event: 'export-article-pdf' },
            ]"
            @export-article-excel="exportFile('excel', selectedArticleUrls)"
            @export-article-json="exportFile('json', selectedArticleUrls)"
            @export-article-html="exportFile('html', selectedArticleUrls, contentNotDownloadedCount)"
            @export-article-text="exportFile('text', selectedArticleUrls, contentNotDownloadedCount)"
            @export-article-markdown="exportFile('markdown', selectedArticleUrls, contentNotDownloadedCount)"
            @export-article-word="exportFile('word', selectedArticleUrls, contentNotDownloadedCount)"
            @export-article-pdf="exportFile('pdf', selectedArticleUrls, contentNotDownloadedCount)"
          >
            <UButton
              :loading="exportBtnLoading"
              :disabled="!hasSelectedAccounts"
              color="white"
              class="font-mono"
              :label="exportBtnLoading ? `${exportPhase} ${exportCompletedCount}/${exportTotalCount}` : '导出'"
              trailing-icon="i-heroicons-chevron-down-20-solid"
            />
          </ButtonGroup>

          <UButton
            :disabled="!hasSingleSelectedAccount"
            :icon="copied ? 'i-lucide:check' : 'i-heroicons-link-16-solid'"
            label="复制公众号链接"
            :color="copied ? 'green' : 'blue'"
            @click="copyWechatLink"
          />
          <UButton v-if="isDev" @click="debug">调试</UButton>
        </div>
      </header>
      <div v-if="bulkPreviewText" class="px-3 py-2 flex items-center justify-between gap-3 text-sm text-blue-700 bg-blue-50 border-b border-blue-200">
        <span>{{ bulkPreviewText }}</span>
        <UButton
          v-if="bulkPreviewReadyToExport"
          color="green"
          icon="i-lucide:rocket"
          :disabled="bulkMarkdownLoading || bulkPreviewLoading || downloadBtnLoading || exportBtnLoading"
          @click="exportUsingPreview"
        >
          基于这次预估开始导出
        </UButton>
      </div>
      <div v-if="singleArticleExportStatusText" class="px-3 py-2 text-sm text-amber-700 bg-amber-50 border-b border-amber-200">
        {{ singleArticleExportStatusText }}
      </div>
      <div v-if="bulkExportStatusText" class="px-3 py-2 text-sm text-slate-600 bg-slate-50 border-b border-slate-200">
        {{ bulkExportStatusText }}
      </div>

      <ag-grid-vue
        style="width: 100%; height: 100%"
        :loading="loading"
        :rowData="globalRowData"
        :columnDefs="columnDefs"
        :gridOptions="gridOptions"
        @grid-ready="onGridReady"
        @filter-changed="onFilterChanged"
        @column-moved="onColumnStateChange"
        @column-visible="onColumnStateChange"
        @column-pinned="onColumnStateChange"
        @column-resized="onColumnStateChange"
        @selection-changed="onSelectionChanged"
      ></ag-grid-vue>
    </div>

    <PreviewArticle ref="previewArticleRef" />
  </div>
</template>
