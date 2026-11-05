# 贴吧 Flare 插件

给 [Flare](https://github.com/DimensionDev/Flare) 用的百度贴吧适配器，基于 Social Plugin API v1。

## 功能

| Flare 能力 | 实现 | 数据来源 |
| --- | --- | --- |
| `timeline` | 贴吧热议（默认时间线）、吧内帖子列表 | `/mo/q/hotMessage/list`、`/f?kw=` |
| `tab-catalog` | “我关注的吧 / 推荐吧”动态目录 | `/mg/o/getForumHome` |
| `post.detail` | 主题帖正文 | `/mo/q/m?kz=<tid>&pn=1` |
| `post.context` | 楼层（按页） | `/mo/q/m?kz=<tid>&pn=<n>` |

登录使用 `WebCookie`：在 Flare 内置浏览器打开贴吧并登录，Host 自动收集 `BDUSS`、`BAIDUID` 等 Cookie，再用 `/mo/q/newmoindex?need_user=1` 校验身份。

未实现：帖子/用户搜索、通知、发帖回帖、关注关系。Flare 的 `search` 能力要求五个方法全部实现，贴吧缺少对应的 discover 接口，因此首版不声明该能力。

## 安装

### 从 GitHub 安装

在 Flare 的插件管理里填入本仓库地址并点击 **Install**，确认权限后选择平台 `贴吧`，origin 填 `https://tieba.baidu.com`，然后走浏览器登录。

插件需要 `mediaNetwork` 权限，用于加载贴吧头像和帖子图片（`himg.bdimg.com`、`imgsrc.baidu.com`、`tiebapic.baidu.com` 等 CDN）。

### 本地开发

Flare Desktop：设置 → 插件 → 右上角菜单 → **Plugin development**，选择本目录（含 `manifest.json`、`plugin.js`、`assets/`）。

```sh
npm install
npm run dev      # 监听 src/plugin.ts，重建根目录 plugin.js
npm run check    # TypeScript 类型检查
npm run build    # 类型检查 + 构建
```

修改 `plugin.js`、`manifest.json`、`assets/icon.*` 或 `locales/*.json` 后，在 Flare 里点 **Reload plugin**。停止开发后再安装/更新同一插件。

## 实现说明

- 所有接口走 `https://tieba.baidu.com` 的 Web JSON 接口，不使用 `c.tieba.baidu.com` 的客户端签名接口，也不使用 protobuf（Flare 的 HTTP body 是 UTF-8 字符串，无法承载二进制）。
- 百度会对无 Cookie 或伪造 Cookie 的请求返回 403「百度安全验证」，所以游客模式不可用，必须登录。
- 帖子详情和楼层是服务端渲染 HTML，插件按 `li.j_post_list_item` 的 `data-info`（HTML 转义的 JSON）和 `div.content` 解析；楼层时间按北京时间（UTC+8）转为 ISO-8601。
- 时间线游标是帖子列表的绝对下标，按 30 条/页换算 `pn`；楼层游标是页码。

## 已知限制

- 楼层详情页最多回查 4 页；楼层分页最多 20 页。
- 贴吧页面结构变化可能导致解析失败，需要同步调整 `parseThreadPage`。
- 贴吧 Web 接口没有公开文档，属于非官方适配。

## 发布

仓库根目录提交 `src/`、`manifest.json`、`plugin.js`（已构建）、`assets/`、`locales/`、`package.json`、`package-lock.json`、`tsconfig.json`、`build.mjs` 和本 README，然后打与 `manifest.version` 一致的稳定 tag（例如 `v0.1.0`）。Flare 读取 tag 指向的仓库根目录。

```sh
npm run build
git tag v0.1.0
git push origin v0.1.0
```
