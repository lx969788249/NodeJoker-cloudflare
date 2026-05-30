import { Hono } from 'hono';
import { authMiddleware, requireAdmin } from '../auth';
import { getBackupConfig } from '../db';
import { json, errorJson } from '../utils';
import { readSqlite } from '../sqlite-reader';
import { TarGzReader } from '../tar';
import type { AuthUser, Env } from '../types';

const backupRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// GET /api/backup — export DB as JSON download
backupRoutes.get('/backup', authMiddleware, requireAdmin, async (c) => {
  const db = c.env.DB;
  const users = await db.prepare('SELECT * FROM users').all();
  const images = await db.prepare('SELECT * FROM images').all();
  const settings = await db.prepare('SELECT * FROM settings').all();

  const dbDump = JSON.stringify({ users: users.results, images: images.results, settings: settings.results, exportedAt: new Date().toISOString() }, null, 2);
  return new Response(dbDump, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="nodeimage-backup-${Date.now()}.json"` },
  });
});

// POST /api/backup/restore — 支持 JSON 和旧版 tar.gz 备份
backupRoutes.post('/backup/restore', authMiddleware, requireAdmin, async (c) => {
  const db = c.env.DB;
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return errorJson('无效的请求数据');

  const file = formData.get('backup');
  if (!file || typeof file === 'string') return errorJson('缺少备份文件');

  const fileObj = file as unknown as { name?: string; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };

  try {
    let data: { users: Record<string, unknown>[]; images: Record<string, unknown>[]; settings: Record<string, unknown>[] };

    const fname = (fileObj.name || '').toLowerCase();

    if (fname.endsWith('.tar.gz') || fname.endsWith('.tgz')) {
      // 旧版 tar.gz 备份 → 提取 db.sqlite → 解析
      const tarGzBuf = new Uint8Array(await fileObj.arrayBuffer());
      const reader = new TarGzReader();
      await reader.load(tarGzBuf);

      const sqliteBuf = reader.getFile('data/db.sqlite');
      if (!sqliteBuf) return errorJson('备份中未找到 data/db.sqlite');

      const raw = readSqlite(sqliteBuf);
      data = {
        users: raw.users,
        images: raw.images.map(({ thumbName, ...rest }: Record<string, unknown>) => rest),
        settings: raw.settings,
      };
    } else {
      // JSON 备份
      const text = await fileObj.text();
      data = JSON.parse(text);
    }

    if (!data.users || !data.images || !data.settings) return errorJson('无效的备份文件格式');

    await db.exec('DELETE FROM users');
    for (const u of data.users) {
      await db.prepare('INSERT INTO users (id, username, passwordHash, apiKey, token, level, sessionVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(u.id as string, u.username as string, (u.passwordHash as string) ?? null, (u.apiKey as string) ?? '', (u.token as string) ?? null, (u.level as number) ?? 1, (u.sessionVersion as number) ?? 1, (u.createdAt as number) ?? Date.now()).run();
    }
    await db.exec('DELETE FROM images');
    for (const img of data.images) {
      await db.prepare('INSERT INTO images (id, userId, filename, mime, size, width, height, createdAt, autoDelete, deleteAfterDays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(img.id as string, img.userId as string, img.filename as string, (img.mime as string) || '', (img.size as number) || 0, (img.width as number) ?? null, (img.height as number) ?? null, (img.createdAt as number) ?? Date.now(), (img.autoDelete as number) ?? 0, (img.deleteAfterDays as number) ?? null).run();
    }
    await db.exec('DELETE FROM settings');
    for (const s of data.settings) {
      await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(s.key as string, s.value as string).run();
    }
    return json({ message: '备份已恢复' });
  } catch (err: unknown) {
    return errorJson('恢复失败: ' + (err instanceof Error ? err.message : '未知错误'), 500);
  }
});

// GET /api/backup/status
backupRoutes.get('/backup/status', authMiddleware, requireAdmin, async (c) => {
  const config = await getBackupConfig(c.env.DB);
  return json({
    s3: { configured: !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey), endpoint: config.s3Endpoint || null, bucket: config.s3Bucket || null },
    webhook: { configured: !!config.webhookUrl, url: config.webhookUrl || null },
    intervalHours: config.intervalHours, keepCount: config.keepCount,
  });
});

export default backupRoutes;
