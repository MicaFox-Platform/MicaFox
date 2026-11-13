// Prices an order line: the code to debug. Its local `apiKey` stands for a secret a real pricing call signs with; a
// snapshot here shows it as `redacted`, never its value.

import { createHash } from "node:crypto";

import { roundToCents } from "./a/util.js";
import { normalizeSku } from "./b/util.js";

const UNIT_PRICES: Readonly<Record<string, number>> = { "SKU-1": 19.99, "SKU-2": 4.5 };
const DEFAULT_UNIT_PRICE = 1;
// Only a fallback for the demo; a real app reads its secrets from the deployment
const DEMO_API_KEY = "demo-pricing-key";

/** The price of `quantity` items of one SKU, signed so a downstream service can check it. */
export interface Quote {
  sku: string;
  quantity: number;
  total: number;
  signature: string;
}

/** Prices `quantity` items of `rawSku`; an unknown SKU costs 1 per item. */
export const quote = (rawSku: string, quantity: number): Quote => {
  const apiKey = process.env.PRICING_API_KEY ?? DEMO_API_KEY;
  const sku = normalizeSku(rawSku);
  const unitPrice = UNIT_PRICES[sku] ?? DEFAULT_UNIT_PRICE;
  const total = roundToCents(unitPrice * quantity);
  const signature = createHash("sha256")
    .update(`${apiKey}:${sku}:${String(total)}`)
    .digest("hex")
    .slice(0, 16);
  // tools/testkit/.env.example holds the number of the next line; its test/env-examples.test.ts fails when it moves
  return { sku, quantity, total, signature }; // breakpoint here
};
