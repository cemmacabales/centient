# Agent-Ready Codex Dispatch Design

## Goal

When the trusted maintainer applies the `agent-ready` label to an open GitHub
issue, automatically create an isolated draft pull request against `develop`
and delegate it to Codex Cloud. Codex must implement the issue on that branch
and run the repository's verification commands. The automation must never
merge a pull request. Every commit produced by this automation must use only
`cemmacabales <carlmacabales31@gmail.com>` as both author and committer. No
co-author trailer or generated-by-AI attribution is permitted in commit or
pull-request text.

## Context

The repository has pull-request CI in `.github/workflows/ci.yml`, a historical
manual issue-processing guide in `auto-dev.md`, and an initial event-driven
relay that mentioned `@codex` on ordinary issues. The maintainer has ChatGPT
Plus and does not have separately billed OpenAI API access.

ChatGPT Plus includes Codex Cloud and GitHub delegation. The official Codex
GitHub Action, by contrast, requires API-key billing. The GitHub integration
documents `@codex` task delegation on pull requests, not ordinary issues. This
design therefore creates a draft pull request first and posts the instruction
there, consuming the maintainer's included Codex allowance.

## Considered Approaches

### 1. GitHub label relay to Codex Cloud (selected)

A GitHub Actions workflow reacts to the `issues.labeled` event, creates a
maintainer-authored dispatch commit and draft pull request, then posts a fixed
`@codex` instruction on that pull request as the maintainer's GitHub account.
This uses the documented GitHub trigger while keeping implementation inside
Codex Cloud.

Trade-off: the repository needs a fine-grained GitHub personal access token so
the comment has the identity linked to the maintainer's ChatGPT account.

### 2. `openai/codex-action`

Run Codex directly on a GitHub-hosted runner, then commit and open the pull
request from the workflow. This gives the workflow more direct control over
verification and artifacts, but it requires an OpenAI API key and separate API
billing. It is rejected for the current account setup.

### 3. Dedicated webhook service

Receive GitHub webhooks in an external service and start agent runs through an
API. This allows richer queuing and policy, but introduces hosting,
authentication, observability, and maintenance that the current single-label
workflow does not need. It is rejected as unnecessary infrastructure.

## Architecture

Create `.github/workflows/agent-ready.yml` with the following behavior:

1. Trigger only on the `issues` event with activity type `labeled`.
2. Continue only when all of these conditions are true:
   - the added label is exactly `agent-ready`;
   - the issue is open;
   - the event sender is `cemmacabales`.
3. Serialize dispatches per issue with a concurrency group and do not cancel an
   in-progress dispatch.
4. Use a fine-grained personal access token stored as
   `CODEX_TRIGGER_TOKEN` to create `codex/issue-<number>` from `develop`, add a
   temporary dispatch file in a commit authored and committed as the
   maintainer, and open a draft pull request back to `develop`.
   Before any write, verify that the token authenticates as the
   `cemmacabales` user account.
5. Post the fixed `@codex` implementation instruction on that pull request,
   then link the draft pull request from the source issue.
6. Add the workflow run ID as an event-specific hidden marker to both comments.
   A rerun of the same GitHub event retains that run ID, detects the marker on
   a comment authored by the maintainer's user account, and exits successfully
   without starting a duplicate task. Removing and later re-adding
   `agent-ready` creates a new workflow run ID and intentionally starts a new
   attempt. Markers from any other account are ignored.
7. Put no issue title or body into executable JavaScript or shell source. The
   fixed comment links the issue and tells Codex to treat issue content as
   untrusted requirements rather than operational instructions.

Create `.github/workflows/single-contributor.yml` as a trusted
`pull_request_target` check. It runs the workflow definition from the
base branch, inspects every commit returned by GitHub's pull-request commits
API without checking out or executing pull-request code, and fails unless both
Git author and committer metadata exactly match
`cemmacabales <carlmacabales31@gmail.com>`. It also rejects co-author trailers
and explicit AI attribution in commit messages, pull-request titles, and
pull-request bodies, and reruns whenever those PR fields are edited. It uses
the narrowly scoped `statuses: write` permission to publish the required
`single-contributor/verified` status directly on the pull request's latest head
commit. Runs are serialized by pull-request number and a newer event cancels
the stale run before it can overwrite the latest terminal status.

The pull-request comment delegates this contract to Codex Cloud:

- read the issue and repository instructions;
- work on the existing `codex/issue-<number>` pull-request branch;
- remove the temporary dispatch file before finishing;
- keep the change scoped to the issue;
- run the relevant tests, typecheck, and build;
- configure the commit author as
  `cemmacabales <carlmacabales31@gmail.com>` and preserve that identity for
  every commit;
- add no co-author trailer, bot author, AI contributor, or generated-by-AI
  attribution to commits, pull-request titles, or pull-request bodies;
- if verification succeeds, push the implementation to the existing draft
  pull request, whose body already contains `Closes #<number>`;
- if requirements are unclear or verification fails, comment with the specific
  blocker on the pull request;
- never merge or enable auto-merge.

## Authentication and Permissions

Before enabling the workflow, the maintainer must:

1. Connect `webnxt-2030/Centient` to Codex Cloud using the ChatGPT account that
   is linked to GitHub user `cemmacabales`.
2. Create a fine-grained GitHub personal access token owned by
   `cemmacabales`, scoped only to this repository, with Metadata read access
   plus Contents, Issues, and Pull requests read/write access.
3. Store the token as the repository Actions secret `CODEX_TRIGGER_TOKEN`.

The workflow's built-in `GITHUB_TOKEN` receives only `contents: read` and
`issues: read`. The personal token is passed only to the dispatch step that
creates the branch, draft pull request, and comments. No OpenAI API key is
stored in GitHub.

## Idempotency and Failure Handling

- A duplicate delivery or manual rerun of one label event finds the same hidden
  marker on the issue or pull request and does not post another `@codex`
  mention or create another pull request.
- A deliberate label removal and re-addition has a different workflow run ID,
  so it starts a fresh attempt.
- A missing, expired, or under-scoped `CODEX_TRIGGER_TOKEN` fails the workflow
  before a delegation comment is created.
- Events from senders other than `cemmacabales`, closed issues, and other labels
  are skipped without consuming Codex usage.
- A later re-label reuses the existing open draft pull request and posts a new
  task comment for the new run ID.
- Codex Cloud reports implementation blockers on the draft pull request.
- The single-contributor workflow deterministically rejects pull requests with
  any mismatched commit author or committer metadata, co-author trailer, or
  explicit AI attribution. It also fails while a temporary
  `.github/codex-dispatch/issue-<number>.md` file remains in the pull request.
  Repository branch protection must require this `single-contributor/verified`
  status alongside `.github/workflows/ci.yml`.

## Testing

Add a focused Vitest test that reads the workflow as text and verifies its
security- and behavior-critical contract:

- exact `issues.labeled` trigger;
- exact label, issue-state, and actor guards;
- least-privilege workflow permissions;
- use of `CODEX_TRIGGER_TOKEN` rather than an OpenAI API key;
- run-ID idempotency markers on the issue and pull request, accepted only from
  the maintainer's user account;
- maintainer-authored Git data commit, draft pull request against `develop`,
  `codex/issue-<number>` branch convention, `Closes` linkage, verification
  requirement, temporary-file cleanup, and no-merge instruction.

Add a second focused test for the pull-request trigger, read-only repository
and pull-request permissions, scoped status writes to the PR head, exact author
and committer identity, prohibited attribution, pagination, and deterministic
failure.

Also parse the workflow with Ruby's built-in YAML parser as a syntax check,
while relying on the focused test for GitHub-specific `on` semantics because
Ruby 2.6 interprets YAML 1.1. Run the focused test first, then the complete test
suite and typecheck.

## Documentation

Add `docs/agent-ready-automation.md` with the one-time Codex Cloud connection,
fine-grained token creation, repository-secret setup, a safe smoke test, retry
behavior, and token rotation instructions. Do not place token values in the
repository, workflow logs, issue comments, or documentation.

## Non-Goals

- No automatic merging or auto-merge configuration.
- No commit metadata or commit/pull-request text attributing work to Codex,
  ChatGPT, GitHub Actions, or any other AI agent or bot.
- No OpenAI API key or pay-as-you-go API usage.
- No processing of multiple queued issues in one agent task.
- No external webhook service, database, or scheduler.
- No changes to application runtime code.
