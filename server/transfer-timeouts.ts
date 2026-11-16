/* Time a worker may take to move one media file. The 20 s used for ordinary ComfyUI calls is too short for a
   video of tens of MB over a home link to a remote GPU, so uploads and downloads have their own limits.
   Operators change them with COMFYFIELD_UPLOAD_TIMEOUT_SECONDS and COMFYFIELD_DOWNLOAD_TIMEOUT_SECONDS
   (5–7200); anything else falls back to the default of ten minutes. */

export const DEFAULT_TRANSFER_TIMEOUT_MS = 600_000;

function seconds(raw: string | undefined): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 5 && value <= 7200 ? Math.round(value * 1000) : DEFAULT_TRANSFER_TIMEOUT_MS;
}

export function uploadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number { return seconds(env.COMFYFIELD_UPLOAD_TIMEOUT_SECONDS); }
export function downloadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number { return seconds(env.COMFYFIELD_DOWNLOAD_TIMEOUT_SECONDS); }
