import { PhotonImage, resize, watermark, SamplingFilter } from '@cf-wasm/photon/workerd';
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
		return null; // 图片损坏
	}

	try {
		// 超大图片保护：超过 6000px 直接拒绝处理
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
				const ratio = targetW / srcW;
				targetH = Math.round(srcH * ratio);
			} else {
				targetH = Math.min(opts.height!, MAX_DIMENSION);
				const ratio = targetH / srcH;
				targetW = Math.round(srcW * ratio);
			}

			if (targetW !== srcW || targetH !== srcH) {
				const resized = resize(image, targetW, targetH, SamplingFilter.Lanczos3);
				image.free();
				image = resized;
			}
		}

		// --- 水印 ---
		if (opts.watermark && wmConfig?.enabled) {
			const wmObject = await bucket.get('_system/watermark.png');
			if (wmObject) {
				const wmBytes = new Uint8Array(await wmObject.arrayBuffer());
				let wmImage: PhotonImage | null = null;
				try {
					wmImage = PhotonImage.new_from_byteslice(wmBytes);

					// 水印大小为原图宽度的 20%，最小 80px
					const wmWidth = Math.max(80, Math.floor(image.get_width() * 0.2));
					const wmRatio = wmWidth / wmImage.get_width();
					const wmHeight = Math.floor(wmImage.get_height() * wmRatio);

					if (wmWidth !== wmImage.get_width() || wmHeight !== wmImage.get_height()) {
						const wmResized = resize(wmImage, wmWidth, wmHeight, SamplingFilter.Lanczos3);
						wmImage.free();
						wmImage = wmResized;
					}

					const padding = 20;
					let x: number, y: number;
					switch (wmConfig.position) {
						case 'tl': x = padding; y = padding; break;
						case 'tr': x = image.get_width() - wmWidth - padding; y = padding; break;
						case 'bl': x = padding; y = image.get_height() - wmHeight - padding; break;
						case 'center': x = Math.floor((image.get_width() - wmWidth) / 2); y = Math.floor((image.get_height() - wmHeight) / 2); break;
						case 'br': default: x = image.get_width() - wmWidth - padding; y = image.get_height() - wmHeight - padding; break;
					}

					watermark(image, wmImage, BigInt(x), BigInt(y));
				} finally {
					if (wmImage) wmImage.free();
				}
			}
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
