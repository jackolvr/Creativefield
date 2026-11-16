import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSFER_TIMEOUT_MS, downloadTimeoutMs, uploadTimeoutMs } from "../server/transfer-timeouts";

describe("worker transfer timeouts", () => {
  it("defaults to ten minutes, well above the 20 s used for ordinary calls", () => {
    expect(uploadTimeoutMs({})).toBe(DEFAULT_TRANSFER_TIMEOUT_MS);
    expect(downloadTimeoutMs({})).toBe(600_000);
  });
  it("reads seconds from the environment, separately for each direction", () => {
    const env = { COMFYFIELD_UPLOAD_TIMEOUT_SECONDS: "900", COMFYFIELD_DOWNLOAD_TIMEOUT_SECONDS: "45" };
    expect(uploadTimeoutMs(env)).toBe(900_000);
    expect(downloadTimeoutMs(env)).toBe(45_000);
  });
  it("falls back to the default for anything out of range or not a number", () => {
    for (const value of ["", "abc", "0", "1", "99999", "-5"]) {
      expect(uploadTimeoutMs({ COMFYFIELD_UPLOAD_TIMEOUT_SECONDS: value })).toBe(DEFAULT_TRANSFER_TIMEOUT_MS);
    }
  });
});
