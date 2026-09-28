import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

const SHA = "1fde77d539ca040bb12c07df0c82dad5c8cf3a58";

describe("GET /api/version (#48)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports the deployed SHA, its mirror commit and the network", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEPLOYED_SHA", SHA);
    vi.stubEnv("STELLAR_NETWORK", "testnet");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      sha: SHA,
      shortSha: "1fde77d",
      commitUrl: `https://github.com/artisam-centient/centient/commit/${SHA}`,
      network: "testnet",
    });
  });

  it("reports null, not a guess, when the build has no SHA", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEPLOYED_SHA", "");
    vi.stubEnv("STELLAR_NETWORK", "testnet");

    const body = await (await GET()).json();

    expect(body).toMatchObject({ sha: null, shortSha: null, commitUrl: null, network: "testnet" });
  });
});
