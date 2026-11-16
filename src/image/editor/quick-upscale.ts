/* Quick upscale: only the part of the picture the editor actually shows is sent to the upscaler.
 * The work is planned in document pixels from the current zoom, split into overlapping tiles, and
 * each result is feathered before it lands in one full-canvas layer. No new ComfyUI graph: the
 * existing upscale-image-esrgan capability is called once per tile. */
import {blankCanvas} from "./bitmaps";

export type QuickRect = {x: number; y: number; w: number; h: number};
export type QuickTile = {x: number; y: number; w: number; h: number; source: QuickRect; feather: number};

/** The document rectangle that is actually on screen, from the transformed canvas and its stage. */
export function visibleDocumentRect(
  canvas: {left: number; top: number; width: number; height: number},
  stage: {left: number; top: number; width: number; height: number},
  documentWidth: number,
  documentHeight: number,
): QuickRect | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  const left = Math.max(canvas.left, stage.left);
  const top = Math.max(canvas.top, stage.top);
  const right = Math.min(canvas.left + canvas.width, stage.left + stage.width);
  const bottom = Math.min(canvas.top + canvas.height, stage.top + stage.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const perX = documentWidth / canvas.width;
  const perY = documentHeight / canvas.height;
  const x = Math.max(0, Math.floor((left - canvas.left) * perX));
  const y = Math.max(0, Math.floor((top - canvas.top) * perY));
  const w = Math.min(documentWidth - x, Math.ceil((right - left) * perX));
  const h = Math.min(documentHeight - y, Math.ceil((bottom - top) * perY));
  return w > 0 && h > 0 ? {x, y, w, h} : null;
}

/**
 * Plan overlapping tiles for the visible rectangle. A tile aims at `screenPx` display pixels, so a
 * zoomed-in view gets small, detailed tiles and a zoomed-out view fewer, larger ones. The cap keeps
 * a single Quick upscale bounded; feather is the overlap that hides the tile seams.
 */
/** Detailed tiles cover this many document pixels per side. The detailed workflow redraws at about 2K
 *  whatever it gets, so a small tile costs as much as a big one: a 1024 px tile enlarged 2x fills that size,
 *  and a picture needs the fewest runs (a 2048x1157 picture: 4 tiles, not 12). */
export const DETAIL_TILE_PX = 1024;

export function planQuickTiles(
  visible: QuickRect,
  documentWidth: number,
  documentHeight: number,
  options: {screenPx: number; documentPerScreen: number; maxTiles?: number},
): QuickTile[] {
  const maxTiles = options.maxTiles ?? 24;
  let tile = Math.max(96, Math.round(options.screenPx * options.documentPerScreen));
  tile = Math.min(tile, Math.max(documentWidth, documentHeight));
  const count = (size: number) => Math.ceil(visible.w / size) * Math.ceil(visible.h / size);
  if (count(tile) > maxTiles) {
    tile = Math.max(96, Math.ceil(Math.sqrt((visible.w * visible.h) / maxTiles)));
  }
  const feather = Math.max(8, Math.min(64, Math.round(tile * 0.1)));
  /* Even rows and columns: as many as the tile size needs, then the visible area divided equally, so no
     thin leftover strip costs a whole run (1157 px high: two rows of 579, not 1024 and 133). */
  const stepX = Math.ceil(visible.w / Math.ceil(visible.w / tile)), stepY = Math.ceil(visible.h / Math.ceil(visible.h / tile));
  const tiles: QuickTile[] = [];
  for (let y = visible.y; y < visible.y + visible.h; y += stepY) {
    for (let x = visible.x; x < visible.x + visible.w; x += stepX) {
      const w = Math.min(stepX, documentWidth - x, visible.x + visible.w - x);
      const h = Math.min(stepY, documentHeight - y, visible.y + visible.h - y);
      if (w <= 0 || h <= 0) continue;
      /* Never send a pixel outside the part the user can see: the overlap is taken from the
         inside of the visible rectangle, never beyond its zoom level. */
      const sx = Math.max(visible.x, x - feather);
      const sy = Math.max(visible.y, y - feather);
      const ex = Math.min(visible.x + visible.w, x + w + feather);
      const ey = Math.min(visible.y + visible.h, y + h + feather);
      const source = {x: sx, y: sy, w: Math.max(1, ex - sx), h: Math.max(1, ey - sy)};
      tiles.push({x: source.x, y: source.y, w: source.w, h: source.h, source, feather});
    }
  }
  return tiles;
}

/** Fade a tile's four edges to transparent, so overlapping tiles and the untouched picture blend. */
export function featherTile(canvas: HTMLCanvasElement, feather: number) {
  const mask = blankCanvas(canvas.width, canvas.height);
  const ctx = mask.getContext("2d")!;
  const inset = Math.min(feather, Math.floor(Math.min(canvas.width, canvas.height) / 3));
  ctx.filter = `blur(${Math.max(1, inset)}px)`;
  ctx.fillStyle = "#fff";
  ctx.fillRect(inset, inset, Math.max(0, canvas.width - inset * 2), Math.max(0, canvas.height - inset * 2));
  const target = canvas.getContext("2d")!;
  target.globalCompositeOperation = "destination-in";
  target.drawImage(mask, 0, 0);
}

/* ── Fidelity guard ─────────────────────────────────────────────────────────────────────────────
 * A generative rebuild (Detailed mode) may invent: a plant on a plain backdrop, noise or dither in a flat
 * colour. Two maps from the ORIGINAL tile decide, per pixel, how much of the model's answer is kept:
 *  - detail: only where the original itself has texture (local contrast); flat areas keep the plain enlargement;
 *  - agreement: only where the model's answer, blurred, still looks like the original blurred; a new object or a
 *    changed colour patch differs at that coarse scale and is dropped.
 * Pure array maths (luminance in, weights out), so it is tested without a browser. */

/** Box-blurred copy of a w×h plane (radius in pixels, separable, edges clamped). */
export function blurPlane(plane: ArrayLike<number>, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius)), tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  if (!r) { for (let i = 0; i < w * h; i++) out[i] = plane[i]; return out; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0; for (let k = -r; k <= r; k++) sum += plane[y * w + Math.min(w - 1, Math.max(0, x + k))];
    tmp[y * w + x] = sum / (2 * r + 1);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0; for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
    out[y * w + x] = sum / (2 * r + 1);
  }
  return out;
}

const smoothstep = (edge0: number, edge1: number, value: number) => { const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

/** How much texture the original has around each pixel, 0 (flat) to 1 (textured): the local standard deviation
 *  of luminance (0..255) over a small window. Below ~3 levels a surface is flat; from ~12 it is clearly detailed. */
export function detailWeights(luma: ArrayLike<number>, w: number, h: number, radius = 2): Float32Array {
  const mean = blurPlane(luma, w, h, radius), square = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) square[i] = luma[i] * luma[i];
  const meanSquare = blurPlane(square, w, h, radius), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = smoothstep(3, 12, Math.sqrt(Math.max(0, meanSquare[i] - mean[i] * mean[i])));
  return out;
}

/** Whether the model's answer still matches the original at a coarse scale, 1 (same) to 0 (something new):
 *  both are blurred, and a difference over ~10 levels starts to drop the answer, over ~28 it is gone. */
export function agreementWeights(original: ArrayLike<number>, answer: ArrayLike<number>, w: number, h: number, radius = 3): Float32Array {
  const a = blurPlane(original, w, h, radius), b = blurPlane(answer, w, h, radius), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = 1 - smoothstep(10, 28, Math.abs(a[i] - b[i]));
  return out;
}

/** Share of a tile that has texture worth a model pass; under ~4 % the tile is skipped and simply enlarged. */
export function detailShare(weights: ArrayLike<number>): number {
  let textured = 0; for (let i = 0; i < weights.length; i++) if (weights[i] > 0.5) textured++;
  return weights.length ? textured / weights.length : 0;
}
export const MIN_DETAIL_SHARE = 0.04;

const lumaOf = (data: Uint8ClampedArray) => { const out = new Float32Array(data.length / 4); for (let i = 0; i < out.length; i++) out[i] = .2126 * data[i * 4] + .7152 * data[i * 4 + 1] + .0722 * data[i * 4 + 2]; return out; };

/** The original tile's detail weights (for the skip decision and the guard), from a canvas. */
export function tileDetail(source: HTMLCanvasElement): Float32Array {
  const ctx = source.getContext("2d", {willReadFrequently: true})!;
  return detailWeights(lumaOf(ctx.getImageData(0, 0, source.width, source.height).data), source.width, source.height);
}

/** Keep the model's answer only where the original has texture and the answer agrees with it; everywhere
 *  else the plain enlargement of the original. Returns the guarded patch at the answer's size. */
export function guardedPatch(source: HTMLCanvasElement, answer: HTMLCanvasElement, detail = tileDetail(source)): HTMLCanvasElement {
  const w = source.width, h = source.height;
  // The answer, brought down to the original's grid for the comparison.
  const small = blankCanvas(w, h); small.getContext("2d")!.drawImage(answer, 0, 0, w, h);
  const original = lumaOf(source.getContext("2d", {willReadFrequently: true})!.getImageData(0, 0, w, h).data);
  const rebuilt = lumaOf(small.getContext("2d", {willReadFrequently: true})!.getImageData(0, 0, w, h).data);
  const agree = agreementWeights(original, rebuilt, w, h);
  const keep = new Float32Array(w * h); for (let i = 0; i < w * h; i++) keep[i] = detail[i] * agree[i];
  const soft = blurPlane(keep, w, h, 1);
  // The weights as an alpha mask at the original's size, enlarged smoothly to the answer's size.
  const mask = blankCanvas(w, h), mctx = mask.getContext("2d")!, image = mctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { image.data[i * 4 + 3] = Math.round(255 * soft[i]); }
  mctx.putImageData(image, 0, 0);
  const kept = blankCanvas(answer.width, answer.height), kctx = kept.getContext("2d")!;
  kctx.drawImage(answer, 0, 0);
  kctx.globalCompositeOperation = "destination-in"; kctx.imageSmoothingQuality = "high"; kctx.drawImage(mask, 0, 0, answer.width, answer.height);
  const out = blankCanvas(answer.width, answer.height), octx = out.getContext("2d")!;
  octx.imageSmoothingQuality = "high"; octx.drawImage(source, 0, 0, answer.width, answer.height);
  octx.drawImage(kept, 0, 0);
  return out;
}
