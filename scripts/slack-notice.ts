/**
 * Posts a one-line notice to the team's Slack channel when `main` moves or an
 * issue is opened, closed or reopened. Run by `.github/workflows/slack-notice.yml`
 * straight from the checkout (`node scripts/slack-notice.ts`), with no install
 * step, so this file imports nothing but Node and keeps to syntax Node can run
 * as written.
 *
 * It is off until the `SLACK_WEBHOOK_URL` secret is set, and it never fails a
 * run: a notice that could not be sent is a warning on the workflow, not a red
 * mark on `main`.
 *
 * The repository is public, so anybody can open an issue. A notice is sent only
 * for an issue written by somebody with access to the repository, and every
 * title is escaped, so a stranger can neither post to the channel nor slip a
 * Slack mention or link into it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Slack treats `&`, `<` and `>` as markup; `<!channel>` in a title would ping everyone. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const link = (url: string, label: string) => `<${url}|${escapeSlack(label)}>`;

/** Changes under these, or to a test or a Markdown file, never reach the running portal. */
const NOT_DEPLOYED = [/^docs\//, /^\.github\//, /^\.claude\//, /^e2e\//, /^scripts\//, /\.md$/, /\.test\.tsx?$/, /(^|\/)__tests__\//];

/**
 * What a push to `main` means for production. `files` is every path the push
 * changed, or null when that could not be worked out, in which case the notice
 * assumes the change ships rather than say "nothing to deploy" on a guess.
 */
export function deployNote(files: string[] | null): string {
  if (files && files.length > 0 && files.every((f) => NOT_DEPLOYED.some((p) => p.test(f)))) {
    return "Nothing to deploy: it does not change the running portal.";
  }
  if (files?.some((f) => f.startsWith("migrations/"))) {
    return "Waiting on a production deploy. It changes the database, so the deploy script takes a safety copy and migrates first.";
  }
  return "Waiting on a production deploy.";
}

const TEAM = ["OWNER", "MEMBER", "COLLABORATOR"];
const ISSUE_VERB: Record<string, string> = { opened: "New issue", closed: "Closed", reopened: "Reopened" };

/** The notice for one GitHub event, or null when the event is not worth one. */
export function slackNotice(eventName: string, event: any, files: string[] | null = null): string | null {
  if (eventName === "workflow_dispatch") {
    return "Test message: Slack is connected to the SPO portal's GitHub repository.";
  }

  if (eventName === "push") {
    if (event?.ref !== "refs/heads/main" || event.deleted) return null;
    const commits: any[] = event.commits ?? [];
    const head = event.head_commit ?? commits[commits.length - 1];
    if (!head) return null;
    const title = String(head.message ?? "").split("\n")[0];
    const more = commits.length > 1 ? ` (and ${commits.length - 1} more)` : "";
    return `*Merged to main:* ${link(head.url, title)}${more}\n${deployNote(files)}`;
  }

  if (eventName === "issues") {
    const issue = event?.issue;
    const verb = ISSUE_VERB[event?.action];
    if (!issue || !verb || !TEAM.includes(issue.author_association)) return null;
    const how = event.action === "closed" && issue.state_reason === "not_planned" ? " as not planned" : "";
    return `*${verb}${how}:* ${link(issue.html_url, `#${issue.number} ${issue.title}`)}`;
  }

  return null;
}

/** Only ever a Slack incoming webhook, so a mistyped secret cannot send notices somewhere else. */
export function isSlackWebhook(url: string): boolean {
  return url.startsWith("https://hooks.slack.com/");
}

/** The paths a push changed, from the checkout; null when git cannot say. */
function changedFiles(event: any): string[] | null {
  const sha = /^[0-9a-f]{40}$/;
  if (!sha.test(event?.before ?? "") || !sha.test(event?.after ?? "") || /^0+$/.test(event.before)) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", event.before, event.after], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

async function main() {
  const url = process.env.SLACK_WEBHOOK_URL ?? "";
  if (!url) {
    console.log("Slack is not set up (no SLACK_WEBHOOK_URL secret); nothing sent.");
    return;
  }
  if (!isSlackWebhook(url)) {
    console.log("::warning::SLACK_WEBHOOK_URL is not a Slack incoming webhook address; nothing sent.");
    return;
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const text = slackNotice(eventName, event, eventName === "push" ? changedFiles(event) : null);
  if (!text) {
    console.log("Nothing to say about this event.");
    return;
  }

  // The address is a credential: it is never logged, and neither is an error that might carry it.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) console.log("Notice sent.");
    else console.log(`::warning::Slack refused the notice (HTTP ${res.status}).`);
  } catch {
    console.log("::warning::Slack could not be reached; the notice was not sent.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log("::warning::The Slack notice could not be built; nothing sent.");
  });
}
