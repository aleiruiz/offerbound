import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkerCtx } from "../src/deps.js";

type AnyFn = (...args: unknown[]) => unknown;

/**
 * A copy of `ctx` whose transactions behave as usual except for one model method: `replace`
 * receives the real call and decides what happens (run an owner's edit first, throw, ...).
 * It lets a test act "between the snapshot and the write" without timing tricks.
 */
export function interceptTx<C extends WorkerCtx>(
  ctx: C,
  model: keyof Prisma.TransactionClient & string,
  method: string,
  replace: (call: () => Promise<unknown>, args: unknown[]) => Promise<unknown>,
): C {
  const base: PrismaClient = ctx.prisma;
  const wrapModel = (delegate: object): object =>
    new Proxy(delegate, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property !== method || typeof value !== "function") return value;
        return (...args: unknown[]) =>
          replace(() => Promise.resolve((value as AnyFn).apply(target, args)), args);
      },
    });
  const wrapTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property === model) return wrapModel(value as object);
        return typeof value === "function" ? (value as AnyFn).bind(target) : value;
      },
    });
  const prisma = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "$transaction") {
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => fn(wrapTx(tx)), options);
      }
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
  return { ...ctx, prisma };
}
