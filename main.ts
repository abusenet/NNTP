#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Usage:
 *
 * ```
 * $ nntp.ts --address=news.localhost:119 --hostname=news.php.net --port=119
 */
import { parse } from "https://deno.land/std@0.196.0/flags/mod.ts";
import { retry } from "https://deno.land/std@0.196.0/async/retry.ts";
import { validate } from "https://deno.land/x/htpasswd@v0.2.0/main.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ListenOptions = {
  address?: string;
  ssl?: boolean;
} & Deno.ListenTlsOptions;

type ConnectOptions = {
  user?: string;
  pass?: string;
  htpasswd?: string;
} & Deno.ConnectTlsOptions;

const COMMANDS = [
  "ARTICLE",
  "AUTHINFO USER",
  "AUTHINFO PASS",
  "BODY",
  "CAPABILITIES",
  "DATE",
  "GROUP",
  "HDR",
  "HEAD",
  "HELP",
  "IHAVE",
  "LAST",
  "LIST",
  "LIST ACTIVE.TIMES",
  "LIST ACTIVE",
  "LIST DISTRIB.PATS",
  "LIST HEADERS",
  "LIST NEWSGROUPS",
  "LIST OVERVIEW.FMT",
  "LISTGROUP",
  "MODE READER",
  "NEWGROUPS",
  "NEWNEWS",
  "NEXT",
  "OVER",
  "POST",
  "QUIT",
  "STAT",
  "SLAVE",
].sort().reduce((commands: Uint8Array[], command: string) => {
  commands.push(encoder.encode(command.toUpperCase()));
  commands.push(encoder.encode(command.toLowerCase()));
  return commands;
}, []);

/**
 * Parses a possible command from a line.
 *
 * @param {Uint8Array} line - The line to parse.
 * @returns the command in uppercase, or null if no command is found.
 */
function parseCommand(line: Uint8Array): string | null {
  let result = null;
  for (const command of COMMANDS) {
    if (command.every((byte, i) => byte === line[i])) {
      result = decoder.decode(command).trim().toUpperCase();
    }
  }

  return result;
}

class RequestStream extends TransformStream {
  constructor({ user, pass, htpasswd }: ConnectOptions) {
    const authinfo = {
      user: "",
      authenticated: !htpasswd, // If no htpasswd is provided, authentication is disabled
    };

    super({
      async transform(line: Uint8Array, controller) {
        const command = parseCommand(line);

        if (command?.includes("AUTHINFO ")) {
          // Skips authentication if already authenticated, or no htpasswd is provided.
          if (authinfo.authenticated) {
            controller.enqueue(line);
            return;
          }

          const arg = decoder.decode(line).trim().split(" ")[2];

          if (command === "AUTHINFO USER") {
            authinfo.user = arg;
            line = encoder.encode(`AUTHINFO USER ${user}\r\n`); // Authenticates using the provider's username.
          } else if (command === "AUTHINFO PASS") {
            if (await validate(htpasswd!, authinfo.user, arg)) {
              authinfo.authenticated = true;
              line = encoder.encode(`AUTHINFO PASS ${pass}\r\n`); // Authenticates using the provider's password.
            }

            // Otherwise, authenticates with the provider directly using the
            // provided credentials.
          }
        }

        controller.enqueue(line);
      },
    });
  }
}

const ResponseCodes: Record<number, string> = {
  200: "Service available, posting allowed",
  201: "Service available, posting prohibited",
  281: "Authentication accepted",
  381: "Password required",
  400: "Service temporarily unavailable",
  481: "Authentication failed/rejected",
  482: "Authentication commands issued out of sequence",
  502: "Service permanently unavailable",
};

class ResponseStream extends TransformStream {
  constructor() {
    super({
      transform(line: Uint8Array, controller) {
        const status = decoder.decode(line.subarray(0, 3));
        const statusText = ResponseCodes[Number(status)];
        if (statusText) {
          line = encoder.encode(`${status} ${statusText}\r\n`);
        }

        controller.enqueue(line);
      },
    });
  }
}

/**
 * Pipes lines from source to target.
 */
function pipe(source: Deno.Conn, target: Deno.Conn, stream: TransformStream) {
  return source.readable
    .pipeThrough(stream)
    .pipeTo(target.writable)
    .catch((_error) => {
      // Ignore errors that occur when one end of the pipe is closed.
    });
}

async function handle(conn: Deno.Conn, options: ConnectOptions) {
  const remoteAddr = conn.remoteAddr as Deno.NetAddr;
  console.log(`${remoteAddr.hostname}:${remoteAddr.port} connected`);

  let server: Deno.Conn;

  await retry(async () => {
    if (options.caCerts) {
      server = await Deno.connectTls(options);
    } else {
      server = await Deno.connect(options);
    }
  }, {
    multiplier: 2,
    maxTimeout: 60000,
    maxAttempts: 5,
    minTimeout: 100,
    jitter: 1,
  });

  // Sets up two-way pipeline
  pipe(server, conn, new ResponseStream());
  pipe(conn, server, new RequestStream(options));
}

export async function serve(options: ListenOptions & ConnectOptions) {
  const {
    address = ":119",
    cert,
    key,
    ssl,
    ...connectOptions
  } = options;

  let [hostname, port] = address.split(":") as [string, string | number];
  if (!hostname) {
    hostname = "0.0.0.0";
  }
  port = Number(port);

  let server;
  if (cert && key) {
    server = Deno.listenTls({
      hostname,
      port,
      cert,
      key,
    });
  } else {
    server = Deno.listen({
      hostname,
      port,
    });
  }

  if (ssl) {
    connectOptions.caCerts = [];
  }

  for await (const conn of server) {
    handle(conn, connectOptions);
  }
}

// Learn more at https://deno.land/manual/examples/module_metadata#concepts
if (import.meta.main) {
  const {
    address,
    cert,
    key,
    htpasswd,
    hostname,
    port,
    ssl,
    user,
    pass,
  } = parse(Deno.args, {
    alias: {
      address: ["addr"],
      hostname: ["h"],
      port: ["p"],
    },
    boolean: ["ssl"],
    default: {
      address: "0.0.0.0:119",
      hostname: Deno.env.get("NNTP_HOSTNAME"),
      port: Deno.env.get("NNTP_PORT"),
      ssl: Deno.env.get("NNTP_SSL") === "true",
      user: Deno.env.get("NNTP_USER"),
      pass: Deno.env.get("NNTP_PASS"),
    },
    string: [
      "address", // Address of the local server to listen on.
      "cert",
      "key", // SSL options.
      "htpasswd", // Path to htpasswd file. If not provided no authentication is done.
      "hostname",
      "port",
      "user",
      "pass", // Remote NNTP server.
    ],
  });

  Deno.addSignalListener("SIGINT", () => {
    console.log("interrupted!");
    Deno.exit();
  });

  serve({
    address,
    cert,
    key,
    htpasswd,
    hostname,
    port: Number(port),
    ssl,
    user,
    pass,
  });

  console.log(`Serving at ${address}`);
}
