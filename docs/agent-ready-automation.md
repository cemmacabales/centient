# Agent-ready Codex automation

Applying `agent-ready` to an open issue delegates it to Codex Cloud. The
automation accepts label events only from `cemmacabales`; Codex works from
`develop`, verifies the change, and opens an unmerged pull request.

## One-time setup

1. In Codex Cloud, connect `webnxt-2030/Centient` using the ChatGPT account
   linked to GitHub user `cemmacabales`.
2. Create a fine-grained GitHub personal access token owned by `cemmacabales`.
   Limit repository access to `webnxt-2030/Centient`. Grant Metadata read and
   Issues read/write permissions only.
3. In the repository, open Settings > Secrets and variables > Actions and add
   the token as `CODEX_TRIGGER_TOKEN`.
4. Confirm the repository has an `agent-ready` label.

Do not put the token value in source files, workflow logs, issues, or pull
requests. ChatGPT Plus usage limits apply to delegated Codex Cloud tasks.

## Smoke test

1. Open a small, fully specified test issue.
2. Apply `agent-ready` as `cemmacabales`.
3. Confirm the workflow posts one marked `@codex` comment.
4. Rerun the same workflow run and confirm it does not post a second comment.
5. Confirm Codex creates `codex/issue-<number>`, runs the required verification,
   and opens a pull request against `develop` without merging it.
6. Confirm every commit reports only
   `cemmacabales <carlmacabales31@gmail.com>` as author and committer.

Close the test pull request and issue manually if they are not intended to
merge.

## Retry behavior

A rerun of the same label event is deduplicated. To start a deliberate new
attempt, remove `agent-ready`, address the cause of the failure, and re-add the
label. The new label event gets a new marker.

## Rotate or revoke the token

Create the replacement with the same narrow repository permissions, replace
`CODEX_TRIGGER_TOKEN` in Actions secrets, and revoke the old token. Apply the
label to a small test issue to verify the replacement. Removing the secret or
revoking the token disables new dispatches without affecting existing pull
requests.

## Troubleshooting

- No workflow run: verify the issue is open, the exact label is `agent-ready`,
  and the label was applied by `cemmacabales`.
- Workflow authentication failure: replace an expired token and confirm Issues
  read/write permission.
- Comment appears but Codex does not react: reconnect the repository in Codex
  Cloud and confirm the GitHub identity is linked to the ChatGPT Plus account.
- Codex reports failed checks: fix the blocker, remove the label, and re-add it
  to start a fresh attempt.
