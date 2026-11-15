/* The top bar's four tools (DOC-2153): Create, Change, Upscale and Film Studio. Every entry the Video, Image and
   3D menus used to hold is placed under the tool it belongs to, and each tool's dropdown keeps the function rows
   and preview clips of groupMenu. A workflow's tool comes from its manifest (`role`), else from what it takes: a
   workflow that needs no picture or clip creates something new, one that does changes it. */
import type {MenuGroup} from "../ds";
import type {CapabilityManifestV2} from "../capabilities/types";
import {finishRoleOf,roleOf} from "../capabilities/roles";
import {groupMenu,type MenuEntry} from "./menu-groups";

export type Tool = "create" | "change" | "upscale" | "film-studio";
/** Top-bar items in tool order. `href` is the item's own address for the active mark, not a route. */
export const TOOLS: {tool:Tool;label:string;href:string}[] = [
  {tool:"create",label:"Create",href:"#tool/create"},
  {tool:"change",label:"Change",href:"#tool/change"},
  {tool:"upscale",label:"Upscale",href:"#tool/upscale"},
  {tool:"film-studio",label:"Film Studio",href:"#tool/film-studio"},
];
export const toolHref = (tool:Tool) => TOOLS.find(item=>item.tool===tool)!.href;

/** The app's own video screens (not workflows), by the tool they belong to. */
const VIDEO_SCREENS: Record<string,Tool> = {
  create:"create", talk:"create",
  transform:"change", openjutsu:"change", trim:"change", edit:"change", motion:"change",
  enhance:"upscale",
  storyboard:"film-studio",
};
export const videoScreenTool = (id:string):Tool => VIDEO_SCREENS[id] ?? "change";

/** Image menu entries: making a picture is Create, an upscale is Upscale, everything else edits a picture. */
export const imageEntryTool = (id:string):Tool => id==="create-image"||id==="router-create" ? "create" : /upscale/.test(id) ? "upscale" : "change";

/** A workflow's tool: its role first; an Upscale-chain step or an upscale workflow is Upscale. Otherwise Change keeps
 *  the medium (a clip in, a clip out; a picture in, a picture out) and Create makes something new: from words, or a
 *  clip or a 3D model from a picture. */
export function workflowTool(manifest:Pick<CapabilityManifestV2,"role"|"finishStep"|"inputs"|"outputs"|"category"|"title">):Tool{
  if(finishRoleOf(manifest)) return "upscale";
  const role = roleOf(manifest)?.tool;
  if(role) return role;
  if(manifest.category==="3d") return "create";
  if(/upscale/i.test(manifest.title)) return "upscale";
  const takes=(type:string)=>manifest.inputs.some(port=>port.type===type),makes=(type:string)=>manifest.outputs.some(port=>port.type===type);
  return takes("video")&&makes("video")||takes("image")&&makes("image")&&!makes("video") ? "change" : "create";
}

export type ToolEntry = MenuEntry & {kind:"video"|"image"|"3d"; tool:Tool};
const SINGLE_ROW:Partial<Record<Tool,{title:string;text:string}>>={
  upscale:{title:"Upscale",text:"sharper, bigger or smoother"},
  "film-studio":{title:"Film Studio",text:"plan the shots, block the scene, make one film"},
};

/** Each tool's dropdown: its entries in the function rows of their kind (video, then image, then 3D). Row ids are
 *  prefixed with the kind, since Video and Image both have a "change" row. Tools without entries are left out. */
export function toolMenus(entries:readonly ToolEntry[]):Partial<Record<Tool,MenuGroup[]>>{
  const menus:Partial<Record<Tool,MenuGroup[]>> = {};
  for(const {tool} of TOOLS){
    const groups = (["video","image","3d"] as const).flatMap(kind=>{
      const own = entries.filter(entry=>entry.tool===tool&&entry.kind===kind);
      return own.length ? groupMenu(kind,own).map(group=>({...group,id:`${kind}:${group.id}`})) : [];
    });
    // The small tools are one row with their own name; the video rows (Make a video, Finish) would mislabel them.
    const single=SINGLE_ROW[tool];
    if(groups.length) menus[tool] = single?[{id:`${tool}:all`,title:single.title,text:single.text,tiles:groups.flatMap(group=>group.tiles)}]:groups;
  }
  return menus;
}

/** Which tool the screen at `hash` belongs to, for the active mark in the top bar. Screens outside the four tools
 *  (Library, Projects, Models, Nodes, All tools) return undefined. */
export function toolOfHash(hash:string):Tool|undefined{
  const [section,part] = hash.replace(/^#/,"").split("/");
  switch(section){
    case "image": case "3d": case "audio": case "characters": case "influencer": case "marketing": return "create";
    case "imageedit": case "remix": case "motion": case "openjutsu": return "change";
    case "block": return "film-studio";
    case "video":
      if(part==="enhance") return "upscale";
      if(part==="storyboard"||part==="keyframes") return "film-studio";
      if(part==="transform"||part==="replace"||part==="trim"||part==="edit") return "change";
      return "create";
    default: return undefined;
  }
}

type Entry = MenuEntry & {id:string};
/** Every entry of the old Video, Image and 3D menus, placed under its tool, plus the extra entries a tool adds
 *  (Film Studio's own tasks, the audio studio). */
export function toolEntriesFrom(menus:{video:{features:Entry[];models:Entry[]};image:{features:Entry[];models:Entry[]};threeD?:{features:Entry[];models:Entry[]}},
  workflowOf:(id:string)=>Pick<CapabilityManifestV2,"role"|"finishStep"|"inputs"|"outputs"|"category"|"title">|undefined,extra:readonly ToolEntry[]=[]):ToolEntry[]{
  const tool=(id:string,fallback:Tool)=>{const manifest=workflowOf(id);return manifest?workflowTool(manifest):fallback;};
  return [
    ...menus.video.features.map(entry=>({...entry,kind:"video" as const,tool:videoScreenTool(entry.id)})),
    ...menus.video.models.map(entry=>({...entry,kind:"video" as const,tool:tool(entry.id,"change")})),
    ...menus.image.features.map(entry=>({...entry,kind:"image" as const,tool:imageEntryTool(entry.id)})),
    ...menus.image.models.map(entry=>({...entry,kind:"image" as const,tool:tool(entry.id,"change")})),
    ...[...(menus.threeD?.features??[]),...(menus.threeD?.models??[])].map(entry=>({...entry,kind:"3d" as const,tool:"create" as const})),
    ...extra,
  ];
}

/** What a tool adds beyond the old menus: Film Studio's own tasks (those no Video entry already opens) and, where
 *  this computer has it, the audio studio under Create. */
export function toolExtras(tasks:readonly {id:string;label:string;text:string;href:string;group:string}[],videoHrefs:readonly string[],audio:boolean,open:(id:string)=>void):ToolEntry[]{
  return [
    ...(audio?[{id:"audio",title:"Voices and lip sync",text:"Speech, voices and lip sync",onSelect:()=>{location.hash="audio";},kind:"video" as const,tool:"create" as const}]:[]),
    ...tasks.filter(task=>task.group==="Film Studio"&&!videoHrefs.includes(task.href))
      .map(task=>({id:task.id,title:task.label,text:task.text,onSelect:()=>open(task.id),kind:"video" as const,tool:"film-studio" as const})),
  ];
}
