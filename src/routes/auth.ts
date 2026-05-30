import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '../crypto';
import { getUserByUsername, getUser, updateUser, createUser, getBranding } from '../db';
import { generateApiKey, generateToken, nanoid, json, errorJson } from '../utils';
import { authMiddleware } from '../auth';
import type { AuthUser, Env } from '../types';

const authRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// POST /api/auth/login
authRoutes.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username: string = (body.username || '').trim().slice(0, 30);
  const password: string = body.password || '';
  if (!username || !password) return errorJson('用户名和密码不能为空');

  const db = c.env.DB;
  const user = await getUserByUsername(db, username);
  if (!user) return errorJson('用户名或密码错误', 401);

  if (!user.passwordHash) {
    user.passwordHash = await hashPassword(password);
    await updateUser(db, user.id, { passwordHash: user.passwordHash });
  } else {
    if (!await verifyPassword(password, user.passwordHash)) return errorJson('用户名或密码错误', 401);
  }

  const token = generateToken();
  await updateUser(db, user.id, { token });
  const isDefault = user.username === 'admin' && password === 'admin';
  return json({ message: '登录成功', token, user: { username: user.username, level: user.level }, defaultCreds: isDefault });
});

// POST /api/auth/logout
authRoutes.post('/auth/logout', authMiddleware, async (c) => {
  const u = c.get('user');
  if (u) await updateUser(c.env.DB, u.id, { token: null });
  return json({ message: '已注销' });
});

// POST /api/auth/register
authRoutes.post('/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username: string = (body.username || '').trim().slice(0, 30);
  const password: string = body.password || '';
  if (!username || !password) return errorJson('用户名和密码不能为空');

  const db = c.env.DB;
  if (!(await getBranding(db)).registrationEnabled) return errorJson('注册已关闭', 403);
  if (await getUserByUsername(db, username)) return errorJson('用户名已存在');

  const passwordHash = await hashPassword(password);
  const apiKey = generateApiKey();
  const newId = nanoid();
  await createUser(db, { id: newId, username, passwordHash, apiKey, token: null, level: 1, sessionVersion: 1, createdAt: Date.now() });
  const token = generateToken();
  await updateUser(db, newId, { token });
  return json({ message: '注册成功', token, user: { username, level: 1 } });
});

// POST /api/user/password + /api/user/credentials
async function handleCredentialChange(c: any): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const { oldPassword, newPassword, newUsername } = body as Record<string, string>;
  const nextUsername = (newUsername || '').trim();
  if (!oldPassword || !newPassword || !nextUsername) return errorJson('缺少必填项');

  const u = c.get('user') as AuthUser;
  const db = c.env.DB as Env['DB'];
  const dbUser = await getUser(db, u.id);
  if (!dbUser) return errorJson('用户不存在', 404);
  if (!dbUser.passwordHash || !await verifyPassword(oldPassword, dbUser.passwordHash)) return errorJson('原密码错误', 401);

  const dup = await getUserByUsername(db, nextUsername);
  if (dup && dup.id !== dbUser.id) return errorJson('用户名已存在');

  await updateUser(db, dbUser.id, { username: nextUsername.slice(0, 30), passwordHash: await hashPassword(newPassword), sessionVersion: (dbUser.sessionVersion || 1) + 1, token: null });
  return json({ message: '账号密码已更新，请重新登录', username: nextUsername.slice(0, 30) });
}

authRoutes.post('/user/password', authMiddleware, (c) => handleCredentialChange(c));
authRoutes.post('/user/credentials', authMiddleware, (c) => handleCredentialChange(c));

// GET /api/user/api-key
authRoutes.get('/user/api-key', authMiddleware, (c) => json({ apiKey: c.get('user').apiKey }));

// POST /api/user/regenerate-api-key
authRoutes.post('/api/user/regenerate-api-key', authMiddleware, async (c) => {
  const newKey = generateApiKey();
  await updateUser(c.env.DB, c.get('user').id, { apiKey: newKey });
  return json({ apiKey: newKey });
});

export default authRoutes;
