/* Enhance video: one tool instead of one workspace per finishing pack. The person picks a step per row
   (Upscale: Fast or Best; Smooth motion: 2x) and the ready packs behind each choice run one after the
   other on the server, each an unchanged workflow. Which pack stands behind a choice is the manifests'
   `finishStep` (src/capabilities/finish-steps.ts); this screen names no pack. The rows themselves are
   shared with Create Video (./finish-params). */
import {useMemo,type ComponentProps} from "react";
import {Meta} from "../ds";
import {chainLine,finishRows,planFinish} from "../capabilities/finish-steps";
import type {CapabilityManifestV2} from "../capabilities/types";
import {TeamComposer,type ComposerFinish} from "./TeamComposer";
import {FinishParams,useFinishChoice} from "./finish-params";

type ComposerProps=Omit<ComponentProps<typeof TeamComposer>,"manifest"|"finish"|"workflowIds"|"modelChoice"|"initialInputs">;

/** `screen` is the resolved Enhance screen: the ready finishing packs and an optional clip from the link. */
export function EnhanceVideo({screen:{packs,assetId},...composer}:{screen:{packs:CapabilityManifestV2[];assetId?:string}}&ComposerProps){
  const rows=useMemo(()=>finishRows(packs),[packs]);
  /* A first visit upscales with the first ready option and leaves the rest off. */
  const [choice,setChoice]=useFinishChoice(`comfyfield:enhance:${composer.user.id}`,()=>{
    const upscale=rows.find(row=>row.step==="upscale")??rows[0];
    return upscale?{[upscale.step]:upscale.options[0]?.option}:{};
  });
  const steps=useMemo(()=>planFinish(choice,packs),[choice,packs]);
  /* The composer shows the first step's pack: its input, readiness and worker are what Generate needs first. */
  const lead=packs.find(pack=>pack.id===steps[0]?.capabilityId)??packs.find(pack=>pack.id===rows[0]?.options[0]?.pack)??packs[0];
  const finish:ComposerFinish={
    title:"Enhance video",
    subtitle:steps.length?chainLine(steps):"Choose a step below",
    params:<FinishParams rows={rows} choice={choice} steps={steps} onChange={setChoice}/>,
    request:()=>{
      const [first,...rest]=steps;
      const pack=first&&packs.find(item=>item.id===first.capabilityId);
      if(!first||!pack)return undefined;
      return {capabilityId:pack.id,version:pack.version,controls:first.controls,audioPolicy:pack.audioPolicies.includes("preserve")?"preserve":pack.audioPolicies[0]??"mute",
        finish:rest.map(({capabilityId,controls})=>({capabilityId,controls}))};
    },
  };
  if(!lead)return null;
  /* The info button explains every step that will run, not only the first pack. */
  const info=<>{steps.map(step=>{const pack=packs.find(item=>item.id===step.capabilityId);return pack?<Meta key={step.capabilityId}>{`${step.label}: ${pack.description}`}</Meta>:null;})}</>;
  return <TeamComposer {...composer} workflowInfo={info} manifest={lead} workflowIds={[lead.id]} finish={finish} initialInputs={assetId?{source_video:assetId}:undefined}/>;
}
