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
  const tiles: QuickTile[] = [];
  for (let y = visible.y; y < visible.y + visible.h; y += tile) {
    for (let x = visible.x; x < visible.x + visible.w; x += tile) {
      const w = Math.min(tile, documentWidth - x);
      const h = Math.min(tile, documentHeight - y);
      if (w <= 0 || h <= 0) continue;
      const sx = Math.max(0, x - feather);
      const sy = Math.max(0, y - feather);
      const source = {
        x: sx,
        y: sy,
        w: Math.min(documentWidth - sx, w + (x - sx) + feather),
        h: Math.min(documentHeight - sy, h + (y - sy) + feather),
      };
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
