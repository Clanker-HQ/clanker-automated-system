import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../src/keyed-mutex.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("KeyedMutex", () => {
  it("runs a single call and returns its result", async () => {
    const mutex = new KeyedMutex();
    expect(await mutex.run("a", async () => 42)).toBe(42);
  });

  it("serializes two calls on the same key — the second doesn't start until the first finishes", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = deferred<void>();

    const call1 = mutex.run("a", async () => {
      order.push("1-start");
      await first.promise;
      order.push("1-end");
    });
    const call2 = mutex.run("a", async () => {
      order.push("2-start");
    });

    // Give call2 every chance to (wrongly) start before call1 finishes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["1-start"]);

    first.resolve();
    await Promise.all([call1, call2]);
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
  });

  it("runs calls on different keys concurrently, not serialized against each other", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const blockA = deferred<void>();

    const callA = mutex.run("a", async () => {
      order.push("a-start");
      await blockA.promise;
      order.push("a-end");
    });
    const callB = mutex.run("b", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await callB;
    // b completed even though a is still blocked — different keys don't queue behind each other.
    expect(order).toEqual(["a-start", "b-start", "b-end"]);
    blockA.resolve();
    await callA;
  });

  it("keeps the queue moving for a key even when an earlier call throws", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run("a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A prior throw must not permanently jam this key's queue.
    expect(await mutex.run("a", async () => "recovered")).toBe("recovered");
  });

  it("propagates each call's own result/error independently under contention", async () => {
    const mutex = new KeyedMutex();
    const results = await Promise.allSettled([
      mutex.run("a", async () => "one"),
      mutex.run("a", async () => {
        throw new Error("two failed");
      }),
      mutex.run("a", async () => "three"),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "one" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toEqual({ status: "fulfilled", value: "three" });
  });
});
