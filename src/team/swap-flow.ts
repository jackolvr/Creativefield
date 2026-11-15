/* Swap a thing, behind Generate (DOC-2191,): turn a routeSwap decision into runs of the unchanged
   workflows. The person's own picture is used as it is. Without one, the picture of the new thing is made from the
   clip itself: one frame at a time (first frame first, never the whole clip), SAM 3.1 finds the thing in it, the
   frame is cut to it and edited with the person's sentence. Only when no edit workflow is ready is a fast 4 MP
   picture made from the words. No UI here, so the whole flow is testable with a fake server. */
import {workspacePath, type Asset, type Call} from "./api";
import {FRAME_POSITIONS} from "../capabilities/swap-frames";
import type {CapabilityManifestV2} from "../capabilities/types";
import {runSwapAttempt, type TrackedStep} from "./swap-run";
import type {SwapRoute} from "./intent/swap-route";
import {routeRole} from "../capabilities/roles";
import {taskPacks} from "../capabilities/tasks";
import {capability} from "../capabilities/lookup";
import {FLASH_RESTYLE_ID} from "./transform-video-state";

/** SAM 3.1 image segment: finds the named thing in one frame. */
export const SEGMENT_CAPABILITY = capability("sam3-image-segment");

/** A workflow chosen for a step and the ComfyUI it runs on. */
export type Pick = {manifest: Pick_; workerId: string};
type Pick_ = Pick__<CapabilityManifestV2, "id" | "version" | "inputs" | "controls"> & {audioPolicies?: CapabilityManifestV2["audioPolicies"]};
type Pick__<T, K extends keyof T> = {[P in K]: T[P]};

/** "the bike" → "bike": the words SAM and the area swap look for. */
export const swapNoun = (target: string | undefined) => (target ?? "").replace(/^(the|this|that|these|those|his|her|their|my|der|die|das|den|dem|diese[nrsm]?|dieses|seine[nrsm]?|ihre[nrsm]?|meine[nrsm]?)\s+/i, "").trim();

const step = (id: string, label: string, pick: Pick, inputs: TrackedStep["inputs"], controls: Record<string, unknown>): TrackedStep =>
  ({id, label, capabilityId: pick.manifest.id, version: pick.manifest.version, inputs, controls, workerId: pick.workerId,
    // The sound rule the workflow takes: a video swap keeps the clip's own sound, a picture step has none.
    audioPolicy: pick.manifest.audioPolicies?.includes("preserve") ? "preserve" : pick.manifest.audioPolicies?.[0] ?? "mute"});
/** A value the control allows: a select takes the nearest of its options (5 s asked of a 5/8/10 select stays 5,
 *  3 s becomes 5), a number stays inside its min and max. */
function allowed(control: CapabilityManifestV2["controls"][number], value: unknown): unknown {
  if (typeof value !== "number") return value;
  const numbers = (control.options ?? []).map(Number).filter(Number.isFinite);
  if (numbers.length) return numbers.reduce((best, option) => Math.abs(option - value) < Math.abs(best - value) || (Math.abs(option - value) === Math.abs(best - value) && option > best) ? option : best);
  return Math.min(control.max ?? value, Math.max(control.min ?? value, value));
}
/** Only the controls a workflow declares, each within what it allows, so a step never sends a field or value its graph does not take. */
const declared = (pick: Pick, controls: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(controls).flatMap(([id, value]) => {
    const control = pick.manifest.controls.find(item => item.id === id);
    return value !== undefined && control ? [[id, allowed(control, value)]] : [];
  }));
const firstImagePort = (pick: Pick) => pick.manifest.inputs.find(port => port.type === "image")?.id ?? "source_image";

export type ReferenceFlow = {
  call: Call; workspaceId: string; projectId: string; requestId: string;
  video: string; target?: string; sentence: string;
  /** SAM 3.1 image segment and the picture edit; `words` makes a picture from words when no edit is ready. */
  segment?: Pick; edit?: Pick; words?: Pick;
  onStep?: (label: string) => void; onRun?: (runId: string | null) => void; alive?: () => boolean;
  waitMs?: number; sleep?: (ms: number) => Promise<void>;
};

/** The picture of the new thing, made from the clip: returns the asset id, and how it was made. */
export async function referenceFromClip(flow: ReferenceFlow): Promise<{asset: string; from: "frame" | "words"}> {
  const run = (steps: TrackedStep[]) => runSwapAttempt({call: flow.call, workspaceId: flow.workspaceId, projectId: flow.projectId, workerId: steps[0].workerId ?? "",
    requestId: flow.requestId, steps, onStep: flow.onStep, onRun: flow.onRun, alive: flow.alive, waitMs: flow.waitMs, sleep: flow.sleep});
  const noun = swapNoun(flow.target);
  if (flow.edit) {
    let picture: string | undefined;
    // One frame at a time; stop at the first where SAM finds the thing.
    if (flow.segment && noun) for (const at of FRAME_POSITIONS) {
      flow.onStep?.(`Look for ${noun} in the clip…`);
      const frame = await flow.call<Asset>(workspacePath(flow.workspaceId, "swap-reference/frame"), "POST", {projectId: flow.projectId, assetId: flow.video, at});
      const mask = (await run([step(`find-${Math.round(at * 100)}`, `Find ${noun}`, flow.segment, {[firstImagePort(flow.segment)]: {asset: frame.id}}, declared(flow.segment, {prompt: noun})) ]))[`find-${Math.round(at * 100)}`];
      const crop = await flow.call<{found: boolean; asset?: Asset}>(workspacePath(flow.workspaceId, "swap-reference/crop"), "POST", {projectId: flow.projectId, imageAssetId: frame.id, maskAssetId: mask});
      if (crop.found && crop.asset) { picture = crop.asset.id; break; }
    }
    // Not found in any of those frames (or nothing named): the first frame as a whole.
    if (!picture) picture = (await flow.call<Asset>(workspacePath(flow.workspaceId, "swap-reference/frame"), "POST", {projectId: flow.projectId, assetId: flow.video, at: 0})).id;
    const edited = (await run([step("picture", `Make ${noun || "the new thing"} as you describe`, flow.edit, {[firstImagePort(flow.edit)]: {asset: picture}}, declared(flow.edit, {prompt: flow.sentence}))]))["picture"];
    return {asset: edited, from: "frame"};
  }
  if (flow.words) {
    const made = (await run([step("picture", `Make a picture of ${noun || "the new thing"}`, flow.words, {}, declared(flow.words, {prompt: `${flow.sentence}. One ${noun || "object"}, seen whole, plain background.`, megapixels: 4})) ]))["picture"];
    return {asset: made, from: "words"};
  }
  throw new Error("Add a picture of what it should become.");
}

/** The run that does the swap itself, for the routed workflow: its ports filled from the one standard panel. */
export function swapStep(route: Exclude<SwapRoute, "picture">, pick: Pick, input: {video: string; pictures: string[]; target?: string; sentence: string; seconds?: number; resolution?: string; seed?: number}): TrackedStep {
  const images = pick.manifest.inputs.filter(port => port.type === "image");
  const inputs: TrackedStep["inputs"] = {source_video: {asset: input.video}};
  // References fill the workflow's picture ports in order; an optional first_frame stays empty here.
  images.filter(port => port.id !== "first_frame" && port.id !== "scene_guide").forEach((port, index) => { if (input.pictures[index]) inputs[port.id] = {asset: input.pictures[index]}; });
  const label = route === "person" ? `Replace ${input.target ?? "the person"}` : route === "look" ? "Change the look" : `Change ${input.target ?? "the thing"}`;
  return step("swap", label, pick, inputs, declared(pick, {
    prompt: route === "thing" ? swapNoun(input.target) || input.sentence : input.sentence,
    change_to: route === "thing" ? input.sentence : undefined,
    // The length of the clip to change (the loader reads only that much); the per-generation piece keeps its default.
    source_seconds: input.seconds, resolution: input.resolution, seed: input.seed,
  }));
}

/** The workflows a swap can use here, each with the ComfyUI it runs on, chosen by the manifests (role and task
 *  ranks), never named in a screen. `routeFor` gives a workflow's ready worker on this computer, or nothing. */
export type SwapPicks = {thing?: Pick; person?: Pick; look?: Pick; segment?: Pick; edit?: Pick; words?: Pick};
export function swapPicks(catalogue: readonly CapabilityManifestV2[], routeFor: (id: string) => Pick | undefined): SwapPicks {
  const first = (ids: readonly string[]) => ids.map(id => routeFor(id)).find((found): found is Pick => !!found);
  const person = routeRole("change", "replace-person", catalogue, manifest => !!routeFor(manifest.id));
  return {
    thing: first(taskPacks("video.swap-thing")),
    person: person && routeFor(person.id),
    // The whole look runs on the person workflow with style pictures (Change › New look today).
    look: routeFor(FLASH_RESTYLE_ID),
    segment: routeFor(SEGMENT_CAPABILITY.id),
    edit: first(taskPacks("image.edit")),
    words: first(taskPacks("image.create")),
  };
}
