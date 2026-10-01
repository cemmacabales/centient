# Repository mirrors

Centient's canonical repository is private. Two public mirrors exist so the
project's history can be shared without granting access to the canonical repo.
This note records the topology and the sync procedure so the layout isn't
rediscovered from `git remote -v` each time.

## Remotes

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | `github.com/webnxt-2030/Centient` | Canonical (private). All PRs open and merge here. |
| `mirror-personal` | `github.com/cemmacabales/centient` | Public mirror. |
| `mirror-artisam` | `github.com/artisam-centient/centient` | Public mirror. |

## Sync procedure

Mirrors track `develop` and `staging`. After a PR merges into either branch
on the canonical repo, refresh and push both to each public mirror:

```bash
git fetch origin
git push mirror-personal origin/develop:develop origin/staging:staging
git push mirror-artisam  origin/develop:develop origin/staging:staging
```

`staging` must be pushed after every promotion, not only `develop`. Railway's
`web` deploys from `staging`, and `/api/version` links the deployed commit on
the artisam mirror (`PUBLIC_SOURCE_REPO` in `lib/build-info.ts`), so an
unpushed promotion merge commit is a dead link. Each QA gate also checks that
the build-under-test SHA is identical on all three repos.

Check that the three repos agree:

```bash
git fetch --all
for r in origin mirror-personal mirror-artisam; do
  echo "$r $(git rev-parse --short $r/develop) $(git rev-parse --short $r/staging)"
done
```

Notes:

- Only `develop` and `staging` are mirrored; feature branches stay on the
  canonical repo. `main` is not synced by this procedure.
- The mirrors are push destinations, not sources of truth — never open PRs
  against them.
- Run the sync from a checkout that has all three remotes configured (the
  primary working copy).
