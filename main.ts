#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Usage:
 *
 * ```
 * $ nntp.ts --address=news.localhost:119 --hostname=news.php.net --port=119
 */
import { parse } from "https://deno.land/std@0.192.0/flags/mod.ts";
import { TextLineStream } from "https://deno.land/std@0.192.0/streams/text_line_stream.ts";
import { validate } from "https://deno.land/x/htpasswd/main.ts";

type ListenOptions = {
  address?: string;
  ssl?: boolean;
} & Deno.ListenTlsOptions;

type ConnectOptions = {
  user?: string;
  pass?: string;
  htpasswd?: string;
} & Deno.ConnectTlsOptions;

class RequestStream extends TransformStream {
  constructor({ user, pass, htpasswd }: ConnectOptions) {
    const authinfo = {
      user: "",
      authenticated: !htpasswd, // If no htpasswd is provided, authentication is disabled
    };

    super({
      async transform(line: string, controller) {
        const [command, ...args] = line.split(" ");
        console.info(`[C] ${line}`);
        switch (command.toUpperCase()) {
          case "AUTHINFO": {
            // Skips authentication if already authenticated, or no htpasswd is provided.
            if (authinfo.authenticated) {
              break;
            }

            const type = args[0].toUpperCase();

            if (type === "USER") {
              authinfo.user = args[1];
              line = `AUTHINFO USER ${user}`; // Authenticates using the provider's username.
            } else if (type === "PASS") {
              if (await validate(htpasswd!, authinfo.user, args[1])) {
                authinfo.authenticated = true;
                line = `AUTHINFO PASS ${pass}`; // Authenticates using the provider's password.
              }

              // Otherwise, authenticates with the provider directly using the
              // provided credentials.
            }
            break;
          }
          default:
            break;
        }

        controller.enqueue(`${line}\r\n`);
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
      transform(line: string, controller) {
        console.info(`[S] ${line}`);
        const [status, ..._rest] = line.split(" ");

        const statusText = ResponseCodes[Number(status)];
        if (statusText) {
          line = `${status} ${statusText}`;
        }

        controller.enqueue(`${line}\r\n`);
      },
    });
  }
}

/**
 * Pipes lines from source to target.
 */
function pipe(source: Deno.Conn, target: Deno.Conn, stream: TransformStream) {
  source.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
    .pipeThrough(stream)
    .pipeThrough(new TextEncoderStream())
    .pipeTo(target.writable);
}

async function handle(conn: Deno.Conn, options: ConnectOptions) {
  const remoteAddr = conn.remoteAddr as Deno.NetAddr;
  console.log(`${remoteAddr.hostname}:${remoteAddr.port} connected`);

  let server;

  if (options.caCerts) {
    server = await Deno.connectTls(options);
  } else {
    server = await Deno.connect(options);
  }

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
