# 生产接线调查

## 当前已验证

- 3002 登录、auth-key、公众号 info 和 InfoQ 单账号 canary 已成功。
- C3-7a 解析、C3-5/C3-6 runner、控制面鉴权 smoke 已通过。
- 详情动态路由和 events middleware 已在本机产物中验证。

## 待核对

- `server/utils/mp-sync-production.ts` 是否真正写入文章库、manifest 和可回滚快照。
- 正式账号导入接口及现有账号数量、导入结果校验与回滚方式。
- `server/plugins/mp-sync-startup.server.ts` 的恢复与调度默认值及异常隔离。
- 全量/增量边界、重复执行幂等性和快照 hash 证据。

## 阶段 1 盘点结果

- `mp-sync-production.ts` 当前只将抓取结果写入 `.data/mp-sync-staging/<job>/snapshot.json` 和 `manifest.json`，没有提交到文章库、知识库 manifest 或 Qdrant。
- `import-browser` 已通过 `dryRun` 参数进入 `upsertMpAccounts`，可用于正式账号导入前预览；当前尚未执行真实约 233 账号导入。
- 启动插件在 `MP_SYNC_AUTOSTART_RECOVERY=1` 且存在 auth-key 时恢复，并以 `MP_SYNC_SCHEDULE_MS>=60000` 创建增量 job；调度 job 当前直接调用同步服务，缺少写入提交成功/失败状态的统一门。
- 宽泛工作树递归检索曾超时；后续证据采集限制为指定源码、SQLite/JSON manifest 和单次 smoke 输出。

## 发布判定

机器证据可支持 `INTERNAL_READY`；真人身份、审批时间和真人 verdict 必须为空，未得到明确真人确认前保持 fail-closed。

## 阶段 2/5 结果

- 新增 `commitStagedSyncJob`：staging snapshot -> Markdown 文章 -> `manifest.sqlite` -> Ollama embedding -> Qdrant upsert；依赖失败会回滚文件、SQLite，并尝试删除已 upsert 点。
- 同 URL 增量复用既有 manifest `id`/`library_path`，重复提交按 `content_hash` 零重复。
- InfoQ canary 真实提交完成：95 篇快照、95 条 manifest、95 个 Qdrant 点；证据与回滚目录位于 `.data/mp-sync-production/rollback/<jobId>`。
- Qdrant/Ollama 真实本机服务可达，collection 1024 维与 `bge-m3` 一致。
- 约 233 个正式账号输入未在当前文件系统/分支中发现；本机 registry 仅 1 个账号，不能伪造导入。

## 阶段 3/4 结果

- 从 Docker 3001 实例挂载的已知导入文件读取到 74 条正式账号；源 SHA-256 为 `8505bc462d0ccefeb0c34792faabcf6bb77b0c7a344317ad0c9395306dc032cd`。
- 账号 dry-run / 正式导入 / 重复导入分别为 `74/0/0`、`74/0/0`、`0/0/74`（inserted/updated/unchanged），registry 总数为 75。
- 估计 233 条与实际可审计源文件不一致，缺少约 159 条输入；不以机器推断替代真实导出。
- 新 production build 在 3010 隔离实例 readiness 成功，恢复与调度配置可加载；首个调度 tick 前停止，尚未进行真实联网重启恢复演练。
- `recoverInterruptedJobs` 新增 job hooks，`recoverMpSyncJobs` 在生产模式下将恢复抓取文章提交到 C3-9，失败保持该 job failed。
- 进一步修正：正常同步与恢复同步均在 runner finalize 前执行 `beforeFinalize` 提交屏障；C3-9 失败时 job 保持 running，不会出现“completed 但未写入”的假成功。
- 3011 隔离调度 canary 已完成一个真实 60 秒 tick：1/1 succeeded，snapshot 39，manifest/文章 39，Qdrant 39，rollback commit evidence 已落盘。
- 3002 75 账号调度后发现 54 auth_required + 19 rate_limited；已回滚且 manifest hash 一致。生产调度暂设 0，等待凭据/限流处理与真人确认。
- 已修复分页全量收集导致的 147→1601 snapshot 放大，新增 `RunSyncJobDeps.onArticles` 只接收最终 newArticles；最新隔离断言 snapshot 数量与 newArticles 相等。
