import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member} from "./auth";

const querySchema=z.object({runId:z.uuid().optional(),capabilityId:z.string().min(1).max(200).optional(),quality:z.string().max(40).optional(),length:z.string().max(10).optional(),
  /** Seconds of video the run makes, when the settings say it (Swap's Length). */seconds:z.string().max(10).optional(),
  /** Steps that run on the made clip afterwards (Upscale, Smooth), as workflow ids, comma separated. */after:z.string().max(400).optional()}).strict();

/** Rule of thumb on this computer (user, 2026-11-15): about one minute of work per second of video. Short test runs pull
 *  the history down, so a video's estimate never goes below this. */
export const SECONDS_PER_VIDEO_SECOND=60;
/** The seconds of video a run makes, read from its own settings: Length (`length`) or the clip length to change
 *  (`source_seconds`). Undefined when the settings name no length (pictures, or a clip changed whole). */
export function videoSeconds(controls:Record<string,unknown>|undefined):number|undefined{
  for(const id of ["source_seconds","length"]){const value=Number(controls?.[id]);if(Number.isFinite(value)&&value>0&&value<=120)return value;}
  return undefined;
}
/** The estimate: the history's median, never below the per-second rule for a video, plus each later step's median. */
export function combineEstimate(median:number|undefined,seconds:number|undefined,steps:readonly (number|undefined)[]):number|undefined{
  const floor=seconds?seconds*SECONDS_PER_VIDEO_SECOND:0;
  const own=Math.max(median??0,floor);
  const total=own+steps.reduce<number>((sum,step)=>sum+(step??0),0);
  return total>0?Math.round(total):undefined;
}

/**
 * How long a job like this usually takes here: the median of the last finished runs of the same workflow,
 * with the same quality and length, or failing that the same quality. Another quality is never used: an HD finish takes far longer.
 * Submit to result, so a queue wait counts. For a video it is never below one minute per second of video, and the
 * steps that run on the made clip afterwards add their own medians. Null when there is nothing to go on.
 */
export async function runEstimate(pool:Pool,workspaceId:string,capabilityId:string,quality?:string,length?:string,extra:{seconds?:number;after?:readonly string[]}={}){
  const median=async(id:string,withLength:boolean,q?:string)=>(await pool.query<{seconds:number|null;samples:number}>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float AS seconds,count(*)::int AS samples FROM (
       SELECT extract(epoch FROM updated_at-created_at) AS seconds FROM runs
       WHERE workspace_id=$1 AND capability_id=$2 AND state='succeeded' AND deleted_at IS NULL
         AND coalesce(invocation->'controls'->>'quality','')=coalesce($4,'')
         AND ($3::boolean IS FALSE OR coalesce(invocation->'controls'->>'length','')=coalesce($5,''))
       ORDER BY created_at DESC LIMIT 20) recent WHERE seconds>0`,
    [workspaceId,id,withLength,q??null,length??null])).rows[0];
  const exact=await median(capabilityId,true,quality);
  const pick=exact&&exact.samples>0?exact:await median(capabilityId,false,quality);
  const own=pick&&pick.samples>0&&pick.seconds?pick.seconds:undefined;
  const steps=await Promise.all((extra.after??[]).map(async id=>{const step=await median(id,false);return step&&step.samples>0&&step.seconds?step.seconds:undefined;}));
  const seconds=combineEstimate(own,extra.seconds,steps);
  return seconds?{seconds,samples:pick?.samples??0}:null;
}

export async function runEstimateRoutes(app:FastifyInstance,pool:Pool){
  app.get("/api/v1/workspaces/:workspaceId/run-estimate",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId,"viewer");
    const q=querySchema.parse(request.query??{});
    if(q.runId){
      const run=(await pool.query("SELECT capability_id,invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,q.runId])).rows[0];
      if(!run)return {estimate:null};
      const c=run.invocation?.controls??{};
      const after=(run.invocation?.finishAfter??[]).map((step:{capabilityId?:unknown})=>String(step.capabilityId??"")).filter(Boolean);
      return {estimate:await runEstimate(pool,workspaceId,run.capability_id,c.quality==null?undefined:String(c.quality),c.length==null?undefined:String(c.length),{seconds:videoSeconds(c),after})};
    }
    if(!q.capabilityId)return {estimate:null};
    const seconds=videoSeconds({source_seconds:q.seconds,length:q.length});
    return {estimate:await runEstimate(pool,workspaceId,q.capabilityId,q.quality,q.length,{seconds,after:q.after?q.after.split(",").filter(Boolean):[]})};
  });
}
