import { ready, inspect, transform, collect } from '@standardagents/sip';
import type { R2Bucket } from '@cloudflare/workers-types';
import { PhotonImage, draw_text_with_border } from '@cf-wasm/photon/workerd';
import type { WatermarkConfig } from './db';

export interface ProcessOptions {
	width?: number;
	height?: number;
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 85;
let sipReady = false;
async function ensureReady() {
	if (!sipReady) { await ready(); sipReady = true; }
}

/** 上传时用 SIP 转 JPEG — 任意大小图片都行，内存 ~50KB */
export async function convertToJpeg(
	inputBytes: Uint8Array,
	quality: number,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	try {
		await ensureReady();
		const { source } = await inspect(inputBytes);
		const encoded = transform(source, { quality });
		const { data, info } = await collect(encoded);
		const imgInfo = await info;
		return { data: new Uint8Array(data), width: imgInfo.width, height: imgInfo.height };
	} catch {
		return null;
	}
}

/** 服务端缩放 — SIP 流式处理，支持 ?w= ?h= ?q= */
export async function resizeImage(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		await ensureReady();
		const inputBytes = new Uint8Array(await object.arrayBuffer());
		const { source } = await inspect(inputBytes);
		const encoded = transform(source, {
			width: opts.width,
			height: opts.height,
			quality: opts.quality ?? DEFAULT_QUALITY,
		});
		const { data } = await collect(encoded);
		return { body: new Uint8Array(data), contentType: 'image/jpeg' };
	} catch {
		return null;
	}
}

/** 服务端缩放 + 文字水印 — SIP 缩放后 Photon 加文字 */
export async function resizeWithWatermark(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
	wmConfig: WatermarkConfig,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	// 1. SIP 缩放
	const resized = await resizeImage(bucket, key, opts);
	if (!resized) return null;

	// 2. Photon 加文字水印 (此时图片已缩放，内存安全)
	try {
		const image = PhotonImage.new_from_byteslice(resized.body);
		try {
			const fs = Math.min(200, Math.max(8, wmConfig.fontSize || 24));
			const imgW = image.get_width();
			const imgH = image.get_height();
			const textW = Math.floor(wmConfig.text.length * fs * 0.6);
			const textH = fs;
			const padding = 20;

			let x: number, y: number;
			switch (wmConfig.position) {
				case 'tl': x = padding; y = padding + textH; break;
				case 'tr': x = imgW - textW - padding; y = padding + textH; break;
				case 'bl': x = padding; y = imgH - padding; break;
				case 'center': x = Math.floor((imgW - textW) / 2); y = Math.floor((imgH + textH) / 2); break;
				case 'br': default: x = imgW - textW - padding; y = imgH - padding; break;
			}

			draw_text_with_border(image, wmConfig.text, x, y, fs);
			const outputBytes = image.get_bytes_jpeg(opts.quality ?? DEFAULT_QUALITY);
			return { body: outputBytes, contentType: 'image/jpeg' };
		} finally {
			image.free();
		}
	} catch {
		// 加水印失败 → 返回缩放后的图
		return resized;
	}
}
