# Agent-Ready Codex Dispatch Design

## Goal

When the trusted maintainer applies the `agent-ready` label to an open GitHub
issue, automatically delegate that issue to Codex Cloud. Codex must implement
the issue on an isolated branch, run the repository's verification commands,
and open a pull request against `develop`. The automation must never merge a
pull request. Every commit and pull request produced by this automation must
attribute only `cemmacabales <carlmacabales31@gmail.com>`; no AI agent,
co-author trailer, bot identity, or generated-by-AI attribution is permitted.

## Context

The repository currently has pull-request CI in `.github/workflows/ci.yml` and
a historical manual issue-processing guide in `auto-dev.md`, but it has no
event-driven issue-to-agent workflow. The maintainer has ChatGPT Plus and does
not have separately billed OpenAI API access.

ChatGPT Plus includes Codex Cloud and GitHub delegation. The official Codex
GitHub Action, by contrast, requires API-key billing. This design therefore
uses the GitHub integration's `@codex` issue-comment trigger and consumes the
maintainer's included Codex allowance.

## Considered Approaches

### 1. GitHub label relay to Codex Cloud (selected)

A GitHub Actions workflow reacts to the `issues.labeled` event and posts a
fixed `@codex` instruction as the maintainer's GitHub account. This is the
smallest option that works with ChatGPT Plus and keeps implementation inside
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
   `CODEX_TRIGGER_TOKEN` to read issue comments and create one new comment.
5. Add an event-specific hidden marker to the comment. A rerun of the same
   GitHub event detects the marker and exits successfully without starting a
   duplicate task. Removing and later re-adding `agent-ready` produces a new
   event marker and intentionally starts a new attempt.
6. Put no issue title or body into executable JavaScript or shell source. The
   fixed comment links the issue and tells Codex to treat issue content as
   untrusted requirements rather than operational instructions.

The comment delegates this contract to Codex Cloud:

- read the issue and repository instructions;
- start from `develop` on `codex/issue-<number>`;
- keep the change scoped to the issue;
- run the relevant tests, typecheck, and build;
- configure the commit author as
  `cemmacabales <carlmacabales31@gmail.com>` and preserve that identity for
  every commit;
- add no co-author trailer, bot author, AI contributor, or generated-by-AI
  attribution to commits, pull-request titles, or pull-request bodies;
- if verification succeeds, push the branch and open a pull request against
  `develop` whose body contains `Closes #<number>`;
- if requirements are unclear or verification fails, comment with the specific
  blocker and do not open a pull request;
- never merge or enable auto-merge.

## Authentication and Permissions

Before enabling the workflow, the maintainer must:

1. Connect `webnxt-2030/Centient` to Codex Cloud using the ChatGPT account that
   is linked to GitHub user `cemmacabales`.
2. Create a fine-grained GitHub personal access token owned by
   `cemmacabales`, scoped only to this repository, with Metadata read access
   and Issues read/write access.
3. Store the token as the repository Actions secret `CODEX_TRIGGER_TOKEN`.

The workflow's built-in `GITHUB_TOKEN` receives only `contents: read` and
`issues: read`. The personal token is passed only to the comment-posting step.
No OpenAI API key is stored in GitHub.

## Idempotency and Failure Handling

- A duplicate delivery or manual rerun of one label event finds the same hidden
  marker and does not post another `@codex` mention.
- A deliberate label removal and re-addition has a different event timestamp,
  so it starts a fresh attempt.
- A missing, expired, or under-scoped `CODEX_TRIGGER_TOKEN` fails the workflow
  before a delegation comment is created.
- Events from senders other than `cemmacabales`, closed issues, and other labels
  are skipped without consuming Codex usage.
- Codex Cloud reports implementation blockers on the issue and must not create
  a pull request when its required verification fails.
- Existing branch protections and `.github/workflows/ci.yml` remain the final
  deterministic gate on the pull request.

## Testing

Add a focused Vitest test that reads the workflow as text and verifies its
security- and behavior-critical contract:

- exact `issues.labeled` trigger;
- exact label, issue-state, and actor guards;
- least-privilege workflow permissions;
- use of `CODEX_TRIGGER_TOKEN` rather than an OpenAI API key;
- event-specific idempotency marker;
- `develop` base, `codex/issue-<number>` branch convention, verification
  requirement, `Closes` linkage, and no-merge instruction.

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
- No commit, pull-request, or contributor attribution for Codex, ChatGPT,
  GitHub Actions, or any other AI agent or bot.
- No OpenAI API key or pay-as-you-go API usage.
- No processing of multiple queued issues in one agent task.
- No external webhook service, database, or scheduler.
- No changes to application runtime code.
