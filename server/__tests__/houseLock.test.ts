import { describe, it, expect } from "vitest";
import { withHouseLock } from "../houseLock";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withHouseLock (#313)", () => {
  it("lets the second request on a house count only after the first has written", async () => {
    const accounts: string[] = ["a", "b", "c"];
    const grant = (who: string) =>
      withHouseLock("house-1", async () => {
        const seen = accounts.length; // the count
        await tick(); // the gap a database round trip leaves
        if (seen >= 4) return "refused";
        accounts.push(who); // the write
        return "granted";
      });
    expect(await Promise.all([grant("d"), grant("e")])).toEqual(["granted", "refused"]);
    expect(accounts).toHaveLength(4);
  });

  it("does not hold up another house, and runs at once with no house", async () => {
    const order: string[] = [];
    const slow = withHouseLock("house-1", async () => { await tick(); await tick(); order.push("slow"); });
    const other = withHouseLock("house-2", async () => { order.push("other"); });
    const none = withHouseLock(null, async () => { order.push("none"); });
    await Promise.all([slow, other, none]);
    expect(order.indexOf("slow")).toBe(2);
  });

  it("keeps the line moving after a failure", async () => {
    const failed = withHouseLock("house-3", async () => { throw new Error("boom"); });
    await expect(failed).rejects.toThrow("boom");
    expect(await withHouseLock("house-3", async () => "next")).toBe("next");
  });
});
