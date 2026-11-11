# 贴吧 Flare 插件

给 [Flare](https://github.com/DimensionDev/Flare) 用的百度贴吧适配器，基于 Social Plugin API v1。

## 功能

| Flare 能力 | 实现 |
| --- | --- |
| `timeline` | 贴吧热榜、推荐帖子、吧内帖子列表 |
| `tab-catalog` | 我关注的吧、推荐吧 |
| `post.detail` / `post.context` | 原生阅读帖子、楼层和楼中楼，支持图片、GIF 和可直接播放的视频 |
| `search` | 搜帖子和吧友，展示精确匹配的贴吧和发现页热词 |
| `profile` | 查看吧友资料，包含头像、昵称、简介和粉丝数（以贴吧返回为准） |
| Deep Links | 识别 `tieba.baidu.com/p/<tid>` 并在 Flare 内打开帖子 |

公开内容可以用游客身份阅读。登录时，Flare 在内置浏览器打开百度账号页，自动收集贴吧的会话 Cookie。插件会向贴吧确认登录状态和账号 ID，再接入我关注的吧。

## 安装

### 从 GitHub 安装

在 Flare 的插件管理里填入本仓库地址并点击 **Install**，确认权限后进入添加账号页，输入 `tieba.baidu.com`（不用带 `https://`），检测到「贴吧」后走浏览器登录。

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

- 热榜和搜索使用贴吧 Web JSON 接口。吧内列表和主题帖从移动网页版读取，后续楼层及楼中楼走对应的异步分页接口。
- 推荐和吧内列表使用紧凑卡片，显示头像、作者、来源吧、标题和回复数。打开帖子可查看完整正文及媒体。
- 帖子详情中的普通图片进入 Flare 原生媒体区域。贴吧相册能提供原始尺寸时使用其大图和尺寸，其他情况使用帖子页的图片。表情保留在正文内。
- 热榜话题在 Flare 内显示简介、封面和可翻页的相关讨论。相关帖子、搜索结果里的帖子、吧内列表和推荐帖子使用 Flare 原生详情。搜索命中的贴吧页通过网页打开。
- 发帖、回帖和通知暂未接入。贴吧 Web 接口属于非官方适配，网页结构或百度安全验证变化可能影响访问。

## 发布

仓库根目录提交 `src/`、`manifest.json`、`plugin.js`（已构建）、`assets/`、`locales/`、`package.json`、`package-lock.json`、`tsconfig.json`、`build.mjs` 和本 README，然后打与 `manifest.version` 一致的稳定 tag（例如 `v0.1.0`）。Flare 读取 tag 指向的仓库根目录。

```sh
npm run build
git tag v0.1.0
git push origin v0.1.0
```
