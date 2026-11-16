import { describe, expect, it } from "vitest";
import { gpuLaneOrigins, inGpuLane, onThisComputer } from "../server/gpu-lane";

describe("GPU lane membership", () => {
  const remote = { kind: "local", origin: "http://zitpoc-comfy:8188" };
  it("keeps loopback workers in the lane and leaves other hosts out by default", () => {
    expect(inGpuLane({ kind: "local", origin: "http://127.0.0.1:8188" }, {})).toBe(true);
    expect(inGpuLane(remote, {})).toBe(false);
  });
  it("adds a remote worker named in COMFYFIELD_GPU_LANE_ORIGINS, matched by origin", () => {
    const env = { COMFYFIELD_GPU_LANE_ORIGINS: " http://zitpoc-comfy:8188/ , not a url,http://other:8188" };
    expect(gpuLaneOrigins(env)).toEqual(["http://zitpoc-comfy:8188", "http://other:8188"]);
    expect(inGpuLane(remote, env)).toBe(true);
    expect(inGpuLane({ kind: "local", origin: "http://zitpoc-comfy:9999" }, env)).toBe(false);
  });
  it("never lets Comfy Cloud or an origin-less worker join", () => {
    const env = { COMFYFIELD_GPU_LANE_ORIGINS: "https://cloud.comfy.org,http://zitpoc-comfy:8188" };
    expect(inGpuLane({ kind: "cloud", origin: "https://cloud.comfy.org" }, env)).toBe(false);
    expect(inGpuLane({ kind: "local" }, env)).toBe(false);
  });
  it("does not change what counts as this computer", () => {
    expect(onThisComputer(remote)).toBe(false);
  });
});
