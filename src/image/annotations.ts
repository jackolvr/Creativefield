import {z} from "zod";

export const imageAnnotationsSchema=z.array(z.object({
  x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),
  w:z.number().finite().positive().max(1),h:z.number().finite().positive().max(1),
  instruction:z.string().trim().min(1).max(500),
}).strict().refine(box=>box.x+box.w<=1.000001&&box.y+box.h<=1.000001,"Keep the box inside the image")).min(1).max(8);
export type ImageAnnotation=z.infer<typeof imageAnnotationsSchema>[number];
export const annotationStorageKey=(workspace:string,asset:string)=>`comfyfield.annotations.${workspace}.${asset}`;
export function annotationInstruction(boxes:ImageAnnotation[],prompt="") {
  const valid=imageAnnotationsSchema.parse(boxes);
  return `${prompt.trim()}\nImage 1 is the clean original. Image 2 is a guide: each region to edit is the bright, undimmed area inside a numbered frame; the frame and number sit outside the region. Treat every numbered instruction below as a required edit, not as text to draw. Apply ALL numbered edits to image 1 in one result, matching each instruction to its numbered box in image 2. Change only their indicated regions; keep the image size, composition and everything outside these regions unchanged. Do not include guide boxes, numbers or labels in the result.\n${valid.map((box,index)=>`Region ${index+1}: ${box.instruction}`).join("\n")}\nCoordinates are normalized from the top-left.\n${JSON.stringify(valid.map((box,index)=>({region:index+1,...box})))}`.trim();
}
/** One annotated region, edited on its own crop (every edit model can do this; no guide image to read
 *  or copy): the region is the middle of the picture the model gets, and the result is used only inside it. */
export function annotationCropInstruction(box:ImageAnnotation,prompt=""){
  const valid=imageAnnotationsSchema.parse([box])[0];
  return `${prompt.trim()}
Change only this, the object or area in the middle of the picture: ${valid.instruction}
Keep the framing, size, perspective, light and everything around it exactly as it is.`.trim();
}
/** Annotation boxes relative to a crop of the picture (pixels), clamped to it. Pure. */
export function annotationsInCrop(boxes:ImageAnnotation[],size:{width:number;height:number},crop:Box):ImageAnnotation[]{
  return boxes.map(box=>{
    const x=Math.max(0,(box.x*size.width-crop.x)/crop.w),y=Math.max(0,(box.y*size.height-crop.y)/crop.h);
    const right=Math.min(1,(box.x*size.width+box.w*size.width-crop.x)/crop.w),bottom=Math.min(1,(box.y*size.height+box.h*size.height-crop.y)/crop.h);
    return {...box,x,y,w:Math.max(1e-4,right-x),h:Math.max(1e-4,bottom-y)};
  });
}
type Box={x:number;y:number;w:number;h:number};
/**
 * Where a region's number goes on the guide: always OUTSIDE the box, so a model that copies the guide
 * into its result copies the number where the result is thrown away (the annotation matte keeps only
 * the box interiors). Above the box when there is room, else below, else left, else right; null when
 * the box fills the picture (the text still names the region). Pure, in pixels.
 */
export function guideLabelSpot(box:Box,size:{width:number;height:number},label:{w:number;h:number},gap:number):{x:number;y:number}|null{
  const x=Math.min(Math.max(0,box.x),Math.max(0,size.width-label.w)),y=Math.min(Math.max(0,box.y),Math.max(0,size.height-label.h));
  if(box.y-gap-label.h>=0)return {x,y:box.y-gap-label.h};
  if(box.y+box.h+gap+label.h<=size.height)return {x,y:box.y+box.h+gap};
  if(box.x-gap-label.w>=0)return {x:box.x-gap-label.w,y};
  if(box.x+box.w+gap+label.w<=size.width)return {x:box.x+box.w+gap,y};
  return null;
}
/** The guide is a separate reference. Never paint annotations onto the source. Inside each box the
 *  guide is the untouched picture; the frame, its number and a dimming lie outside the boxes only. */
export function annotationGuide(source:HTMLCanvasElement,boxes:ImageAnnotation[]) {
  const valid=imageAnnotationsSchema.parse(boxes),guide=document.createElement("canvas");
  guide.width=source.width;guide.height=source.height;const ctx=guide.getContext("2d")!;
  ctx.drawImage(source,0,0);
  const unit=Math.max(14,Math.round(Math.min(guide.width,guide.height)/35)),line=Math.max(2,Math.round(unit/7)),gap=line;
  const rects=valid.map(box=>({x:Math.floor(box.x*guide.width),y:Math.floor(box.y*guide.height),w:Math.ceil(box.w*guide.width),h:Math.ceil(box.h*guide.height)}));
  // Darken everything but the regions, so the places to change stand out without marks inside them.
  ctx.save();ctx.beginPath();ctx.rect(0,0,guide.width,guide.height);for(const r of rects)ctx.rect(r.x,r.y,r.w,r.h);
  ctx.fillStyle="rgba(0,0,0,0.45)";ctx.fill("evenodd");ctx.restore();
  ctx.strokeStyle="#2fa8ff";ctx.lineWidth=line;ctx.setLineDash([unit/2,unit/3]);ctx.font=`600 ${unit}px sans-serif`;
  rects.forEach((r,index)=>{
    // The whole stroke sits outside the box edge.
    const out=gap+line/2;ctx.strokeRect(r.x-out,r.y-out,r.w+2*out,r.h+2*out);
    const spot=guideLabelSpot(r,{width:guide.width,height:guide.height},{w:unit*1.6,h:unit*1.5},gap+line);
    if(!spot)return;
    ctx.fillStyle="#2fa8ff";ctx.fillRect(spot.x,spot.y,unit*1.6,unit*1.5);
    ctx.fillStyle="#101214";ctx.fillText(String(index+1),spot.x+unit*.35,spot.y+unit*1.1);
  });return guide;
}
