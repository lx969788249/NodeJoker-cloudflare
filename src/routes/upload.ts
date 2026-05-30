import { Hono } from 'hono';
import type { R2Bucket } from '@cloudflare/workers-types';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon/workerd';
import { authMiddleware } from '../auth';
import { createImage, countTodayUploads, getCompressionConfig } from '../db';
import { nanoid, getTodayRange, getYearMonth, getBaseUrl, json, errorJson } from '../utils';
import type { AuthUser, Env } from '../types';
import type { ImageRecord } from '../db';

const uploadRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const DAILY_UPLOAD_LIMIT = 200;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif',
]);

// 不需要转 JPEG 的格式 (GIF 保留动画, AVIF 本身已现代)
const SKIP_JPEG_CONVERT = new Set(['image/gif', 'image/avif']);
// 超过此大小的文件跳过 Photon 转换 (高分辨率图片解码后可能 OOM)
const MAX_CONVERT_SIZE = 2 * 1024 * 1024; // 2MB

uploadRoutes.post('/upload', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const bucket = c.env.IMAGES as R2Bucket;

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return errorJson('无效的请求数据');

  const file = formData.get('image');
  if (!file || typeof file === 'string') return errorJson('缺少图片文件');

  const fileObj = file as unknown as { type: string; size: number; name: string; arrayBuffer(): Promise<ArrayBuffer> };
  if (!ALLOWED_MIME.has(fileObj.type)) return errorJson('不支持的文件类型');
  if (fileObj.size > MAX_FILE_SIZE) return errorJson('文件大小超过限制 (最大 100MB)', 413);

  const { start, end } = getTodayRange();
  if (await countTodayUploads(db, user.id, start, end) >= DAILY_UPLOAD_LIMIT) {
    return errorJson('已达到今日上传上限', 429);
  }

  const autoDelete = formData.get('autoDelete') === 'true';
  const deleteDays = autoDelete ? Math.min(365, Math.max(1, Number(formData.get('deleteDays')) || 30)) : null;

  const { year, month } = getYearMonth();
  const id = nanoid();
  const inputBuffer = await fileObj.arrayBuffer();

  // 上传时转 JPEG (大幅减小体积，>2MB 文件跳过以免 OOM)
  let finalBuffer: ArrayBuffer | Uint8Array = inputBuffer;
  let finalMime = fileObj.type;
  let finalExt: string;
  let finalSize = fileObj.size;
  let converted = false;

  if (!SKIP_JPEG_CONVERT.has(fileObj.type) && fileObj.size <= MAX_CONVERT_SIZE) {
    try {
      const compConfig = await getCompressionConfig(db);
      let image: PhotonImage | null = PhotonImage.new_from_byteslice(new Uint8Array(inputBuffer));
      try {
        const MAX_UPLOAD_DIM = 4000;
        if (image.get_width() > MAX_UPLOAD_DIM || image.get_height() > MAX_UPLOAD_DIM) {
          const ratio = Math.min(MAX_UPLOAD_DIM / image.get_width(), MAX_UPLOAD_DIM / image.get_height());
          const tw = Math.round(image.get_width() * ratio);
          const th = Math.round(image.get_height() * ratio);
          const resized = resize(image, tw, th, SamplingFilter.Lanczos3);
          image.free();
          image = resized;
        }
        const jpegBytes = image.get_bytes_jpeg(compConfig.quality);
        finalBuffer = jpegBytes;
        finalMime = 'image/jpeg';
        finalExt = 'jpg';
        finalSize = jpegBytes.length;
        converted = true;
      } finally {
        if (image) image.free();
      }
    } catch {
      // 转换失败 → 退回原格式
      const dotIdx = fileObj.name.lastIndexOf('.');
      finalExt = dotIdx > 0 ? fileObj.name.slice(dotIdx + 1).toLowerCase() || 'png' : 'png';
    }
  } else {
    const dotIdx = fileObj.name.lastIndexOf('.');
    finalExt = dotIdx > 0 ? fileObj.name.slice(dotIdx + 1).toLowerCase() || 'png' : 'png';
  }

  const filename = `${year}/${month}/${id}.${finalExt}`;
  await bucket.put(filename, finalBuffer, { httpMetadata: { contentType: finalMime } });

  const record: ImageRecord = {
    id, userId: user.id, filename, mime: finalMime,
    size: finalSize, width: null, height: null,
    createdAt: Date.now(), autoDelete: autoDelete ? 1 : 0, deleteAfterDays: deleteDays,
  };
  await createImage(db, record);

  const baseUrl = getBaseUrl(c.req.raw);
  const fileUrl = `${baseUrl}/uploads/${filename}`;
  return json({ id, url: fileUrl, size: finalSize, format: finalExt, converted, markdown: `![image](${fileUrl})`, html: `<img src="${fileUrl}" alt="image" />`, bbcode: `[img]${fileUrl}[/img]` });
});

export default uploadRoutes;
