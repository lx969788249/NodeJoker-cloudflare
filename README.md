# Nodeimage Cloudflare 版

> Nodeimage 图床的 Cloudflare 重构版。Fork → `npm run deploy` → 完成。

## 一键部署

```bash
git clone <你的仓库>
cd nodeimage-cloudflare
npm install
npm run deploy
```

`wrangler deploy` 会自动创建 D1 数据库 + R2 存储桶 + 部署 Worker。

然后打开 Worker 域名，首次访问自动建表。

默认账号 **admin / admin**，登录后改密码。

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
