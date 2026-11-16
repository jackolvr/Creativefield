import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export type LocalComfyStartResult = { state: "launch_requested" | "already_starting" };
export type LocalComfyStarter = (origin: string) => Promise<LocalComfyStartResult>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A worker the operator named in COMFYFIELD_COMFY_ORIGIN (or the HyperFlow one) on another host, e.g. a GPU reached over a
 *  VPN: the same plain origin counts as managed. Both sides must be plain http(s) origins; only the operator's own
 *  setting can name it, so a worker row alone never makes an address startable. */
function matchesConfiguredRemoteOrigin(origin: string, configuredOrigin: string): boolean {
  try {
    const url = new URL(origin);
    const configured = new URL(configuredOrigin);
    return (url.protocol === "http:" || url.protocol === "https:") && !LOOPBACK.has(configured.hostname) && !url.username && !url.password && !configured.username && !configured.password && url.pathname === "/" && configured.pathname === "/" && !url.search && !url.hash && !configured.search && !configured.hash && url.origin === configured.origin;
  } catch {
    return false;
  }
}

function matchesLoopbackOrigin(origin: string, configuredOrigin: string): boolean {
  try {
    const url = new URL(origin);
    const configured = new URL(configuredOrigin);
    return url.protocol === "http:" && configured.protocol === "http:" && LOOPBACK.has(url.hostname) && LOOPBACK.has(configured.hostname) && !url.username && !url.password && !configured.username && !configured.password && url.pathname === "/" && configured.pathname === "/" && !url.search && !url.hash && !configured.search && !configured.hash && (url.port || "80") === (configured.port || "80");
  } catch {
    return false;
  }
}

export function managedLocalComfyFamily(origin: string, env: NodeJS.ProcessEnv = process.env) {
  const hyperflowOrigin = env.COMFYFIELD_HYPERFLOW_ORIGIN?.trim();
  if (hyperflowOrigin && env.COMFYFIELD_HYPERFLOW_START_SCRIPT?.trim() && (matchesLoopbackOrigin(origin, hyperflowOrigin) || matchesConfiguredRemoteOrigin(origin, hyperflowOrigin))) return "hyperflow";
  const comfyOrigin = env.COMFYFIELD_COMFY_ORIGIN?.trim();
  if (matchesLoopbackOrigin(origin, comfyOrigin || "http://127.0.0.1:8188")) return "default";
  // A remote worker has no default script: the operator must name one in COMFYFIELD_COMFY_START_SCRIPT.
  if (comfyOrigin && env.COMFYFIELD_COMFY_START_SCRIPT?.trim() && matchesConfiguredRemoteOrigin(origin, comfyOrigin)) return "default";
}

export function managedLocalComfyOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return managedLocalComfyFamily(origin, env) !== undefined;
}

export function createLocalComfyStarter(options: {
  root?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  launch?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  env?: NodeJS.ProcessEnv;
} = {}): LocalComfyStarter {
  const root = options.root ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const launch = options.launch ?? spawn;
  const env = options.env ?? process.env;
  const lastLaunch = new Map<string, number>();

  return async origin => {
    const family = managedLocalComfyFamily(origin, env);
    if (!family) throw new Error("The managed starter only supports configured local ComfyUI workers.");
    const current = now();
    const last = lastLaunch.get(family);
    if (last !== undefined && current - last < 30_000) return { state: "already_starting" };

    const configuredScript = family === "hyperflow" ? env.COMFYFIELD_HYPERFLOW_START_SCRIPT : env.COMFYFIELD_COMFY_START_SCRIPT;
    // Windows runs a .bat/.cmd through cmd.exe. Elsewhere the script is a .sh run by bash (or an executable file),
    // started without a shell, so its path is never interpreted. It takes no arguments: wrap them in a small script.
    const windows = platform === "win32";
    if (!windows && !configuredScript?.trim()) throw new Error("Start ComfyUI on this computer, then check the worker again.");
    const script = path.resolve(configuredScript?.trim() || path.join(root, "scripts", "start-comfy.bat"));
    // cmd.exe interprets these characters even inside quotes. A local operator
    // may choose a script, but never inject extra shell commands through its path.
    if (windows ? (/["%&|<>^!\r\n]/.test(script) || !/\.(?:bat|cmd)$/i.test(script)) : /[\0\r\n]/.test(script)) throw new Error("Invalid local ComfyUI startup script path.");
    lastLaunch.set(family, current);
    try {
      await access(script, windows ? undefined : /\.sh$/i.test(script) ? constants.R_OK : constants.X_OK);
      const [command, args] = windows ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", script.includes(" ")?`"${script}"`:script]] : /\.sh$/i.test(script) ? ["bash", [script]] : [script, []];
      await new Promise<void>((resolve, reject) => {
        const child = launch(command, args, {
          cwd: root,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    } catch (error) {
      lastLaunch.delete(family);
      throw error;
    }
    return { state: "launch_requested" };
  };
}

export const startLocalComfy = createLocalComfyStarter();
