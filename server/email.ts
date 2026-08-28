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

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
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
      return { sent: false, reason: "send_failed" };
    }

    return { sent: true, id: data?.id ?? null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`send threw for "${message.subject}" to ${message.to}: ${detail}`, "email");
    return { sent: false, reason: "send_failed" };
  }
}
