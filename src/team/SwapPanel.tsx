/* Swap a thing, one standard panel (DOC-2191,): your clip, optional pictures, one sentence and the usual
   settings. The app routes (routeSwap) and runs the unchanged workflows (swap-flow): the person's own picture is used
   as it is; without one, the picture of the new thing is made from one frame of the clip. One quiet line under the
   button says what will happen; Details lets the person pick another way when the guess is wrong. */
import {useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import {Maximize2,Timer} from "lucide-react";
import {Button,Collapsible,GenerateButton,Meta,Notice,ParamButton,Params,PromptField,SegmentedTabs,UploadSlot} from "../ds";
import {assetUrl,composerAssets,workspacePath,type Asset,type Call,type Project,type Workspace} from "./api";
import {TeamMediaInput} from "./TeamMediaInput";
import {routeSwap,type SwapRoute} from "./intent/swap-route";
import {referenceFromClip,swapStep,type SwapPicks} from "./swap-flow";
import {cancelSwapRun,runSwapAttempt} from "./swap-run";
import {aboutTime} from "./RunDevelop";

const ROUTES:{id:Exclude<SwapRoute,"picture">;label:string}[]=[{id:"thing",label:"One thing"},{id:"person",label:"A person"},{id:"look",label:"The whole look"}];
/** Seconds of your clip to change, 1 to 15 like Create Video; a shorter clip is changed whole. */
const LENGTHS=Array.from({length:15},(_,index)=>index+1),SIZES=["480p","576p","736p"];
const MAX_PICTURES=4;

export function SwapPanel({workspace,project,call,canEdit,picks,onChanged,top}:{workspace:Workspace;project:Project;call:Call;canEdit:boolean;
  /** The workflows this computer can use, chosen by the manifests (swapPicks). */picks:SwapPicks;onChanged:()=>void;/** The Change switcher. */top?:ReactNode}){
  const [assets,setAssets]=useState<Asset[]>([]),[video,setVideo]=useState(""),[pictures,setPictures]=useState<string[]>([]),[sentence,setSentence]=useState("");
  const [seconds,setSeconds]=useState(5),[size,setSize]=useState("576p"),[override,setOverride]=useState<Exclude<SwapRoute,"picture">|"">("");
  const [doing,setDoing]=useState(""),[error,setError]=useState(""),[runId,setRunId]=useState<string|null>(null),[cancelling,setCancelling]=useState(false);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{void composerAssets(call,workspace.id,project.id,[video,...pictures].filter(Boolean)).then(page=>{if(alive.current)setAssets(page.items);}).catch(()=>{});},[workspace.id,project.id]);

  const ability={editFrame:!!picks.edit,fromWords:!!picks.words};
  const decision=useMemo(()=>routeSwap({source:video?"video":undefined,references:pictures.map(()=>({})),text:sentence},ability),[video,pictures,sentence,ability.editFrame,ability.fromWords]);
  const route=decision.ready?(override||(decision.route==="picture"?"thing":decision.route)):undefined;
  const pick=route?picks[route]:undefined;
  // A person needs pictures of the new person; the line asks for them instead of making one up.
  const missing=!decision.ready?decision.say:!pick?"This kind of change is not set up on this computer.":route==="person"&&!pictures.length?"Add a picture of the new person.":decision.picture==="ask"&&!pictures.length?"Add a picture of what it should become.":"";
  const line=decision.ready&&!missing?(override?`${ROUTES.find(item=>item.id===override)!.label}: as you picked under Details.`:decision.say):"";

  /* How long this usually takes here: the routed workflow's history, at least a minute per second of video. */
  const [usual,setUsual]=useState<string>();
  useEffect(()=>{if(!pick){setUsual(undefined);return;}let current=true;const q=new URLSearchParams({capabilityId:pick.manifest.id,seconds:String(seconds)});
    void call<{estimate:{seconds:number}|null}>(workspacePath(workspace.id,`run-estimate?${q}`)).then(body=>{if(current)setUsual(body.estimate?aboutTime(body.estimate.seconds):undefined);},()=>{});
    return()=>{current=false;};},[pick?.manifest.id,seconds,workspace.id]);
  async function upload(file:File,kind:"image"|"video"){
    const form=new FormData();form.append("file",file);
    const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${encodeURIComponent(project.id)}&kind=${kind}`),"POST",form);
    setAssets(old=>[asset,...old.filter(item=>item.id!==asset.id)]);onChanged();return asset.id;
  }
  /* One attempt at a time: a second press while one runs does nothing (state updates arrive a tick later). */
  const running=useRef(false);
  async function generate(){
    if(!decision.ready||!route||!pick||missing||running.current)return;
    running.current=true;setError("");setCancelling(false);const requestId=crypto.randomUUID();
    /* The swap goes on when the person opens another screen in this tab: only the panel's own display stops
       (`alive` guards the setters, not the runs). Surviving a closed tab needs the server chain (DOC-2191). */
    const common={call,workspaceId:workspace.id,projectId:project.id,requestId,onStep:(label:string)=>{if(alive.current)setDoing(label);},onRun:(id:string|null)=>{if(alive.current)setRunId(id);},alive:()=>true};
    try{
      // Never over the person's own pictures: only a missing picture is made, from the clip first.
      let used=pictures;
      if(!used.length&&route!=="person")used=[(await referenceFromClip({...common,video,target:decision.target,sentence,segment:picks.segment,edit:picks.edit,words:picks.words})).asset];
      await runSwapAttempt({...common,workerId:pick.workerId,steps:[swapStep(route,pick,{video,pictures:used,target:decision.target,sentence,seconds,resolution:size})],onChanged});
    }catch(cause){if(alive.current&&!cancelling)setError((cause as Error).message);}
    finally{running.current=false;if(alive.current)setDoing("");onChanged();}
  }
  async function cancel(){if(!runId)return;setCancelling(true);try{await cancelSwapRun(call,workspace.id,runId);}catch(cause){setError((cause as Error).message);setCancelling(false);}}

  const locked=!!doing||!canEdit,source=assets.find(asset=>asset.id===video);
  return <div className="cf-form">
    {top}
    <TeamMediaInput projectId={project.id} label="Your video" type="video" hint="Drop the clip to change" file={null} selected={source} options={assets.filter(asset=>asset.media_type==="video")} disabled={locked}
      onFile={file=>{if(file)void upload(file,"video").then(setVideo).catch(cause=>setError((cause as Error).message));}} onSelect={setVideo} onUpload={()=>{}} canUpload={canEdit} workspace={workspace.id}/>
    {[...pictures,""].slice(0,MAX_PICTURES).map((id,index)=><UploadSlot key={id||`empty-${index}`} label={index===0?"Pictures":""} hint={index===0?"Optional: a person, a thing or a look":"Optional"}
      accept="image/png,image/jpeg,image/webp" kinds={["image"]} preview={id?assetUrl(workspace.id,id):undefined} disabled={locked}
      // An empty file clears the slot; a new one replaces its picture or adds one.
      onFile={file=>{if(!file){if(id)setPictures(old=>old.filter(item=>item!==id));return;}void upload(file,"image").then(next=>setPictures(old=>id?old.map(item=>item===id?next:item):[...old,next])).catch(cause=>setError((cause as Error).message));}}
      onAsset={next=>setPictures(old=>id?old.map(item=>item===id?next:item):[...old,next])}/>)}
    <PromptField label="What should change" value={sentence} disabled={locked} onChange={setSentence} placeholder="Make the bike yellow. Remove the glass bottle. Change the lighting."/>
    <Params>
      <ParamButton title="Length" icon={<Timer size={16}/>} label={`${seconds} s`} value={seconds} options={LENGTHS.map(value=>({value,label:`${value} s`}))} onChange={setSeconds} disabled={locked}/>
      <ParamButton title="Size" icon={<Maximize2 size={16}/>} label={size} value={size} options={SIZES.map(value=>({value,label:value}))} onChange={setSize} disabled={locked}/>
    </Params>
    <Collapsible title="Details">
      <SegmentedTabs quiet label="Way" value={override||"auto"} onChange={value=>setOverride(value==="auto"?"":value as Exclude<SwapRoute,"picture">)} items={[{id:"auto",label:"Automatic"},...ROUTES]}/>
    </Collapsible>
    {error&&<Notice priority={25} title="The change didn't finish" details={error} actions={<Button variant="secondary" disabled={locked} onClick={()=>void generate()}>Try again</Button>}>Nothing else changed in your clip.</Notice>}
    <GenerateButton label={doing?"Generating…":"Generate"} estimate={doing?undefined:usual} busy={!!doing} disabled={locked||!!missing||!decision.ready} disabledReason={missing||undefined} onClick={()=>void generate()}/>
    {doing?<Meta>{doing}</Meta>:line?<Meta>{line}</Meta>:missing?<Meta>{missing}</Meta>:null}
    {runId&&<Button variant="secondary" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?"Cancelling…":"Cancel"}</Button>}
  </div>;
}
