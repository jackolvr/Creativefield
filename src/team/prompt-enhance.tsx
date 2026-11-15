import {useState} from "react";
import {Sparkles} from "lucide-react";
import {Button,InfoButton,Meta,ShimmerText} from "../ds";
import {workspacePath,type Call} from "./api";

/** One shared prompt enhancer for images and videos: the server's Qwen3.5 9B caption model.
 *  Every prompt field imports this hook and button, so there is one request path and one wording. */
export function usePromptExpander({call,workspaceId,getPrompt,setPrompt,disabled=false,notify}:{
  call:Call;
  workspaceId:string;
  getPrompt:()=>string;
  setPrompt:(text:string)=>void;
  disabled?:boolean;
  notify?:(message:string)=>void;
}){
  const [busy,setBusy]=useState(false);
  const run=async()=>{
    if(disabled||busy)return;
    const text=getPrompt().trim();
    if(!text){notify?.("Write a prompt first.");return;}
    setBusy(true);
    try{
      const result=await call<{text:string;seconds?:number}>(workspacePath(workspaceId,"prompt-expand"),"POST",{prompt:text});
      setPrompt(result.text);
      notify?.(`Prompt expanded${result.seconds?` in ${result.seconds} s`:""}`);
    }catch(error){notify?.((error as Error).message);}
    finally{setBusy(false);}
  };
  return {busy,run};
}

/** The button and explanation that every prompt field shows in the same place. */
export function PromptEnhanceTools({busy,run,disabled}:{busy:boolean;run:()=>void;disabled?:boolean}){
  return <>
    <Button variant="ghost" disabled={disabled||busy} onClick={run}>
      <Sparkles size={14}/>{busy?<ShimmerText>Enhancing prompt</ShimmerText>:"Enhance prompt"}
    </Button>
    <InfoButton title="Prompt enhancement">
      <Meta>One shared local caption model (Qwen3.5 9B) enhances prompts for images and videos — no cloud, no per-workflow model.</Meta>
      <Meta>It keeps your concrete parts and adds visible detail; Midjourney flags like --ar are removed before the model reads it.</Meta>
    </InfoButton>
  </>;
}
