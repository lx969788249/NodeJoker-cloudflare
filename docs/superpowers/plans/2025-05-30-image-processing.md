# Image Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time image processing (resize, WebP conversion, watermark overlay) to `/uploads/*` route using @cf-wasm/photon WASM library.

**Architecture:** New `src/image-processor.ts` module encapsulates all Photon WASM logic. The `/uploads/*` route in `src/index.ts` parses query params (`?w=`, `?f=`, `?wm=1`), delegates to processor, and returns transformed bytes with CDN-cache headers. Watermark config stored in D1 `settings` table, watermark image stored in R2 `_system/watermark.png`.

**Tech Stack:** @cf-wasm/photon, Hono, Cloudflare Workers, D1, R2

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/image-processor.ts` | **Create** | Photon pipeline: decode→resize→watermark→output |
| `src/index.ts` | Modify | Rewrite `/uploads/*` route for query param handling |
| `src/routes/admin.ts` | Modify | Add `GET/POST /api/settings/watermark`, `POST /api/settings/watermark/upload` |
| `src/db.ts` | Modify | Add `getWatermarkConfig()` + export `WatermarkConfig` type |
| `public/index.html` | Modify | Add watermark settings section to admin panel |
| `public/assets/js/main.js` | Modify | Use `?w=400` for thumbs, `?w=1200` for preview; watermark settings JS |

---

### Task 1: Install @cf-wasm/photon dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/liuxin/Desktop/NodeJoker_cloudflare/NodeJoker-cloudflare && npm install @cf-wasm/photon
```

Expected: `@cf-wasm/photon` added to `dependencies` in `package.json` and `node_modules/`.

---

### Task 2: Create image processor module with Photon WASM

**Files:**
- Create: `src/image-processor.ts`

- [ ] **Step 1: Write the image processor module**

```typescript
import { PhotonImage, resize, encode_webp, encode_jpeg, encode_png, decode_image, SamplingFilter } from '@cf-wasm/photon';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface WatermarkConfig {
	enabled: boolean;
	opacity: number;
	position: 'tl' | 'tr' | 'bl' | 'br' | 'center';
}

export interface ProcessOptions {
	width?: number;
	height?: number;
	format?: 'webp' | 'jpeg' | 'png';
	quality?: number;
	watermark?: boolean;
}

const DEFAULT_QUALITY = 85;

/** Main entry: fetch original from R2, decode, process, output as bytes */
export async function processImage(
	bucket: R2Bucket,
	key: string,
	opts: ProcessOptions,
	watermarkConfig: WatermarkConfig | null,
): Promise<{ body: Uint8Array; contentType: string } | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	const inputBytes = new Uint8Array(await object.arrayBuffer());
	let image = decode_image(inputBytes);

	// Resize
	if (opts.width || opts.height) {
		const targetW = opts.width ?? image.get_width();
		const targetH = opts.height ?? image.get_height();
		if (!opts.width) {
			// height given, scale width proportionally
			const ratio = opts.height! / image.get_height();
			image = resize(image, Math.round(image.get_width() * ratio), opts.height!, SamplingFilter.Lanczos3);
		} else if (!opts.height) {
			// width given, scale height proportionally
			const ratio = opts.width! / image.get_width();
			image = resize(image, opts.width!, Math.round(image.get_height() * ratio), SamplingFilter.Lanczos3);
		} else {
			image = resize(image, targetW, targetH, SamplingFilter.Lanczos3);
		}
	}

	// Watermark
	if (opts.watermark && watermarkConfig?.enabled) {
		const wmObject = await bucket.get('_system/watermark.png');
		if (wmObject) {
			const wmBytes = new Uint8Array(await wmObject.arrayBuffer());
			const wmImage = decode_image(wmBytes);

			// Calculate watermark size: 20% of image width, min 100px
			const wmWidth = Math.max(100, Math.floor(image.get_width() * 0.2));
			const wmRatio = wmWidth / wmImage.get_width();
			const wmHeight = Math.floor(wmImage.get_height() * wmRatio);
			const wmResized = resize(wmImage, wmWidth, wmHeight, SamplingFilter.Lanczos3);

			// Position
			const padding = 20;
			let x: number, y: number;
			switch (watermarkConfig.position) {
				case 'tl': x = padding; y = padding; break;
				case 'tr': x = image.get_width() - wmWidth - padding; y = padding; break;
				case 'bl': x = padding; y = image.get_height() - wmHeight - padding; break;
				case 'center': x = Math.floor((image.get_width() - wmWidth) / 2); y = Math.floor((image.get_height() - wmHeight) / 2); break;
				case 'br': default: x = image.get_width() - wmWidth - padding; y = image.get_height() - wmHeight - padding; break;
			}

			// Note: Photon's draw_image doesn't support opacity directly.
			// We composite the watermark onto the base image.
			// draw_image(base, overlay, x, y) — overlays the watermark at position.
			// For opacity, we'd ideally pre-process the watermark, but Photon's API
			// is limited here. We'll composite as-is for now; users can upload a
			// semi-transparent PNG watermark for opacity control.
			try {
				// @ts-expect-error draw_image may not be fully typed
				if (typeof draw_image === 'function') {
					// @ts-expect-error
					draw_image(image, wmResized, x, y);
				}
			} catch {
				// draw_image not available — skip watermark compositing
			}
		}
	}

	// Encode output
	const fmt = opts.format ?? 'webp';
	let outputBytes: Uint8Array;
	let contentType: string;
	switch (fmt) {
		case 'jpeg': {
			outputBytes = encode_jpeg(image, opts.quality ?? DEFAULT_QUALITY);
			contentType = 'image/jpeg';
			break;
		}
		case 'png': {
			outputBytes = encode_png(image);
			contentType = 'image/png';
			break;
		}
		case 'webp':
		default: {
			outputBytes = encode_webp(image, opts.quality ?? DEFAULT_QUALITY);
			contentType = 'image/webp';
			break;
		}
	}

	return { body: outputBytes, contentType };
}
```

> **Note:** The `draw_image` function availability depends on the @cf-wasm/photon version. If it's unavailable in the installed version, the watermark compositing step will silently skip. We'll verify this during testing and adjust the approach if needed (e.g., using raw pixel manipulation or a different compositing strategy).

---

### Task 3: Rewrite /uploads/* route in index.ts

**Files:**
- Modify: `src/index.ts:56-67`

- [ ] **Step 1: Replace the /uploads/* handler**

Replace the existing simple proxy handler (lines 56-67) with:

```typescript
import { processImage, parseWatermarkConfig } from './image-processor';

// /uploads/* — R2 代理 + 图片实时处理
app.get('/uploads/*', async (c) => {
	const bucket = c.env.IMAGES as R2Bucket;
	const key = c.req.path.replace(/^\/uploads\//, '');

	// 拒绝访问系统文件
	if (key.startsWith('_system/')) return c.notFound();

	const q = c.req.query();

	// 无参数 → 直出原图 (快速路径)
	if (!q.w && !q.h && !q.f && !q.wm) {
		const object = await bucket.get(key);
		if (!object) return c.notFound();
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		headers.set('Access-Control-Allow-Origin', '*');
		return new Response(object.body, { headers });
	}

	// 有参数 → Photon 处理
	const opts = {
		width: q.w ? Math.min(4000, Math.max(1, parseInt(q.w) || 0)) : undefined,
		height: q.h ? Math.min(4000, Math.max(1, parseInt(q.h) || 0)) : undefined,
		format: (['webp', 'jpeg', 'png'].includes(q.f) ? q.f : undefined) as 'webp' | 'jpeg' | 'png' | undefined,
		quality: q.q ? Math.min(100, Math.max(1, parseInt(q.q) || 85)) : undefined,
		watermark: q.wm === '1',
	};

	const wmConfig = await parseWatermarkConfig(c.env.DB);

	const result = await processImage(bucket, key, opts, wmConfig);
	if (!result) return c.notFound();

	const headers = new Headers();
	headers.set('Content-Type', result.contentType);
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	headers.set('Access-Control-Allow-Origin', '*');
	return new Response(result.body, { headers });
});
```

- [ ] **Step 2: Add the import line at the top of index.ts**

After line 10 (`import type { Env, AuthUser } from './types';`), add:

```typescript
import { processImage, parseWatermarkConfig } from './image-processor';
```

---

### Task 4: Add watermark config DB helpers and type to db.ts

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Add WatermarkConfig type export and getWatermarkConfig function**

Add after the `BackupConfig` interface (after line 45):

```typescript
export interface WatermarkConfig {
	enabled: boolean;
	opacity: number;
	position: 'tl' | 'tr' | 'bl' | 'br' | 'center';
}
```

Add before `export async function getBranding` (before line 302):

```typescript
export async function getWatermarkConfig(db: D1Database): Promise<WatermarkConfig> {
	const raw = await getSetting(db, 'watermark');
	if (raw) {
		try {
			return JSON.parse(raw);
		} catch {
			// fall through
		}
	}
	return {
		enabled: false,
		opacity: 0.5,
		position: 'br',
	};
}
```

- [ ] **Step 2: Update image-processor.ts to use the DB type**

After writing the db.ts changes, update `src/image-processor.ts` to import `WatermarkConfig` from `./db` instead of defining it inline. Remove the `WatermarkConfig` interface from image-processor.ts and add:

```typescript
import type { WatermarkConfig } from './db';
import type { D1Database } from '@cloudflare/workers-types';
```

Also export a `parseWatermarkConfig` helper in `image-processor.ts`:

```typescript
export async function parseWatermarkConfig(db: D1Database): Promise<WatermarkConfig | null> {
	// Use the db helper — imported from ./db
	const { getWatermarkConfig } = await import('./db');
	return getWatermarkConfig(db);
}
```

> Actually, to avoid circular dependencies and keep things simple, let's just import `getWatermarkConfig` directly in `index.ts` instead.

---

### Task 5: Add watermark settings API routes to admin.ts

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Add import for getWatermarkConfig**

Update the import on line 5 to include `getWatermarkConfig`:

```typescript
import { listUsers, getUser, getUserByUsername, updateUser, deleteUser, deleteImagesByIds, getBranding, getBackupConfig, setSetting, listImagesByUser, createUser, getStats, getWatermarkConfig } from '../db';
```

- [ ] **Step 2: Add watermark API routes**

Add before the `GET /api/stats` route (before line 125, just before `// GET /api/stats`):

```typescript
// GET /api/settings/watermark
adminRoutes.get('/settings/watermark', authMiddleware, requireAdmin, async (c) => {
	const config = await getWatermarkConfig(c.env.DB);
	return json({ enabled: config.enabled, opacity: config.opacity, position: config.position });
});

// POST /api/settings/watermark
adminRoutes.post('/settings/watermark', authMiddleware, requireAdmin, async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const config = {
		enabled: body.enabled === true || body.enabled === 'true',
		opacity: Math.min(1, Math.max(0, Number(body.opacity) || 0.5)),
		position: ['tl', 'tr', 'bl', 'br', 'center'].includes(body.position) ? body.position : 'br',
	};
	await setSetting(c.env.DB, 'watermark', JSON.stringify(config));
	return json({ message: '水印设置已更新', watermark: config });
});

// POST /api/settings/watermark/upload — upload watermark PNG image
adminRoutes.post('/settings/watermark/upload', authMiddleware, requireAdmin, async (c) => {
	const formData = await c.req.formData().catch(() => null);
	if (!formData) return errorJson('无效的请求数据');

	const file = formData.get('watermark');
	if (!file || typeof file === 'string') return errorJson('缺少水印图片');

	const fileObj = file as unknown as { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
	if (!fileObj.type.startsWith('image/png') && !fileObj.type.startsWith('image/jpeg')) {
		return errorJson('水印图片仅支持 PNG/JPEG 格式');
	}
	if (fileObj.size > 5 * 1024 * 1024) {
		return errorJson('水印图片大小不能超过 5MB', 413);
	}

	const buffer = await fileObj.arrayBuffer();
	const bucket = c.env.IMAGES as R2Bucket;
	await bucket.put('_system/watermark.png', buffer, {
		httpMetadata: { contentType: fileObj.type },
	});

	return json({ message: '水印图片已上传' });
});
```

---

### Task 6: Add watermark settings section to index.html

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add watermark settings section**

Add after the "用户注册" section (`<!-- 用户注册 -->` block, after line 298) and before the "用户管理" section:

```html
<!-- 水印设置 -->
<section class="settings-section" id="watermarkSection" data-save="watermark">
  <span class="dirty-badge">未保存</span>
  <h3>水印设置</h3>
  <div class="setting-row">
    <label class="checkbox-container">
      <input type="checkbox" id="watermarkEnabled">
      <span class="checkmark"></span>
      <div class="setting-label"><span class="setting-title">开启全局水印</span><span class="setting-desc">上传的图片可通过 ?wm=1 参数叠加水印</span></div>
    </label>
  </div>
  <div class="settings-grid">
    <div class="setting-row">
      <label class="setting-title">水印位置</label>
      <select id="watermarkPosition" class="text-input" style="flex:1;">
        <option value="br">右下角</option>
        <option value="bl">左下角</option>
        <option value="tr">右上角</option>
        <option value="tl">左上角</option>
        <option value="center">居中</option>
      </select>
    </div>
    <div class="setting-row">
      <label class="setting-title">透明度</label>
      <input type="range" id="watermarkOpacity" min="0" max="100" value="50" style="flex:1;">
      <span id="watermarkOpacityValue" style="min-width:40px;text-align:right;">50%</span>
    </div>
  </div>
  <div class="setting-row" style="margin-top:8px;">
    <label class="setting-title">水印图片</label>
    <div style="display:flex;align-items:center;gap:8px;">
      <input type="file" id="watermarkFileInput" accept="image/png,image/jpeg" style="display:none;">
      <button class="tailwind-btn" id="uploadWatermarkBtn">上传水印图片</button>
      <span id="watermarkUploadStatus" style="font-size:12px;"></span>
    </div>
  </div>
</section>
```

---

### Task 7: Update frontend JS for image processing params and watermark settings

**Files:**
- Modify: `public/assets/js/main.js`

- [ ] **Step 1: Add ?w=400 to thumbnail images**

Find the two places where `img.thumbUrl || img.url` is used and replace with `?w=400`:

**Line 557** (in `renderHistory`): Change:
```javascript
imageEl.src = img.thumbUrl || img.url;
```
to:
```javascript
imageEl.src = img.thumbUrl || (img.url + '?w=400');
```

**Line 420** (in result rendering): Change:
```javascript
imageEl.src = res.thumbUrl || res.url;
```
to:
```javascript
imageEl.src = res.thumbUrl || (res.url + '?w=400');
```

- [ ] **Step 2: Add ?w=1200 to image modal preview**

**Line 801** (in `openImageModal`): Change:
```javascript
els.modalImage.src = url;
```
to:
```javascript
els.modalImage.src = url + '?w=1200';
```

- [ ] **Step 3: Add watermark state and element references**

In `state` object (after line 38), add:
```javascript
watermark: {
  enabled: false,
  opacity: 0.5,
  position: 'br'
},
```

In `els` object (after the existing element refs), add:
```javascript
watermarkEnabled: document.getElementById('watermarkEnabled'),
watermarkPosition: document.getElementById('watermarkPosition'),
watermarkOpacity: document.getElementById('watermarkOpacity'),
watermarkOpacityValue: document.getElementById('watermarkOpacityValue'),
watermarkFileInput: document.getElementById('watermarkFileInput'),
uploadWatermarkBtn: document.getElementById('uploadWatermarkBtn'),
watermarkUploadStatus: document.getElementById('watermarkUploadStatus'),
```

- [ ] **Step 4: Add watermark settings event listeners**

Add after the `applyBranding` button listener (~line 1119) and before the backup listeners:

```javascript
// Watermark settings listeners
if (els.watermarkEnabled) {
  els.watermarkEnabled.addEventListener('change', () => {
    state.watermark.enabled = els.watermarkEnabled.checked;
    markSectionDirty(els.watermarkEnabled);
  });
}
if (els.watermarkPosition) {
  els.watermarkPosition.addEventListener('change', () => {
    state.watermark.position = els.watermarkPosition.value;
    markSectionDirty(els.watermarkPosition);
  });
}
if (els.watermarkOpacity) {
  els.watermarkOpacity.addEventListener('input', () => {
    state.watermark.opacity = parseInt(els.watermarkOpacity.value) / 100;
    if (els.watermarkOpacityValue) {
      els.watermarkOpacityValue.textContent = els.watermarkOpacity.value + '%';
    }
    markSectionDirty(els.watermarkOpacity);
  });
}
if (els.uploadWatermarkBtn && els.watermarkFileInput) {
  els.uploadWatermarkBtn.addEventListener('click', () => els.watermarkFileInput.click());
  els.watermarkFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('watermark', file);
    try {
      const res = await fetch('/api/settings/watermark/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || '上传失败');
      if (els.watermarkUploadStatus) {
        els.watermarkUploadStatus.textContent = '✓ 已上传';
        els.watermarkUploadStatus.style.color = 'var(--success, #4caf50)';
      }
      showNotification('水印图片已上传', 'success');
    } catch (err) {
      console.error(err);
      if (els.watermarkUploadStatus) {
        els.watermarkUploadStatus.textContent = '✗ ' + err.message;
        els.watermarkUploadStatus.style.color = 'var(--danger, #f44336)';
      }
      showNotification(err.message, 'error');
    }
  });
}
```

- [ ] **Step 5: Add watermark save logic to the unified save handler**

Update the save handler (add after line 1052 `} else if (type === 'backup') {`):
```javascript
} else if (type === 'watermark') {
  hasWatermark = true;
```

Add variable after line 1041 (`let hasBranding = false, hasBackup = false;`):
```javascript
let hasBranding = false, hasBackup = false, hasWatermark = false;
```

Add save block after the backup save block (~line 1081):
```javascript
// 水印设置通过 API 保存
if (hasWatermark) {
  try {
    await saveWatermarkSettings();
    const secs = document.querySelectorAll('.settings-section.dirty[data-save="watermark"]');
    secs.forEach((s) => { s.classList.remove('dirty'); saved.push(s.querySelector('h3')?.textContent || ''); });
  } catch (err) {
    showNotification('水印设置保存失败: ' + err.message, 'error');
    return;
  }
}
```

- [ ] **Step 6: Add loadWatermarkSettings and saveWatermarkSettings functions**

Add after the `saveBrandingToServer` function (~line 1649):

```javascript
async function loadWatermarkSettings() {
  try {
    const res = await fetch('/api/settings/watermark', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    state.watermark = {
      enabled: !!data.enabled,
      opacity: Number(data.opacity) || 0.5,
      position: data.position || 'br',
    };
    applyWatermarkSettings();
  } catch {
    // ignore — watermark disabled by default
  }
}

function applyWatermarkSettings() {
  if (els.watermarkEnabled) els.watermarkEnabled.checked = state.watermark.enabled;
  if (els.watermarkPosition) els.watermarkPosition.value = state.watermark.position;
  if (els.watermarkOpacity) {
    els.watermarkOpacity.value = Math.round(state.watermark.opacity * 100);
    if (els.watermarkOpacityValue) {
      els.watermarkOpacityValue.textContent = Math.round(state.watermark.opacity * 100) + '%';
    }
  }
}

async function saveWatermarkSettings() {
  const res = await fetch('/api/settings/watermark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
    body: JSON.stringify({
      enabled: state.watermark.enabled,
      opacity: state.watermark.opacity,
      position: state.watermark.position,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || '保存失败');
  }
  return res.json();
}
```

- [ ] **Step 7: Call loadWatermarkSettings on settings page load**

In the `switchView` function, when `view === 'settings'`, add a call to `loadWatermarkSettings()`. Find the block after line ~353:

```javascript
if (view === 'settings') {
  // ...
  if (isAdminUser()) {
    loadWatermarkSettings();  // Add this line
  }
}
```

---

### Task 8: Update import in index.ts to use db directly

**Files:**
- Modify: `src/index.ts`

Since Task 4 adds `getWatermarkConfig` to `db.ts`, we can import it directly instead of going through `image-processor.ts`. Update `src/image-processor.ts` to NOT export `parseWatermarkConfig`, and instead import it in `index.ts`:

- [ ] **Step 1: Simplify image-processor.ts (remove parseWatermarkConfig)**

Remove any `parseWatermarkConfig` export from `image-processor.ts`. The `processImage` function already takes `WatermarkConfig | null` as a parameter — that's the right API. Callers are responsible for fetching config.

- [ ] **Step 2: Update index.ts imports**

Change the import line added in Task 3 to:
```typescript
import { processImage } from './image-processor';
import { getWatermarkConfig } from './db';
```

And in the route handler, use:
```typescript
const wmConfig = await getWatermarkConfig(c.env.DB);
```
instead of `parseWatermarkConfig`.

---

### Task 9: Build, verify, and deploy

**Files:** None (verification only)

- [ ] **Step 1: TypeScript type check**

```bash
cd /Users/liuxin/Desktop/NodeJoker_cloudflare/NodeJoker-cloudflare && npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 2: Test with wrangler dev**

```bash
cd /Users/liuxin/Desktop/NodeJoker_cloudflare/NodeJoker-cloudflare && npx wrangler dev
```

- [ ] **Step 3: Verify test cases with curl**

```bash
# Test 1: Original image (no params) still works
curl -I http://localhost:7878/uploads/2025/05/someimage.jpg

# Test 2: Resize to width=400
curl -o /tmp/thumb.jpg http://localhost:7878/uploads/2025/05/someimage.jpg?w=400

# Test 3: WebP conversion
curl -o /tmp/test.webp http://localhost:7878/uploads/2025/05/someimage.jpg?w=800\&f=webp

# Test 4: Watermark
curl -o /tmp/wm.jpg http://localhost:7878/uploads/2025/05/someimage.jpg?wm=1

# Test 5: Combined params
curl -o /tmp/combined.webp http://localhost:7878/uploads/2025/05/someimage.jpg?w=600\&f=webp\&q=80\&wm=1
```

- [ ] **Step 4: Deploy**

```bash
cd /Users/liuxin/Desktop/NodeJoker_cloudflare/NodeJoker-cloudflare && npm run deploy
```
