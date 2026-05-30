# Nodeimage Cloudflare 版

> Nodeimage 图床的 Cloudflare 重构版。纯浏览器操作，不用打开终端。

## 部署

**1. Fork 本仓库**

**2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com)** → Workers & Pages → 创建 → Workers → Connect to Git → 选你 Fork 的仓库

**3. 配置部署命令**：

| 设置 | 值 |
|------|-----|
| Build command | （留空） |
| Deploy command | `npm run deploy` |

**4. 保存并部署** — Cloudflare 自动创建 D1 + R2 + Worker。

之后每次 push 自动部署。首次访问自动建表，默认账号 **admin / admin**。

> 也可以命令行部署：`npm install && npm run deploy`

## 本地开发

```bash
npm install
npm run dev      # → http://localhost:7878
```

## 与原版差异

| 功能 | 原版 | Cloudflare 版 |
|------|------|---------------|
| WebP 压缩 | ✅ sharp | ❌ 移除 |
| EXIF 旋转 | ✅ sharp | ❌ 移除 |
| 水印 | ✅ sharp | ❌ 移除 |
| 缩略图 | ✅ sharp | 前端 CSS 缩放 |
| 认证 | Session Cookie | Bearer Token |
| 数据库 | SQLite 文件 | D1（分布式 SQLite） |
| 文件存储 | 本地磁盘 | R2（全球对象存储） |
