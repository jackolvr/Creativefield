/* Out-of-memory rescue, on this computer only. A local run that fails because the graphics card ran out
   of memory is offered once more with smaller settings: the next lower resolution and a shorter clip, with the same
   inputs and seed. It is only ever an offer; nothing reruns by itself and nothing goes to the cloud. */
import type {Control} from "./types";

/** The worker's own words for a full graphics card (ComfyUI / PyTorch / CUDA). */
export const isOutOfMemory = (error?: string | null) =>
  !!error && /out of memory|OutOfMemoryError|allocation on device|not enough (gpu |video |graphics )?memory/i.test(error);

type SizeControl = Pick<Control, "id" | "label" | "type" | "options" | "min" | "max">;
const RESOLUTION = /resolution|size|megapixel/i, DURATION = /duration|seconds|length/i;
/** How much of the person's own clip to read (`source_seconds`): cutting it changes what they get back and saves no
 *  graphics memory, since those workflows make the clip window by window (`window_seconds`, `clip_seconds`). */
const SOURCE_LENGTH = /^source_/i;
/** How big an option is: "1024x576" by its area, "736p" or "2.0" by its number. */
function amount(option: string | number): number {
  if (typeof option === "number") return option;
  const area = /(\d+)\s*[x×]\s*(\d+)/i.exec(option);
  if (area) return Number(area[1]) * Number(area[2]);
  const number = /\d+(\.\d+)?/.exec(option);
  return number ? Number(number[0]) : NaN;
}
const shown = (value: unknown, control: SizeControl) => DURATION.test(control.id) && typeof value === "number" ? `${value} s` : String(value);

/** Smaller settings for a run that ran out of memory, and what changed in plain words ("736p → 480p", "5 s → 3 s").
 *  Undefined when no resolution or duration can go lower. Every other setting, the seed included, stays. */
export function smallerRun(controls: readonly SizeControl[], values: Record<string, unknown>):
  {controls: Record<string, string | number | boolean>; changes: string[]} | undefined {
  const next: Record<string, string | number | boolean> = {}, changes: string[] = [];
  for (const control of controls) {
    const current = values[control.id] ?? (control as {default?: unknown}).default;
    if (current === undefined || current === null) continue;
    if (RESOLUTION.test(control.id) && control.options?.length) {
      const size = amount(current as string | number);
      const lower = control.options.filter(option => amount(option) < size).sort((a, b) => amount(b) - amount(a))[0];
      if (lower !== undefined) { next[control.id] = lower; changes.push(`${shown(current, control)} → ${shown(lower, control)}`); }
    } else if (DURATION.test(control.id) && !SOURCE_LENGTH.test(control.id) && typeof current === "number") {
      const floor = control.min ?? 1, target = Math.max(floor, Math.min(current - 1, Math.round(current * 0.6)));
      const lower = control.options?.length
        ? control.options.map(Number).filter(option => option <= target && option >= floor).sort((a, b) => b - a)[0]
        : control.type === "integer" ? Math.floor(target) : target;
      if (lower !== undefined && Number.isFinite(lower) && lower < current) { next[control.id] = lower; changes.push(`${shown(current, control)} → ${shown(lower, control)}`); }
    }
  }
  return changes.length ? {controls: next, changes} : undefined;
}
