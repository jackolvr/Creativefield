import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import path from "node:path";
import {access, mkdir, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {HttpError, member} from "./auth";
import {storageVolume} from "./setup-storage";
import type {ServerConfig} from "./config";

const params = z.object({workspaceId: z.uuid()});
const body = z.object({
  modelsDirectory: z.string().trim().max(2000).nullable().optional(),
  completed: z.boolean().optional(),
  dismissed: z.boolean().optional(),
}).strict();

const TABLE = "CREATE TABLE IF NOT EXISTS onboarding_settings(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, models_directory text, completed boolean NOT NULL DEFAULT false, dismissed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())";

async function ensureTable(pool: Pool) {
  await pool.query(TABLE);
}

/** Where models should live when the person has not chosen a folder yet: an existing configured root wins,
 *  otherwise a single app-owned folder beside the database and storage. */
function defaultModelsDirectory(config: ServerConfig) {
  if (config.modelRoot) return path.resolve(config.modelRoot);
  const home = process.env.COMFYFIELD_HOME?.trim();
  return path.resolve(home ? home : ".comfyfield", "models");
}

async function folderState(directory: string | null, fallback: string) {
  const effective = directory ?? fallback;
  let exists = false, writable = false;
  try {
    const info = await stat(effective);
    exists = info.isDirectory();
    if (exists) await access(effective, constants.W_OK);
    writable = exists;
  } catch { /* missing or unreadable */ }
  const volume = await storageVolume(exists ? effective : path.dirname(effective));
  return {paths: {effective, exists, writable, freeBytes: volume?.freeBytes ?? null}};
}

export async function onboardingRoutes(app: FastifyInstance, pool: Pool, config: ServerConfig) {
  const base = "/api/v1/workspaces/:workspaceId";
  async function read(workspaceId: string) {
    await ensureTable(pool);
    const row = (await pool.query("SELECT models_directory,completed,dismissed FROM onboarding_settings WHERE workspace_id=$1", [workspaceId])).rows[0] as {models_directory: string | null; completed: boolean; dismissed: boolean} | undefined;
    const fallback = defaultModelsDirectory(config);
    const directory = row?.models_directory ?? null;
    const folder = await folderState(directory, fallback);
    const workers = (await pool.query("SELECT name,origin,enabled,inventory FROM workers WHERE workspace_id=$1 ORDER BY name,id", [workspaceId])).rows as Array<{name: string; origin: string; enabled: boolean; inventory?: {online?: boolean}}>;
    const online = workers.filter(worker => worker.enabled && worker.inventory?.online === true);
    return {
      completed: row?.completed ?? false,
      dismissed: row?.dismissed ?? false,
      modelsDirectory: folder.paths.effective,
      modelsDirectoryChosen: directory,
      folder: folder.paths,
      system: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        comfyWorkers: {total: workers.length, online: online.length, names: online.map(worker => worker.name)},
      },
    };
  }

  app.get(`${base}/onboarding`, async request => {
    const {workspaceId} = params.parse(request.params);
    await member(pool, request, workspaceId);
    return read(workspaceId);
  });

  app.put(`${base}/onboarding`, async request => {
    const {workspaceId} = params.parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const input = body.parse(request.body ?? {});
    await ensureTable(pool);
    const row = (await pool.query("SELECT models_directory,completed,dismissed FROM onboarding_settings WHERE workspace_id=$1", [workspaceId])).rows[0] as {models_directory: string | null; completed: boolean; dismissed: boolean} | undefined;
    let modelsDirectory = row?.models_directory ?? null;
    if (input.modelsDirectory !== undefined) {
      if (input.modelsDirectory === null || input.modelsDirectory === "") modelsDirectory = null;
      else {
        const chosen = path.resolve(input.modelsDirectory);
        if (!path.isAbsolute(input.modelsDirectory)) throw new HttpError(400, "Choose an absolute folder path.");
        try {
          await mkdir(chosen, {recursive: true});
          const info = await stat(chosen);
          if (!info.isDirectory()) throw new Error("not a directory");
          await access(chosen, constants.W_OK);
        } catch {
          throw new HttpError(400, "That folder cannot be created or written to. Choose another folder.");
        }
        modelsDirectory = chosen;
      }
    }
    const completed = input.completed ?? row?.completed ?? false;
    const dismissed = input.dismissed ?? row?.dismissed ?? false;
    await pool.query(
      `INSERT INTO onboarding_settings(workspace_id,models_directory,completed,dismissed,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(workspace_id) DO UPDATE SET models_directory=EXCLUDED.models_directory,completed=EXCLUDED.completed,dismissed=EXCLUDED.dismissed,updated_at=now()`,
      [workspaceId, modelsDirectory, completed, dismissed],
    );
    return {...await read(workspaceId), savedBy: user.id};
  });
}
