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

## 2026-10-05 账号作用域同步误判修复

- 根因：同步前把目标公众号 fakeid 强制与登录主体 fakeid 比较，导致同一登录会话搜索并添加其他公众号时被错误阻断；正确边界是只校验缓存 `ownerKey` 属于当前登录作用域。
- 修改：`apis/index.ts`、`shared/utils/account-session.ts` 及两个账号同步 smoke；同一作用域跨公众号允许，旧登录作用域仍拒绝。
- 验证：账号作用域 smoke 10 项、同步调度 smoke 18 项、账号密码登录 smoke 16 项、Biome、`git diff --check` 和 production build 均通过。
- 发布：提交 `1f1372d0eebb31891330746cf162b6e7f1a9481c` 已推送并 fetch-back 与 `origin/master` 一致。
- 3019 隔离候选曾验证通过（API JSON、账号密码空请求 400、bundle 新文案），随后已删除候选容器、镜像、独立 exports 和临时 Dockerfile；正式 3001 未切换。
- 正式切换阻断：`data/exports/article-library/jobs` 中 5 个历史 `job.json` 含重复 JSON 尾部；3001 对这 5 个 ID 均返回 `found:false`，无法证明合法终态，未修改 job、快照、账号、调度或生产镜像。

## 2026-10-06 继续收口 owner 作用域修复

- 只读刷新确认 3001 仍为 `wechat-article-exporter:release-6757f19b-20261005`，端口 `3001→3000`，仅一个 Node 主进程，`kb-wechat-sync` 仍 Disabled。
- 快照仍为 401 个账号、13022 篇文章，SHA-256=`576EC47E13274D702BCB4E1415E70F6A0FECC1D5DACE2C3B64E76FDAA857E0BE`；未运行真实同步、未读取认证秘密。
- 重新核对 5 个历史 job 的原始 SHA 与重复尾部；3001 API 对每个 ID 均返回 `found:false`，因此不猜造终态。
- 在干净 `HEAD=10dd35244dd282d25c1ace043ce24f539e120be1` 上重新执行 `yarn build`，Nuxt/Nitro production build 通过；下一步是候选镜像真实 Edge CSR 验证和生产切换门禁复核。
- 候选 `candidate-10dd352-owner-scope-20261006-r2` 已在 3019 通过 HTTP JSON 与真实 Edge CSR：dashboard DOM 正常、无 Nuxt 错误页、无 pageerror/失败资源；登录弹窗可切换二维码与账号密码模式。
- 5 个历史 job 先按原 SHA 备份到 `D:\\tmp\\wechat-job-repair-backup-20261006`，再仅去除首个完整 JSON 后的重复尾部，保留原对象、status 与计数；修复后全部严格 JSON，快照 SHA 仍未变化。原始备份作为回滚副本保留。
