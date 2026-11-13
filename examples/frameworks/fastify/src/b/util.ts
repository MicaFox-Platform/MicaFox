// One of two files named util.ts, with a/util.ts: a breakpoint on `util.ts` alone matches both and gets status
// `error`, while `b/util.ts` picks this one.

/** Normalizes a SKU as typed by a client, such as ` sku-1 `, to its catalog form, `SKU-1`. */
export const normalizeSku = (sku: string): string => sku.trim().toUpperCase();
