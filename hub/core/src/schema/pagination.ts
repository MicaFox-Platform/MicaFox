import { Type } from "typebox";
import type { TArray, TInteger, TObject, TOptional, TSchema, TString } from "typebox";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
// Cursors are opaque to clients; this bounds what one can make the hub parse
const MAX_CURSOR_LENGTH = 512;

/** The query parameters of every list; a list spreads them into its own query object, beside its filters. */
export const pageQueryProperties: { limit: TOptional<TInteger>; cursor: TOptional<TString> } = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CURSOR_LENGTH })),
};

/** The answer of every list: a page of `item`, and `nextCursor` unless it is the last page. */
export const pageOf = <Item extends TSchema>(
  item: Item,
): TObject<{ items: TArray<Item>; nextCursor: TOptional<TString> }> =>
  Type.Object({ items: Type.Array(item), nextCursor: Type.Optional(Type.String()) });
