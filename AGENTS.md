# 仓库指南

## 项目结构与模块组织
本仓库是一个用于导出微信公众号文章数据的 Nuxt 3 应用。UI 路由位于 `pages/`，可复用的 Vue 组件位于 `components/`，共享的客户端逻辑位于 `composables/`、`store/` 和 `utils/`。服务端接口与后端辅助代码位于 `server/api/` 和 `server/utils/`。共享的渲染与解析代码位于 `shared/utils/`。静态文件放在 `public/`，设计资源放在 `assets/`，用于解析校验的 HTML 样例文件放在 `samples/`。类型声明统一放在 `types/`。

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
格式化由 `biome.json` 和 `.prettierrc` 强制约束：使用 2 个空格缩进、分号、JS/TS 中的单引号，以及 120 字符行宽。变量和函数优先使用 `camelCase`，Vue 组件文件名使用 `PascalCase`，例如 `ProxyMetrics.vue`；Nuxt/Nitro 路由命名遵循 `server/api/public/v1/article.get.ts` 这类形式。CSS/Tailwind 的改动应尽量靠近受影响的组件；如果属于全局样式，则放在 `style.css` 或相应配置文件中。

## 测试指南
当前没有统一的 `yarn test` 脚本。回归检查以样例驱动为主：解析与渲染相关的夹具文件位于 `test/` 和 `samples/`。当你新增解析或导出行为时，请在 `samples/` 中新增或更新具有代表性的样例文件，并让 `test/` 下的辅助脚本保持单一行为职责，命名风格参考现有的 `parse_cgi_data.ts` 或 `normalize_html.ts`。至少应在提交前通过 `yarn dev` 验证受影响的流程。

## 提交与 Pull Request 规范
近期提交历史中既有版本号提交（如 `2.3.17`、`update`），也有带范围的修复提交（如 `fix: ...`）。功能性改动请优先使用明确的提交标题，例如 `fix: handle missing article metadata` 或 `feat: add proxy metrics panel`，避免使用含义不明的 `update`。PR 应说明用户可见的变更内容，标注任何配置或 API 影响，关联相关 issue，并在涉及 UI 改动时附上截图。如果你修改了导出结果或解析行为，请说明验证过哪些样例或手工场景。

## 配置与安全提示
本地配置请从 `.env.example` 开始。不要提交真实凭据、Cookie 或代理密钥。`config/proxy.txt`、服务端抓取工具以及与登录相关的接口都属于敏感区域；若修改这些部分，请在 PR 中明确记录行为变化。
