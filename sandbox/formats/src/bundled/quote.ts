// The code to debug: a breakpoint on the marked line captures `sku`, `quantity`, `unitPrice` and `total`.

const UNIT_PRICES: Readonly<Record<string, number>> = { "SKU-1": 19.99, "SKU-2": 4.5 };

/** The price of `quantity` items of one SKU. */
export interface Quote {
  sku: string;
  quantity: number;
  total: number;
}

/** Prices `quantity` items of `sku`; an unknown SKU costs 1 per item. */
export const quote = (sku: string, quantity: number): Quote => {
  const unitPrice = UNIT_PRICES[sku] ?? 1;
  const total = unitPrice * quantity;
  return { sku, quantity, total }; // breakpoint here
};
