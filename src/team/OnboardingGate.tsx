import {useEffect, useState} from "react";
import {Button,Dialog,FormSection,Meta,Notice,StatusText,TextField} from "../ds";
import {workspacePath, type Call} from "./api";

type FolderState = {effective: string; exists: boolean; writable: boolean; freeBytes: number | null};
type OnboardingState = {
  completed: boolean;
  dismissed: boolean;
  modelsDirectory: string;
  modelsDirectoryChosen: string | null;
  folder: FolderState;
  system: {platform: string; arch: string; node: string; comfyWorkers: {total: number; online: number; names: string[]}};
};

const freeText = (bytes: number | null) => bytes === null ? "unknown" : `${(bytes / 1e9).toFixed(1)} GB free`;

/** First-run setup: says what this computer already has, asks once where models should live and keeps
 *  that choice on the server so every later download and repair uses the same folder. */
export function OnboardingGate({open,workspaceId,call,onClose}:{open: boolean; workspaceId: string; call: Call; onClose: () => void}) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [step, setStep] = useState<"welcome" | "folder" | "done">("welcome");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** What failed, so Try again repeats exactly that: reading this computer, or the save. */
  const [attempt, setAttempt] = useState<"load" | {completed: boolean; dismissed: boolean}>("load");

  const load = async () => {
    setBusy(true); setError(""); setAttempt("load");
    try {
      const next = await call<OnboardingState>(workspacePath(workspaceId, "onboarding"), "GET");
      setState(next); setFolder(next.modelsDirectory);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => { if (open) { setStep("welcome"); void load(); } }, [open, workspaceId]);

  const save = async (completed: boolean, dismissed: boolean) => {
    setBusy(true); setError(""); setAttempt({completed, dismissed});
    try {
      await call<OnboardingState>(workspacePath(workspaceId, "onboarding"), "PUT", {modelsDirectory: folder.trim() || null, completed, dismissed});
      onClose();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  const footer = step === "welcome"
    ? <><Button variant="ghost" disabled={busy} onClick={() => void save(false, true)}>Set up later</Button><Button variant="primary" disabled={busy || !state} onClick={() => setStep("folder")}>Continue</Button></>
    : step === "folder"
      ? <><Button variant="ghost" disabled={busy} onClick={() => setStep("welcome")}>Back</Button><Button variant="primary" disabled={busy || !folder.trim()} onClick={() => void save(true, false)}>{busy ? "Saving…" : "Finish setup"}</Button></>
      : null;

  return <Dialog open={open} title={step === "welcome" ? "Welcome to CreativeField" : "Where should models live?"} onClose={() => void save(false, true)} footer={footer}>
    {error && <Notice priority={10} title={attempt === "load" ? "This computer could not be checked" : "Setup could not be saved"} details={error}
      actions={<Button variant="secondary" disabled={busy} onClick={() => void (attempt === "load" ? load() : save(attempt.completed, attempt.dismissed))}>Try again</Button>}>Nothing was changed.</Notice>}
    {busy && !state && <Meta>Checking this computer…</Meta>}
    {step === "welcome" && state && <>
      <Notice tone="info" title="One folder for every model">CreativeField downloads and checks models here later, and every workflow searches the same place.</Notice>
      <FormSection title="This computer">
        <Meta>Node {state.system.node} · {state.system.platform}/{state.system.arch}</Meta>
        <Meta>ComfyUI: {state.system.comfyWorkers.online > 0 ? `${state.system.comfyWorkers.online} worker online${state.system.comfyWorkers.names.length ? ` (${state.system.comfyWorkers.names.join(", ")})` : ""}` : "not connected yet"}</Meta>
        <Meta>Models folder: {state.modelsDirectory} · {freeText(state.folder.freeBytes)}{state.folder.exists ? "" : " · will be created"}</Meta>
      </FormSection>
      <FormSection title="What happens next">
        <Meta>Choose the folder, then continue to the studio. Model downloads and the ComfyUI check follow in the install steps.</Meta>
      </FormSection>
    </>}
    {step === "folder" && state && <>
      <FormSection title="Models folder">
        <TextField label="Absolute folder path" value={folder} onChange={setFolder} disabled={busy} />
        <Meta>This is asked once and saved for this workspace. Downloads, checks and repairs use this exact folder. Leave the suggested path to keep everything inside CreativeField.</Meta>
      </FormSection>
      <Meta parts={[`${freeText(state.folder.freeBytes)} on this volume`, state.folder.exists ? "folder exists" : "folder will be created"]}/>
    </>}
    {step === "folder" && !state && error && <StatusText tone="warn">Folder check needs the setup state.</StatusText>}
  </Dialog>;
}
