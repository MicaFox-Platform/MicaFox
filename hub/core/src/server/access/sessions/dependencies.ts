import type { Database } from "../../db/index.js";
import type { PasswordHasher } from "../password/index.js";
import type { EmailBackoff } from "../throttle/index.js";

/** What sessions, and the setup that starts the first one, need from the hub. */
export interface SessionDependencies {
  db: Database;
  passwords: PasswordHasher;
  emailBackoff: EmailBackoff;
  /** The URL users open; it is known once the hub listens, so each request asks for it. */
  publicUrl: () => string;
  /** The clock, in milliseconds. */
  now: () => number;
}
