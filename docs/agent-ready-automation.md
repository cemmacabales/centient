# Agent-ready Codex automation

Applying `agent-ready` to an open issue creates a draft pull request from
`codex/issue-<number>` and delegates that pull request to Codex Cloud. The
automation accepts label events only from `cemmacabales`. Codex implements the
issue on the existing pull-request branch, verifies the change, and leaves the
pull request unmerged for maintainer review.

The draft-pull-request step is required because the Codex GitHub integration
responds to `@codex` on pull requests. An `@codex` comment on an ordinary issue
is not the supported task trigger.

## One-time setup

1. Open Codex settings and connect `webnxt-2030/Centient` using the ChatGPT
   account linked to GitHub user `cemmacabales`. Enable Codex code review for
   the repository so `@codex` pull-request comments can start cloud tasks.
2. Create a fine-grained GitHub personal access token owned by `cemmacabales`.
   Set the resource owner to `webnxt-2030` and limit repository access to
   `Centient`.
3. Grant the token these repository permissions:
   - Metadata: read (automatically included)
   - Contents: read and write
   - Issues: read and write
   - Pull requests: read and write
4. In the repository, open Settings > Secrets and variables > Actions and add
   the token as `CODEX_TRIGGER_TOKEN`.
5. Confirm the repository has an `agent-ready` label.
6. In the `develop` branch protection or ruleset, require the
   `single-contributor/verified` status so a pull request cannot merge when
   any commit has different author or committer metadata, a co-author trailer,
   explicit AI attribution in commit or pull-request text, or a temporary
   dispatch file that Codex has not removed.

Do not put the token value in source files, workflow logs, issues, or pull
requests. ChatGPT Plus usage limits apply to delegated Codex Cloud tasks. The
workflow does not require an OpenAI API key or separate API billing.

## Smoke test

1. Open a small, fully specified test issue.
2. Apply `agent-ready` as `cemmacabales`.
3. Confirm the workflow creates `codex/issue-<number>` with one temporary
   dispatch file and opens a draft pull request against `develop`.
4. Confirm the workflow posts one marked `@codex` comment on that pull request
   and a link to the draft pull request on the issue.
5. Rerun the same workflow run and confirm it does not post another `@codex`
   comment or create another pull request.
6. Confirm Codex removes the temporary dispatch file, implements the issue on
   the existing branch, and runs `npm test`, `npm run typecheck`, and
   `npm run build`.
7. Confirm every commit reports only
   `cemmacabales <carlmacabales31@gmail.com>` as author and committer.
8. Confirm the `single-contributor/verified` status passes on the pull
   request's latest head commit.

Close the test pull request and issue manually if they are not intended to
merge. The automation never merges or enables auto-merge.

## Retry behavior

A rerun of the same label event is deduplicated by its workflow run ID. The
workflow checks trusted markers on both the source issue and draft pull request,
so a partial failure after posting the `@codex` comment does not start a second
task when the run is retried.

To start a deliberate new attempt, remove `agent-ready`, address the cause of
the failure, and re-add the label. The new event posts a fresh `@codex` comment
on the existing open draft pull request. If that pull request was closed or its
branch was deleted, restore them before retrying or remove the stale branch so
the workflow can create a new draft pull request.

## Rotate or revoke the token

Create the replacement with the same repository permissions, replace
`CODEX_TRIGGER_TOKEN` in Actions secrets, and revoke the old token. Apply the
label to a small test issue to verify the replacement. Removing the secret or
revoking the token disables new dispatches without affecting existing pull
requests.

## Troubleshooting

- No workflow run: verify the issue is open, the exact label is `agent-ready`,
  and the label was applied by `cemmacabales`.
- Workflow authentication failure: replace an expired token and confirm it has
  Contents, Issues, and Pull requests read/write access to `Centient`. The
  workflow also rejects a valid token unless its authenticated user is exactly
  `cemmacabales`.
- Draft pull request appears but Codex does not react: confirm the repository
  is connected in Codex settings, code review is enabled, and the token belongs
  to the GitHub identity linked to the ChatGPT Plus account.
- Pull-request creation fails because the branch already exists: restore its
  open draft pull request or delete only that stale `codex/issue-<number>`
  branch before re-applying the label.
- Codex reports failed checks: fix the blocker, remove the label, and re-add it
  to start a fresh attempt on the existing open draft pull request.
