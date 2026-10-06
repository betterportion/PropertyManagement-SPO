import { describe, it, expect } from "vitest";
import { deployNote, escapeSlack, isSlackWebhook, slackNotice } from "../slack-notice";

/**
 * The notices go to a channel people read, from a public repository. What
 * matters is who can cause one, that a title cannot carry Slack markup, and
 * that "nothing to deploy" is never said on a guess.
 */
const push = (patch: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  commits: [{}],
  head_commit: {
    message: "feat: dashboard budget section says when there are no owned houses (#299)\n\nThe body is not shown.",
    url: "https://github.com/betterportion/PropertyManagement-SPO/commit/b3f5403",
  },
  ...patch,
});

const issue = (action: string, patch: Record<string, unknown> = {}) => ({
  action,
  issue: {
    number: 165,
    title: "[a11y] Unnamed controls on Settings and Contacts",
    html_url: "https://github.com/betterportion/PropertyManagement-SPO/issues/165",
    author_association: "OWNER",
    state_reason: null,
    ...patch,
  },
});

describe("slackNotice: a push", () => {
  it("names the merged change by its first line and says a deploy is waiting", () => {
    expect(slackNotice("push", push(), ["client/src/pages/AdminDashboard.tsx"])).toBe(
      "*Merged to main:* <https://github.com/betterportion/PropertyManagement-SPO/commit/b3f5403|feat: dashboard budget section says when there are no owned houses (#299)>\n" +
        "Waiting on a production deploy.",
    );
  });

  it("counts the other commits when a push carries several", () => {
    expect(slackNotice("push", push({ commits: [{}, {}, {}] }), null)).toContain("(and 2 more)");
  });

  it("says nothing for another branch, or for a branch being deleted", () => {
    expect(slackNotice("push", push({ ref: "refs/heads/feat/something" }), [])).toBeNull();
    expect(slackNotice("push", push({ deleted: true, head_commit: null, commits: [] }), [])).toBeNull();
  });
});

describe("deployNote", () => {
  it("says the database changes when a migration is in the push", () => {
    expect(deployNote(["shared/schema.ts", "migrations/0043_add_thing.sql"])).toContain("changes the database");
  });

  it("says nothing to deploy only when every file stays out of the running portal", () => {
    const quiet = ["docs/WORKFLOWS.md", "README.md", ".github/workflows/ci.yml", "server/__tests__/authz.test.ts", "e2e/dashboard.spec.ts", "scripts/deploy-production.sh"];
    expect(deployNote(quiet)).toContain("Nothing to deploy");
    expect(deployNote([...quiet, "server/authz.ts"])).toBe("Waiting on a production deploy.");
  });

  it("assumes a deploy is needed when the changed files are unknown or empty", () => {
    expect(deployNote(null)).toBe("Waiting on a production deploy.");
    expect(deployNote([])).toBe("Waiting on a production deploy.");
  });
});

describe("slackNotice: an issue", () => {
  it("announces an issue opened, closed or reopened by somebody on the team", () => {
    const linked = "<https://github.com/betterportion/PropertyManagement-SPO/issues/165|#165 [a11y] Unnamed controls on Settings and Contacts>";
    expect(slackNotice("issues", issue("opened"))).toBe(`*New issue:* ${linked}`);
    expect(slackNotice("issues", issue("closed", { state_reason: "completed" }))).toBe(`*Closed:* ${linked}`);
    expect(slackNotice("issues", issue("closed", { state_reason: "not_planned" }))).toBe(`*Closed as not planned:* ${linked}`);
    expect(slackNotice("issues", issue("reopened", { author_association: "COLLABORATOR" }))).toBe(`*Reopened:* ${linked}`);
  });

  it("stays silent for an issue a stranger wrote: the repository is public", () => {
    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN", undefined]) {
      expect(slackNotice("issues", issue("opened", { author_association: association }))).toBeNull();
      expect(slackNotice("issues", issue("closed", { author_association: association }))).toBeNull();
    }
  });

  it("stays silent for the issue activity nobody asked to hear about", () => {
    expect(slackNotice("issues", issue("labeled"))).toBeNull();
    expect(slackNotice("issues", issue("edited"))).toBeNull();
    expect(slackNotice("issue_comment", issue("created"))).toBeNull();
  });

  it("cannot be made to ping the channel or forge a link through a title", () => {
    const text = slackNotice("issues", issue("opened", { title: "<!channel> see <https://evil.example|here> & now" }));
    expect(text).toContain("&lt;!channel&gt; see &lt;https://evil.example|here&gt; &amp; now");
    expect(text).not.toContain("<!channel>");
  });
});

describe("slackNotice: the test button", () => {
  it("sends a test message when the workflow is run by hand", () => {
    expect(slackNotice("workflow_dispatch", {})).toContain("Slack is connected");
  });
});

describe("escapeSlack", () => {
  it("escapes the ampersand first, so an entity is never double-read", () => {
    expect(escapeSlack("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("isSlackWebhook", () => {
  it("accepts only a Slack incoming webhook address", () => {
    expect(isSlackWebhook("https://hooks.slack.com/services/T000/B000/xxxx")).toBe(true);
    expect(isSlackWebhook("https://hooks.slack.com.evil.example/services/T000")).toBe(false);
    expect(isSlackWebhook("http://hooks.slack.com/services/T000")).toBe(false);
    expect(isSlackWebhook("https://example.com/hook")).toBe(false);
  });
});
