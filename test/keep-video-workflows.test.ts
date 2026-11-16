import { describe, expect, it } from "vitest";
import { keptVideoWorkflowPatterns, loadServerCatalogue, retireNonHyperflowVideoModels } from "../server/catalogue";
import { validateCapability } from "../src/capabilities/validate";
import { capabilityReadiness } from "../src/capabilities/readiness";
import type { CapabilityBundle } from "../src/capabilities/types";

const video = (id: string, category = "t2v", title = id): CapabilityBundle => ({
  manifest: { schemaVersion: 2, id, version: "1", title, category, description: "", inputs: [], controls: [], presets: [], routes: [], coverage: { local: "implemented", hosted: "planned" },
    outputs: [{ id: "video", label: "Clip", type: "video", required: true }], licenses: { software: "", weights: [] }, sources: [], tickets: [], audioPolicies: ["mute"] },
});
const ids = (bundles: CapabilityBundle[]) => bundles.map(b => b.manifest.id);

describe("COMFYFIELD_KEEP_VIDEO_WORKFLOWS", () => {
  const all = [video("ltx23-t2v"), video("ltx23-i2v", "i2v"), video("wan22-i2v-14b", "i2v"), video("h3-t2v"), video("x-flash", "t2v", "HyperFlow clip"), video("up", "enhance")];
  it("keeps today's behaviour when unset or empty", () => {
    expect(ids(retireNonHyperflowVideoModels(all, {}))).toEqual(["x-flash", "up"]);
    expect(ids(retireNonHyperflowVideoModels(all, { COMFYFIELD_KEEP_VIDEO_WORKFLOWS: " , " }))).toEqual(["x-flash", "up"]);
  });
  it("keeps listed ids and globs, and nothing else", () => {
    const kept = retireNonHyperflowVideoModels(all, { COMFYFIELD_KEEP_VIDEO_WORKFLOWS: "ltx23-*, wan22-i2v-14b" });
    expect(ids(kept)).toEqual(["ltx23-t2v", "ltx23-i2v", "wan22-i2v-14b", "x-flash", "up"]);
  });
  it("matches whole ids and treats regex characters literally", () => {
    expect(keptVideoWorkflowPatterns({ COMFYFIELD_KEEP_VIDEO_WORKFLOWS: "h3.t2v" })[0].test("h3-t2v")).toBe(false);
    expect(ids(retireNonHyperflowVideoModels(all, { COMFYFIELD_KEEP_VIDEO_WORKFLOWS: "ltx23" }))).toEqual(["x-flash", "up"]);
  });
  it("never retires non-video workflows", () => {
    const stills: CapabilityBundle = { manifest: { ...video("img").manifest, outputs: [{ id: "image", label: "Image", type: "image", required: true }] } };
    expect(ids(retireNonHyperflowVideoModels([stills], {}))).toEqual(["img"]);
  });
});

describe("LTX 2.3 native workflows", () => {
  const load = async () => (await loadServerCatalogue({ log: () => {} })).filter(b => /^ltx23-/.test(b.manifest.id));
  it("pass the capability validator", async () => {
    const bundles = await load();
    expect(ids(bundles).sort()).toEqual(["ltx23-i2v", "ltx23-t2v"]);
    for (const bundle of bundles) expect(validateCapability(bundle)).toEqual([]);
  });
  it("bind every control and input into the graph, with the server's own file names", async () => {
    for (const { manifest, template } of await load()) {
      for (const item of [...manifest.inputs, ...manifest.controls]) expect(item.binding && item.binding.field in template![item.binding.node].inputs).toBe(true);
      expect(manifest.inputs.length).toBe(manifest.id === "ltx23-i2v" ? 1 : 0);
      const models = manifest.routes[0].requirements.filter(r => r.kind === "model").map(r => `${r.location}/${r.name}`);
      expect(models).toEqual(["checkpoints/pinkcherry_v18_fp8scaled.safetensors", "text_encoders/gemma_heretic_fp8.safetensors", "loras/ltx23_distilled_lora.safetensors"]);
      const nodes = new Set(manifest.routes[0].requirements.filter(r => r.kind === "node").map(r => r.name));
      expect(new Set(Object.values(template!).map(n => n.class_type))).toEqual(nodes);
    }
  });
  it("are ready on a worker that has the files and nodes, and ask for files otherwise (name only; no version check)", async () => {
    const [bundle] = await load();
    const route = bundle.manifest.routes[0];
    const full = { online: true, objectInfoChecked: true, nodes: route.requirements.filter(r => r.kind === "node").map(r => r.name), models: route.requirements.filter(r => r.kind === "model").map(r => `${r.location}/${r.name}`), credentials: [] };
    expect(capabilityReadiness(bundle.manifest, "local", full).state).toBe("ready");
    const lacking = capabilityReadiness(bundle.manifest, "local", { ...full, models: full.models.slice(1) });
    expect(lacking.state).toBe("download_required");
  });
});
