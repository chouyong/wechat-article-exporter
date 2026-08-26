import {
  createIncrementalJob,
  getActiveSyncJobId,
  recoverMpSyncJobs,
  startMpSyncJob,
} from '~/server/utils/mp-sync-production';

export default defineNitroPlugin(async () => {
  // 启动恢复与定时调度默认关闭；没有真实 auth-key 时 fail-closed，不会伪造联网运行。
  if (process.env.MP_SYNC_AUTOSTART_RECOVERY !== '1') return;
  const authKey = process.env.MP_SYNC_AUTH_KEY?.trim();
  if (!authKey) {
    console.warn('[mp-sync] recovery skipped: MP_SYNC_AUTH_KEY is not configured');
    return;
  }
  try {
    const summary = await recoverMpSyncJobs(authKey);
    if (summary.failed.length)
      console.error(
        '[mp-sync] recovery partial failure',
        summary.failed.map(item => item.jobId)
      );
  } catch (error) {
    console.error('[mp-sync] recovery failed closed', error);
  }

  const scheduleMs = Number(process.env.MP_SYNC_SCHEDULE_MS || 0);
  if (!Number.isFinite(scheduleMs) || scheduleMs < 60_000) return;
  const schedule = () => {
    if (getActiveSyncJobId()) return;
    try {
      const job = createIncrementalJob('scheduled:' + Math.floor(Date.now() / scheduleMs));
      if (job.status === 'queued') {
        void startMpSyncJob(job.id, authKey).catch(error => {
          console.error('[mp-sync] scheduled job failed:', error instanceof Error ? error.name : 'unknown_error');
        });
      }
    } catch (error) {
      console.error('[mp-sync] schedule admission failed:', error instanceof Error ? error.name : 'unknown_error');
    }
  };
  const timer = setInterval(schedule, scheduleMs);
  timer.unref?.();
});
