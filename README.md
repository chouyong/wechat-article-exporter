<p align="center">
  <img src="./assets/logo.svg" alt="Logo">
</p>

# wechat-article-exporter

![GitHub stars]
![GitHub forks]
![GitHub License]
![Package Version]


一款在线的 **微信公众号文章批量下载** 工具，支持导出阅读量与评论数据，无需搭建任何环境，可通过 [在线网站] 使用，同时也支持 docker 私有化部署和 Cloudflare 部署。

支持下载各种文件格式，其中 HTML 格式可100%还原文章排版与样式。

交流群(QQ):
- `991482155` 1群已满
- `775909845` 2群
- `814249342` 3群

## :bell: 重要告知：项目域名调整
项目域名调整如下：

|     | 下载站                            | 文档站                        |
|-----|--------------------------------|----------------------------|
| 调整后 | https://down.mptext.top        | https://docs.mptext.top    |
| 调整前 | https://exporter.wxdown.online | https://docs.wxdown.online |

具体细节可以查看 [这里](https://docs.mptext.top/misc/domain.html)。


## :books: 如何使用？

该工具的使用教程已移至 [文档站点](https://docs.mptext.top)。


## :dart: 特性

- [x] 搜索公众号，支持关键字搜索
- [x] 支持导出 html/json/excel/txt/md/docx 格式(html 格式打包了图片和样式文件，能够保证100%还原文章样式)
- [x] 缓存文章列表数据，减少接口请求次数
- [x] 支持文章过滤，包括作者、标题、发布时间、原创标识、所属合集等
- [x] 支持合集下载
- [x] 支持图片分享消息
- [x] 支持视频分享消息
- [x] 支持导出评论、评论回复、阅读量、转发量等数据 (需要抓包获取 credentials 信息，[查看操作步骤](https://docs.mptext.top/advanced/wxdown-service.html))
- [x] 支持 Docker 部署
- [x] 支持 Cloudflare 部署
- [x] 开放 API 接口


## :heart: 感谢

- 感谢 [Deno Deploy]、[Cloudflare Workers] 提供免费托管服务
- 感谢 [WeChat_Article] 项目提供原理思路


## :star: 支持

如果你觉得本项目帮助到了你，请给作者一个免费的 Star，感谢你的支持！


## :bulb: 原理

在公众号后台写文章时支持搜索其他公众号的文章功能，以此来实现抓取指定公众号所有文章的目的。

## :clipboard: 运维交接（2026-05-28）

以下记录用于本地持续导出任务的交接与复核，详细版本见 `AGENTS.md`。

- 时间窗口：`2026-04-01 00:00:00` 至 `2026-04-30 23:59:59`（`Asia/Shanghai`）。
- 数据源硬规则：账号与文章导出仅使用 `wechat-article-exporter` 系统内已同步数据与缓存；不使用 `wechat-rss`、`we-mp-rss`、RSS 缓存。
- 执行策略：采用 `cache-first`（优先本地 html/snapshot 缓存）+ 离线导出；仅对缺失项低速补抓，并用 `source-index.json` 去重与映射。
- 稳定性参数（`server/utils/article-library-export.ts`）：
  - `ARTICLE_CONCURRENCY = 1`
  - `REQUEST_DELAY_MS = 3500`
  - `ARTICLE_REQUEST_TIMEOUT_MS = 45000`
  - `ARTICLE_REQUEST_RETRY = 2`
- `2026-05-28` 核验结果：
  - 仅统计未删除文章（`is_deleted != true`）：`total=6263, covered=6263, missing=0`
  - 统计窗口内全部文章（含已删除）：`total=6732, covered=6263, missing=469`
- 主要产物路径：
  - `data/exports/article-library/jobs/offline-cached-april-2026-v2/export.zip`
  - `data/exports/article-library/jobs/offline-cached-april-2026-missing92/export.zip`

> 结论：按“有效文章（未删除）”口径，四月区间导出已闭环（`6263/6263`）。

如需查看 2026-01~03 的导出排查与修复复盘，请见 [导出复盘](./docs/export-postmortem-2026-01-to-03.md)。


## :memo: 许可

MIT

## :red_circle: 声明

本程序承诺，不会利用您扫码登录的公众号进行任何形式的私有爬虫，也就是说不存在把你的账号作为公共账号为别人爬取文章的行为，也不存在类似账号池的东西。

您的公众号只会服务于您自己的抓取文章的目的。

通过本程序获取的公众号文章内容，版权归文章原作者所有，请合理使用。若发现侵权行为，请联系我们处理。


## :chart_with_upwards_trend: Star 历史

[![Star History Chart]][Star History Chart Link]



<!-- Definitions -->

[GitHub stars]: https://img.shields.io/github/stars/wechat-article/wechat-article-exporter?style=social&label=Star&style=plastic

[GitHub forks]: https://img.shields.io/github/forks/wechat-article/wechat-article-exporter?style=social&label=Fork&style=plastic

[GitHub License]: https://img.shields.io/github/license/wechat-article/wechat-article-exporter?label=License

[Package Version]: https://img.shields.io/github/package-json/v/wechat-article/wechat-article-exporter


[Deno Deploy]: https://deno.com/deploy

[Cloudflare Workers]: https://workers.cloudflare.com

[Wechat_Article]: https://github.com/1061700625/WeChat_Article

[Star History Chart]: https://api.star-history.com/svg?repos=wechat-article/wechat-article-exporter&type=Timeline

[Star History Chart Link]: https://star-history.com/#wechat-article/wechat-article-exporter&Timeline

[在线网站]: https://down.mptext.top
