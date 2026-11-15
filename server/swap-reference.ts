/* Swap a thing: the reference picture made from the clip itself (DOC-2191,), never from the whole clip.
   - frame: one still at a position of the clip, grabbed by seeking (FFmpeg -ss before -i, no full decode), cached per
     clip, its bytes and the position, so asking again costs nothing.
   - crop:  a SAM 3.1 mask of that still says whether the thing is in it and where; the still is cut to that box (with
     a margin). No white in the mask means "not in this frame", and the caller tries the next position.
   Both files are working files (metadata.intermediate), so they stay out of the Library. */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import path from "node:path";
import {Readable} from "node:stream";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import sharp from "sharp";
import {z} from "zod";
import {member,HttpError} from "./auth";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {SELF_CONTAINED_DEMUXERS} from "./export-profiles";

/** FFmpeg and ffprobe read only the stored file itself: local files and self-contained containers, nothing remote. */
const SAFE_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", SELF_CONTAINED_DEMUXERS];

const execute = promisify(execFile);
export {FRAME_POSITIONS} from "../src/capabilities/swap-frames";
/** A mask with less white than this share of the frame finds nothing usable. */
export const MIN_MASK_SHARE = 0.001;
/** Margin around the found thing, as a share of its box, so the edit sees a little of its surroundings. */
export const CROP_MARGIN = 0.12;

type Box = {left: number; top: number; width: number; height: number};
/** The box of white pixels in a grey mask (values 0–255, row by row), or undefined when there is too little white. */
export function maskBox(pixels: Uint8Array | Buffer, width: number, height: number, minShare = MIN_MASK_SHARE): Box | undefined {
  let minX = width, minY = height, maxX = -1, maxY = -1, white = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[y * width + x] > 127) { white += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0 || white < width * height * minShare) return undefined;
  return {left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1};
}
/** The box grown by the margin, scaled from the mask's size to the picture's, kept inside the picture. */
export function cropBox(box: Box, mask: {width: number; height: number}, image: {width: number; height: number}, margin = CROP_MARGIN): Box {
  const sx = image.width / mask.width, sy = image.height / mask.height;
  const padX = box.width * margin, padY = box.height * margin;
  const left = Math.max(0, Math.floor((box.left - padX) * sx)), top = Math.max(0, Math.floor((box.top - padY) * sy));
  const right = Math.min(image.width, Math.ceil((box.left + box.width + padX) * sx)), bottom = Math.min(image.height, Math.ceil((box.top + box.height + padY) * sy));
  return {left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top)};
}

async function asset(pool: Pool, workspaceId: string, projectId: string, id: string) {
  return (await pool.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3", [workspaceId, projectId, id])).rows[0];
}
async function savePng(pool: Pool, store: DiskStore, row: {workspaceId: string; projectId: string; userId: string; parentId: string; name: string; png: Buffer; metadata: Record<string, unknown>}) {
  const saved = await store.put(row.workspaceId, Readable.from(row.png));
  const facts = await sharp(row.png).metadata();
  return (await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'image','image/png',$5,$6,$7,$8,$9,$10) RETURNING *",
    [newId(), row.workspaceId, row.projectId, row.name, saved.key, saved.sha256, saved.bytes, row.userId, row.parentId, JSON.stringify({intermediate: true, width: facts.width, height: facts.height, ...row.metadata})])).rows[0];
}
const durationOf = async (file: string) => {
  const {stdout} = await execute(process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", ...SAFE_INPUT, "-show_entries", "format=duration", "-of", "csv=p=0", file], {timeout: 15000});
  const seconds = Number(String(stdout).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

export async function swapReferenceRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  const base = "/api/v1/workspaces/:workspaceId/swap-reference";

  app.post(`${base}/frame`, async request => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params), user = await member(pool, request, workspaceId, "creator");
    const body = z.object({projectId: z.uuid(), assetId: z.uuid(), at: z.number().min(0).max(0.95)}).strict().parse(request.body);
    const source = await asset(pool, workspaceId, body.projectId, body.assetId);
    if (!source || source.media_type !== "video") throw new HttpError(404, "Source video not found");
    const cached = (await pool.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND metadata->'swapFrame'->>'sourceAssetId'=$3 AND metadata->'swapFrame'->>'sourceSha256'=$4 AND (metadata->'swapFrame'->>'at')::float=$5 LIMIT 1",
      [workspaceId, body.projectId, source.id, source.sha256, body.at])).rows[0];
    if (cached) return cached;
    const file = await store.file(workspaceId, source.storage_key);
    const known = Number((source.metadata as {durationSeconds?: unknown} | null)?.durationSeconds);
    const seconds = body.at === 0 ? 0 : body.at * (Number.isFinite(known) && known > 0 ? known : await durationOf(file));
    const scratch = await mkdtemp(path.join(store.root, "swap-frame-"));
    try {
      const target = path.join(scratch, "frame.png");
      // -ss before -i seeks to the frame; only that one frame is decoded.
      await execute(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-nostdin", ...SAFE_INPUT, "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1", "-an", target], {timeout: 30000});
      const png = await readFile(target).catch(() => undefined);
      if (!png?.length) throw new HttpError(422, "No frame at that point of the clip");
      return await savePng(pool, store, {workspaceId, projectId: body.projectId, userId: user.id, parentId: source.id, name: `Frame of ${source.name}`, png,
        metadata: {swapFrame: {version: 1, sourceAssetId: source.id, sourceSha256: source.sha256, at: body.at, seconds}}});
    } finally {
      const resolved = path.resolve(scratch);
      if (path.dirname(resolved) === path.resolve(store.root) && path.basename(resolved).startsWith("swap-frame-")) await rm(resolved, {recursive: true, force: true});
    }
  });

  app.post(`${base}/crop`, async request => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params), user = await member(pool, request, workspaceId, "creator");
    const body = z.object({projectId: z.uuid(), imageAssetId: z.uuid(), maskAssetId: z.uuid()}).strict().parse(request.body);
    const [image, mask] = await Promise.all([asset(pool, workspaceId, body.projectId, body.imageAssetId), asset(pool, workspaceId, body.projectId, body.maskAssetId)]);
    if (!image || image.media_type !== "image" || !mask || mask.media_type !== "image") throw new HttpError(404, "Picture or mask not found");
    const cached = (await pool.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND metadata->'swapCrop'->>'imageAssetId'=$3 AND metadata->'swapCrop'->>'maskAssetId'=$4 LIMIT 1",
      [workspaceId, body.projectId, image.id, mask.id])).rows[0];
    if (cached) return {found: true, asset: cached};
    const maskFile = await readFile(await store.file(workspaceId, mask.storage_key));
    const {data, info} = await sharp(maskFile).greyscale().raw().toBuffer({resolveWithObject: true});
    const box = maskBox(data, info.width, info.height);
    if (!box) return {found: false};
    const imageFile = await readFile(await store.file(workspaceId, image.storage_key));
    const size = await sharp(imageFile).metadata();
    const crop = cropBox(box, {width: info.width, height: info.height}, {width: size.width ?? info.width, height: size.height ?? info.height});
    const png = await sharp(imageFile).extract(crop).png().toBuffer();
    return {found: true, asset: await savePng(pool, store, {workspaceId, projectId: body.projectId, userId: user.id, parentId: image.id, name: `Cut-out of ${image.name}`, png,
      metadata: {swapCrop: {version: 1, imageAssetId: image.id, maskAssetId: mask.id, box: crop}}})};
  });
}
