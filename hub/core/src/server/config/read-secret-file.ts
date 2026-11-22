import { closeSync, openSync, readSync } from "node:fs";

const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** A `*_FILE` setting's file is larger than a setting can be. */
export class SecretFileTooLargeError extends Error {
  constructor() {
    super(`The file is larger than ${String(MAX_SECRET_FILE_BYTES)} bytes`);
    this.name = "SecretFileTooLargeError";
  }
}

/** Reads a `*_FILE` setting's file as text; a file over 64 KiB, such as `/dev/zero`, is refused, not read whole. */
export const readSecretFile = (path: string): string => {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    // A pipe or FIFO, such as process substitution, can return a part per read
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (bytesRead === 0 || length === buffer.length) {
        break;
      }
    }
    if (length > MAX_SECRET_FILE_BYTES) {
      throw new SecretFileTooLargeError();
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(descriptor);
  }
};
