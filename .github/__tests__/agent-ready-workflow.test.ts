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

  it("uses least privilege and the maintainer token without an OpenAI key", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(/permissions:\n  contents: read\n  issues: read/);
    expect(workflow).toContain("secrets.CODEX_TRIGGER_TOKEN");
    expect(workflow).not.toContain("OPENAI_API_KEY");
  });

  it("deduplicates one label event while allowing a later re-label", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("context.runId");
    expect(workflow).toContain("agent-ready-dispatch:");
    expect(workflow).toContain("comments.some(");
    expect(workflow).toContain(
      'comment.user?.login === "cemmacabales"',
    );
    expect(workflow).toContain('comment.user?.type === "User"');
  });

  it("delegates the required branch, verification, PR, and authorship contract", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("codex/issue-${issueNumber}");
    expect(workflow).toContain("target `develop`");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("Closes #${issueNumber}");
    expect(workflow).toContain(
      "cemmacabales <carlmacabales31@gmail.com>",
    );
    expect(workflow).toContain("Never merge or enable auto-merge");
    expect(workflow).toContain("Do not add AI attribution");
  });
});
