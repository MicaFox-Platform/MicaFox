# 0014. Pass SDK logs as a full message and a context

## Status

Accepted · 2026-10-29

## Context

The SDK reports its own problems to the app's logger. Apps should switch MicaFox to the logger they already use by
passing it as it is: `console`, pino and winston must work without wrapper code, and others with a few lines of
adapter. These loggers disagree on arguments: pino takes `(object, message)` and uses arguments after the message
only to fill `%s`-style placeholders in it, dropping the rest; winston takes `(message, meta)` and merges the meta
object; `console` prints whatever it gets. JSON output turns an `Error` into `{}`.

## Decision

We call each `Logger` method with a message that is complete on its own as the first argument and, always, a
`LogContext` of plain, serializable values as the second.

## Alternatives

- **Message only** — every logger works, but none gets structured fields such as `breakpointId` or the error's
  `code`, and adding them later changes what pino, winston and a passed `console` print for every app that passes
  them directly.
- **Message and raw values, `(message, ...args)`** — pino drops the extra arguments, so the error behind a warning
  is lost, and winston's JSON output prints an `Error` as `{}`.
- **Context first, `(context, message)`** — native in pino, but `console` prints the object before the message and
  winston takes the object as the message.
- **Detect the logger's kind** — breaks on child loggers and wrappers, and every new logger needs SDK code.

## Consequences

- `console`, pino and winston work as passed; winston also gets the context as structured fields.
- pino drops the context; apps that want its fields add a four-line adapter, shown in the API docs.
- The default `console` gets the message alone, so a default setup prints one clean line; an app passes `console`
  itself to print the context too.
- Text from outside the SDK is passed as it is: a `%s` or `%j` in an error message makes pino, winston with
  `format.splat()` and a passed `console` print the context inside the message; the default `console` prints it as
  is.
- `LogContext` gains fields only as optional ones, and `component` may get new values in a minor version.
- Methods are called synchronously; a returned promise is ignored and its rejection caught.
