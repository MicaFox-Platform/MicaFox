// Postgres cannot store NUL in text; a lone surrogate is not text at all. NUL comes in as a variable, which the
// control-character rule cannot see, so the pattern is not spelt with a control character
const NUL = String.fromCharCode(0);
const UNSTORABLE = new RegExp(
  `${NUL}|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]`,
  "g",
);
const REPLACEMENT = "\uFFFD";

/** Whether `text` holds what Postgres cannot store in `text`: NUL or an unpaired surrogate. */
export const hasUnstorable = (text: string): boolean => {
  UNSTORABLE.lastIndex = 0;
  return UNSTORABLE.test(text);
};

/** Replaces what Postgres cannot store in `text` with U+FFFD, and counts each one. */
export const replaceUnstorable = (text: string, counter: { replaced: number }): string =>
  text.replace(UNSTORABLE, () => {
    counter.replaced += 1;
    return REPLACEMENT;
  });
