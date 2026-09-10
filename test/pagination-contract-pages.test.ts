import { expect, test } from "bun:test";
import { walkPages, type PageLike } from "../web/src/api.js";

const page = <T>(items: T[], next: string | null): PageLike<T> => ({
  items,
  next,
});

/** Issue #29: the shared pagination walker must make progress, keep partial
 * pages on failure, and stay cancellable instead of merging the same page
 * until an arbitrary cap. Tests drive it with an injected page fetcher. */
test("P1 #29 walker stops when the server repeats the same cursor", async () => {
  const calls: string[] = [];
  const result = await walkPages("", page(["a", "b"], "cursor-1"), {
    keyOf: (v) => v,
    fetchPage: async (cursor) => {
      calls.push(cursor);
      return page(["c"], "cursor-1");
    },
  });
  expect(result.items).toEqual(["a", "b", "c"]);
  expect(result.repeatedCursor).toBe(true);
  expect(result.pages).toBe(1);
  expect(calls).toEqual(["cursor-1"]);
  expect((result.error as { code?: string })?.code).toBe("invalid_cursor");
});

test("P1 #29 walker stops on a cursor cycle", async () => {
  const result = await walkPages("", page([0], "a"), {
    fetchPage: async (cursor) =>
      cursor === "a" ? page([1], "b") : page([2], "a"),
  });
  expect(result.items).toEqual([0, 1, 2]);
  expect(result.repeatedCursor).toBe(true);
  expect(result.pages).toBe(2);
});

test("P1 #29 walker rejects a regressing cursor when an order is known", async () => {
  const result = await walkPages("", page([0], "m"), {
    cursorOrder: (previous, next) => next > previous,
    fetchPage: async (cursor) =>
      cursor === "m" ? page([1], "b") : page([2], "z"),
  });
  expect(result.items).toEqual([0, 1]);
  expect(result.pages).toBe(1);
  expect((result.error as { code?: string })?.code).toBe("invalid_cursor");
});

test("P1 #29 walker preserves collected pages when a later page fails", async () => {
  const result = await walkPages("", page([0], "a"), {
    fetchPage: async (cursor) => {
      if (cursor === "a") return page([1], "b");
      throw Object.assign(new Error("boom"), { code: "unknown" });
    },
  });
  expect(result.items).toEqual([0, 1]);
  expect(result.pages).toBe(1);
  expect(result.next).toBe("b");
  expect(result.error).toBeInstanceOf(Error);
  expect(result.incomplete).toBe(false);
});

test("P1 #29 walker discards an in-flight page after cancellation", async () => {
  let cancelled = false;
  const result = await walkPages("", page([0], "a"), {
    isCancelled: () => cancelled,
    fetchPage: async () => {
      cancelled = true; // unmount happens while the request is in flight
      return page([1], "b");
    },
  });
  expect(result.items).toEqual([0]);
  expect(result.cancelled).toBe(true);
  expect(result.pages).toBe(0);
  expect(result.error).toBe(null);
});

test("P1 #29 walker reports an explicit incomplete limit and keeps the cursor", async () => {
  const result = await walkPages("", page([0], "a"), {
    maxPages: 2,
    fetchPage: async (cursor) =>
      cursor === "a" ? page([1], "b") : page([2], "c"),
  });
  expect(result.items).toEqual([0, 1, 2]);
  expect(result.pages).toBe(2);
  expect(result.next).toBe("c");
  expect(result.incomplete).toBe(true);
});

test("P1 #29 walker deduplicates repeated rows and reports cumulative pages", async () => {
  const snapshots: number[] = [];
  const result = await walkPages("", page([{ id: "a" }], "1"), {
    keyOf: (item) => item.id,
    onPage: (snapshot) => snapshots.push(snapshot.items.length),
    fetchPage: async (cursor) =>
      cursor === "1"
        ? page([{ id: "a" }, { id: "b" }], "2")
        : page([{ id: "b" }], null),
  });
  expect(result.items).toEqual([{ id: "a" }, { id: "b" }]);
  expect(result.pages).toBe(2);
  expect(result.next).toBe(null);
  expect(result.repeatedCursor).toBe(false);
  expect(snapshots).toEqual([2, 2]);
});
