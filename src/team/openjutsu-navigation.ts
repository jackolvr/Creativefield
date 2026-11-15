import {roleCandidates,roleChoices,roleOf,routeRole} from "../capabilities/roles";
import type {CapabilityManifestV2} from "../capabilities/types";

type Choice = {value:string;label:string;note?:string};
type OpenJutsuScreen =
  | {kind:"composer";manifest:CapabilityManifestV2;subtitle:string;options:Choice[]}
  | {kind:"experimental"}
  | {kind:"router"};

/* Replace character (Change › Person): which workflow runs is the manifests' role (tool "change", task
   "replace-person"), never a list of ids here. The best-ranked ready workflow is the default; the others that
   are ready are the choices (one per option, see roleChoices); a link or a saved run may name any of them,
   including a link-only one. Ready means ready on this computer (`localReady`), else in `ready`. */
const TOOL="change",TASK="replace-person";
const labelOf=(manifest:CapabilityManifestV2)=>roleOf(manifest)?.label??manifest.title;

export function resolveOpenJutsu({hash,catalogue,localReady,ready,hosted,experiment}: {
  hash:string;
  catalogue:CapabilityManifestV2[];
  localReady?:ReadonlySet<string>;
  ready:CapabilityManifestV2[];
  hosted:boolean;
  experiment?:string;
}):{screen:OpenJutsuScreen;localAvailable:boolean}{
  const [section,subroute]=hash.replace(/^#/,"").split("/");
  const requested=section==="openjutsu"?subroute:undefined;
  const local=catalogue.filter(manifest=>manifest.coverage.local==="implemented");
  const readyIds=localReady??new Set(ready.map(manifest=>manifest.id));
  const isReady=(manifest:CapabilityManifestV2)=>readyIds.has(manifest.id);
  const people=roleCandidates(TOOL,TASK,local);
  const pinned=people.find(manifest=>manifest.id===requested);
  const manifest=pinned??(requested==="advanced"?routeRole(TOOL,TASK,local,isReady,"several"):routeRole(TOOL,TASK,local,isReady));
  const localAvailable=!!manifest;
  if(hosted||requested==="cloud")return {screen:{kind:"router"},localAvailable};
  if(requested==="multi")return {screen:{kind:"experimental"},localAvailable};
  if(!manifest)return {screen:{kind:"router"},localAvailable};

  // Nothing ready yet: offer the best workflow of each option, so the screen says what each one needs.
  const readyOnes=roleChoices(people.filter(isReady));
  const shown=readyOnes.length?readyOnes:roleChoices(people);
  const choices=new Map<string,Choice>();
  for(const option of [...shown,manifest])choices.set(option.id,{value:option.id,label:labelOf(option)});
  if(experiment)choices.set(experiment,{value:experiment,label:"SCAIL-2 · Multiple characters",note:"Experimental"});
  return {screen:{kind:"composer",manifest,subtitle:labelOf(manifest),options:[...choices.values()]},localAvailable};
}
