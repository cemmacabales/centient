import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/agent-ready.yml",
);

function readWorkflow(): string {
  return readFileSync(workflowPath, "utf8");
}

describe("agent-ready Codex dispatch workflow", () => {
  it("runs only for trusted agent-ready label events on open issues", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/^on:\n  issues:\n    types: \[labeled\]/m);
    expect(workflow).toContain(
      "github.event.label.name == 'agent-ready'",
    );
    expect(workflow).toContain("github.event.issue.state == 'open'");
    expect(workflow).toContain(
      "github.event.sender.login == 'cemmacabales'",
    );
  });

  it("keeps the workflow token read-only and uses the maintainer token without an OpenAI key", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/permissions:\n  contents: read\n  issues: read/);
    expect(workflow).toContain("secrets.CODEX_TRIGGER_TOKEN");
    expect(workflow).not.toContain("OPENAI_API_KEY");
    expect(workflow).toContain("github.rest.users.getAuthenticated");
    expect(workflow).toContain(
      'authenticatedUser.data.login !== "cemmacabales"',
    );
    expect(workflow).toContain('authenticatedUser.data.type !== "User"');
    expect(workflow).toContain("CODEX_TRIGGER_TOKEN must belong to cemmacabales");
  });

  it("deduplicates one label event on both the issue and pull request", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("context.runId");
    expect(workflow).toContain("agent-ready-dispatch:");
    expect(workflow).toContain("issueComments.some(");
    expect(workflow).toContain("pullRequestComments.some(");
    expect(workflow).toContain(
      'comment.user?.login === "cemmacabales"',
    );
    expect(workflow).toContain('comment.user?.type === "User"');
  });

  it("creates a maintainer-authored dispatch branch and draft pull request", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("codex/issue-${issueNumber}");
    expect(workflow).toContain("github.rest.git.createBlob");
    expect(workflow).toContain("github.rest.git.createTree");
    expect(workflow).toContain("github.rest.git.createCommit");
    expect(workflow).toContain("github.rest.git.createRef");
    expect(workflow).toContain('name: "cemmacabales"');
    expect(workflow).toContain('email: "carlmacabales31@gmail.com"');
    expect(workflow).toContain("github.rest.pulls.create");
    expect(workflow).toContain('base: "develop"');
    expect(workflow).toContain("draft: true");
    expect(workflow).toContain("Closes #${issueNumber}");
    expect(workflow).toContain(
      'pullRequest.user?.login === "cemmacabales"',
    );
    expect(workflow).toContain(
      "Refusing to reuse an untrusted or orphaned branch",
    );
  });

  it("dispatches Codex from the pull request with the implementation contract", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("issue_number: pullRequest.number");
    expect(workflow).toContain("@codex implement GitHub issue #${issueNumber}");
    expect(workflow).toContain("Remove \\`${dispatchPath}\\` before finishing");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain(
      "cemmacabales <carlmacabales31@gmail.com>",
    );
    expect(workflow).toContain("Never merge or enable auto-merge");
    expect(workflow).toContain("Do not add AI attribution");
  });
});
