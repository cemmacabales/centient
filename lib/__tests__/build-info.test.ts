import { afterEach, describe, expect, it, vi } from "vitest";
import { deployedBuild, resolveDeployedSha } from "@/lib/build-info";

const SHA = "8f660cc632f1c868a41618434a1c169dc0edabcc";

describe("resolveDeployedSha (#48)", () => {
  it("takes Railway's commit SHA", () => {
    expect(resolveDeployedSha({ RAILWAY_GIT_COMMIT_SHA: SHA })).toBe(SHA);
  });

  it("prefers Railway's SHA over a CI SHA", () => {
    const env = { RAILWAY_GIT_COMMIT_SHA: SHA, GITHUB_SHA: "0".repeat(40) };
    expect(resolveDeployedSha(env)).toBe(SHA);
  });

  it("falls back to GITHUB_SHA", () => {
    expect(resolveDeployedSha({ GITHUB_SHA: SHA })).toBe(SHA);
  });

  it("trims and lowercases", () => {
    const env = { RAILWAY_GIT_COMMIT_SHA: ` ${SHA.toUpperCase()}\n` };
    expect(resolveDeployedSha(env)).toBe(SHA);
  });

  it("returns null when no variable is set", () => {
    expect(resolveDeployedSha({})).toBeNull();
  });

  it("rejects a value that is not a hex SHA rather than show it", () => {
    for (const bad of ["", "   ", "main", "8f660c", "g".repeat(40), `${SHA}0`]) {
      expect(resolveDeployedSha({ RAILWAY_GIT_COMMIT_SHA: bad })).toBeNull();
    }
  });

  it("skips an invalid Railway value and uses a valid CI one", () => {
    const env = { RAILWAY_GIT_COMMIT_SHA: "unknown", GITHUB_SHA: SHA };
    expect(resolveDeployedSha(env)).toBe(SHA);
  });
});

describe("deployedBuild (#48)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("describes the inlined SHA with its short form and mirror commit link", () => {
    vi.stubEnv("NEXT_PUBLIC_DEPLOYED_SHA", SHA);
    expect(deployedBuild()).toEqual({
      sha: SHA,
      shortSha: "8f660cc",
      commitUrl: `https://github.com/artisam-centient/centient/commit/${SHA}`,
    });
  });

  it("is null for a build with no SHA", () => {
    vi.stubEnv("NEXT_PUBLIC_DEPLOYED_SHA", "");
    expect(deployedBuild()).toBeNull();
  });

  it("is null for a malformed SHA", () => {
    vi.stubEnv("NEXT_PUBLIC_DEPLOYED_SHA", "not-a-sha");
    expect(deployedBuild()).toBeNull();
  });
});
