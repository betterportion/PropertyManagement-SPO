import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { isPortalAccessQuery, portalAccessKey } from "./portalAccess";

describe("isPortalAccessQuery", () => {
  it("marks a housemate's portal access stale after a grant on another resident", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const sam = [portalAccessKey(1)];
    const jordan = [portalAccessKey(2)];
    const roster = ["/api/residents"];
    const samRecord = ["/api/residents/1"];
    for (const key of [sam, jordan, roster, samRecord]) client.setQueryData(key, {});

    await client.invalidateQueries({ predicate: isPortalAccessQuery });

    expect(client.getQueryState(sam)?.isInvalidated).toBe(true);
    expect(client.getQueryState(jordan)?.isInvalidated).toBe(true);
    expect(client.getQueryState(roster)?.isInvalidated).toBe(false);
    expect(client.getQueryState(samRecord)?.isInvalidated).toBe(false);
  });
});
