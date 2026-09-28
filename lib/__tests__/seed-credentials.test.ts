import { describe, expect, it } from "vitest";
import { isLocalDevelopment, resolveSeedPassword } from "../seed-credentials";

describe("isLocalDevelopment", () => {
  it("is true for a loopback database outside Railway", () => {
    expect(isLocalDevelopment({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/centient_dev" })).toBe(true);
    expect(isLocalDevelopment({ DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5433/centient_test" })).toBe(true);
    expect(isLocalDevelopment({ DATABASE_URL: "postgresql://postgres:postgres@[::1]:5432/centient_dev" })).toBe(true);
  });

  it("is false for a remote database", () => {
    expect(isLocalDevelopment({ DATABASE_URL: "postgresql://u:p@postgres.railway.internal:5432/railway" })).toBe(false);
    expect(isLocalDevelopment({ DATABASE_URL: "postgresql://u:p@example.proxy.rlwy.net:41234/railway" })).toBe(false);
  });

  it("is false inside any Railway environment, even with a loopback URL", () => {
    expect(
      isLocalDevelopment({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/centient_dev",
        RAILWAY_ENVIRONMENT_ID: "env-id",
      }),
    ).toBe(false);
    expect(
      isLocalDevelopment({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/centient_dev",
        RAILWAY_PROJECT_ID: "project-id",
      }),
    ).toBe(false);
  });

  it("is false when the database URL is missing or unparseable", () => {
    expect(isLocalDevelopment({})).toBe(false);
    expect(isLocalDevelopment({ DATABASE_URL: "not a url" })).toBe(false);
  });
});

describe("resolveSeedPassword", () => {
  const account = "admin@centient.work";

  it("uses the environment value wherever it runs", () => {
    expect(resolveSeedPassword({ account, envValue: "from-env", localDefault: "local", local: false })).toBe("from-env");
    expect(resolveSeedPassword({ account, envValue: "from-env", localDefault: "local", local: true })).toBe("from-env");
  });

  it("falls back to the local default only on local development", () => {
    expect(resolveSeedPassword({ account, envValue: undefined, localDefault: "local", local: true })).toBe("local");
  });

  it("treats a blank environment value as unset", () => {
    expect(resolveSeedPassword({ account, envValue: "  ", localDefault: "local", local: true })).toBe("local");
    expect(() => resolveSeedPassword({ account, envValue: "  ", localDefault: "local", local: false })).toThrow();
  });

  it("refuses outside local development, naming the account but never the default", () => {
    let message = "";
    try {
      resolveSeedPassword({ account, envValue: undefined, localDefault: "local-default-value", local: false });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(account);
    expect(message).not.toContain("local-default-value");
  });
});
