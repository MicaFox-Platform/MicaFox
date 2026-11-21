// The code to debug: a breakpoint on the marked line captures `sku`, `quantity`, `unitPrice` and `total`.

const UNIT_PRICES = { "SKU-1": 19.99, "SKU-2": 4.5 };

/** Prices `quantity` items of `sku`; an unknown SKU costs 1 per item. */
const quote = (sku, quantity) => {
  const unitPrice = UNIT_PRICES[sku] ?? 1;
  const total = unitPrice * quantity;
  return { sku, quantity, total }; // breakpoint here
};

module.exports = { quote };
