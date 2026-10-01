/**
 * ---------------------------------------------------------------------------
 * Outbound email
 * ---------------------------------------------------------------------------
 * The only module that talks to the email provider, the way objectStorage/ is
 * the only code that talks to a bucket. Everything else calls sendEmail and
 * looks at the result.
 *
 * Two properties every caller can rely on:
 *
 *   - It never throws. An email is a courtesy attached to something that
 *     already happened — a filed request, a move-out — and the request that
 *     triggered it must not fail because the mail provider is down or the
 *     domain is not verified yet. Failures are logged server-side and
 *     reported in the returned result.
 *
 *   - Unconfigured is a normal state, not an error. Until the Resend domain
 *     setup (#49) is done, RESEND_API_KEY / EMAIL_FROM stay unset and every
 *     send resolves to { sent: false, reason: "not_configured" }. The day
 *     the variables appear, sends start working with no code change.
 *
 * Messages are plain text on purpose: nothing sent so far needs markup, and
 * plain text cannot smuggle in tracking or broken rendering. Content rules
 * follow the audit log's: amounts and names are fine, credentials and
 * banking identifiers must never appear.
 */
import { Resend } from "resend";
import { readEmailConfigFromEnv } from "./config";
import { log } from "./logger";
import type { EmailOutcome, EmailTemplate } from "@shared/emailTemplates";

export interface OutboundEmail {
  /** Which automated email this is, for the email log. */
  template: EmailTemplate;
  to: string;
  subject: string;
  text: string;
}

/** What the email log records about one send: never the subject or the body. */
export interface EmailOutcomeRecord {
  template: EmailTemplate;
  recipient: string;
  outcome: EmailOutcome;
  errorClass: string | null;
}

type OutcomeListener = (record: EmailOutcomeRecord) => void | Promise<void>;
let outcomeListener: OutcomeListener | null = null;

/**
 * Where each send's outcome goes -- the email log, registered at boot
 * (server/routes.ts). Kept as a seam so this module still never touches the
 * database, and a failure to log can never fail a send.
 */
export function onEmailOutcome(listener: OutcomeListener | null): void {
  outcomeListener = listener;
}

function report(message: OutboundEmail, outcome: EmailOutcome, errorClass: string | null = null): void {
  if (!outcomeListener) return;
  try {
    void Promise.resolve(outcomeListener({ template: message.template, recipient: message.to, outcome, errorClass })).catch((error) =>
      log(`could not record an email outcome: ${error instanceof Error ? error.name : "error"}`, "email"),
    );
  } catch (error) {
    log(`could not record an email outcome: ${error instanceof Error ? error.name : "error"}`, "email");
  }
}

/** A short, safe label for what went wrong: an error's kind, never its text. */
function errorClassOf(value: unknown): string {
  const name = (value as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "unknown";
}

export type SendEmailResult =
  | { sent: true; id: string | null }
  | { sent: false; reason: "not_configured" | "send_failed" };

/** Whether a send would actually go out, for features that want to say so. */
export function isEmailConfigured(): boolean {
  return readEmailConfigFromEnv().configured;
}

export async function sendEmail(message: OutboundEmail): Promise<SendEmailResult> {
  const config = readEmailConfigFromEnv();
  if (!config.configured) {
    log(`email not configured; skipped "${message.subject}" to ${message.to}`, "email");
    report(message, "not_configured");
    return { sent: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(config.apiKey);
    const { data, error } = await resend.emails.send({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
    });

    if (error) {
      log(`send failed for "${message.subject}" to ${message.to}: ${error.message}`, "email");
      report(message, "failed", errorClassOf(error));
      return { sent: false, reason: "send_failed" };
    }

    report(message, "sent");
    return { sent: true, id: data?.id ?? null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`send threw for "${message.subject}" to ${message.to}: ${detail}`, "email");
    report(message, "failed", errorClassOf(error));
    return { sent: false, reason: "send_failed" };
  }
}
