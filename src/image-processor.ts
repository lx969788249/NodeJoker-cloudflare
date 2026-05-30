import { PhotonImage, resize, draw_text_with_border, SamplingFilter } from '@cf-wasm/photon/workerd';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { WatermarkConfig } from './db';

export interface ProcessOptions {
	width?: number;
	height?: number;
	format?: 'webp' | 'jpeg' | 'png';
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 85;
const MAX_DIMENSION = 4000;

/** 从 R2 取原图 → Photon 处理 → 返回字节 */
export async function processImage(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
	wmConfig: WatermarkConfig | null,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	const inputBytes = new Uint8Array(await object.arrayBuffer());
	let image: PhotonImage;

	try {
		image = PhotonImage.new_from_byteslice(inputBytes);
	} catch {
		return null;
	}

	try {
		// 超大图保护
		if (image.get_width() > 6000 || image.get_height() > 6000) {
			image.free();
			return null;
		}

		// --- 缩放 ---
		if (opts.width || opts.height) {
			const srcW = image.get_width();
			const srcH = image.get_height();

			let targetW: number, targetH: number;
			if (opts.width && opts.height) {
				targetW = Math.min(opts.width, MAX_DIMENSION);
				targetH = Math.min(opts.height, MAX_DIMENSION);
			} else if (opts.width) {
				targetW = Math.min(opts.width, MAX_DIMENSION);
				targetH = Math.round(srcH * (targetW / srcW));
			} else {
				targetH = Math.min(opts.height!, MAX_DIMENSION);
				targetW = Math.round(srcW * (targetH / srcH));
			}

			if (targetW !== srcW || targetH !== srcH) {
				const resized = resize(image, targetW, targetH, SamplingFilter.Lanczos3);
				image.free();
				image = resized;
			}
		}

		// --- 文字水印 ---
		if (opts.watermark && wmConfig?.enabled && wmConfig.text) {
			const fs = Math.min(200, Math.max(8, wmConfig.fontSize || 24));
			// 根据位置计算文字坐标
			const padding = 20;
			const imgW = image.get_width();
			const imgH = image.get_height();
			// 估算文字宽度: 每个字符约 font_size * 0.6
			const textW = Math.floor(wmConfig.text.length * fs * 0.6);
			const textH = fs;

			let x: number, y: number;
			switch (wmConfig.position) {
				case 'tl': x = padding; y = padding + textH; break;
				case 'tr': x = imgW - textW - padding; y = padding + textH; break;
				case 'bl': x = padding; y = imgH - padding; break;
				case 'center': x = Math.floor((imgW - textW) / 2); y = Math.floor((imgH + textH) / 2); break;
				case 'br': default: x = imgW - textW - padding; y = imgH - padding; break;
			}

			draw_text_with_border(image, wmConfig.text, x, y, fs);
		}

		// --- 编码输出 ---
		const fmt = opts.format ?? 'webp';
		let outputBytes: Uint8Array;
		let contentType: string;
		switch (fmt) {
			case 'jpeg':
				outputBytes = image.get_bytes_jpeg(opts.quality ?? DEFAULT_QUALITY);
				contentType = 'image/jpeg';
				break;
			case 'png':
				outputBytes = image.get_bytes();
				contentType = 'image/png';
				break;
			case 'webp':
			default:
				outputBytes = image.get_bytes_webp();
				contentType = 'image/webp';
				break;
		}

		return { body: outputBytes, contentType };
	} finally {
		image.free();
	}
}
