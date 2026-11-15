import {lazy,Suspense,useEffect,useMemo,useRef,useState} from "react";
import {Block,Button,Dialog,LinkButton,Meta,Notice,PromptField,SegmentedTabs,StatusText,Toolbar} from "../ds";
import {workspacePath,type Call,type Project,type Worker,type Workspace} from "../team/api";
import type {VideoHandoff} from "../capabilities/shot-direction";
import {scanReferenceClip} from "./analysis-client";
import {shotBatches,type AnalysisScan,type ShotDecision} from "./analysis-contract";
import {shotBrief} from "./shot-brief";
import {decideShotsWithVision} from "./decision";
import {evaluateFrame} from "./score/evaluate";
import {parseStageScore} from "./score/parse";
import {synthesizeMeasuredPlan} from "./geometry-synthesis";
import {planToScoreYaml} from "./score-build";
import {requestGeometryBatch} from "./analysis-client";
import "./film-studio.css";

const LegacyFilmStudio=lazy(async()=>({default:(await import("./FilmStudio")).LegacyFilmStudio}));
const StageViewport=lazy(async()=>({default:(await import("./stage/StageViewport")).StageViewport}));

export type H3FilmStudioProps={
  workspace:Workspace;
  project:Project;
  call:Call;
  canCreate:boolean;
  onOpenShotGenerator:()=>void;
  onSendToVideo?:(assetId:string,handoff?:VideoHandoff)=>void;
};

type H3Take={id:string;file:string;subfolder:string;frames?:number};
type H3Clip={id:string;name:string;kind?:string;seconds?:number;active?:string;takes?:H3Take[]};
type H3Project={clips?:H3Clip[]};

const projectName=(id:string)=>`cf-${id}`;
const takeOf=(clip:H3Clip)=>clip.takes?.find(take=>take.id===clip.active)??clip.takes?.[0];
const shotWords=(scan:AnalysisScan)=>{
  const lines=[`Reference analysis: ${scan.shots.length} shot${scan.shots.length===1?"":"s"}, ${scan.clip.durationSec.toFixed(1)} s.`];
  for(const decision of scan.decisions){
    lines.push(`Shot ${decision.shotIndex+1}: ${decision.people} ${decision.people===1?"person":"people"}, ${decision.size} shot, ${decision.motion} camera.`);
  }
  for(const geometry of scan.geometries){
    if(geometry.quality==="estimated")continue;
    const camera=geometry.camera;
    lines.push(`Shot ${geometry.shotIndex+1}: ${Math.round(camera.lensMm)} mm, ${Math.round(camera.fovDeg)}Ãƒâ€šÃ‚Â° horizontal, camera ${camera.heightM.toFixed(1)} m high, ${Math.round(camera.pitchDeg)}Ãƒâ€šÃ‚Â° pitch.`);
  }
  return lines.join("\n");
};
type BriefEntry={label:string;shotNumber:number;brief:ReturnType<typeof shotBrief>};
const blockingLines=(scan:AnalysisScan)=>scan.geometries.flatMap(geometry=>{
  const lines:string[]=[];
  for(const person of geometry.persons){
    const first=person.keyframes[0],last=person.keyframes[person.keyframes.length-1];
    const start=first?`${first.xM.toFixed(1)} m right, ${first.zM.toFixed(1)} m forward`:"position unknown";
    const end=last&&last!==first?`, ends ${last.xM.toFixed(1)} m right, ${last.zM.toFixed(1)} m forward`:"";
    lines.push(`${person.label??"Person"}: ${person.heightM.toFixed(2)} m tall, starts ${start}${end}.`);
  }
  if(!geometry.persons.length)lines.push(`Shot ${geometry.shotIndex+1}: no person measured.`);
  return lines;
});
const measurementLines=(scan:AnalysisScan)=>scan.geometries.flatMap(geometry=>{
  const camera=geometry.camera;
  const level=geometry.quality==="estimated"?"estimated":`${Math.round(geometry.floor.confidence*100)}% floor confidence`;
  return [`Shot ${geometry.shotIndex+1}: ${Math.round(camera.lensMm)} mm Ãƒâ€šÃ‚Â· ${Math.round(camera.fovDeg)}Ãƒâ€šÃ‚Â° horizontal Ãƒâ€šÃ‚Â· ${camera.heightM.toFixed(2)} m high Ãƒâ€šÃ‚Â· ${Math.round(camera.pitchDeg)}Ãƒâ€šÃ‚Â° pitch Ãƒâ€šÃ‚Â· ${level}`];
});

/** Film Studio, hosted on the H3 Editor custom node of the HyperFlow H3 Flash worker.
 *  CreativeField maps the open project to cf-<projectId>, and this host adds the video-analysis
 *  bridge: it reads H3 clips through the workspace API and writes the analysis back as a note. */
export function H3FilmStudio({workspace,project,call,canCreate,onOpenShotGenerator,onSendToVideo}:H3FilmStudioProps){
  const [origin,setOrigin]=useState("");
  const [worker,setWorker]=useState<Worker|null>(null);
  const [error,setError]=useState("");
  const [legacy,setLegacy]=useState(false);
  const [clips,setClips]=useState<H3Clip[]>([]);
  const [analysisOpen,setAnalysisOpen]=useState(false);
  const [scanning,setScanning]=useState(false);
  const [measuring,setMeasuring]=useState(false);
  const [analysisStage,setAnalysisStage]=useState("");
  const [scan,setScan]=useState<AnalysisScan|null>(null);
  const [scanClip,setScanClip]=useState<H3Clip|null>(null);
  const [analysisError,setAnalysisError]=useState("");
  const [noteSaved,setNoteSaved]=useState(false);
  const [analysisTab,setAnalysisTab]=useState<"brief"|"blocking"|"measurements">("brief");
  const [briefDraft,setBriefDraft]=useState("");
  const retry=useRef<number|undefined>(undefined);
  const name=projectName(project.id);
  const briefs=useMemo<BriefEntry[]|null>(()=>{
    if(!scan)return null;
    const parsed=parseStageScore(scan.scoreYaml);
    if(!parsed.score)return null;
    const score=parsed.score;
    return score.shots.map(shot=>({label:shot.label,shotNumber:shot.shotNumber,brief:shotBrief(score,shot,{sound:true})}));
  },[scan]);
  const briefLines=useMemo(()=>{
    if(!scan)return [];
    if(briefs?.length)return briefs.map(entry=>[`Shot ${entry.shotNumber}: ${entry.label}`, `${entry.brief.camera.move}; ${Math.round(entry.brief.camera.lensMm)} mm; ${entry.brief.camera.angle}.`, ...entry.brief.subjects.map(subject=>`${subject.label}: ${subject.side}, ${subject.framing}, ${subject.action}.`)].join("\n"));
    return [shotWords(scan)];
  },[scan,briefs]);
  const blockingScore=useMemo(()=>{
    if(!scan||!scan.decisions.length)return null;
    try{
      const windows=scan.shots.map(shot=>({shotIndex:shot.index,startSec:shot.startSec,endSec:shot.endSec}));
      const synthesized=synthesizeMeasuredPlan({decisions:scan.decisions,geometries:scan.geometries,shots:windows,title:scanClip?.name??"H3 clip",aspectRatio:scan.clip.aspectRatio,cuts:scan.clip.cuts});
      const built=planToScoreYaml(synthesized.plan,{durationSec:scan.clip.durationSec,aspectRatio:scan.clip.aspectRatio,cuts:scan.clip.cuts});
      return parseStageScore(built.yaml).score??null;
    }catch{return null;}
  },[scan,scanClip]);
  useEffect(()=>{if(!scanning&&!measuring)setBriefDraft(briefLines.join("\n\n"));},[briefLines,scanning,measuring]);

  useEffect(()=>{
    let current=true;
    void call<Worker[]>(workspacePath(workspace.id,"workers")).then(workers=>{
      const local=workers.filter(item=>item.enabled&&(item as Worker&{kind?:string}).kind!=="cloud");
      const preferred=local.find(item=>/HyperFlow H3 Flash/i.test(item.name))??local.find(item=>/H3/i.test(item.name))??local[0];
      if(!current)return;
      if(!preferred){setError("No local HyperFlow H3 Flash worker is connected. Open Settings to connect it.");return;}
      setWorker(preferred);
      setOrigin(preferred.origin.replace(/\/+$/,""));
    }).catch(cause=>{if(current)setError((cause as Error).message);});
    return()=>{current=false;};
  },[call,workspace.id]);

  useEffect(()=>{
    if(!origin)return;
    let live=true;
    const load=async()=>{
      try{
        const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}`,{credentials:"same-origin"});
        if(response.status===404){if(live)retry.current=window.setTimeout(load,1500);return;}
        if(!response.ok)throw new Error("The H3 project could not be read.");
        const data=await response.json() as H3Project;
        if(live)setClips((data.clips??[]).filter(clip=>takeOf(clip)));
      }catch{/* the editor may still be creating the project; the analysis dialog retries on open */}
    };
    void load();
    return()=>{live=false;if(retry.current)window.clearTimeout(retry.current);};
  },[origin,workspace.id,name]);

  async function refreshClips(){
    const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}`,{credentials:"same-origin"});
    if(!response.ok)throw new Error("The H3 project is not ready. Open a project in the editor first.");
    const data=await response.json() as H3Project;
    const next=(data.clips??[]).filter(clip=>takeOf(clip));
    setClips(next);
    return next;
  }

  async function openAnalysis(){
    setAnalysisOpen(true);setAnalysisError("");setNoteSaved(false);
    try{await refreshClips();}catch(cause){setAnalysisError((cause as Error).message);}
  }

  async function analyse(clip:H3Clip){
    const take=takeOf(clip);
    if(!take)return;
    setScanning(true);setAnalysisError("");setScan(null);setScanClip(clip);setNoteSaved(false);setAnalysisTab("brief");setAnalysisStage("Scanning the clip");
    try{
      const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/media?filename=${encodeURIComponent(take.file)}&subfolder=${encodeURIComponent(take.subfolder)}`,{credentials:"same-origin"});
      if(!response.ok)throw new Error("The clip file is not available.");
      const result=await scanReferenceClip(workspace.id,await response.blob(),{filename:take.file});
      setScan(result);
      if(result.pending.decisions){
        setAnalysisStage("Reading the shots");
        let decisions:ShotDecision[]=[...result.decisions];
        for(const batch of shotBatches(result.shots.length)){
          const pending=batch.indices.filter(index=>!decisions.some(decision=>decision.shotIndex===index));
          const frames:string[]=[];const indices:number[]=[];
          for(const index of pending){const shotFrames=result.shots[index]?.frames??[];const frame=shotFrames[Math.floor((shotFrames.length-1)/2)];if(frame){frames.push(frame);indices.push(index);}}
          const vision=await decideShotsWithVision(workspace.id,frames,indices);
          if(!vision)break;
          const fresh:ShotDecision[]=vision.decisions.map(({index,decision})=>({shotIndex:index,people:decision.people,size:decision.size,motion:decision.motion,needsStaging:Math.max(0,Math.round(decision.needsStaging))}));
          decisions=[...decisions,...fresh].sort((left,right)=>left.shotIndex-right.shotIndex);
          setScan(current=>current?{...current,decisions}:current);
        }
      }
    }catch(cause){setAnalysisError((cause as Error).message);}
    finally{setScanning(false);setAnalysisStage("");}
  }

  async function measureGeometry(){
    if(!scan)return;
    setMeasuring(true);setAnalysisError("");setAnalysisStage("Measuring camera, floor and blocking");
    try{
      const result=await requestGeometryBatch(workspace.id,{cacheKey:scan.cacheKey,shotIndices:scan.shots.map(shot=>shot.index)});
      setScan(current=>current?{...current,geometries:result.geometries,skips:current.skips}:current);
    }catch(cause){setAnalysisError((cause as Error).message);}
    finally{setMeasuring(false);setAnalysisStage("");}
  }

  async function saveNote(){
    if(!scan||!scanClip)return;
    setAnalysisError("");
    try{
      const response=await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/h3-editor/project/${encodeURIComponent(name)}/notes`,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({clip:scanClip.id,frame:0,text:(briefDraft.trim()||briefLines.join("\n\n")).slice(0,3900)})});
      if(!response.ok)throw new Error("The note could not be saved in the H3 project.");
      setNoteSaved(true);
    }catch(cause){setAnalysisError((cause as Error).message);}
  }

  if(legacy)return <LegacyFilmStudio workspace={workspace} project={project} canCreate={canCreate} onOpenShotGenerator={onOpenShotGenerator} onSendToVideo={onSendToVideo}/>;
  return <div className="cf-h3studio">
    <Toolbar end={<><Meta>{worker?.name??"Looking for HyperFlow H3 Flash"}</Meta>{clips.length>0&&<Button variant="secondary" onClick={()=>void openAnalysis()}>Analyze clip</Button>}<Button variant="ghost" onClick={()=>setLegacy(true)}>Classic studio</Button>{origin&&<LinkButton variant="secondary" href={`/h3-editor/${workspace.id}/h3take/editor?project=${encodeURIComponent(name)}`}>Open in new tab</LinkButton>}</>}>
      <Meta>H3 Editor</Meta>
    </Toolbar>
    {error&&<Notice priority={10} title="The H3 Editor is not reachable" actions={<Button variant="secondary" onClick={()=>{setError("");setLegacy(true);}}>Use classic studio</Button>} details={error}>The editor runs inside the HyperFlow H3 Flash worker. Connect a local worker in Settings and try again.</Notice>}
    {origin
      ?<iframe className="cf-h3studio__frame" title="H3 Editor" src={`/h3-editor/${workspace.id}/h3take/editor?project=${encodeURIComponent(name)}&cf_project=${encodeURIComponent(project.id)}`} allow="clipboard-write; fullscreen"/>
      :!error&&<Meta>Looking for the HyperFlow H3 Flash workerÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</Meta>}
    <Dialog open={analysisOpen} title="Analyze an H3 clip" onClose={()=>setAnalysisOpen(false)} footer={<Button variant="secondary" onClick={()=>setAnalysisOpen(false)}>Close</Button>}>
      {analysisError&&<Notice priority={20} title="Analysis did not finish" details={analysisError}>The clip stays unchanged.</Notice>}
      {(scanning||measuring)&&<StatusText tone="active">{analysisStage||"Analysing the clip."}</StatusText>}
      {!scan&&!scanning&&<Block label="Clips"><div className="cf-h3analysis">{clips.map(clip=><Button key={clip.id} variant="secondary" onClick={()=>void analyse(clip)}>{clip.name||clip.id}</Button>)}</div>{!clips.length&&<Meta>Open a project with a rendered or imported clip in the editor first.</Meta>}</Block>}
      {scan&&scanClip&&<Block label={scanClip.name||scanClip.id}>
        <Meta parts={[`${scan.shots.length} shots`,`${scan.clip.durationSec.toFixed(1)} s`,`${scan.clip.width}ÃƒÆ’Ã¢â‚¬â€${scan.clip.height}`]}/>
        <SegmentedTabs items={[{id:"brief",label:"Shot brief"},{id:"blocking",label:"Blocking"},{id:"measurements",label:"Measurements"}]} value={analysisTab} onChange={setAnalysisTab} label="Analysis view" block/>
        {analysisTab==="brief"&&<div className="cf-h3analysis">{scan.decisions.length||scan.geometries.length?<PromptField label="Shot brief" value={briefDraft} onChange={setBriefDraft} placeholder="Write the brief for this clip." compact/>:<Meta>No brief yet. Analyse the clip first.</Meta>}</div>}
        {analysisTab==="blocking"&&<div className="cf-h3analysis">{blockingScore&&<div className="cf-h3blocking__stage"><Suspense fallback={null}><StageViewport score={blockingScore} frame={evaluateFrame(blockingScore,0)} view="free" labels="all" onNavigateStart={()=>{}}/></Suspense></div>}{scan.decisions.map(decision=><Meta key={`d${decision.shotIndex}`}>{`Shot ${decision.shotIndex+1}: ${decision.people} ${decision.people===1?"person":"people"}, ${decision.size} shot, ${decision.motion} camera.`}</Meta>)}{blockingLines(scan).map((line,index)=><Meta key={`p${index}`}>{line}</Meta>)}{!blockingLines(scan).length&&<Meta>Press Measure camera to place the people and the camera.</Meta>}</div>}
        {analysisTab==="measurements"&&<div className="cf-h3analysis">{measurementLines(scan).map((line,index)=><Meta key={`m${index}`}>{line}</Meta>)}{scan.skips.map(skip=><Meta key={`s${skip.shotIndex}`}>{`Shot ${skip.shotIndex+1}: ${skip.reason}`}</Meta>)}{!measurementLines(scan).length&&<Meta>No measurements yet. Press Measure camera.</Meta>}</div>}
        {scan.pending.geometry&&!measuring&&scan.geometries.length===0&&<Button variant="secondary" onClick={()=>void measureGeometry()}>Measure camera</Button>}{noteSaved?<StatusText tone="ok">Saved as a note at the clip's first frame.</StatusText>:<Button variant="primary" onClick={()=>void saveNote()}>Save brief as note</Button>}
      </Block>}
    </Dialog>
  </div>;
}
