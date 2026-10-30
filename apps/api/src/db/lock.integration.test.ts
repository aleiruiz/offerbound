import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { testPrisma } from "../../test/db.js";
import { INTAKE_LOCK_TX_OPTIONS, withIntakeLock } from "./lock.js";

const prisma = testPrisma();

describe("withIntakeLock", () => {
  it("runs one holder at a time and returns the callback's value", async () => {
    const order: string[] = [];
    const slow = withIntakeLock(prisma, async () => {
      order.push("first start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push("first end");
      return 1;
    });
    // Let the first transaction take the lock before the second asks for it.
    await vi.waitFor(() => expect(order).toEqual(["first start"]));
    const fast = withIntakeLock(prisma, () => {
      order.push("second");
      return Promise.resolve(2);
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(order).toEqual(["first start", "first end", "second"]);
  });

  it("gives the transaction a timeout and a wait for a connection beyond Prisma's 5 s default", async () => {
    // The timeout also covers the wait for the lock, so a long holder (an import, a search
    // finalize) must not make a short critical section fail.
    expect(INTAKE_LOCK_TX_OPTIONS.timeout).toBeGreaterThan(5_000);
    expect(INTAKE_LOCK_TX_OPTIONS.maxWait).toBeGreaterThan(2_000);
    const transaction = vi.fn().mockResolvedValue("ok");
    const fake = { $transaction: transaction } as unknown as PrismaClient;
    expect(await withIntakeLock(fake, () => Promise.resolve("unused"))).toBe("ok");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), INTAKE_LOCK_TX_OPTIONS);
  });

  it("applies the transaction timeout to the wait for the lock", async () => {
    let held = false;
    const holder = withIntakeLock(prisma, async () => {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await vi.waitFor(() => expect(held).toBe(true));
    await expect(
      withIntakeLock(prisma, () => Promise.resolve(1), { timeout: 100, maxWait: 100 }),
    ).rejects.toThrow();
    await holder;
  });
});
