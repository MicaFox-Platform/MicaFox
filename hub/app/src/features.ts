import { extension } from "#ee";
import type { Extension, Feature } from "@micafox/hub-core";

/** The server features in the order of their migrations; the debugger joins when its server part exists. */
export const FEATURES: readonly Feature[] = [];

/** The paid features of `ee/`: empty in the basic hub, whose build holds no file of it. */
export const EXTENSION: Extension = extension;
