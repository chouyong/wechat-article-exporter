# 持续供数生产接线机器证据

生成时间：2026-07-19

## 机器验证

- C3-7a 响应解析 smoke：128/128
- C3-5/C3-6 runner smoke：359/359
- 同步任务 registry smoke：179/179
- PageFetcher smoke：6/6
- 账号 registry smoke：16/16
- C3-9 提交器离线首次写入：1 篇，Qdrant upsert 1 点
- C3-9 提交器离线重复提交：0 重复写入
- C3-9 Qdrant 故障演练：失败闭合，目标文章文件回滚为 0 残留
- InfoQ canary 生产提交：快照 95 篇，manifest 写入 95 条，Qdrant upsert 95 点
- InfoQ canary 第二次提交：同一 95 篇快照，`changedCount=0`，无重复向量写入
- canary 回滚证据：`.data/mp-sync-production/rollback/ad90669a-5f6a-4d61-8f24-bc7de94c2244/`
- 当前 Qdrant collection：`kb_wechat_articles_bge_m3_v2`，服务报告 1024 维，状态 green
- 当前 Ollama embedding：`bge-m3`，服务报告 1024 维
- 文章库 manifest：`D:\knowledgeBase\self-evolving-kb-architecture\90_system\manifest.sqlite`
- 文章目标目录：`D:\knowledgeBase\self-evolving-kb-architecture\02_library\articles`

## 账号导入

- 可审计源文件：`D:\knowledgeBase\wechat-article-exporter\wechat-article-exporter\public\imports\wechat-rss-accounts.full.cleaned.json`
- 源文件 SHA-256：`8505bc462d0ccefeb0c34792faabcf6bb77b0c7a344317ad0c9395306dc032cd`
- 源文件账号数：74；有效 74；唯一 fakeid 74；无效 0。
- `dryRun:true`：inserted=74、updated=0、unchanged=0、invalid=0。
- `dryRun:false`：inserted=74、updated=0、unchanged=0、invalid=0；registry 总数由 1 增至 75。
- 重复正式导入：inserted=0、updated=0、unchanged=74、invalid=0，证明幂等。
- 此源文件只覆盖 74 条；此前估计的约 233 条中仍缺少约 159 条可审计输入，未伪造或猜测其余账号。
- 导入接口：`POST /api/tools/mp-accounts/import-browser`，支持 `dryRun`、幂等 upsert、invalidItems。
- 账号导入机器证据已补齐：输入 hash、输入/有效/无效数量、dry-run、正式写入和重复导入统计；SQLite 事务由 registry 内部原子提交，未生成独立快照文件。

## 启动与调度边界

- `.env` 已接入生产提交目标、Ollama 和 Qdrant 配置；凭据字段不写入本证据。
- `MP_SYNC_PRODUCTION_ENABLED=1` 已配置。
- 已用新 production build 在隔离端口 3010 启动，配置 `MP_SYNC_AUTOSTART_RECOVERY=1`、`MP_SYNC_SCHEDULE_MS=60000`、`MP_SYNC_PRODUCTION_ENABLED=1`，HTTP readiness 成功；在首个 60 秒调度 tick 前停止，未触发全量联网任务。
- 真实调度 canary（隔离 SQLite，仅启用 InfoQ，端口 3011）已等待一个 60 秒 tick：job `885bf1a4-3ae1-4207-9ec3-0e666069034a`，`completed`，1/1 succeeded，0 failed；staging snapshot 39 篇，C3-9 提交 39 篇、Qdrant upsert 39 点。隔离回滚证据：`D:\tmp\mp-sync-schedule-production\rollback\885bf1a4-3ae1-4207-9ec3-0e666069034a\`。
- 3002 首个 75 账号真实调度 job `c34123a1-a279-436c-bb0e-56e33f208c80` 暴露账号健康阻断：2 succeeded、54 `auth_required`、19 `rate_limited`；job 在提交屏障中被安全停止并精确回滚，live manifest 与提交前备份 SHA-256 相同，未观察到 Qdrant upsert。
- 该 job 同时暴露分页旁路收集缺陷（147 个 `newArticles` 被放大为 1601 条 snapshot）；已修复为 runner 只通过 `onArticles` 传递最终去重结果。最新 3012 隔离 tick 的 collector 断言 `snapshotArticles === newArticles` 成立（该次因隔离凭据状态 failed、两者均为 0）。
- 启动恢复路径已接入 recovery job hooks：恢复抓取的文章会生成 staging snapshot 并在 production mode 提交到 C3-9；提交失败会把该 job 记为 failed，保持 fail-closed。
- 尚未完成真实“进程中断→恢复抓取→提交成功”的联网重启演练；调度只验证了 1 个账号，尚未等待 75 账号全量任务，因此不能据此宣布全量生产 GO。
- 当前 3002 `.env` 的 `MP_SYNC_SCHEDULE_MS=0`，autostart recovery 保持开启；在 54 auth_required/19 rate_limited 未解决前不重新开启全量定时调度。
- 每次同步在 runner finalize 前生成 staging snapshot，再经过 C3-9 提交器；embedding、Qdrant 或 manifest 任一失败均拒绝 finalize，job 保持 running 交恢复路径，并执行回滚。

## 真人发布字段（故意留空）

```yaml
release_owner: null
human_reviewer: null
approval_time: null
human_verdict: null
production_go: null
```

以上字段只能由真实责任人在查看机器证据后填写。机器通过不等于真人放行。
