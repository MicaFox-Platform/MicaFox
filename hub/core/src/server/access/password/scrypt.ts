import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

interface Params {
  cost: number;
  blockSize: number;
  parallelization: number;
}

/** The parameters of a new hash, from docs/architecture/hub/access.md#logging-in. */
export const CURRENT_PARAMS: Params = { cost: 2 ** 15, blockSize: 8, parallelization: 3 };

const SALT_BYTES = 16;
const KEY_BYTES = 32;
// scrypt needs 128 * N * r bytes, which is Node's default limit exactly; the headroom is for p
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/;

interface ParsedHash extends Params {
  salt: Buffer;
  key: Buffer;
}

const derive = async (password: string, salt: Buffer, params: Params): Promise<Buffer> =>
  await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_BYTES,
      // Node's own option names
      {
        cost: params.cost,
        blockSize: params.blockSize,
        parallelization: params.parallelization,
        maxmem: MAX_MEMORY_BYTES,
      },
      (error, key) => {
        if (error === null) {
          resolve(key);
        } else {
          reject(error);
        }
      },
    );
  });

const format = (params: Params, salt: Buffer, key: Buffer): string =>
  [
    "scrypt",
    String(params.cost),
    String(params.blockSize),
    String(params.parallelization),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");

// A hash the database holds is the hub's own; one that does not parse is treated as a wrong password, never a crash
const parse = (stored: string): ParsedHash | undefined => {
  const match = FORMAT.exec(stored);
  if (match === null) {
    return undefined;
  }
  const [, cost, blockSize, parallelization, salt, key] = match;
  return {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
    salt: Buffer.from(salt ?? "", "base64url"),
    key: Buffer.from(key ?? "", "base64url"),
  };
};

/** `scrypt$N$r$p$salt$key`, so a hash says how to check it and a stronger setting can replace it later. */
export const hashWithScrypt = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  return format(CURRENT_PARAMS, salt, await derive(password, salt, CURRENT_PARAMS));
};

/** A hash of no password, with the current parameters, to spend the same time on an email that has no user. */
export const decoyHash = (): string => format(CURRENT_PARAMS, Buffer.alloc(SALT_BYTES), Buffer.alloc(KEY_BYTES));

/** Whether `password` made `stored`; a hash in a format this code does not know never matches. */
export const matchesScrypt = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parse(stored);
  if (parsed === undefined) {
    return false;
  }
  try {
    const key = await derive(password, parsed.salt, parsed);
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  } catch {
    // Parameters scrypt refuses, such as a cost that is not a power of two or needs more memory than allowed
    return false;
  }
};

/** Whether `stored` was made with weaker parameters than a new hash would get. */
export const isWeakerThanCurrent = (stored: string): boolean => {
  const parsed = parse(stored);
  return (
    parsed !== undefined &&
    (parsed.cost < CURRENT_PARAMS.cost ||
      parsed.blockSize < CURRENT_PARAMS.blockSize ||
      parsed.parallelization < CURRENT_PARAMS.parallelization)
  );
};
