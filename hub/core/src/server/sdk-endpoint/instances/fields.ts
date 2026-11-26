import type { Hello } from "@micafox/protocol";

import { replaceUnstorable } from "../../db/index.js";

/** The limits of what a `hello` may store: docs/architecture/hub/sdk-endpoint.md#keeping-instances. */
export const FIELD_LIMITS = {
  service: 128,
  hostname: 255,
  labels: 32,
  labelKey: 64,
  labelValue: 256,
  sdk: 64,
  commit: 64,
} as const;

// `pid` is an `integer` column; a real one is a positive 31-bit number
const MAX_PID = 2_147_483_647;

/** What a `hello` leaves in the table, cut to fit and free of what Postgres cannot store. */
export interface InstanceFields {
  service: string | null;
  labels: Record<string, string>;
  hostname: string;
  pid: number;
  sdkName: string;
  sdkVersion: string;
  runtimeName: string;
  runtimeVersion: string;
  modules: string[];
  commit: string | null;
  protocolVersion: number;
}

/** The fields to store, how many were cut or repaired, and how many characters were replaced. */
export interface CutFields {
  fields: InstanceFields;
  /** Fields, labels and characters the hub changed to fit: counted, never a reason to refuse the session. */
  cut: number;
  /** NUL characters and unpaired surrogates replaced with U+FFFD. */
  replaced: number;
}

// Cuts `text` to `max` UTF-16 units without leaving half of a surrogate pair, which Postgres could not store
const cutText = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  const end = max > 0 && text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
};

/**
 * Makes the fields of a `hello` storable: each is scrubbed of NUL and unpaired surrogates, then cut at its limit.
 * `modules` are the ones the session agreed on, which the hub bounds, not the ones the SDK listed.
 */
export const cutFields = (hello: Hello, modules: readonly string[]): CutFields => {
  const counter = { replaced: 0 };
  let cut = 0;
  const fit = (text: string, max: number): string => {
    const clean = replaceUnstorable(text, counter);
    const fitted = cutText(clean, max);
    cut += fitted === clean ? 0 : 1;
    return fitted;
  };
  const optional = (text: string | undefined, max: number): string | null =>
    text === undefined ? null : fit(text, max);

  const entries = Object.entries(hello.labels);
  cut += Math.max(entries.length - FIELD_LIMITS.labels, 0);
  const kept = entries
    .slice(0, FIELD_LIMITS.labels)
    .map(([key, value]): [string, string] => [fit(key, FIELD_LIMITS.labelKey), fit(value, FIELD_LIMITS.labelValue)]);
  // Own properties, so a key such as `__proto__` is a label like any other
  const labels: Record<string, string> = Object.fromEntries(kept);
  // Keys that a cut made the same keep the last value; the others count as cut
  cut += kept.length - Object.keys(labels).length;
  const pid = Number.isInteger(hello.pid) && hello.pid >= 0 && hello.pid <= MAX_PID ? hello.pid : 0;
  cut += pid === hello.pid ? 0 : 1;

  const fields: InstanceFields = {
    service: optional(hello.service, FIELD_LIMITS.service),
    labels,
    hostname: fit(hello.hostname, FIELD_LIMITS.hostname),
    pid,
    sdkName: fit(hello.sdk.name, FIELD_LIMITS.sdk),
    sdkVersion: fit(hello.sdk.version, FIELD_LIMITS.sdk),
    runtimeName: fit(hello.runtime.name, FIELD_LIMITS.sdk),
    runtimeVersion: fit(hello.runtime.version, FIELD_LIMITS.sdk),
    modules: [...modules],
    commit: optional(hello.commit, FIELD_LIMITS.commit),
    protocolVersion: hello.version,
  };
  return { fields, cut, replaced: counter.replaced };
};
