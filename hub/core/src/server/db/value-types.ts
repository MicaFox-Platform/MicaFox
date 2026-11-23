// Postgres type ids whose values both dialects return as the text Postgres sends: pg and PGlite parse them
// differently (int8 to a string or a number, date to a local or a UTC Date, interval to an object or a string), so
// code that passes on PGlite would break on Postgres
const INT8 = 20;
const DATE = 1082;
const INTERVAL = 1186;

/** The type ids returned as text by every dialect of the hub. */
export const TEXT_TYPE_IDS: readonly number[] = [INT8, DATE, INTERVAL];

/** Returns the value as Postgres sent it. */
export const asText = (value: string): string => value;
