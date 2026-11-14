# 0011. Encode snapshot values as a nested tree

## Status

Accepted · 2026-10-23

## Context

A snapshot carries the variables of a paused frame: primitives, strings, arrays, objects, maps and sets, often
nested and sometimes cyclic or shared. Hubs and UIs, including custom ones, read the format to show values. The SDK
cuts every value to depth, size and time limits, so a snapshot is small and a reader must see what was cut.

## Decision

We encode each value as a JSON object with a `type` that holds its children inline, and mark cut values and cycles
in place.

## Alternatives

- **A flat table of values that refer to each other by index** — a shared object is stored once, but every hub and
  UI has to resolve the references, and a snapshot is hard to read in a log or a test. Within the depth limit,
  repeated shared objects cost little.
- **Values as strings, like `util.inspect` output** — simple to show, but a reader cannot expand, search or compare
  fields, and the hub cannot tell what was cut.

## Consequences

- A hub or UI renders a snapshot by walking the tree, with no reference resolution.
- A shared object reached twice is stored twice; a cycle is marked `circular` instead of repeating.
- The position of a value in the tree is its path, so later protocol additions can address one value of a
  breakpoint, for example to capture more of it.
- New value types are additions: a reader shows an unknown `type` as unavailable.
