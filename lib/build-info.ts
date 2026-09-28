// The commit a build was made from, so the public URL shows its exact deployed
// SHA (#48). A reviewer reads it in the landing footer or at `/api/version`, then
// opens the same commit on the public mirror, which carries identical SHAs.
//
// The SHA is captured once, at build time: next.config.ts resolves it from the
// deployment's variables and inlines it as NEXT_PUBLIC_DEPLOYED_SHA, so the
// footer and the API report the commit the served bundle was built from, not
// whatever the runtime environment happens to say. Imported by next.config.ts,
// so this file must not import anything.

/** The public mirror of the development repository, at identical commit SHAs. */
export const PUBLIC_SOURCE_REPO = "https://github.com/artisam-centient/centient";

const SHA = /^[0-9a-f]{7,40}$/;

export interface BuildInfo {
  sha: string;
  shortSha: string;
  commitUrl: string;
}

/**
 * The commit SHA from the deployment-provided variables, or null.
 *
 * Railway sets RAILWAY_GIT_COMMIT_SHA on every build from GitHub; GITHUB_SHA
 * covers a CI build. Anything that is not a hex SHA is rejected rather than
 * shown: a wrong SHA on the public page is worse than none.
 */
export function resolveDeployedSha(env: Record<string, string | undefined> = process.env): string | null {
  for (const raw of [env.RAILWAY_GIT_COMMIT_SHA, env.GITHUB_SHA]) {
    const sha = parseSha(raw);
    if (sha) return sha;
  }
  return null;
}

/** The deployed build, or null for a local or unidentified build. */
export function deployedBuild(): BuildInfo | null {
  // A literal property access, so Next.js inlines the build-time value.
  const sha = parseSha(process.env.NEXT_PUBLIC_DEPLOYED_SHA);
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    commitUrl: `${PUBLIC_SOURCE_REPO}/commit/${sha}`,
  };
}

function parseSha(raw: string | undefined): string | null {
  const sha = raw?.trim().toLowerCase();
  return sha && SHA.test(sha) ? sha : null;
}
