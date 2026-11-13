// The route handler to debug, on the Node.js runtime. Next.js bundles it into `.next/server/`, and the SDK does not
// support bundled code yet, so a breakpoint on the marked line stays unresolved: see tests/nextjs.test.ts.

import type { NextRequest } from "next/server";

const UNIT_PRICES: Partial<Record<string, number>> = { "SKU-1": 19.99, "SKU-2": 4.5 };

/** `GET /quote?sku=&quantity=`: prices `quantity` items of `sku`; an unknown SKU costs 1 per item. */
export const GET = (request: NextRequest): Response => {
  const sku = request.nextUrl.searchParams.get("sku") ?? "SKU-1";
  const quantity = Number(request.nextUrl.searchParams.get("quantity") ?? "1");
  const unitPrice = UNIT_PRICES[sku] ?? 1;
  const total = unitPrice * quantity;
  return Response.json({ sku, quantity, total }); // breakpoint here
};
