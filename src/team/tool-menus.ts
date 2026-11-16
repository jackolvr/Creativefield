/* The Video and Image dropdowns (user, 2026-11-15; DOC-2153): the top bar keeps Video and Image, and inside each the
   app's tools are the rows — Video: Create, Change, Upscale, Film Studio; Image: Create, Change, Upscale, FotoField.
   The tiles are the tasks in plain words (the All tools list, same readiness), not model workflows: the workflow is
   chosen inside the tool, so a dropdown never opens a second list of models. */
import type {MenuGroup} from "../ds";
import {groupMenu,type MenuEntry} from "./menu-groups";

export type Medium = "video" | "image";

/** Image menu entries that are screens, by row: making a picture is Create, an upscale is Upscale, the rest change a picture. */
export const imageEntryTool = (id:string):"create"|"change"|"upscale" => id==="create-image"||id==="router-create" ? "create" : /upscale/.test(id) ? "upscale" : "change";

type TaskLike = {id:string;label:string;text:string;href:string;group:string;video?:string};
const ROWS: Record<Medium,{id:string;title:string;text:string}[]> = {
  video: [{id:"create",title:"Create",text:"make a new clip"},{id:"change",title:"Change",text:"change a clip you have"},{id:"upscale",title:"Upscale",text:"sharper, bigger or smoother"},{id:"film-studio",title:"Film Studio",text:"plan the shots, make one film"}],
  image: [{id:"create",title:"Create",text:"make a new picture"},{id:"change",title:"Change",text:"change a picture you have"},{id:"upscale",title:"Upscale",text:"bigger and sharper"},{id:"fotofield",title:"FotoField",text:"layers, masks and AI edits"}],
};
/** Menu entries with a loop of their own (Creative Field characters, CONVE-1747), by the title the menu shows: [clip, poster]
 *  under public/examples/tiles. Screen entries (Camera angles, Relight) have no task id, so the title is the key. */
const T="/examples/tiles/";
const MENU_MEDIA:Record<string,[string,string]>={
  "Upscale":["menu-upscale","menu-upscale"],"Edit video":["menu-edit","menu-edit"],
  "Make a picture":["menu-picture","picture"],"Remix Studio":["menu-remix","remix"],"My characters":["menu-character","character"],
  "Camera angles":["menu-angles","angles"],"Relight":["menu-relight","new-look-before"],
};
const TASK_ROW: Record<string,string> = {Create:"create",Change:"change",Upscale:"upscale","Film Studio":"film-studio"};
/** Tasks a dropdown leaves out because a screen entry does the same more directly: "Turn it around" opens the general
 *  picture tool, the Camera angles entry opens the angles workflow itself. */
const COVERED_BY_SCREEN = new Set(["angles"]);

/** Which dropdown a task's screen belongs to, from its address; 3D and the rest stay out. */
export function mediumOf(href:string):Medium|undefined{
  const section = href.replace(/^#/,"").split("/")[0];
  if(["video","motion","block","audio","openjutsu"].includes(section)) return "video";
  if(["image","imageedit","remix","marketing","characters"].includes(section)) return "image";
  return undefined;
}

export type MediumExtra = MenuEntry & {medium:Medium; row:string};
/** One row per tool for each medium. `tasks` are the ready All-tools tasks; `extras` are screens that are no task
 *  (Trim, OpenJutsu, Camera angles, Relight). FotoField is its own Image row. Empty rows are left out. */
export function mediumMenus(tasks:readonly TaskLike[],openTask:(id:string)=>void,extras:readonly MediumExtra[]=[]):Record<Medium,MenuGroup[]>{
  const entries:MediumExtra[] = [
    ...tasks.flatMap(task=>{
      const medium = mediumOf(task.href);
      if(!medium||COVERED_BY_SCREEN.has(task.id)) return [];
      const row = medium==="image"&&task.id==="fix-picture" ? "fotofield" : TASK_ROW[task.group];
      return row ? [{id:task.id,title:task.label,text:task.text,onSelect:()=>openTask(task.id),medium,row}] : [];
    }),
    ...extras,
  ];
  const menus = {} as Record<Medium,MenuGroup[]>;
  for(const medium of ["video","image"] as const){
    menus[medium] = ROWS[medium].flatMap(row=>{
      const own = entries.filter(entry=>entry.medium===medium&&entry.row===row.id);
      // groupMenu gives each tile its preview clip; the tool is the row, in the tasks' own order.
      const order = own.map(entry=>entry.id);
      const tiles = own.length ? groupMenu(medium,own).flatMap(group=>group.tiles).sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))
        /* A tool with its own All tools loop shows that same loop in the menu, so both places tell one story. */
        .map(tile=>{const own=MENU_MEDIA[tile.title],task=tasks.find(t=>t.id===tile.id);return own?{...tile,clip:`${T}${own[0]}.mp4`,poster:`${T}${own[1]}.webp`}:task?.video?{...tile,clip:task.video,poster:task.video.replace(/\.mp4$/,".webp")}:tile;}) : [];
      return tiles.length ? [{id:`${medium}:${row.id}`,title:row.title,text:row.text,tiles}] : [];
    });
  }
  return menus;
}
