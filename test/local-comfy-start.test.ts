import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalComfyStarter, managedLocalComfyFamily } from "../server/local-comfy-start";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "cf-start-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fakeLaunch() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const launch = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as never;
  return { calls, launch };
}

describe("managed ComfyUI starter", () => {
  const remote = "http://zitpoc-comfy:8188";
  it("recognises a remote worker only when the operator names its origin and a start script", () => {
    expect(managedLocalComfyFamily(remote, {})).toBeUndefined();
    expect(managedLocalComfyFamily(remote, { COMFYFIELD_COMFY_ORIGIN: remote })).toBeUndefined();
    expect(managedLocalComfyFamily(remote, { COMFYFIELD_COMFY_ORIGIN: remote, COMFYFIELD_COMFY_START_SCRIPT: "/x/start.sh" })).toBe("default");
    expect(managedLocalComfyFamily("http://elsewhere:8188", { COMFYFIELD_COMFY_ORIGIN: remote, COMFYFIELD_COMFY_START_SCRIPT: "/x/start.sh" })).toBeUndefined();
  });
  it("keeps the loopback default working", () => {
    expect(managedLocalComfyFamily("http://127.0.0.1:8188", {})).toBe("default");
  });
  it("runs a .sh hook with bash on Linux, without a shell and without arguments", async () => {
    const script = path.join(dir, "start.sh");
    await writeFile(script, "#!/usr/bin/env bash\nexit 0\n");
    const { calls, launch } = fakeLaunch();
    const start = createLocalComfyStarter({ root: dir, platform: "linux", launch, env: { COMFYFIELD_COMFY_ORIGIN: remote, COMFYFIELD_COMFY_START_SCRIPT: script } });
    expect(await start(remote)).toEqual({ state: "launch_requested" });
    expect(calls).toEqual([{ command: "bash", args: [script] }]);
  });
  it("debounces a second request for 30 s", async () => {
    const script = path.join(dir, "start.sh");
    await writeFile(script, "exit 0\n");
    const { calls, launch } = fakeLaunch();
    let t = 1000;
    const start = createLocalComfyStarter({ root: dir, platform: "linux", launch, now: () => t, env: { COMFYFIELD_COMFY_ORIGIN: remote, COMFYFIELD_COMFY_START_SCRIPT: script } });
    await start(remote); t += 5000;
    expect(await start(remote)).toEqual({ state: "already_starting" });
    expect(calls).toHaveLength(1);
  });
  it("executes a non-.sh hook directly when it is executable, and refuses it when it is not", async () => {
    const script = path.join(dir, "start");
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    const { calls, launch } = fakeLaunch();
    const env = { COMFYFIELD_COMFY_ORIGIN: remote, COMFYFIELD_COMFY_START_SCRIPT: script };
    await chmod(script, 0o644);
    await expect(createLocalComfyStarter({ root: dir, platform: "linux", launch, env })(remote)).rejects.toThrow();
    await chmod(script, 0o755);
    await createLocalComfyStarter({ root: dir, platform: "linux", launch, env })(remote);
    expect(calls).toEqual([{ command: script, args: [] }]);
  });
  it("still says to start ComfyUI by hand on Linux when no hook is set", async () => {
    const { launch } = fakeLaunch();
    await expect(createLocalComfyStarter({ root: dir, platform: "linux", launch, env: {} })("http://127.0.0.1:8188")).rejects.toThrow(/Start ComfyUI on this computer/);
  });
  it("keeps the Windows path: a .bat through cmd.exe, and rejects other extensions", async () => {
    const bat = path.join(dir, "start.bat");
    await writeFile(bat, "@echo off\n");
    const { calls, launch } = fakeLaunch();
    await createLocalComfyStarter({ root: dir, platform: "win32", launch, env: { COMFYFIELD_COMFY_START_SCRIPT: bat } })("http://127.0.0.1:8188");
    expect(calls[0].args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    await expect(createLocalComfyStarter({ root: dir, platform: "win32", launch, env: { COMFYFIELD_COMFY_START_SCRIPT: path.join(dir, "start.sh") } })("http://127.0.0.1:8188")).rejects.toThrow(/Invalid/);
  });
});
