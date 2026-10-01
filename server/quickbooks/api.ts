/**
 * The only code that talks to Intuit. Everything else goes through the
 * `QuickBooksApi` interface, which the tests replace wholesale -- `npm test`
 * never reaches QuickBooks and needs no secret.
 *
 * Read-only by construction: the scope requested is the accounting scope
 * (Intuit has no narrower read-only one), but the only calls this file makes
 * are company info, two list queries and the Profit and Loss report.
 *
 * Errors say what happened in words an admin can act on and carry an HTTP
 * status at most -- never a token, never a raw response body, because the
 * message ends up on the settings screen and in the server log.
 */
import type { QuickBooksConfig } from "../config";
import type { ProfitAndLossReport } from "./report";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
} as const;
const SCOPE = "com.intuit.quickbooks.accounting";
const MINOR_VERSION = "75";

export interface QuickBooksTokens {
  accessToken: string;
  /** Intuit may hand back a new one on every refresh; it must be stored. */
  refreshToken: string;
  refreshTokenExpiresAt: Date | null;
}

export interface QuickBooksListItem {
  id: string;
  name: string;
}

export interface QuickBooksAccount extends QuickBooksListItem {
  type: string;
}

export interface QuickBooksApi {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<QuickBooksTokens>;
  refresh(refreshToken: string): Promise<QuickBooksTokens>;
  revoke(refreshToken: string): Promise<void>;
  companyName(accessToken: string, realmId: string): Promise<string>;
  listClasses(accessToken: string, realmId: string): Promise<QuickBooksListItem[]>;
  listExpenseAccounts(accessToken: string, realmId: string): Promise<QuickBooksAccount[]>;
  profitAndLossByClass(accessToken: string, realmId: string, startDate: string, endDate: string): Promise<ProfitAndLossReport>;
}

/** The refresh token was refused: the connection is gone and an admin must reconnect. */
export class QuickBooksConnectionLostError extends Error {}

/** Any other failure talking to QuickBooks. */
export class QuickBooksRequestError extends Error {}

/** Account types whose balances are spending. */
const EXPENSE_ACCOUNT_TYPES = new Set(["Expense", "Other Expense", "Cost of Goods Sold"]);

export function createQuickBooksApi(config: QuickBooksConfig, fetchImpl: typeof fetch = fetch): QuickBooksApi {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const apiBase = API_BASE[config.environment];

  async function tokenRequest(body: URLSearchParams): Promise<QuickBooksTokens> {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (json.error === "invalid_grant") {
        throw new QuickBooksConnectionLostError("QuickBooks no longer accepts this connection. Reconnect it in Settings.");
      }
      throw new QuickBooksRequestError(`QuickBooks refused the sign-in exchange (HTTP ${res.status}).`);
    }
    const accessToken = typeof json.access_token === "string" ? json.access_token : null;
    const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
    if (!accessToken || !refreshToken) {
      throw new QuickBooksRequestError("QuickBooks sent back an incomplete sign-in.");
    }
    const ttl = typeof json.x_refresh_token_expires_in === "number" ? json.x_refresh_token_expires_in : null;
    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: ttl ? new Date(Date.now() + ttl * 1_000) : null,
    };
  }

  async function apiGet<T>(accessToken: string, path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${apiBase}${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: MINOR_VERSION })) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (res.status === 401) {
      throw new QuickBooksConnectionLostError("QuickBooks refused the portal's access. Reconnect it in Settings.");
    }
    if (!res.ok) throw new QuickBooksRequestError(`QuickBooks did not answer a request (HTTP ${res.status}).`);
    return (await res.json()) as T;
  }

  async function query<T>(accessToken: string, realmId: string, entity: string, statement: string): Promise<T[]> {
    const json = await apiGet<{ QueryResponse?: Record<string, T[]> }>(accessToken, `/v3/company/${realmId}/query`, {
      query: statement,
    });
    return json.QueryResponse?.[entity] ?? [];
  }

  return {
    authorizeUrl(state) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPE);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    exchangeCode(code) {
      return tokenRequest(
        new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
      );
    },

    refresh(refreshToken) {
      return tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
    },

    async revoke(refreshToken) {
      const res = await fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token: refreshToken }),
      });
      if (!res.ok) throw new QuickBooksRequestError(`QuickBooks did not confirm the disconnect (HTTP ${res.status}).`);
    },

    async companyName(accessToken, realmId) {
      const json = await apiGet<{ CompanyInfo?: { CompanyName?: string } }>(
        accessToken,
        `/v3/company/${realmId}/companyinfo/${realmId}`,
        {},
      );
      return json.CompanyInfo?.CompanyName ?? "QuickBooks company";
    },

    async listClasses(accessToken, realmId) {
      const rows = await query<{ Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }>(
        accessToken,
        realmId,
        "Class",
        "select * from Class maxresults 1000",
      );
      return rows
        .filter((row) => row.Active !== false)
        .map((row) => ({ id: row.Id, name: row.FullyQualifiedName ?? row.Name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async listExpenseAccounts(accessToken, realmId) {
      const rows = await query<{ Id: string; Name: string; FullyQualifiedName?: string; AccountType?: string; Active?: boolean }>(
        accessToken,
        realmId,
        "Account",
        "select * from Account where Active = true maxresults 1000",
      );
      return rows
        .filter((row) => row.AccountType && EXPENSE_ACCOUNT_TYPES.has(row.AccountType))
        .map((row) => ({ id: row.Id, name: row.FullyQualifiedName ?? row.Name, type: row.AccountType! }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    profitAndLossByClass(accessToken, realmId, startDate, endDate) {
      return apiGet<ProfitAndLossReport>(accessToken, `/v3/company/${realmId}/reports/ProfitAndLoss`, {
        start_date: startDate,
        end_date: endDate,
        summarize_column_by: "Classes",
      });
    },
  };
}
