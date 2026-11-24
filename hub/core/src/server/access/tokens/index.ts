import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/** A new secret: 32 random bytes in base64url behind `prefix`. Show it once and store only its `hashToken`. */
export const createToken = (prefix = ""): string => `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;

/** The SHA-256 of a token as hex, the only form the hub stores and looks up (ADR 0030). */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
