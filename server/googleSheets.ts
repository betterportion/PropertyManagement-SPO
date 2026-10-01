/**
 * Reading the master resident sheet from Google Sheets -- the only code that
 * talks to Google for it, behind `RosterSheetReader` so the tests replace it.
 *
 * Read-only twice over: the service account asks only for the
 * spreadsheets.readonly scope, and SPO shares the sheet with it as a Viewer.
 * No Google library is added for one read: the service account signs its own
 * token request with Node's crypto.
 *
 * Only the allowlisted columns are ever requested. The header row is read
 * first; if any header looks like a banking field, no data rows are read at
 * all, and the planner refuses the sheet (server/rosterSync.ts).
 */
import { createSign } from "node:crypto";
import type { RosterSheetConfig } from "./config";
import { looksLikeBankingHeader, mapRosterHeaders } from "@shared/rosterSheet";
import type { SheetTable } from "./rosterSync";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export interface RosterSheetReader {
  readTable(): Promise<SheetTable>;
}

/** A failure reading the sheet, in words for an admin -- never a key or a response body. */
export class RosterSheetError extends Error {}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function createRosterSheetReader(config: RosterSheetConfig, fetchImpl: typeof fetch = fetch): RosterSheetReader {
  const tab = `'${config.tab.replace(/'/g, "''")}'`;

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(config.privateKey);
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${base64url(signature)}`,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !json.access_token) {
      throw new RosterSheetError(`Google refused the service account's sign-in (HTTP ${res.status}). Check GOOGLE_SERVICE_ACCOUNT_JSON.`);
    }
    return json.access_token;
  }

  async function get<T>(token: string, path: string, params: URLSearchParams): Promise<T> {
    const res = await fetchImpl(`${SHEETS_BASE}/${encodeURIComponent(config.sheetId)}${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403 || res.status === 404) {
      throw new RosterSheetError(
        `Google can't find the sheet or tab, or it isn't shared with ${config.clientEmail} (HTTP ${res.status}). Check RESIDENT_SHEET_ID, RESIDENT_SHEET_TAB and the sharing.`,
      );
    }
    if (!res.ok) throw new RosterSheetError(`Google Sheets did not answer (HTTP ${res.status}).`);
    return (await res.json()) as T;
  }

  return {
    async readTable() {
      const token = await accessToken();
      const head = await get<{ values?: string[][] }>(token, `/values/${encodeURIComponent(`${tab}!1:1`)}`, new URLSearchParams());
      const headers = (head.values?.[0] ?? []).map(String);
      // Refused on the headers alone: not one data cell is fetched.
      if (headers.some((h) => looksLikeBankingHeader(h))) return { headers, rows: [] };

      const wanted = mapRosterHeaders(headers)
        .map((key, index) => (key ? index : -1))
        .filter((index) => index !== -1);
      if (wanted.length === 0) return { headers, rows: [] };

      const params = new URLSearchParams({ majorDimension: "COLUMNS", valueRenderOption: "FORMATTED_VALUE" });
      for (const index of wanted) params.append("ranges", `${tab}!${columnLetter(index)}2:${columnLetter(index)}`);
      const batch = await get<{ valueRanges?: Array<{ values?: string[][] }> }>(token, "/values:batchGet", params);

      const columns = wanted.map((_, i) => (batch.valueRanges?.[i]?.values?.[0] ?? []).map(String));
      const height = Math.max(0, ...columns.map((c) => c.length));
      const rows = Array.from({ length: height }, (_, r) => {
        const cells = new Array<string>(headers.length).fill("");
        wanted.forEach((index, i) => {
          cells[index] = columns[i][r] ?? "";
        });
        return cells;
      });
      return { headers, rows };
    },
  };
}
