import { HttpProblem } from "../../app/index.js";

const MAX_NAME_LENGTH = 64;
// Control and format characters, and line or paragraph separators: invisible, so two names would look alike
const INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const invalid = (message: string): HttpProblem =>
  new HttpProblem("validation", {
    detail: `name: ${message}`,
    errors: [{ path: "/name", in: "body", message }],
  });

/**
 * The name to store: in NFC, trimmed, 1 to 64 characters and without control or invisible characters. Uniqueness ignores case and is
 * the database's to decide.
 */
export const normalizeName = (raw: string): string => {
  // NFC, so the same letters typed two ways are one name to the unique index
  const name = raw.normalize("NFC").trim();
  const length = Array.from(name).length;
  if (length === 0) {
    throw invalid("must not be empty");
  }
  if (length > MAX_NAME_LENGTH) {
    throw invalid(`must be at most ${String(MAX_NAME_LENGTH)} characters`);
  }
  if (INVISIBLE_CHARACTER.test(name)) {
    throw invalid("must not contain control or invisible characters");
  }
  return name;
};
