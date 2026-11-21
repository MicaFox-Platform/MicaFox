// One of two files named util.ts, with b/util.ts: a breakpoint on `util.ts` alone matches both and gets status
// `error`, while `a/util.ts` picks this one.

/** Rounds an amount to whole cents. */
export const roundToCents = (amount: number): number => Math.round(amount * 100) / 100;
