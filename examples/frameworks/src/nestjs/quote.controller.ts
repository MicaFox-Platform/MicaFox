// The NestJS controller to debug: a breakpoint on the marked line of the .ts source captures `sku`, `quantity`,
// `unitPrice` and `total`, through the .map the Nest CLI writes beside the compiled .js.

import { Controller, Get, Query } from "@nestjs/common";

const UNIT_PRICES: Partial<Record<string, number>> = { "SKU-1": 19.99, "SKU-2": 4.5 };

interface Quote {
  readonly sku: string;
  readonly quantity: number;
  readonly total: number;
}

@Controller()
export class QuoteController {
  /** `GET /quote?sku=&quantity=`: prices `quantity` items of `sku`; an unknown SKU costs 1 per item. */
  @Get("quote")
  quote(@Query("sku") skuParameter?: string, @Query("quantity") quantityParameter?: string): Quote {
    const sku = skuParameter ?? "SKU-1";
    const quantity = Number(quantityParameter ?? "1");
    const unitPrice = UNIT_PRICES[sku] ?? 1;
    const total = unitPrice * quantity;
    return { sku, quantity, total }; // breakpoint here
  }
}
