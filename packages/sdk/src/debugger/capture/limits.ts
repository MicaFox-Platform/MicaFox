import type { CaptureLimits } from "@probex-platform/protocol";

/** `CaptureLimits` with every field set: defaults filled in and larger values lowered to their caps. */
export interface ResolvedLimits {
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxStringLength: number;
}

const DEFAULTS: ResolvedLimits = { maxDepth: 3, maxItems: 20, maxStringLength: 256 };
const CAPS: ResolvedLimits = { maxDepth: 5, maxItems: 100, maxStringLength: 4096 };

/** The limits of a breakpoint, which the hub may leave out or set above the caps. */
export const resolveLimits = (limits: CaptureLimits | undefined): ResolvedLimits => ({
  maxDepth: Math.min(limits?.maxDepth ?? DEFAULTS.maxDepth, CAPS.maxDepth),
  maxItems: Math.min(limits?.maxItems ?? DEFAULTS.maxItems, CAPS.maxItems),
  maxStringLength: Math.min(limits?.maxStringLength ?? DEFAULTS.maxStringLength, CAPS.maxStringLength),
});

/** The largest of each limit across breakpoints, which one read serves; the defaults when there are none. */
export const largestLimits = (all: ReadonlyArray<CaptureLimits | undefined>): ResolvedLimits =>
  all.map(resolveLimits).reduce(
    (largest, next) => ({
      maxDepth: Math.max(largest.maxDepth, next.maxDepth),
      maxItems: Math.max(largest.maxItems, next.maxItems),
      maxStringLength: Math.max(largest.maxStringLength, next.maxStringLength),
    }),
    all.length === 0 ? DEFAULTS : { maxDepth: 0, maxItems: 0, maxStringLength: 0 },
  );

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** The first `maxLength` UTF-16 code units of `text`, without splitting a surrogate pair. */
export const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }

  const splitsPair = isHighSurrogate(text.charCodeAt(maxLength - 1)) && isLowSurrogate(text.charCodeAt(maxLength));
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
};
