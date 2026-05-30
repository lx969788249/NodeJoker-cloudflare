import { ready, inspect, transform, collect } from '@standardagents/sip';
import type { R2Bucket } from '@cloudflare/workers-types';
import { PhotonImage, draw_text_with_border } from '@cf-wasm/photon/workerd';
import type { WatermarkConfig } from './db';

// @jsquash — lossy WebP encoding for Cloudflare Workers
import decodeJpeg, { init as initJpegDec } from '@jsquash/jpeg/decode';
import encodeWebp, { init as initWebpEnc } from '@jsquash/webp/encode';
// @ts-expect-error WASM binary imports
import JPEG_DEC_WASM from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
// @ts-expect-error WASM binary imports
import WEBP_ENC_WASM from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';

export interface ProcessOptions {
	width?: number;
	height?: number;
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 80;

// --- WASM init (once per isolate) ---
let _ready = false;
async function ensureReady() {
	if (_ready) return;
	await Promise.all([
		ready(),
		initJpegDec(JPEG_DEC_WASM),
		initWebpEnc(WEBP_ENC_WASM),
	]);
	_ready = true;
}

/** 上传：SIP 缩放 + @jsquash 有损 WebP 编码 */
export async function convertToWebp(
	inputBytes: Uint8Array,
	quality: number,
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
	try {
		await ensureReady();

		// SIP 流式解码+缩放 → JPEG (内存安全，任意大小)
		const { source } = await inspect(inputBytes);
		const encoded = transform(source, { quality: 92 }); // 高质量中间 JPEG
		const { data: jpegBytes, info } = await collect(encoded);
		const imgInfo = await info;

		// @jsquash JPEG 解码 → ImageData
		const imageData = await decodeJpeg(jpegBytes);

		// @jsquash WebP 有损编码（质量可控！）
		const webpBytes = await encodeWebp(imageData, { quality });
		return {
			data: new Uint8Array(webpBytes),
			width: imgInfo.width,
			height: imgInfo.height,
		};
	} catch {
		return null;
	}
}

/** 服务端缩放 → WebP (SIP + @jsquash) */
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

		// SIP 流式缩放 → JPEG
		const { source } = await inspect(inputBytes);
		const encoded = transform(source, {
			width: opts.width,
			height: opts.height,
			quality: 92,
		});
		const { data: jpegBytes } = await collect(encoded);

		// @jsquash JPEG → WebP
		const imageData = await decodeJpeg(jpegBytes);
		const webpBytes = await encodeWebp(imageData, { quality: opts.quality ?? DEFAULT_QUALITY });
		return { body: new Uint8Array(webpBytes), contentType: 'image/webp' };
	} catch {
		return null;
	}
}

/** 缩放 + 文字水印 → WebP */
export async function resizeWithWatermark(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
	wmConfig: WatermarkConfig,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const resized = await resizeImage(bucket, key, opts);
	if (!resized) return null;

	// Photon 加水印 (图片已缩放，内存安全)
	try {
		const image = PhotonImage.new_from_byteslice(resized.body);
		try {
			const fs = Math.min(200, Math.max(8, wmConfig.fontSize || 24));
			const imgW = image.get_width();
			const imgH = image.get_height();
			const textW = Math.floor(wmConfig.text.length * fs * 0.6);
			const padding = 20;

			let x: number, y: number;
			switch (wmConfig.position) {
				case 'tl': x = padding; y = padding + fs; break;
				case 'tr': x = imgW - textW - padding; y = padding + fs; break;
				case 'bl': x = padding; y = imgH - padding; break;
				case 'center': x = Math.floor((imgW - textW) / 2); y = Math.floor((imgH + fs) / 2); break;
				case 'br': default: x = imgW - textW - padding; y = imgH - padding; break;
			}

			draw_text_with_border(image, wmConfig.text, x, y, fs);
			const out = image.get_bytes_webp();
			return { body: out, contentType: 'image/webp' };
		} finally {
			image.free();
		}
	} catch {
		return resized;
	}
}
