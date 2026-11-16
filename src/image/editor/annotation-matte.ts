import {imageAnnotationsSchema,type ImageAnnotation} from "../annotations";
import {blankCanvas} from "./bitmaps";
import {freezeModifyMatte,type ModifyMatte} from "./ai-layer";
import type {Doc} from "./doc";

/** The inner fade of an annotation box in pixels: about 4 % of its short side, 2 to 24 px, none under 64 px. Pure. */
export function annotationFeather(width:number,height:number):number{
  const side=Math.min(width,height);
  return side<64?0:Math.max(2,Math.min(24,Math.round(side*.04)));
}

/** Restrict the new result layer to the union of the requested regions.
 * Preserve composite transparency as well as all pixels outside the boxes. */
export function annotationMatte(doc:Doc,regions:ImageAnnotation[]):ModifyMatte {
  const boxes=imageAnnotationsSchema.parse(regions);
  const matte=freezeModifyMatte({...doc,selection:null},"composite");
  const mask=blankCanvas(doc.width,doc.height),ctx=mask.getContext("2d")!;
  let x0=doc.width,y0=doc.height,x1=0,y1=0;
  for(const box of boxes){
    const x=Math.floor(box.x*doc.width),y=Math.floor(box.y*doc.height);
    const right=Math.min(doc.width,Math.ceil((box.x+box.w)*doc.width));
    const bottom=Math.min(doc.height,Math.ceil((box.y+box.h)*doc.height));
    // A real-sized box fades in over its inner edge, so a slight shift in the model's light leaves no seam;
    // the fade lies inside the box, so nothing outside it ever changes. Small boxes keep a hard edge.
    const feather=annotationFeather(right-x,bottom-y);
    ctx.filter=feather?`blur(${feather/2}px)`:"none";
    ctx.fillRect(x+feather,y+feather,right-x-2*feather,bottom-y-2*feather);ctx.filter="none";
    x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,right);y1=Math.max(y1,bottom);
  }
  const target=matte.canvas.getContext("2d")!;target.globalCompositeOperation="destination-in";target.drawImage(mask,0,0);
  return {canvas:matte.canvas,bounds:{x:x0,y:y0,w:x1-x0,h:y1-y0}};
}
