// The Express route handler to debug: a breakpoint on the marked line captures the request's locals `sku`,
// `quantity`, `unitPrice` and `total`.

const UNIT_PRICES = { "SKU-1": 19.99, "SKU-2": 4.5 };

/** `GET /quote?sku=&quantity=`: prices `quantity` items of `sku`; an unknown SKU costs 1 per item. */
const quote = (request, response) => {
  const sku = String(request.query.sku ?? "SKU-1");
  const quantity = Number(request.query.quantity ?? "1");
  const unitPrice = UNIT_PRICES[sku] ?? 1;
  const total = unitPrice * quantity;
  response.json({ sku, quantity, total }); // breakpoint here
};

module.exports = { quote };
