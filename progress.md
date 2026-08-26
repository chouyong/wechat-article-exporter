# 进度日志

## 2026-07-19

- 已建立本轮生产接线计划和证据边界。
- 阶段 1 盘点完成：确认当前只有 staging 写入，账号导入具备 dryRun，启动恢复/调度已有骨架但未与生产提交闭合。
- 已记录一次宽泛检索超时，后续改用定向读取。
- 阶段 2 完成：新增 C3-9 生产提交器，支持文章 Markdown、manifest.sqlite、Ollama embedding、Qdrant upsert、幂等与回滚。
- 离线提交器演练通过：首次写入、重复零重复、Qdrant 失败回滚。
- 真实 InfoQ canary 提交通过：95 篇快照/95 条 manifest/95 点 Qdrant；生成 rollback commit 证据。
- 串行 smoke 通过：parse 128、runner 359、jobs 179、fetcher 6、registry 16。
- 已写入 `.env` 生产目标配置（不改变凭据值），生成 `production-release-evidence-2026-07-19.md`。
- 账号全量导入仍阻塞：当前 registry 只有 1 个真实账号，未找到约 233 条输入，未执行伪造导入。
- 已定位并审计 Docker 3001 实例的 74 条账号导入源；完成 dry-run、正式导入和重复导入幂等校验，registry 总数 75；仍缺约 159 条未知输入，未伪造。
- 已补齐恢复抓取到 C3-9 提交的 hooks；新 production build 在 3010 隔离端口启动 readiness 通过，首个 60 秒调度 tick 前停止。
- 已将正常/恢复提交移到 runner finalize 前屏障；提交失败保持 running 交恢复，runner 359/359、jobs 179/179 和最新 production build 均通过。
- 已完成真实调度 canary：隔离 SQLite 仅启用 InfoQ，3011 等待 60 秒 tick 后 job completed 1/1，C3-9 写入 39 篇并 upsert 39 点，生成隔离 rollback evidence；未触发 75 账号全量调度。
- 3002 首个 75 账号 tick 发现 54 auth_required、19 rate_limited、2 succeeded；已在无 Qdrant commit 前停止并按证据回滚，manifest SHA-256 与提交前一致。
- 修复 collector 只提交 runner 最终 newArticles，3012 隔离断言 snapshotArticles===newArticles；当前 `.env` schedule=0，避免失败账号每分钟重试。
