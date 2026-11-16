import type {Doc} from "./doc";
export type ObjectRegion={canvas:HTMLCanvasElement;alpha:Uint8ClampedArray;area:number;label?:string};
/** What Quick select looks for, one SAM 3 run each (one concept per prompt; several in one prompt merge into a
 * single mask). The background and a person first; with a person, its parts, otherwise common scene parts. */
export const QUICK_SELECT_FIRST=["background","person"] as const;
export const QUICK_SELECT_PERSON_PARTS=["hair","face","clothing","trousers","shoes"] as const;
export const QUICK_SELECT_SCENE_PARTS=["sky","building","tree","car","animal"] as const;
export function quickSelectPlan(personFound:boolean):string[]{return [...(personFound?QUICK_SELECT_PERSON_PARTS:QUICK_SELECT_SCENE_PARTS)];}
/** Two masks that cover nearly the same pixels are one region for a click (intersection over union). */
export function sameRegion(a:Pick<ObjectRegion,"alpha"|"area">,b:Pick<ObjectRegion,"alpha"|"area">):boolean{
  let both=0;for(let i=3;i<a.alpha.length;i+=4)if(a.alpha[i]>127&&b.alpha[i]>127)both++;
  return both/Math.max(1,a.area+b.area-both)>.9;
}
/** Smallest overlapping instance wins, so a foreground object remains reachable. */
export function hitObject(regions:Pick<ObjectRegion,"alpha"|"area">[],x:number,y:number,w:number,h:number):number{
  x=Math.floor(x);y=Math.floor(y);if(x<0||y<0||x>=w||y>=h)return -1;
  let best=-1,area=Infinity;for(let i=0;i<regions.length;i++)if(regions[i].alpha[(y*w+x)*4+3]>127&&regions[i].area<area){area=regions[i].area;best=i;}return best;
}
/** Selection/active-layer changes do not invalidate analysis; rendered content changes do. */
export function imageSignature(doc:Doc):string{return JSON.stringify([doc.width,doc.height,doc.layers,doc.groups??{}]);}
