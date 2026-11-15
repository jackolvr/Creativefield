/* Enhance video on the server: a chain of finishing packs, each an unchanged workflow. Step 1 is an
   ordinary run whose request names the steps still to run; when a step publishes its video, the
   execution service queues the next one with that video as its source (see `nextFinishStep`). */
import type {PoolClient} from "pg";
import type {CapabilityBundle,CapabilityManifestV2,FinishChainSnapshot,FinishStepRequest} from "../src/capabilities/types";
import {frameRateOf,stepControls} from "../src/capabilities/finish-steps";
import {finishRoleOf} from "../src/capabilities/roles";
import {HttpError} from "./auth";

const SOURCE="source_video";

/** A pack can follow another step when it takes one source clip and makes a video on this computer. */
export function chainablePack(manifest:CapabilityManifestV2):boolean{
  const videos=manifest.inputs.filter(port=>port.type==="video");
  return videos.length===1&&videos[0].id===SOURCE&&manifest.outputs.some(port=>port.type==="video");
}
const localRoute=(bundle:CapabilityBundle)=>bundle.template?bundle.manifest.routes.find(route=>route.execution==="local_comfy"&&route.implementation==="implemented"):undefined;

/** The upscale factor applied up to and including a step, for the library's "Upscaled ×n" line. */
function chainScale(steps:Array<Record<string,unknown>>):number|undefined{
  const factors=steps.map(controls=>Number(controls.scale)).filter(value=>Number.isFinite(value)&&value>1);
  return factors.length?factors.reduce((a,b)=>a*b,1):undefined;
}

/** Where each later step runs. `readyOn` names a local worker that has the pack ready (step 1's own
 *  worker first), or nothing. The requested pack wins on any worker; only when no worker has it does
 *  the step go to the best-ranked pack of the same option (ReCaVSR missing → RTX upscale for "Fast"),
 *  with that pack's own controls. A step no pack can take refuses the request before anything runs. */
export function routeFinishSteps(rest:FinishStepRequest[],catalogue:CapabilityBundle[],readyOn:(bundle:CapabilityBundle)=>string|undefined):FinishStepRequest[]{
  return rest.map(step=>{
    const requested=catalogue.find(candidate=>candidate.manifest.id===step.capabilityId);
    const wanted=requested&&finishRoleOf(requested.manifest);
    if(!requested||!wanted||!chainablePack(requested.manifest)||!localRoute(requested))throw new HttpError(422,`${step.capabilityId} cannot be an Enhance step here`);
    const here=readyOn(requested);
    if(here)return {capabilityId:step.capabilityId,controls:step.controls,workerId:here};
    const fallback=catalogue.filter(candidate=>finishRoleOf(candidate.manifest)?.task===wanted.task&&finishRoleOf(candidate.manifest)?.option===wanted.option&&
      chainablePack(candidate.manifest)&&!!localRoute(candidate)&&!!readyOn(candidate)).sort((a,b)=>finishRoleOf(a.manifest)!.rank-finishRoleOf(b.manifest)!.rank)[0];
    if(!fallback)throw new HttpError(422,`${wanted.label} is not ready on any ComfyUI of this computer. Models shows what it needs.`);
    return {capabilityId:fallback.manifest.id,controls:{...(finishRoleOf(fallback.manifest)!.controls??{})},workerId:readyOn(fallback)};
  });
}

/** Check a request's finishing steps and freeze them as step 1 of the chain. */
export async function admitFinishChain(client:PoolClient,catalogue:CapabilityBundle[],workspaceId:string,manifest:CapabilityManifestV2,inputIds:Record<string,string>,controls:Record<string,unknown>,requested:FinishStepRequest[],readyOn:(bundle:CapabilityBundle)=>string|undefined):Promise<FinishChainSnapshot>{
  const sourceAssetId=inputIds[SOURCE];
  if(!chainablePack(manifest)||!sourceAssetId)throw new HttpError(422,"This workflow cannot start an Enhance chain");
  const rest=routeFinishSteps(requested,catalogue,readyOn);
  const parent=(await client.query<{id:string}>(`SELECT r.id FROM runs r CROSS JOIN LATERAL jsonb_array_elements_text(r.output_ids) elem WHERE r.workspace_id=$1 AND elem=$2 ORDER BY r.created_at DESC LIMIT 1`,[workspaceId,sourceAssetId])).rows[0];
  const scale=chainScale([controls]);
  return {validationVersion:1,contract:"finish_chain_v1",sourceAssetId,...(parent?.id?{parentRunId:parent.id}:{}),step:1,of:1+rest.length,...(scale?{scale}:{}),rest};
}

/** Step 1's own controls with any rate worked out from the source clip: its stored facts first, a probe of
 *  the file otherwise. Without a rate the pack's own default stays. */
export async function firstStepControls(manifest:CapabilityManifestV2,controls:Record<string,unknown>,source:{metadata?:unknown;storage_key?:string}|undefined,probe:(storageKey:string)=>Promise<unknown>):Promise<Record<string,unknown>>{
  const fpsFromSource=finishRoleOf(manifest)?.fpsFromSource;
  if(!fpsFromSource)return controls;
  let fps=frameRateOf((source?.metadata as {frameRate?:unknown}|undefined)?.frameRate);
  if(!fps&&source?.storage_key)fps=frameRateOf(await probe(source.storage_key).catch(()=>undefined));
  const {control,multiplierControl}=fpsFromSource;
  return fps?{...controls,[control]:Math.round(fps*Number(controls[multiplierControl]??1))}:controls;
}

/** A run that makes a video (Create Video) can name finishing steps for its result; a clip-in pack starts a chain instead. */
export const finishesAfter=(manifest:CapabilityManifestV2)=>!chainablePack(manifest)&&manifest.outputs.some(port=>port.type==="video");

/** The first step after a made video: the chain starts on that video and finishes the run's own card. */
export function firstFinishAfter(runId:string,steps:FinishStepRequest[]|undefined,output:{id:string;metadata?:unknown},catalogue:CapabilityBundle[]):NextFinishStep|undefined{
  if(!steps?.length)return undefined;
  return nextFinishStep(runId,{validationVersion:1,contract:"finish_chain_v1",sourceAssetId:output.id,parentRunId:runId,rootRunId:runId,step:0,of:steps.length,rest:steps},output,catalogue);
}

export type NextFinishStep={bundle:CapabilityBundle;routeId:string;workerId?:string;controls:Record<string,string|number|boolean>;snapshot:FinishChainSnapshot};

/** The step that follows a published step, or nothing at the chain's end. A pack that went missing
 *  from the catalogue ends the chain too: the clip made so far stays the result. */
export function nextFinishStep(runId:string,chain:FinishChainSnapshot|undefined,output:{metadata?:unknown},catalogue:CapabilityBundle[]):NextFinishStep|undefined{
  const [next,...rest]=chain?.rest??[];
  if(!chain||!next)return undefined;
  const bundle=catalogue.find(candidate=>candidate.manifest.id===next.capabilityId),route=bundle&&localRoute(bundle);
  if(!bundle||!finishRoleOf(bundle.manifest)||!route||!chainablePack(bundle.manifest))return undefined;
  const fps=frameRateOf((output.metadata as {frameRate?:unknown}|undefined)?.frameRate);
  const rootRunId=chain.rootRunId??runId,scale=chainScale([{scale:chain.scale??1},next.controls]);
  const {scale:_previous,...carried}=chain;
  return {bundle,routeId:route.id,workerId:next.workerId,controls:{...next.controls,...stepControls(bundle.manifest,fps)},
    snapshot:{...carried,...(scale?{scale}:{}),rootRunId,parentRunId:chain.parentRunId??rootRunId,step:chain.step+1,rest}};
}
