import { Writable } from "node:stream";

/** A log stream that keeps what the hub writes, for assertions on its lines. */
export interface LogCapture {
  stream: Writable;
  lines: () => Array<Record<string, unknown>>;
  text: () => string;
}

export const captureLog = (): LogCapture => {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    text: () => written.join(""),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};
