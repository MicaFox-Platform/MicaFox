import http from "node:http";
import net from "node:net";

/** What a test needs of a response. */
export interface Reply {
  status: number;
  contentType: string | undefined;
  connection: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Asks the hub at `url` for `path`, on a connection of its own unless an agent is given; rejects when it breaks. */
export const get = async (url: string, path: string, agent: http.Agent | false = false): Promise<Reply> =>
  await new Promise<Reply>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: new URL(url).port, path, agent }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
          connection: response.headers.connection,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });

/** A request whose client has sent only part of its headers: the hub counts it as running until `finish()`. */
export interface SlowRequest {
  /** Sends the rest of the request and resolves with the response once it is complete. */
  finish: () => Promise<{ status: number; headers: Record<string, string> }>;
  /** Resolves when the hub closes the connection. */
  closed: Promise<void>;
}

const parseResponse = (text: string): { status: number; headers: Record<string, string> } | undefined => {
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return undefined;
  }
  const [statusLine = "", ...headerLines] = text.slice(0, headerEnd).split("\r\n");
  const headers = Object.fromEntries(
    headerLines.map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }),
  );
  const bodyLength = Number(headers["content-length"] ?? "0");
  if (text.length - headerEnd - 4 < bodyLength) {
    return undefined;
  }
  return { status: Number(statusLine.split(" ")[1]), headers };
};

/** Opens a keep-alive connection to the hub at `url` and starts a GET of `path` without finishing it. */
export const openSlowRequest = async (url: string, path: string): Promise<SlowRequest> => {
  const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(url).port) });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: hub\r\nConnection: keep-alive\r\n`);
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      resolve();
    }),
  );
  const finish = async (): Promise<{ status: number; headers: Record<string, string> }> =>
    await new Promise((resolve, reject) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const response = parseResponse(text);
        if (response !== undefined) {
          resolve(response);
        }
      });
      socket.once("error", reject);
      socket.write("\r\n");
    });
  return { finish, closed };
};
