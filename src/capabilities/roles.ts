/* Where a workflow sits in the app, read from its own manifest (`role`), never from its id.
   The app has four tools: Create, Change, Upscale and Film Studio (DOC-2153). Each workflow that
   one of them offers says which tool, which task inside it, which option of that task, its rank
   among workflows offering the same option (1 is preferred, later ranks are fallbacks) and its
   place in a chain. Workflows without a role stay out of the tools and remain reachable through
   Nodes and saved runs.

   Older manifests declare an Upscale step as `finishStep`; it is read as a role of the Upscale tool,
   so imported or custom workflows written before `role` keep working unchanged. */
import type {CapabilityManifestV2,CapabilityRole} from "./types";

type RoleSource = Pick<CapabilityManifestV2,"role"|"finishStep">;

/** The manifest's role, or its legacy `finishStep` read as an Upscale step. */
export function roleOf(manifest:RoleSource):CapabilityRole|undefined{
  if(manifest.role)return manifest.role;
  const step=manifest.finishStep;
  if(!step)return undefined;
  return {tool:"upscale",task:step.step,option:step.option,rank:step.rank,order:step.order,label:step.label,
    ...(step.controls?{controls:step.controls}:{}),...(step.fpsFromSource?{fpsFromSource:step.fpsFromSource}:{})};
}

/** A workflow that can be a step of the Upscale tool's chain (upscale, smooth motion). */
export function finishRoleOf(manifest:RoleSource):CapabilityRole|undefined{
  const role=roleOf(manifest);
  return role?.tool==="upscale"?role:undefined;
}

type Routable = RoleSource & {id:string};
/** Every workflow offering one task of one tool, best first (rank, then chain order). */
export function roleCandidates<T extends Routable>(tool:CapabilityRole["tool"],task:string,pool:readonly T[]):T[]{
  return pool.filter(manifest=>{const role=roleOf(manifest);return role?.tool===tool&&role.task===task;})
    .sort((a,b)=>roleOf(a)!.rank-roleOf(b)!.rank||roleOf(a)!.order-roleOf(b)!.order);
}
/** The workflow a task runs on: the best-ranked ready one, otherwise the best-ranked one at all, so the
 *  screen can say what it still needs. `option` narrows to one choice of the task; link-only workflows
 *  (`pinnedOnly`) are never picked here. */
export function routeRole<T extends Routable>(tool:CapabilityRole["tool"],task:string,pool:readonly T[],ready:(manifest:T)=>boolean,option?:string):T|undefined{
  const candidates=roleCandidates(tool,task,pool).filter(manifest=>!roleOf(manifest)!.pinnedOnly&&(!option||roleOf(manifest)!.option===option));
  return candidates.find(ready)??candidates[0];
}
/** The workflows a task offers as choices, best first: per option the best-ranked one, leaving out an
 *  option a better-ranked choice already covers (`covers`). Link-only workflows are not offered. */
export function roleChoices<T extends Routable>(candidates:readonly T[]):T[]{
  const covered=new Set<string>(),choices:T[]=[];
  for(const manifest of candidates){
    const role=roleOf(manifest);
    if(!role||role.pinnedOnly||covered.has(role.option))continue;
    choices.push(manifest);
    for(const option of [role.option,...(role.covers??[])])covered.add(option);
  }
  return choices;
}
