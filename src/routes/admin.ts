import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import type { R2Bucket } from '@cloudflare/workers-types';
import { authMiddleware, requireAdmin } from '../auth';
import { listUsers, getUser, updateUser, deleteUser, deleteImagesByIds, getBranding, getBackupConfig, setSetting, listImagesByUser } from '../db';
import { json, errorJson } from '../utils';
import type { AuthUser, Env } from '../types';

const adminRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// GET /api/admin/users
adminRoutes.get('/admin/users', authMiddleware, requireAdmin, async (c) => {
  const users = await listUsers(c.env.DB);
  return json({ users: users.map((u) => ({ id: u.id, username: u.username, level: u.level || 1, createdAt: u.createdAt })) });
});

// POST /api/admin/users/:id
adminRoutes.post('/admin/users/:id', authMiddleware, requireAdmin, async (c) => {
  const targetId = c.req.param('id') as string;
  const body = await c.req.json().catch(() => ({}));
  const target = await getUser(c.env.DB, targetId);
  if (!target) return errorJson('用户不存在', 404);

  const nextName = (body.username || '').trim();
  if (!nextName) return errorJson('用户名不能为空');

  const allUsers = await listUsers(c.env.DB);
  if (allUsers.find((u) => u.username === nextName && u.id !== target.id)) return errorJson('用户名已存在');

  let bumped = false;
  const updates: Record<string, unknown> = {};
  if (target.username !== nextName.slice(0, 30)) { updates.username = nextName.slice(0, 30); bumped = true; }
  if (body.password) { updates.passwordHash = await bcrypt.hash(body.password, 10); bumped = true; }
  if (bumped) { updates.sessionVersion = (target.sessionVersion || 1) + 1; updates.token = null; }
  if (Object.keys(updates).length > 0) await updateUser(c.env.DB, targetId, updates as Record<string, string | number | null>);

  return json({ message: '已更新用户' });
});

// DELETE /api/admin/users/:id
adminRoutes.delete('/admin/users/:id', authMiddleware, requireAdmin, async (c) => {
  const id = c.req.param('id') as string;
  if (id === 'admin') return errorJson('不可删除管理员');

  const bucket = c.env.IMAGES as R2Bucket;
  if (!await getUser(c.env.DB, id)) return errorJson('用户不存在', 404);

  // Delete user images from R2 in batches
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const { items } = await listImagesByUser(c.env.DB, id, offset, pageSize);
    if (items.length === 0) break;
    for (const img of items) { try { await bucket.delete(img.filename); } catch { /* ignore */ } }
    await deleteImagesByIds(c.env.DB, id, items.map((i) => i.id));
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  await deleteUser(c.env.DB, id);
  return json({ message: '已删除用户' });
});

// GET /api/settings/branding
adminRoutes.get('/settings/branding', async (c) => {
  const b = await getBranding(c.env.DB);
  return json({ name: b.name || 'Nodeimage', subtitle: b.subtitle || 'NodeSeek专用图床·克隆版', icon: b.icon || '', registrationEnabled: !!b.registrationEnabled });
});

// POST /api/settings/branding
adminRoutes.post('/settings/branding', authMiddleware, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const branding = { name: body.name || 'Nodeimage', subtitle: body.subtitle || 'NodeSeek专用图床·克隆版', icon: body.icon || '', registrationEnabled: body.registrationEnabled === true || body.registrationEnabled === 'true' };
  await setSetting(c.env.DB, 'branding', JSON.stringify(branding));
  return json({ message: '已更新图床设置', branding });
});

// GET /api/settings/backup
adminRoutes.get('/settings/backup', authMiddleware, requireAdmin, async (c) => {
  const config = await getBackupConfig(c.env.DB);
  config.s3AccessKey = config.s3AccessKey ? '***' + config.s3AccessKey.slice(-4) : '';
  config.s3SecretKey = config.s3SecretKey ? '***' : '';
  return json(config);
});

// POST /api/settings/backup
adminRoutes.post('/settings/backup', authMiddleware, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = await getBackupConfig(c.env.DB);
  const updated = {
    intervalHours: Math.max(1, Math.min(720, Number(body.intervalHours) || current.intervalHours)),
    keepCount: Math.max(1, Math.min(365, Number(body.keepCount) || current.keepCount)),
    s3Endpoint: body.s3Endpoint !== undefined ? String(body.s3Endpoint).trim() : current.s3Endpoint,
    s3Region: body.s3Region !== undefined ? String(body.s3Region).trim() : current.s3Region,
    s3Bucket: body.s3Bucket !== undefined ? String(body.s3Bucket).trim() : current.s3Bucket,
    s3AccessKey: body.s3AccessKey !== undefined ? String(body.s3AccessKey).trim() : current.s3AccessKey,
    s3SecretKey: body.s3SecretKey !== undefined ? String(body.s3SecretKey).trim() : current.s3SecretKey,
    webhookUrl: body.webhookUrl !== undefined ? String(body.webhookUrl).trim() : current.webhookUrl,
  };
  await setSetting(c.env.DB, 'backup', JSON.stringify(updated));
  const result = { ...updated, s3AccessKey: updated.s3AccessKey ? '***' + updated.s3AccessKey.slice(-4) : '', s3SecretKey: updated.s3SecretKey ? '***' : '' };
  return json({ message: '备份设置已更新', config: result });
});

// GET /api/stats
adminRoutes.get('/stats', async (c) => {
  const { getStats } = await import('../db');
  return json(await getStats(c.env.DB));
});

export default adminRoutes;
