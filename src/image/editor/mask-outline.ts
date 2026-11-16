import {blankCanvas,sizeOf,type Bitmap} from "./bitmaps";
export type Edge=[number,number,number,number];
/** Exposed pixel boundaries, including holes. The mask itself is never modified. */
export function maskEdges(data:Uint8ClampedArray,w:number,h:number,threshold=8):Edge[]{
  if(data.length!==w*h*4)throw new Error("Invalid mask dimensions");
  const edges:Edge[]=[],at=(x:number,y:number)=>x>=0&&y>=0&&x<w&&y<h&&data[(y*w+x)*4+3]>threshold;
  for(let y=0;y<=h;y++){
    let start=-1;
    for(let x=0;x<=w;x++){
      const edge=x<w&&at(x,y-1)!==at(x,y);
      if(edge&&start<0)start=x;
      if(!edge&&start>=0){edges.push([start,y,x,y]);start=-1;}
    }
  }
  for(let x=0;x<=w;x++){
    let start=-1;
    for(let y=0;y<=h;y++){
      const edge=y<h&&at(x-1,y)!==at(x,y);
      if(edge&&start<0)start=y;
      if(!edge&&start>=0){edges.push([x,start,x,y]);start=-1;}
    }
  }
  return edges;
}
const cache=new WeakMap<Bitmap,{revision:number;path:Path2D}>();
/** The selection glint moves on this tick; short enough to glide, not a frame-rate repaint. */
export const OUTLINE_FRAME_MS=70;
export const OUTLINE_PHASES=8;
/** The mask's outline as a path in its own pixels, computed once per bitmap and revision. */
export function maskOutlinePath(bitmap:Bitmap,revision=0):Path2D{
  let entry=cache.get(bitmap);
  if(!entry||entry.revision!==revision){
    const {w,h}=sizeOf(bitmap),copy=blankCanvas(w,h),c=copy.getContext("2d",{willReadFrequently:true})!;c.drawImage(bitmap,0,0);
    const path=new Path2D();for(const [x,y,x2,y2] of maskEdges(c.getImageData(0,0,w,h).data,w,h)){path.moveTo(x,y);path.lineTo(x2,y2);}
    entry={revision,path};cache.set(bitmap,entry);
  }
  return entry.path;
}
/** A selection: a thin accent line with a light glint travelling along it, instead of black and white ants.
 * `strength` dims it for regions that are only offered (Quick select hover). */
export function drawSelectionShimmer(ctx:CanvasRenderingContext2D,bitmap:Bitmap,revision:number,pixel:number,accent:string,strength=1){
  const path=maskOutlinePath(bitmap,revision),travel=(performance.now()/12)%120;
  ctx.save();ctx.lineJoin="round";ctx.lineCap="round";
  ctx.globalAlpha=.85*strength;ctx.lineWidth=1.25*pixel;ctx.strokeStyle=accent;ctx.stroke(path);
  ctx.globalAlpha=.9*strength;ctx.lineWidth=1.5*pixel;ctx.strokeStyle="#ffffff";ctx.setLineDash([14*pixel,106*pixel]);ctx.lineDashOffset=-travel*pixel;ctx.stroke(path);
  ctx.restore();
}
export function drawMaskOutline(ctx:CanvasRenderingContext2D,bitmap:Bitmap,revision:number,pixel:number,light:string,dark:string,phase=0){
  const path=maskOutlinePath(bitmap,revision);
  ctx.save();ctx.lineWidth=2*pixel;ctx.strokeStyle=dark;ctx.stroke(path);
  ctx.lineWidth=pixel;ctx.strokeStyle=light;ctx.setLineDash([4*pixel,4*pixel]);ctx.lineDashOffset=-phase*pixel;ctx.stroke(path);ctx.restore();
}
