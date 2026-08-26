import assert from 'node:assert/strict';
import {
  buildExactRecoveryTargetPlan,
  validateExactRecoveryJobId,
  validateExactRecoverySourceJob,
} from '../server/utils/article-library-exact-targets.ts';

const sourceJobId = 'a'.repeat(32);
const urls = ['https://mp.weixin.qq.com/s/existing', 'https://mp.weixin.qq.com/s/missing'];
const sourceJob = {
  id: sourceJobId,
  mode: 'single',
  status: 'completed',
  targetUrls: urls,
  totalCandidates: 2,
  processedCandidates: 2,
  exportedCount: 1,
  skippedExistingCount: 0,
  failedCount: 1,
};

assert.equal(validateExactRecoveryJobId(sourceJobId), sourceJobId);
assert.deepEqual(validateExactRecoverySourceJob(sourceJob, sourceJobId, urls), urls);

for (const invalid of [
  { ...sourceJob, id: 'b'.repeat(32) },
  { ...sourceJob, mode: 'full' },
  { ...sourceJob, status: 'running' },
  { ...sourceJob, targetUrls: [urls[0], urls[0]] },
  { ...sourceJob, targetUrls: [...urls].reverse() },
  { ...sourceJob, targetUrls: ['https://example.com/not-wechat', urls[1]] },
  { ...sourceJob, processedCandidates: true },
  { ...sourceJob, failedCount: 0, exportedCount: 2 },
  { ...sourceJob, exportedCount: 0 },
]) {
  assert.throws(() => validateExactRecoverySourceJob(invalid, sourceJobId, urls));
}

assert.throws(() => validateExactRecoveryJobId('../outside'));
assert.throws(() => validateExactRecoveryJobId(''));

const snapshotArticle = {
  fakeid: 'account',
  link: `${urls[0]}?scene=1`,
  is_deleted: false,
};
const plan = buildExactRecoveryTargetPlan([snapshotArticle], urls);
assert.deepEqual(plan, [
  { url: urls[0], snapshotArticle },
  { url: urls[1], snapshotArticle: null },
]);

assert.throws(() => buildExactRecoveryTargetPlan([{ link: urls[1], is_deleted: true }], urls));

console.log('微信公众号 exact recovery 收据与目标计划回归：通过');
