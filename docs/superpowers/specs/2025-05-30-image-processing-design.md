# Image Processing Design

**Date:** 2025-05-30
**Status:** approved

## Overview

Add real-time image processing to `/uploads/*` route using @cf-wasm/photon WASM library on Cloudflare Workers. Supports dynamic resize, WebP conversion, and watermark overlay — all via URL query parameters.

## Constraints

- Must work on workers.dev (no Cloudflare Images paid service)
- Workers runtime: 128MB memory, 30s CPU (free tier)
- No Canvas API in Workers — watermark must be pre-rendered PNG uploaded by admin

## URL Parameters

| Param | Example | Description |
|-------|---------|-------------|
| `?w=` | `?w=400` | Resize to width (aspect-ratio preserved) |
| `?h=` | `?h=300` | Resize to height (aspect-ratio preserved) |
| `?f=` | `?f=webp` | Output format: `webp`, `jpeg`, `png` |
| `?q=` | `?q=80` | Quality 1-100 (default: 85) |
| `?wm=1` | `?wm=1` | Overlay watermark (only if global switch enabled) |

## Processing Pipeline

```
Request: /uploads/2025/05/abc123.jpg?w=400&f=webp&wm=1
  │
  ├─ 1. Parse query params
  ├─ 2. Fetch original from R2
  ├─ 3. If no params → return original directly (fast path, existing behavior)
  ├─ 4. Photon.decode() → Image
  ├─ 5. If w or h → Photon.resize()
  ├─ 6. If wm=1 and watermark enabled:
  │     ├─ Fetch watermark PNG from R2 (_system/watermark.png)
  │     └─ Photon.draw_image() to composite
  └─ 7. Photon.output(f, q) → Response bytes
       └─ Set Cache-Control: public, max-age=31536000, immutable
```

## Watermark Configuration

### Storage

- **D1**: `settings` table, key=`watermark`
  ```json
  {
    "enabled": true,
    "opacity": 0.5,
    "position": "br"
  }
  ```
- **R2**: Watermark image at `_system/watermark.png`

### Position values

`tl` (top-left), `tr` (top-right), `bl` (bottom-left), `br` (bottom-right), `center`

### API Routes

- `GET /api/settings/watermark` — read watermark config (public, used by frontend)
- `POST /api/settings/watermark` — update config (admin only)
- `POST /api/settings/watermark/upload` — upload watermark PNG (admin only)

## Frontend Changes

### Settings Page (`public/index.html`)

New "水印设置" section:
- Toggle: enable/disable watermark globally
- Select: position (top-left, top-right, bottom-left, bottom-right, center)
- Range: opacity (0-100%)
- File input: upload watermark PNG image

### Image Display (`public/assets/js/main.js`)

- Thumbnails: `img.url + '?w=400'`
- Preview/large view: `img.url + '?w=1200'`

## Cache Strategy

- Query params change URL → CDN caches each variant as separate resource
- `Cache-Control: public, max-age=31536000, immutable` on processed responses
- No custom cache key needed — URL is the natural cache key

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/image-processor.ts` | **New** | Photon processing pipeline (decode→resize→watermark→output) |
| `src/index.ts` | Modify | Rewrite `/uploads/*` route to handle query params |
| `src/routes/admin.ts` | Modify | Add watermark settings API routes |
| `src/db.ts` | Modify | Add `getWatermarkConfig` helper |
| `public/index.html` | Modify | Add watermark settings section to admin panel |
| `public/assets/js/main.js` | Modify | Use `?w=400` for thumbs, `?w=1200` for preview; watermark settings JS |

## Dependencies

- `@cf-wasm/photon` — v0.1.x, Rust image processing compiled to WASM

## Risk Mitigation

- **Memory**: Photon processes full images in memory. Workers have 128MB limit. Large images (>30MP) may OOM — add dimension check before processing, skip if too large.
- **CPU time**: Resize + watermark typically < 2s. But very large originals could spike. Cache-first: CDN layer absorbs repeated requests.
- **Cold start**: WASM module ~1.5MB. First request after deploy incurs WASM instantiation cost. Subsequent requests reuse warm instance.
