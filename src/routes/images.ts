import { Hono } from 'hono';
import type { R2Bucket } from '@cloudflare/workers-types';
import { authMiddleware } from '../auth';
import { listImagesByUser, deleteImagesByIds, deleteImageById } from '../db';
import { getBaseUrl, json, errorJson } from '../utils';
import type { AuthUser, Env } from '../types';

const imageRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// GET /api/images
imageRoutes.get('/images', authMiddleware, async (c) => {
  const user = c.get('user');
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(60, Math.max(1, Number(c.req.query('limit')) || 20));
  const { items, total } = await listImagesByUser(c.env.DB, user.id, (page - 1) * limit, limit);
  const baseUrl = getBaseUrl(c.req.raw);
  return json({
    items: items.map((img) => ({ ...img, url: `${baseUrl}/uploads/${img.filename}`, thumbUrl: `${baseUrl}/uploads/${img.filename}` })),
    total, totalPages: Math.max(1, Math.ceil(total / limit)), currentPage: page,
  });
});

// POST /api/images/delete
imageRoutes.post('/images/delete', authMiddleware, async (c) => {
  const user = c.get('user');
  const bucket = c.env.IMAGES as R2Bucket;
  const body = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return errorJson('缺少要删除的ID');

  const deleted = await deleteImagesByIds(c.env.DB, user.id, ids);
  for (const img of deleted) { try { await bucket.delete(img.filename); } catch { /* ignore */ } }
  return json({ message: '删除完成' });
});

// GET /api/v1/list
imageRoutes.get('/v1/list', authMiddleware, async (c) => {
  const user = c.get('user');
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50));
  const { items, total } = await listImagesByUser(c.env.DB, user.id, (page - 1) * limit, limit);
  const baseUrl = getBaseUrl(c.req.raw);
  return json({
    items: items.map((img) => ({
      id: img.id, url: `${baseUrl}/uploads/${img.filename}`, thumbUrl: `${baseUrl}/uploads/${img.filename}`,
      size: img.size, width: img.width, height: img.height, createdAt: img.createdAt,
    })),
    total, totalPages: Math.ceil(total / limit), currentPage: page,
  });
});

// DELETE /api/v1/delete/:id
imageRoutes.delete('/v1/delete/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const bucket = c.env.IMAGES as R2Bucket;
  const imgId = c.req.param('id') as string;
  const img = await deleteImageById(c.env.DB, user.id, imgId);
  if (!img) return errorJson('未找到图片', 404);
  try { await bucket.delete(img.filename); } catch { /* ignore */ }
  return json({ message: '删除成功' });
});

export default imageRoutes;
