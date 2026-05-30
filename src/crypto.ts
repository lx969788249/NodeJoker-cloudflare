// Workers 兼容的密码哈希（Web Crypto PBKDF2，替代 bcryptjs）
// bcryptjs 依赖 Node crypto 模块，Workers 不支持

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pbkdf2(password: string, salt: string, iterations = 100000, keyLen = 32): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
    key,
    keyLen * 8
  );
}

function bufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomUUID();
  const hash = await pbkdf2(password, salt);
  return `${salt}:${bufferToHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = await pbkdf2(password, salt);
  return bufferToHex(derived) === hash;
}
