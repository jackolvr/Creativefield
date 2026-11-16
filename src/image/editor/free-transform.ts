import {updateLayer,type Doc,type Layer} from "./doc";
import {blankCanvas,getBitmap,setBitmap,sizeOf} from "./bitmaps";

/** Bounds of the pixels that are not fully transparent, or null when there are none. */
export function alphaBounds(data:Uint8ClampedArray,width:number,height:number):{x:number;y:number;w:number;h:number}|null{
  let x0=width,y0=height,x1=-1,y1=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]>0){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  return x1<0?null:{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
}

/** The layer cut to a part of its bitmap, drawn exactly where that part was: the new centre follows the
 * layer's flip, scale and rotation. */
export function trimmedGeometry(layer:Layer,part:{x:number;y:number;w:number;h:number}):Pick<Layer,"x"|"y"|"w"|"h">{
  const s=layer.scale||1,a=layer.rotation*Math.PI/180;
  let dx=(part.x+part.w/2-layer.w/2)*s,dy=(part.y+part.h/2-layer.h/2)*s;
  if(layer.flipX)dx=-dx;
  return {x:layer.x+dx*Math.cos(a)-dy*Math.sin(a),y:layer.y+dx*Math.sin(a)+dy*Math.cos(a),w:part.w,h:part.h};
}

/** Photoshop transforms the visible pixels, not the layer's whole canvas: before Free transform the layer is
 * cut to its non-transparent bounds, so the box sits on the content. Returns null when nothing would change. */
export function trimLayerToContent(doc:Doc,id:string):Doc|null{
  const layer=doc.layers.find(item=>item.id===id),bitmap=layer&&getBitmap(layer.src);
  if(!layer||!bitmap||layer.kind==="adjust"||layer.smartObject)return null;
  const {w,h}=sizeOf(bitmap),source=blankCanvas(w,h),ctx=source.getContext("2d",{willReadFrequently:true})!;
  ctx.drawImage(bitmap,0,0);
  let part:ReturnType<typeof alphaBounds>;
  try{part=alphaBounds(ctx.getImageData(0,0,w,h).data,w,h);}catch{return null;}
  if(!part||(part.w===w&&part.h===h))return null;
  const cut=blankCanvas(part.w,part.h);cut.getContext("2d")!.drawImage(source,part.x,part.y,part.w,part.h,0,0,part.w,part.h);
  const key=`bmp:trim${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;setBitmap(key,cut);
  return updateLayer(doc,id,{src:key,...trimmedGeometry({...layer,w,h},part)});
}
export type TransformHandle="move"|"rotate"|"nw"|"ne"|"se"|"sw";
export type TransformPoint={x:number;y:number};
const corner=(handle:TransformHandle)=>({x:handle.includes("w")?-1:1,y:handle.includes("n")?-1:1});
export function transformCorner(layer:Layer,handle:TransformHandle):TransformPoint{
  const c=corner(handle),x=c.x*layer.w*layer.scale/2,y=c.y*layer.h*layer.scale/2,a=layer.rotation*Math.PI/180;
  return {x:layer.x+x*Math.cos(a)-y*Math.sin(a),y:layer.y+x*Math.sin(a)+y*Math.cos(a)};
}
export function dragLayerTransform(layer:Layer,handle:TransformHandle,start:TransformPoint,point:TransformPoint,{center=false,snap=false}={}):Layer{
  if(layer.locks?.position)return layer;
  const dx=point.x-start.x,dy=point.y-start.y;if(!dx&&!dy)return layer;
  if(handle==="move")return {...layer,x:layer.x+dx,y:layer.y+dy};
  if(handle==="rotate"){
    let rotation=layer.rotation+(Math.atan2(point.y-layer.y,point.x-layer.x)-Math.atan2(start.y-layer.y,start.x-layer.x))*180/Math.PI;
    if(snap)rotation=Math.round(rotation/15)*15;
    return {...layer,rotation:((rotation+180)%360+360)%360-180};
  }
  const edge=transformCorner(layer,handle),anchor=center?{x:layer.x,y:layer.y}:{x:2*layer.x-edge.x,y:2*layer.y-edge.y};
  const vx=edge.x-anchor.x,vy=edge.y-anchor.y,denom=vx*vx+vy*vy;
  if(!denom)return layer;
  const scale=Math.max(Math.min(.01,layer.scale),Math.min(10000,layer.scale*(1+(dx*vx+dy*vy)/denom))),factor=scale/layer.scale;
  return {...layer,scale,x:center?layer.x:anchor.x+vx*factor/2,y:center?layer.y:anchor.y+vy*factor/2};
}
export function applyLayerTransform(doc:Doc,id:string,layer:Layer):Doc{
  const before=doc.layers.find(item=>item.id===id);if(!before||before.locks?.position)return doc;
  const patch={x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation};
  if(layer.scale<=0||Object.entries(patch).some(([,value])=>!Number.isFinite(value)))return doc;
  return Object.entries(patch).every(([key,value])=>before[key as keyof Layer]===value)?doc:updateLayer(doc,id,patch);
}
