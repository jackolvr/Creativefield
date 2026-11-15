import type {Asset, Run} from "./api";
import {jobQueueTitle} from "./job-queue";
import {finishDone} from "../capabilities/finish-steps";

export type FeedUpscale={parentRunId?:string;sourceAssetId?:string;capabilityId?:string;scale?:number;/** Every chain step up to this file, in run order. */steps?:string[];seconds?:number;parentCapabilityId?:string;parentSeconds?:number;sourceWidth?:number;sourceHeight?:number;sourceDurationSeconds?:number;sourceContentType?:string};
export type FeedUpscaled={assetId:string;scale?:number;seconds?:number;capabilityId?:string};
export type FeedGeneration={capabilityId?:string;seconds?:number;upscale?:FeedUpscale;upscaled?:FeedUpscaled};

export type FeedCard={
  /** Top-left label: "Original" or "Upscaled 2×". */
  hint?:string;
  /** Right side, small: how it was made, how long it took and the file's format. */
  lines:string[];
  /** Full view can put this file beside the result. */
  compare?:{assetId:string;name:string};
};

const number=(value:unknown)=>Number.isFinite(Number(value))?Number(value):undefined;
const shape=(asset:Asset|undefined)=>{const meta=asset?.metadata as {width?:unknown;height?:unknown}|undefined;const width=number(meta?.width),height=number(meta?.height);return width&&height?`${width}×${height}`:undefined;};
const duration=(asset:Asset|undefined)=>{const meta=asset?.metadata as {durationSeconds?:unknown;duration?:unknown}|undefined;const value=number(meta?.durationSeconds??meta?.duration);return value?`${value.toFixed(1)} s`:undefined;};
const container=(asset:Asset|undefined)=>{const type=asset?.content_type??"";return type.includes("webm")?"WebM":type.includes("quicktime")?"MOV":type.includes("mp4")?"MP4":type.includes("png")?"PNG":type.includes("jpeg")||type.includes("jpg")?"JPG":undefined;};
/** One line for the file's own facts: size, duration and container. */
export const assetFormat=(asset:Asset|undefined)=>[shape(asset),duration(asset),container(asset)].filter(Boolean).join(" · ");
/** The file's size without the rest, for a source-clip line. */
export const assetSize=(asset:Asset|undefined)=>shape(asset);
const time=(seconds:number|undefined)=>seconds===undefined?"":`${seconds} s`;
export const generationOf=(asset:Asset|undefined):FeedGeneration|undefined=>{
  const value=asset?.metadata?.generation as FeedGeneration|undefined;
  return value&&typeof value==="object"?value:undefined;
};

/** What the Enhance steps did to this file ("Upscaled ×2 · Smooth"); "Enhanced" when the steps are not known. */
export const finishWords=(upscale:FeedUpscale|undefined,stepOf?:Record<string,string>,withScale=true)=>{if(!upscale)return [];const words=finishDone(upscale.steps??(upscale.capabilityId?[upscale.capabilityId]:undefined),stepOf,withScale?upscale.scale:undefined);return words.length?words:[upscale.scale&&upscale.scale>1&&withScale?`Upscaled ×${upscale.scale}`:upscale.scale&&upscale.scale>1?"Upscaled":"Enhanced"];};
/** Plain names for the upscale workflows that produce upscaled siblings; the catalogue titles drop their model in brackets. */
const UPSCALE_MODEL_NAMES:Record<string,string>={"recavsr-video-upscale":"ReCaVSR 2K","seedvr2-video-upscale":"SeedVR2","nvidia-vfx-upscale":"NVIDIA VFX","realesrgan-x4":"Real-ESRGAN","z-image-2k-upscale":"Z-Image 2K"};
export const upscaleModelName=(capabilityId:string|undefined,titles:Record<string,string>)=>capabilityId?(UPSCALE_MODEL_NAMES[capabilityId]??jobQueueTitle(capabilityId,titles)):undefined;

/** The quiet card label: the app's mode, with the finishing steps beside it ("Image to video · Smooth"). */
export const feedModeLabel=(mode:string|undefined,done:readonly string[]):string|undefined=>[mode,...done].filter(Boolean).join(" · ")||undefined;

/** The library card for a stored file: which workflow, how long, the upscale pass and the new format. */
export function assetCardFacts(asset:Asset,titles:Record<string,string>,stepOf?:Record<string,string>):FeedCard{
  const generation=generationOf(asset),upscale=generation?.upscale,upscaled=generation?.upscaled;
  const file=[shape(asset),duration(asset),container(asset)].filter(Boolean).join(" · ");
  if(upscale?.sourceAssetId){
    const done=finishWords(upscale,stepOf),packs=(upscale.steps??(upscale.capabilityId?[upscale.capabilityId]:[])).map(id=>jobQueueTitle(id,titles)).filter(Boolean);
    const lines=[jobQueueTitle(upscale.parentCapabilityId??generation?.capabilityId??"",titles),time(upscale.parentSeconds??generation?.seconds),[...done,...packs].join(" · ")+` · ${time(upscale.seconds)}`,file].filter(Boolean) as string[];
    return {hint:done.join(" · "),lines,compare:{assetId:upscale.sourceAssetId,name:"Original"}};
  }
  const lines=[jobQueueTitle(generation?.capabilityId??"",titles),time(generation?.seconds),file].filter(Boolean) as string[];
  const better=upscaled?.assetId?finishWords({scale:upscaled.scale,capabilityId:upscaled.capabilityId},stepOf).join(" · "):"";
  if(upscaled?.assetId){const t=upscaleModelName(upscaled.capabilityId,titles)??"";lines.push(`${better} available${t?` · ${t}`:""}${upscaled.seconds?` · ${time(upscaled.seconds)}`:""}`);}
  return {hint:upscaled?.assetId?"Original":undefined,lines,compare:upscaled?.assetId?{assetId:upscaled.assetId,name:better}:undefined};
}

/** A queued result's card: the workflow and run time, plus the upscale facts its output file carries. */
export function runCardFacts(run:Run,output:Asset|undefined,titles:Record<string,string>,stepOf?:Record<string,string>):FeedCard{
  const generation=generationOf(output),upscale=generation?.upscale;
  const wall=Math.max(0,Math.round((Date.parse(run.updated_at)-Date.parse(run.created_at))/1000));
  const file=[shape(output),duration(output),container(output)].filter(Boolean).join(" · ");
  if(upscale?.sourceAssetId){
    const done=finishWords(upscale,stepOf),lines=[jobQueueTitle(run.capability_id,titles),`${wall} s`,`${done.join(" · ")} · ${time(upscale.seconds)}`,file].filter(Boolean);
    return {hint:done.join(" · "),lines,compare:{assetId:upscale.sourceAssetId,name:"Original"}};
  }
  return {hint:generation?.upscaled?"Original":undefined,lines:[jobQueueTitle(run.capability_id,titles),`${wall} s`,file].filter(Boolean)};
}
