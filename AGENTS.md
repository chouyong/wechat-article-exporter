# 仓库指南

## 项目结构与模块组织
本仓库是一个用于导出微信公众号文章数据的 Nuxt 3 应用。UI 路由位于 `pages/`，可复用的 Vue 组件位于 `components/`，共享的客户端逻辑位于 `composables/`、`store/` 和 `utils/`。服务端接口与后端辅助代码位于 `server/api/` 和 `server/utils/`。共享的渲染与解析代码位于 `shared/utils/`。静态文件放在 `public/`，设计资源放在 `assets/`，用于解析校验的 HTML 样例文件放在 `samples/`。类型声明统一放在 `types/`。

## 知识图谱状态
2026-05-28，当前目录 `D:\knowledgeBase\wechat-article-exporter\wechat-article-exporter` 已加入本机 CodeGraph 知识图谱，工作区内已存在 `.codegraph/` 索引目录。

- 后续在本仓库内查询符号定义、调用关系、影响范围、代码流转时，优先使用 `codegraph_*` 工具，而不是先做全文 grep。
- 适用场景包括：查找函数/类型定义、分析谁调用了某个方法、判断修改某符号的影响半径、追踪某入口如何流转到某个导出或抓取逻辑。
- 如果后续有较大规模代码变动，需要留意 CodeGraph 返回的 pending sync / staleness 提示；仅对提示中列出的文件再做本地读取校验，其余以索引结果为准。

## 构建、测试与开发命令
使用 Node `>=22` 和 Yarn `1.22`。

- `yarn`：安装依赖并执行 `nuxt prepare`。
- `yarn dev`：启动本地 Nuxt 开发服务器。
- `yarn debug`：以启用 Node Inspector 的方式启动 Nuxt。
- `yarn build`：生成生产构建。
- `yarn preview`：按 Cloudflare Pages 预设构建，并使用 Wrangler 在本地预览产物。
- `yarn format`：在整个仓库中运行 Biome 格式化与 import 整理。
- `docker build --build-arg VERSION=<version> -t <image> .`：在测试 Docker 打包时手动构建容器镜像。

## 代码风格与命名约定
格式化由 `biome.json` 和 `.prettierrc` 强制约束：使用 2 个空格缩进、分号、JS/TS 中的单引号，以及 120 字符行宽。变量和函数优先使用 `camelCase`，Vue 组件文件名使用 `PascalCase`，例如 `ProxyMetrics.vue`；Nuxt/Nitro 路由命名遵循 `server/api/public/v1/article.get.ts` 这类形式。CSS 或 Tailwind 的改动应尽量靠近受影响的组件；如果属于全局样式，则放在 `style.css` 或相应配置文件中。

## 测试指南
当前没有统一的 `yarn test` 脚本。回归检查以样例驱动为主：解析与渲染相关的夹具文件位于 `test/` 和 `samples/`。当新增解析或导出行为时，请在 `samples/` 中新增或更新具有代表性的样例文件，并让 `test/` 下的辅助脚本保持单一职责，命名风格参考现有的 `parse_cgi_data.ts` 或 `normalize_html.ts`。至少应在提交前通过 `yarn dev` 验证受影响流程。

## 提交与 Pull Request 规范
近期提交历史中既有版本号提交，也有带范围的修复提交。功能性改动请优先使用明确的提交标题，例如 `fix: handle missing article metadata` 或 `feat: add proxy metrics panel`，避免使用含义不明的 `update`。PR 应说明用户可见的变更内容，标注任何配置或 API 影响，关联相关 issue，并在涉及 UI 改动时附上截图。如果修改了导出结果或解析行为，请说明验证过哪些样例或手工场景。

## 配置与安全提示
本地配置请从 `.env.example` 开始。不要提交真实凭据、Cookie 或代理密钥。`config/proxy.txt`、服务端抓取工具以及与登录相关的接口都属于敏感区域；若修改这些部分，请在 PR 中明确记录行为变化。

## 文章数据硬规则
自 2026-05-24 起，当前仓库内关于“公众号账号”和“公众号文章”的查询、导入、预估、抓取状态判断、正文导出、批量导出、后台任务导出，统一以 `wechat-article-exporter` 自身已经同步到系统内的数据为唯一准源。

- 严禁从 `wechat-rss`、`we-mp-rss`、RSS feed、本地 RSS Markdown 缓存、RSS JSON 缓存中查询公众号账号、文章列表，或据此计算候选账号数、候选文章数、导出数、缺失数。
- `wechat-rss` / `we-mp-rss` 不再作为当前仓库任何账号层面或文章层面的数据来源，也不得用于账号导入、昵称纠错、初始化账户映射、文章补数或导出兜底。
- 如果系统内账号数量或文章数量与 `wechat-rss` 数据不一致，必须以 `wechat-article-exporter` 系统内已同步数据为准，不允许回退到 `wechat-rss` 数据源。
- 新增或修改账号导入、文章查询、正文抓取、导出功能时，必须优先复用当前系统已有的账号列表、文章列表、正文缓存、导出缓存与同步状态；如果现有服务端能力不足，应补系统内持久化或同步链路，不得改为读取 `wechat-rss` 数据来规避。

## 本地代理说明
当前仓库已验证可通过本地 HTTP 代理 `127.0.0.1:18080` 访问 GitHub。仓库级 Git 配置建议如下：

- `git config http.proxy http://127.0.0.1:18080`
- `git config https.proxy http://127.0.0.1:18080`

如果 `18080` 不可用，可使用备用 SOCKS5 代理 `127.0.0.1:1080`。但 Git for Windows 默认 `schannel` 在 “SOCKS5 代理 + GitHub 写操作认证” 场景下可能报错 `SEC_E_NO_CREDENTIALS`。这种情况下，需切换到 `openssl`：

- `git config http.sslBackend openssl`
- `git config http.proxy socks5h://127.0.0.1:1080`
- `git config https.proxy socks5h://127.0.0.1:1080`

常用连通性验证命令：

- `git ls-remote origin`
- `git push origin master`

如果只想临时走备用 SOCKS5 代理而不修改仓库配置，可使用：

- `git -c http.sslBackend=openssl -c http.proxy=socks5h://127.0.0.1:1080 -c https.proxy=socks5h://127.0.0.1:1080 push origin master`

## 最近修复记录
2026-05-20 完成过一项与导出状态同步相关的修复。核心问题是：文章内容抓取成功后，若文章仍处于选中状态，导出 HTML / Txt / Markdown / Word / PDF 时，界面可能仍错误提示“尚未抓取内容”。

本次修复点：

- 在 `pages/dashboard/article.vue` 中，抓取内容、更新元数据、删除状态、评论状态变更后，主动刷新当前选中文章状态。
- 在 `pages/dashboard/single.vue` 中，同步补齐相同逻辑，避免单篇下载页出现同类误判。

相关提交与版本：

- 提交：`99627e7` 修复抓取后导出仍误判未下载内容。
- 版本提交：`fbbb1d0`，版本号 `2.3.18`。
- Git Tag：`2.3.18`。

可复用的中文变更说明如下：

> 本次版本修复了文章下载页和单篇文章下载页中的一个状态同步问题。
> 当用户已成功抓取文章内容后，如果文章仍处于选中状态，导出 HTML / Txt / Markdown / Word / PDF 时，界面此前可能仍错误提示“尚未抓取内容”，导致无法继续导出。
> 本次修复后，在抓取内容、更新元数据、删除状态或评论状态变化后，会同步刷新当前选中文章的状态，确保导出前校验使用的是最新结果。

## 重启交接记录
以下内容用于本机重启后的继续工作，重点是 Docker 部署状态与后续待办。

### 2026-05-25 导出链路交接

#### 当前硬规则
- 当前仓库内，公众号账号与公众号文章的数据源，只允许使用 `wechat-article-exporter` 自身系统内已同步数据。
- 严禁从 `wechat-rss`、`we-mp-rss`、RSS feed、本地 RSS Markdown 缓存、RSS JSON 缓存中查询账号、文章、候选数、导出数、缺失数。
- `server/api/tools/wechat-rss/manifest.post.ts` 目前仍保留为一个禁用壳接口，但实际行为是直接返回 `410`，不再允许账号导入。

#### 当前后台导出实现
- 后台批量 Markdown 导出已经从旧的 `wechat-rss` 方案切换为新的 `article-library` 方案。
- 相关核心文件：
  - `server/utils/article-library-export.ts`
  - `server/api/tools/article-library/snapshot.post.ts`
  - `server/api/tools/article-library/html-snapshot.post.ts`
  - `server/api/tools/article-library/export.post.ts`
  - `server/api/tools/article-library/export-status.get.ts`
  - `server/api/tools/article-library/export-download.get.ts`
  - `server/api/tools/article-library/export-preview.post.ts`
  - `server/api/tools/article-library/export-preview-status.get.ts`
- 页面入口位于：
  - `pages/dashboard/article.vue`

#### 当前导出链路的实际行为
1. 前端在文章页点击“预估”或“后台导出”前，会先把系统内快照同步到服务端：
   - 账号快照：来自 IndexedDB `info`
   - 文章快照：来自 IndexedDB `article`
   - 正文缓存快照：来自 IndexedDB `html`
2. 服务端后台任务优先使用正文缓存快照导出 Markdown。
3. 如果正文缓存不存在，则服务端回退抓取 `mp.weixin.qq.com` 原文。
4. 服务端 Markdown 提取器目前已支持多级 fallback：
   - 标准 `#js_content`
   - `cgiDataNew + renderHTMLFromCgiDataNew`
   - `cgiDataNew + renderTextFromCgiDataNew`
   - `#js_article` / `body` 文本兜底

#### 已完成的相关清理
- 已删除旧的 `server/utils/wechat-rss-export.ts`
- 已删除旧的 `server/api/tools/wechat-rss/` 下文章导出相关接口：
  - `export.post.ts`
  - `export-preview.post.ts`
  - `export-status.get.ts`
  - `export-preview-status.get.ts`
  - `export-download.get.ts`
- 已移除导航和账号页中的 `we-mp-rss` 导入入口
- 已删除旧页面：
  - `pages/tools/wechat-rss-import.vue`
  - `pages/tools/import-rss-accounts.vue`

#### 最近一次真实运行结果
- 最近一次“最近 3 天增量（后台）”任务结果：
  - `totalCandidates = 417`
  - `skippedExistingCount = 378`
  - `failedCount = 39`
  - `exportedCount = 0`
- 这不是全量失败：
  - `378` 篇是因为之前已经成功导出过，所以被正常跳过
  - `39` 篇才是当前真正剩余的问题
- 最近一次失败 job：
  - `data/exports/article-library/jobs/c1b342f9d74b4202a1a316efe66f9761/job.json`
- 其 `failureSamples` 当前主要表现为：
  - `fetch failed`

#### 当前判断
- 目前剩余的 39 篇失败，不再是“正文结构不兼容”为主，最新表现重新收敛到回退抓取失败。
- 这意味着：
  - 这 39 篇没有命中系统内正文缓存快照
  - 后台回退在线抓取时，被微信侧或代理链路拦截/失败

#### 已新增的针对性能力
- 已新增导出模式：
  - `failed-only`
- 页面上应出现：
  - `仅重跑失败文章`
  - `仅重跑失败文章（后台）`
- 该模式只重跑最近一次失败样本，不会再重复处理那 `378` 篇已跳过文章。

#### 最近一次稳定性调整
- `server/utils/article-library-export.ts` 中已做如下调整：
  - `REQUEST_DELAY_MS` 从 `350` 提高到 `1200`
  - `ARTICLE_REQUEST_RETRY` 从 `1` 提高到 `3`
- 目的是降低微信原文回退抓取的瞬时失败概率。

#### 当前需要用户做的操作
- 重启终端、换 key 后，优先去文章页：
  - `http://127.0.0.1:3001/dashboard/article`
- 刷新页面后，不要再跑“最近 3 天增量（后台）”。
- 直接选择：
  - `先扫描预估数量 -> 仅重跑失败文章`
  - 或 `后台导出 Markdown -> 仅重跑失败文章（后台）`

#### 下一步建议
- 如果“仅重跑失败文章”后，失败数明显下降，则说明主要是代理/限流瞬时问题，继续通过重跑消化尾部失败即可。
- 如果仍有少量顽固失败，则下一步应实现：
  - 失败清单单独落盘，例如 `failed.json`
  - 支持针对失败 URL 的单篇诊断与分类
  - 必要时增加“仅从本地已抓正文缓存导出，不做在线回退”的安全模式

### 当前已完成
- 已新增本地部署文件 `.env`。
- 已新增 `docker-compose.yml`，当前端口映射为 `3001:3000`。
- 已修改 `Dockerfile`，使其优先使用本机已有镜像 `ccr.ccs.tencentyun.com/buildingai/node:22.20.0` 作为构建层和运行层基础镜像，避免直接依赖 Docker Hub。
- 已把构建期 `NODE_OPTIONS` 提升到 `--max-old-space-size=4096`，解决 `nuxt build` 的 Node 堆内存不足问题。
- 已将 npm / yarn registry 改到 `http://registry.npmmirror.com`，用于缓解 Docker 构建中的拉包问题。
- 已去掉容器内安装 Chromium 和运行时补装 `puppeteer` 的步骤，因此当前主服务可启动，但 PDF 导出能力暂未恢复。
- 已成功构建镜像并启动容器，验证结果是 `http://127.0.0.1:3001` 返回 `200 OK`，容器日志显示 `Listening on http://0.0.0.0:3000`。

### 当前相关文件
- `Dockerfile`
- `docker-compose.yml`
- `.env`

### 当前工作区状态
截至本次交接，工作区至少包含以下未提交改动：

- 修改：`Dockerfile`
- 新增：`docker-compose.yml`
- 新增：`data/` 目录

如果重启后需要再次确认，请先执行：

- `git status --short`

### 重启后优先检查
1. 启动 Docker Desktop，确认 daemon 正常。
2. 在仓库根目录执行 `docker ps`，查看容器是否随 Docker 自动恢复。
3. 如果容器未启动，执行 `docker compose up -d`。
4. 访问 `http://127.0.0.1:3001`，确认页面可打开。
5. 如需看日志，执行 `docker logs -f wechat-article-exporter`。

### 当前运行方式
- 访问地址：`http://127.0.0.1:3001`
- 容器名：`wechat-article-exporter`
- 启动命令：`docker compose up -d`
- 停止命令：`docker compose down`

### 当前已知限制
- 宿主机 `3000` 端口已被另一条本机 `node.exe` 进程占用，因此该项目改为使用 `3001`。
- 当前镜像未包含 Chromium，因此 `PDF` 导出相关接口大概率不可用。
- Docker 构建强依赖本机代理可用，之前出现过 `127.0.0.1:18080` 代理中断导致 `apt` / `yarn` 下载失败的问题。
- 宿主机上访问某些 HTTPS 站点时，曾出现 `schannel: SEC_E_NO_CREDENTIALS`。如果后续涉及 GitHub 或 npm 的 HTTPS 问题，需要优先怀疑代理和本机证书链设置。

### 后续建议任务
重启后如果要继续部署完善，建议按这个顺序推进：

1. 确认当前 `3001` 服务仍然正常可访问。
2. 决定是否要把 `Dockerfile` / `docker-compose.yml` / `.env` 提交到 Git。
3. 如果要恢复 PDF 导出，再补 Chromium 运行时依赖，并重新验证 `/api/web/pdf/generate`。
4. 如果想把端口改回 `3000`，先释放当前占用 `3000` 的本机 `node.exe`，再调整 `docker-compose.yml`。

### 恢复 PDF 导出的思路
- 优先方案：在 Docker 镜像中恢复 Chromium 与字体安装，并确认构建阶段网络稳定。
- 次优方案：如果容器内装 Chromium 仍然不稳定，可考虑改为挂载宿主机浏览器或改用单独的 PDF 服务，但这属于后续设计，不是当前已完成事项。

### 交接结论
当前主服务已经可用，最关键的基础部署问题已经解决。重启后只需要优先确认 Docker 与容器状态，再决定是否继续处理 PDF 导出与提交代码即可。

### 2026-05-28 四月区间导出补充记录（Asia/Shanghai）

#### 任务范围
- 时间窗口：`2026-04-01 00:00:00` 至 `2026-04-30 23:59:59`（`Asia/Shanghai`）。
- 账号范围：按系统内已同步的关注账号集合执行（历史操作口径为 233 个关注账号）。
- 数据源规则：严格使用 `wechat-article-exporter` 系统内已同步数据与缓存，不使用 `wechat-rss` / `we-mp-rss` / RSS 缓存。

#### 执行策略
- 采用“缓存优先（cache-first）+ 离线导出”方案：
  1. 先使用系统内 `snapshot` + `html` 缓存做主导出；
  2. 仅对缺失项做低速、低并发补抓；
  3. 使用 `source-index.json` 做 URL 去重与导出文件映射；
  4. 使用 `tools/reconcile_article_library_export_index.mjs` 对索引做补齐/修正。
- 为降低在线回退抓取风险，在 `server/utils/article-library-export.ts` 采用了保守节流参数：
  - `ARTICLE_CONCURRENCY = 1`
  - `REQUEST_DELAY_MS = 3500`
  - `ARTICLE_REQUEST_TIMEOUT_MS = 45000`
  - `ARTICLE_REQUEST_RETRY = 2`

#### 核验口径与结果
- 核验时间：`2026-05-28`。
- 口径 A（仅统计未删除文章，`is_deleted != true`）：
  - `total = 6263`
  - `covered = 6263`
  - `missing = 0`
- 口径 B（统计窗口内全部文章，含已删除）：
  - `total = 6732`
  - `covered = 6263`
  - `missing = 469`
- 说明：`6263/6263` 为当前“有效文章导出覆盖率”口径，符合本次四月增量导出闭环目标。

#### 产物与路径
- 主要离线导出包：
  - `data/exports/article-library/jobs/offline-cached-april-2026-v2/export.zip`
  - `data/exports/article-library/jobs/offline-cached-april-2026-missing92/export.zip`
- 历史导出包与后台任务产物统一位于：
  - `data/exports/article-library/jobs/`

### 2026-05-28 三月区间导出补充记录（Asia/Shanghai）

#### 任务范围
- 时间窗口：`2026-03-01 00:00:00` 至 `2026-03-31 23:59:59`（`Asia/Shanghai`）。
- 账号范围：按系统内已同步的关注账号集合执行。
- 数据源规则：严格使用 `wechat-article-exporter` 系统内 `snapshot.json`、正文缓存、导出缓存与 `source-index.json`，不使用 `wechat-rss` / `we-mp-rss` / RSS 缓存。

#### 本次排查与解决过程
1. 先沿用 4 月导出的同一条导出链路，继续以 `article-library` 为唯一导出通道。
2. 对 3 月区间先多次执行 `cached-only`，优先消化系统内已有正文缓存，避免无谓在线回退抓取。
3. 发现 `cached-only` 到后期出现明显边际递减：连续重跑后，新增导出数趋近于 `0`，说明剩余问题已不是大批量缓存待消费，而是尾部缺口。
4. 随后改用批量 `single` 精确补尾：
   - 已扩展 `server/api/tools/article-library/export-single.post.ts`
   - 接口从只支持 `{ url }` 扩展为同时支持 `{ url }` 与 `{ urls: string[] }`
   - 目的：把剩余未覆盖 URL 一次性作为单个批量任务送入后台 job，而不是逐条手工重复提交。
5. 先对剩余 `115` 个未覆盖 URL 提交批量 `single` 任务，任务完成结果：
   - Job ID：`be0afe0f844d4df9b7c658740c0f90e3`
   - `totalCandidates = 115`
   - `processedCandidates = 115`
   - `exportedCount = 115`
   - `failedCount = 0`
6. 在该批量补尾完成后，没有直接以“缓存缺口归零”作为完成依据，而是继续做严格覆盖审计：
   - 用 `snapshot.json` 重新计算 3 月候选文章集合
   - 过滤条件：`is_deleted != true`
   - 时间范围：`2026-03-01 00:00:00` 至 `2026-03-31 23:59:59`（`Asia/Shanghai`）
   - 使用文章字段 `link` 作为 URL 主键去重
   - 再与 `source-index.json.items[url].relativePath` 和实际文件存在性逐条对齐
7. 严格审计后发现仍有 `3` 篇真实缺口，且不是索引别名问题，也不是标题误匹配问题。缺失 URL 为：
   - `https://mp.weixin.qq.com/s/iqKBiLFy1RlTWcUIXOyBEg`
   - `https://mp.weixin.qq.com/s/Oh-20t6kTjeIQgVYQwXGFA`
   - `https://mp.weixin.qq.com/s/ZO3QueVXRfFHiFEEOOpb2w`
8. 对这 `3` 篇再次单独提交批量 `single` 任务，任务完成结果：
   - Job ID：`bfb537cfc21e44148614b8769c5531c4`
   - `exportedCount = 3`
   - `failedCount = 0`
9. 最终再次执行严格覆盖审计，确认 3 月区间有效文章已经全部导出完成。

#### 最终核验结果
- 3 月有效候选文章总数：`6308`
- 已覆盖：`6308`
- 缺失：`0`

补充核验：
- 上述最终结论不是仅靠 job 成功数判断，而是基于 `snapshot.json -> source-index.json -> 文件存在性` 的逐条核对结果。
- 末尾补齐的 `3` 篇文章已确认进入 `source-index.json` 且文件实际存在。
- 其中一条辅助统计口径为：按 `source-index.json` 中 `library/202603*/*.md` 统计，当前已索引且实际存在的 3 月文件数为 `6219`，索引指向缺失文件数为 `0`。

#### 本次可复用经验
- 对整月区间导出，不要只依赖“重复跑 `cached-only` 直到不再增长”的经验判断，必须在末尾补一轮严格覆盖审计。
- 当剩余缺口已经缩小到明确 URL 列表时，优先使用批量 `single` 而不是继续全量/半全量模式重跑。
- 审计时要注意 `snapshot.json` 中文章链接字段名是 `link`，不是 `url`。
- 真实完成判定应以 `snapshot` 候选集、`source-index.json` 映射和实际文件存在性三者同时成立为准。

#### 当前与后续建议
- 当前 2026 年 3 月区间导出已经完成，可作为重启后的稳定基线。
- 重启后如果继续推进 2026 年 2 月导出，建议直接复用本次 3 月流程：
  1. 先按 2 月时间窗口做 `cached-only` 主导出；
  2. 观察是否进入边际递减；
  3. 对剩余未覆盖 URL 改用批量 `single` 补尾；
  4. 最后必须执行 `snapshot -> source-index -> 文件存在性` 的严格覆盖审计；
  5. 不要仅凭 job 面板显示“导出成功”就判断整月闭环完成。

### 2026-05-31 1-3 月导出复盘（Asia/Shanghai）

#### 复盘范围
- 时间窗口：`2026-01-01 00:00:00` 至 `2026-03-31 23:59:59`（`Asia/Shanghai`）。
- 关注点：内容写入、导出链路、失败排查、尾部补救、最终审计。

#### 主要问题
- 1-2 月早期审计文件显示，导出覆盖率并不等于 job 成功数：
  - `total = 9443`
  - `covered = 10`
  - `missing = 9433`
  - `indexedButMissingFile = 0`
- 这批缺口主要表现为 `missing_index`，说明问题优先出在索引和覆盖面，而不是正文解析本身。
- 3 月区间在 `cached-only` 跑到后期后出现边际递减，说明主缓存已经消化完，剩余的是尾部缺口，不该继续全量重跑。

#### 排查方式
1. 先只用 `wechat-article-exporter` 系统内已同步的数据和缓存，不回退到 `wechat-rss` / `we-mp-rss`。
2. 用 `snapshot.json` 重新计算候选集，再和 `source-index.json`、实际文件存在性逐条对齐。
3. 以 `link` 作为文章主键去重，不用标题猜测覆盖率。
4. 对尾部缺口改用批量 `single`，避免重复扫大盘并降低微信侧风控压力。
5. 最终以 `snapshot -> source-index -> 文件存在性` 三重一致作为完成标准。

#### 解决方式
- 补齐了 `article-library` 导出链路，并把尾部补救拆成更细的后台任务。
- 新增 `failed-only` 模式，只重跑失败样本，不再重复消耗已跳过文章。
- 提高了在线回退抓取的稳定性参数：
  - `REQUEST_DELAY_MS` 增大
  - `ARTICLE_REQUEST_RETRY` 增加
- 在 3 月尾部补救后，最终确认有效文章覆盖率归零缺口。

#### 可复用结论
- 不能只看 job 成功，要看覆盖审计。
- `cached-only` 不再增长时，优先做尾部补齐，不要继续全量重跑。
- 任何需要在线回退的导出都要低频、低并发，避免触发微信风控。
- 任务状态不要频繁轮询，等用户明确询问再查。

### 2026-05-31 本机安全排查补充（元宝 / AweSun / Edge）

#### 触发背景
- 用户反馈：电脑重启后，本地“元宝”会被突然拉起，并出现查股票相关内容的现象。
- 本次排查目标：确认是仓库代码触发、浏览器恢复旧会话，还是远控软件/自启动项导致。

#### 已核实结论
- 当前仓库代码内未检出与“元宝”或“股票”直接相关的命名入口，至少没有明显的应用内触发链路。
- Windows 当前存在 Edge 开机自启项：
  - `MicrosoftEdgeAutoLaunch_2C23548C23FDA5866C387A38977FD8B4`
  - 命令：`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --no-startup-window --win-session-start`
- 公共桌面存在 `元宝.lnk`，其目标程序为：
  - `D:\Program Files\Tencent\Yuanbao\yuanbao.exe`
- 当前真正具备远程控制属性、且已确认配置为开机自启的软件是 `AweSun`：
  - 注册表位置：`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
  - 启动命令：`"C:\Program Files\Oray\AweSun\AweSun.exe" --cmd=autorun`

#### 本次现场观察
- 本次排查时未发现 `AweSun` 活动进程，也未发现 `yuanbao.exe` 正在运行。
- 未发现 `AweSun` 服务项常驻；目前看到的明确落点主要是注册表 `Run` 自启。
- 本地存在 `Oray` / `AweSun` 数据目录与 WebView 痕迹：
  - `C:\Users\zhouy\AppData\Roaming\Oray`
  - `C:\ProgramData\Oray`
  - `C:\ProgramData\OrayClient`
- 可读配置与 WebView 偏好文件中能看到 `sunlogin.oray.com` 与 `cc.sunlogin.oray.com` 的访问/站点参与痕迹，说明该软件在本机上至少被实际打开或登录过。
- 目前没有在可直接读取的本地配置中找到“无人值守密码”“自动接入密码”这类明确字段，因此暂时不能直接下结论说“当前已开启无人值守远控”。

#### 当前判断
- “元宝”本身更像普通本地客户端或桌面入口，不是天然的远控程序。
- 更值得警惕的高风险入口是 `AweSun`，因为它具备远程控制能力，且已配置为开机自启。
- 电脑重启后出现的异常拉起，较大概率至少与以下两类机制之一有关：
  1. `AweSun` 这类远控软件带来的人工远程操作可能性；
  2. Edge 自启动后恢复旧会话/旧标签页。
- 目前尚未拿到“就是 `AweSun` 远控后手动打开元宝查股票”的直接证据；现阶段结论应保持为“存在明显远控入口，需继续核验账号绑定、无人值守和历史连接记录”。

#### 后续建议
- 如果机器不再需要 `AweSun`，优先禁用其开机自启，并考虑直接卸载。
- 如果必须保留 `AweSun`，下一步应在应用内核验：
  - 是否已登录账号
  - 是否绑定当前设备
  - 是否开启无人值守访问
  - 是否存在历史远程连接记录
- 同时应检查 Edge 是否启用了“继续浏览上次的标签页/恢复会话”，避免把浏览器恢复误判为被远控操作。
#### 继续核验结果
- `元宝` 是独立安装的腾讯应用，不是 Oray 远控本体：
  - 版本：`2.69.0.622`
  - 安装目录：`D:\Program Files\Tencent\Yuanbao`
  - 卸载程序：`D:\Program Files\Tencent\Yuanbao\2.69.0.622\uninstall.exe`
- `Prefetch` 中存在 `YUANBAO.EXE-5ABA33E7.pf`，最后写入时间为 `2026-05-31 12:01:51`，说明 `yuanbao.exe` 在重启后的当天确实被执行过。
- Edge 历史中出现 `https://yb.tencent.com/s/mHSGy4wvmzoK`，标题为“智勇双全侯亮平和元宝的对话”，说明“元宝”相关网页内容也被实际打开过。
- 目前仍没有直接证明 `AweSun` 正在远控的证据，但它的开机自启和 Oray 访问痕迹仍然是最高优先级排查点。

#### AweSun 深挖结果
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` 里的 `AweSun` 自启项仍然存在，但其目标文件当前是死链：
  - 自启命令：`"C:\Program Files\Oray\AweSun\AweSun.exe" --cmd=autorun`
  - `C:\Program Files\Oray` 目录存在
  - `C:\Program Files\Oray\AweSun` 目录当前不存在
  - `C:\Program Files\Oray\AweSun\AweSun.exe` 当前不存在
- 这说明当前系统里至少残留了旧的远控自启配置，但该自启项现在未必还能成功拉起客户端。
- 尽管可执行文件当前缺失，`C:\ProgramData\Oray\Webview2\...` 的本地 WebView 会话里仍能读到明确的登录态残留：
  - `sunlogin.oray.com` / `cc.sunlogin.oray.com`
  - 客户端标识中出现 `sunloginRemoteClient`
  - 会话页 URL 中存在 `userid=115815482`
  - 同目录下还保留 `_token`、`_refresh_token`、`sessionId` 等字段痕迹
- 上述信息足以说明：这台机器此前确实登录和使用过 Oray / Sunlogin 远控客户端，而且不是纯匿名打开官网页。
- 目前更准确的状态判断应为：
  1. 机器上存在真实的 Sunlogin/AweSun 历史登录与客户端使用痕迹；
  2. 旧的开机自启项仍残留；
  3. 但当前 `AweSun.exe` 主程序疑似已被删除、迁移或卸载不完整，因此“今天是否仍能借该自启项直接远控拉起”需要和现行安装状态分开判断。

#### 已执行清理
- 已删除注册表残留的 `AweSun` 开机自启项：
  - `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run\AweSun`
- 回读确认后，`Run` 项里已不再存在 `AweSun`，`Win32_StartupCommand` 也不再返回 `AweSun/Oray/Sunlogin` 相关启动项。
- 当前仍保留的只是本地历史痕迹和缓存目录，不再是活跃的开机自启入口。

### 2026-05-31 时间窗导出脚本补充（Python / bat）

#### 背景
- 用户希望把 `2026.1-2026.5` 期间公众号文章导出的散落 Python 能力整理成一个固定脚本，后续可以直接通过 `.bat` 自定义时间范围来跑后台导出。

#### 本次新增脚本
- 已新增 Python 主脚本：
  - `tools/export_article_library_range.py`
- 已新增 Windows 包装脚本：
  - `tools/export_article_library_range.bat`

#### 脚本设计口径
- 直接复用当前 `article-library` 后台导出接口：
  - `POST /api/tools/article-library/export`
  - `GET /api/tools/article-library/export-status?id=...`
  - `GET /api/tools/article-library/export-download?id=...`
- 时间参数支持：
  - `YYYY-MM-DD`
  - `YYYY/MM/DD`
  - `YYYY.MM.DD`
  - `YYYY-MM`
  - `YYYY/MM`
  - `YYYY.MM`
  - `YYYY-MM-DD HH:mm:ss`
  - Unix 时间戳
- 默认行为：
  - 模式默认为 `full`
  - 默认自动做 `failed-only` 重试 3 次
  - 支持可选等待预抓取进程结束
  - 支持可选自动下载 zip

#### 已踩坑与修复
- 初版脚本曾误判“任务创建失败”，原因不是服务端拒绝，而是脚本把创建接口的返回结构读错了。
- 当前仓库里：
  - `POST /api/tools/article-library/export`
  - 实际返回的是 `job` 对象本身
  - 不是 `{ job: ... }`
- 因此脚本已修正为：
  - 兼容直接返回 job
  - 兼容 `{ job: ... }` 包装结构
  - 在 HTTP 4xx/5xx 时直接打印服务端错误正文，避免只看到模糊报错

#### 当前新增能力
- Python 脚本新增参数：
  - `--failure-log`
  - `--summary-log`
  - `--download-zip`
  - `--zip-output`
- 作用：
  - 最终仍有失败时，把失败样本单独写到失败日志
  - 干净完成后，把任务摘要落成 JSON
  - 如果下载 zip，明确打印 zip 落盘路径

#### bat 使用方式
- 最简调用：
  - `tools\export_article_library_range.bat 2026-01-01 2026-05-31`
- 带 zip / 失败日志 / 汇总日志的调用示例：
  - `tools\export_article_library_range.bat 2025-12-01 2025-12-31 full "" data\exports\article-library\downloads\2025-12.zip data\exports\article-library\logs\2025-12-failures.jsonl data\exports\article-library\logs\2025-12-summary.json`
- 参数顺序固定为：
  1. `START`
  2. `END`
  3. `MODE`
  4. `PREFETCH_PID`
  5. `ZIP_OUTPUT`
  6. `FAILURE_LOG`
  7. `SUMMARY_LOG`

#### 已验证结果
- 已通过：
  - `python -m py_compile tools/export_article_library_range.py`
  - `python tools/export_article_library_range.py --help`
- 用户实跑时，已确认脚本能够成功创建后台导出任务并打印实时状态：
  - 例如 `status=running processed=482/4896 skipped=450 failed=32`
- 说明当前脚本已接通后台任务链路，不再是“只能创建脚本、不能实际发任务”的状态。

### 2026-06-01 2025-12 区间导出实跑与重启交接

#### 本次实际执行命令
- 已实际执行：
  - `tools\export_article_library_range.bat 2025-12-01 2025-12-31 full "" data\exports\article-library\downloads\2025-12.zip data\exports\article-library\logs\2025-12-failures.jsonl data\exports\article-library\logs\2025-12-summary.json`

#### 这次实跑的关键结果
- 主任务 Job：
  - `22b95f4c1b5b4b31a939176f30ebe50b`
- 主任务最终结果：
  - `totalCandidates = 4896`
  - `exportedCount = 3961`
  - `skippedExistingCount = 889`
  - `failedCount = 46`
- 主任务生成的后台 zip：
  - `data/exports/article-library/jobs/22b95f4c1b5b4b31a939176f30ebe50b/export.zip`
- 随后脚本自动触发 `failed-only` 重跑：
  - Job：`e66fe0cff6364e9880729217aa44a501`
  - 结果：`processed = 20`、`exported = 20`、`failed = 0`
- 最终下载到本地的导出包：
  - `data/exports/article-library/downloads/2025-12.zip`
- 最终摘要文件：
  - `data/exports/article-library/logs/2025-12-summary.json`

#### 当前不能误判为“已全部补齐”
- 虽然 `failed-only` 重跑 `20/20` 全部成功，但这不等于最初 `46` 条失败已经全部清零。
- 当前已经确认补掉的是其中 `20` 条。
- 仍需继续关注的尾部缺口数量：
  - `26`

#### 为什么只补到了 20 条
- 根因不是新脚本又失效，而是这次主任务 `22b95f4c...` 生成于“完整失败日志能力”落地之前。
- 当时服务端仍只在 `job.json.failureSamples` 里保留最多 `20` 条失败样本。
- 因此紧接着触发的 `failed-only` 任务只能看到并重跑这 `20` 条，无法自动拿到原始 `46` 条的完整集合。

#### 本轮为此已经补上的代码能力
- `server/utils/article-library-export.ts`
  - 在线抓取时，已改为“先走代理，失败后自动直连再试”。
  - 已支持为每个导出 job 落完整失败清单：
    - `data/exports/article-library/jobs/<job_id>/failures.jsonl`
  - `failed-only` 已改为优先读取该完整失败日志，而不是只依赖 `failureSamples`。
- `tools/export_article_library_range.py`
  - 已补 `10061` / 超时等瞬时 API 连接错误的自动重试，避免脚本因为状态轮询短暂失败直接退出。
  - 当用户传入 `--failure-log` 时，脚本已改为优先复制 job 目录下的完整 `failures.jsonl`，不再只落 20 条样本。

#### 当前磁盘上相关文件的实际含义
- `data/exports/article-library/logs/2025-12-summary.json`
  - 当前记录的是最后一次 `failed-only` 任务 `e66fe0cff...` 的摘要，不是主任务 `22b95f4c...` 的全量摘要。
- `data/exports/article-library/logs/2025-12-failures.jsonl`
  - 当前这份文件仍是旧一轮失败样本落盘结果，只含 `20` 条，不代表本次主任务全部 `46` 条失败。

#### 重启后的优先续做建议
1. 先不要把当前状态误判成“2025-12 已零失败闭环”。
2. 优先基于当前已落地的新失败日志能力，再跑一轮 `2025-12` 区间导出。
3. 新一轮主任务如果仍有失败，应直接检查：
   - `data/exports/article-library/jobs/<new_job_id>/failures.jsonl`
4. 然后再跑 `failed-only`，此时应能基于完整失败集合继续补尾，而不是只重跑 20 条样本。
5. 最终完成判定不要只看 `failed-only 20/20`，而应看“主任务剩余失败总数是否被压到 0 或明确缩小到新的完整失败列表”。

#### 当前已确认可复用的命令
- 全量区间导出：
  - `tools\export_article_library_range.bat 2025-12-01 2025-12-31 full "" data\exports\article-library\downloads\2025-12.zip data\exports\article-library\logs\2025-12-failures.jsonl data\exports\article-library\logs\2025-12-summary.json`

### 2026-06-02 2025-12 区间导出最终闭环记录（Asia/Shanghai）

#### 本次继续工作的背景
- 电脑重启后继续处理 `2025-12-01 00:00:00` 至 `2025-12-31 23:59:59` 区间导出。
- 上一轮主任务 `22b95f4c1b5b4b31a939176f30ebe50b` 曾有 `failedCount = 46`。
- 旧版任务只在 `failureSamples` 中保留最多 `20` 条失败样本，因此后续 `failed-only` 只补掉了 `20` 条，不能代表 2025-12 已闭环。

#### 第一轮覆盖审计与 26 条补尾
- 先按严格口径从 `snapshot.json` 重新计算 2025-12 候选集，并与 `source-index.json` 和实际文件存在性对齐。
- 初始审计结果：
  - `total = 4896`
  - `covered = 4870`
  - `missingIndex = 26`
  - `indexedMissingFile = 0`
  - `missing = 26`
- 将这 `26` 条缺口作为批量 `single` 提交：
  - Job：`0e9a861e39f64518a652e43d16831e5e`
  - 结果：`processedCandidates = 26`、`exportedCount = 26`、`failedCount = 0`
- 之后普通覆盖审计归零：
  - `total = 4896`
  - `covered = 4896`
  - `missing = 0`

#### 发现并修复 source mismatch 隐性问题
- 普通覆盖审计归零后，又执行了更严格的 source 级审计：
  - 不只检查索引与文件存在；
  - 还读取每个 Markdown frontmatter 的 `source:`；
  - 要求 `source:` 必须等于该候选文章 URL。
- source 级审计发现隐藏问题：
  - `total = 4896`
  - `covered = 4817`
  - `sourceMismatch = 79`
  - `duplicateRelativePaths = 70`
  - `missing = 79`
- 这说明部分 URL 的 `source-index.json` 指向了已有 Markdown 文件，但该文件实际属于另一篇同名/近同名文章，不能算真实覆盖。
- 对这 `79` 条执行强制批量 `single`：
  - Job：`91c4cf742f46415cbe666c2e57801660`
  - 结果：`exportedCount = 58`、`failedCount = 21`
- 失败原因集中为在线抓取超时或 `fetch failed`，不是 Markdown 解析问题。

#### 代理问题定位与解决
- 排查发现本地 HTTP 代理端口 `127.0.0.1:18080` 当时没有监听。
- 容器环境配置走的是：
  - `HTTP_PROXY=http://host.docker.internal:18080`
  - `HTTPS_PROXY=http://host.docker.internal:18080`
  - `ALL_PROXY=http://host.docker.internal:18080`
- 备用 SOCKS 代理 `127.0.0.1:1080` 当时可用，进程为 `ssh.exe`。
- 为了不中断导出，临时新增并启动过一个 HTTP-to-SOCKS 桥接脚本：
  - `tmp/http_to_socks_proxy.mjs`
  - 监听：`127.0.0.1:18080`
  - 转发：`127.0.0.1:1080`
  - 当时进程：`node.exe`，PID `8648`
- 后续用户启动正式 `start-http-proxy-tunnel` 时，因该临时桥接占用 `18080`，出现：
  - `bind [127.0.0.1]:18080: Permission denied`
  - `channel_setup_fwd_listener_tcpip: cannot listen to port: 18080`
- 已按用户要求停止临时桥接进程：
  - `Stop-Process -Force -Id 8648`
- 用户随后确认本地正式 `18080` 代理服务已启动。
- 结论：以后如果正式 `18080` 代理已启动，不要再启动 `tmp/http_to_socks_proxy.mjs`；如果正式代理未启动但 `1080` SOCKS 可用，才临时使用该桥接。

#### 21 条尾部失败最终补齐
- 在代理链路恢复后，对剩余 `21` 条 source mismatch URL 再次执行批量 `single`：
  - Job：`6d31d55b98b2484893287cfd499d8ee3`
  - 结果：`processedCandidates = 21`、`exportedCount = 21`、`failedCount = 0`
- 最终 source 级审计结果：
  - `total = 4896`
  - `covered = 4896`
  - `missingIndex = 0`
  - `indexedMissingFile = 0`
  - `sourceMissing = 0`
  - `sourceMismatch = 0`
  - `duplicateRelativePaths = 0`
  - `missing = 0`
- 最终审计文件：
  - `data/exports/article-library/logs/2025-12-final-audit.json`

#### 最终整月 ZIP
- source 级审计归零后，重新执行 2025-12 `full` 导出以生成完整整月 ZIP：
  - Job：`91b0b60ab58c42b18be6c0f72aa03e83`
  - 结果：`processed = 4896`、`total = 4896`、`exported = 0`、`skipped = 4896`、`failed = 0`
- 最终下载包：
  - `data/exports/article-library/downloads/2025-12.zip`
- 最终摘要：
  - `data/exports/article-library/logs/2025-12-final-summary.json`
- ZIP 校验：
  - `totalEntries = 4934`
  - `markdownEntries = 4896`
  - `duplicateMarkdownPaths = 0`
  - `zipBytes = 49149876`
- 注意：ZIP 总条目数包含目录项，判断文章数时应看 `.md` 条目数，而不是 `totalEntries`。

#### 本次可复用经验
- 月度导出完成判定必须使用 `snapshot -> source-index -> 文件存在性 -> Markdown source:` 四层审计。
- 只看 job 的 `failedCount = 0` 或普通索引覆盖并不够；存在“索引指向了别的同名 Markdown 文件”的隐性误覆盖风险。
- 对明确 URL 缺口，优先使用批量 `single` 强制补尾。
- 如果 `single` 尾部突然批量 `fetch failed`，先检查 `127.0.0.1:18080` 是否真的在监听，再检查容器代理是否仍指向该端口。
- 如果正式 HTTP 代理未启动，但 `127.0.0.1:1080` SOCKS 隧道可用，可临时用 `tmp/http_to_socks_proxy.mjs` 桥接；正式代理启动后必须停掉该桥接，避免端口冲突。
