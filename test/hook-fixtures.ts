import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PRODUCT_VERSION,
  PROTOCOL_VERSION,
  type LocalConfig,
} from "../src/cli/config.js";

/**
 * Minimal hook HTTP fixture: a healthy daemon identity, installation
 * heartbeat, forge_handoff and the two M02 memory routes. It is deliberately
 * small; the real M02 pipeline is exercised in hook-spool-delivery.test.ts.
 */
export interface HookFixtureOptions {
  /** When set, `/api/memory/spaces` advertises this project space. */
  memory?: { spaceId: string; projectRef: string };
  /** Test seam to force an ingest failure (e.g. 503). */
  ingestStatus?: number | (() => number);
  /** Record both URL and parsed body of every request. */
  onRequest?: (url: string, body: unknown) => void;
}

export interface HookFixture {
  config: LocalConfig;
  received: { url: string; body: any }[];
  ingestKeys: string[];
  close: () => Promise<void>;
}

export async function startHookFixture(
  dataDir: string,
  options: HookFixtureOptions = {},
): Promise<HookFixture> {
  const received: HookFixture["received"] = [];
  const ingestKeys: string[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      received.push({ url: request.url ?? "", body });
      options.onRequest?.(request.url ?? "", body);
      response.setHeader("Content-Type", "application/json");
      const url = request.url ?? "";
      if (url === "/health") {
        response.end(
          JSON.stringify({
            service: "skill-forge",
            version: PRODUCT_VERSION,
            protocol: PROTOCOL_VERSION,
          }),
        );
        return;
      }
      if (url === "/api/installations") {
        response.end(
          JSON.stringify({ id: body?.id ?? "fixture", status: "recorded" }),
        );
        return;
      }
      if (url === "/api/tools/forge_handoff") {
        response.end(
          JSON.stringify({ status: "accepted", run_id: "run-fixture" }),
        );
        return;
      }
      if (url.startsWith("/api/memory/spaces")) {
        response.end(
          JSON.stringify({
            items: options.memory
              ? [
                  {
                    id: options.memory.spaceId,
                    kind: "project",
                    project_id: options.memory.projectRef,
                  },
                ]
              : [],
            next: null,
          }),
        );
        return;
      }
      if (url === "/api/memory/ingest") {
        const forced =
          typeof options.ingestStatus === "function"
            ? options.ingestStatus()
            : options.ingestStatus;
        if (forced && forced >= 400) {
          response.statusCode = forced;
          response.end(JSON.stringify({ code: "fixture_forced" }));
          return;
        }
        const key = String(body?.source_event_key ?? "");
        if (ingestKeys.includes(key)) {
          response.end(
            JSON.stringify({ status: "duplicate", run_id: `run-${key}` }),
          );
          return;
        }
        ingestKeys.push(key);
        response.end(
          JSON.stringify({ status: "accepted", run_id: `run-${key}` }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "not_found" }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config: LocalConfig = {
    dataDir,
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    token: "fixture-owner-token",
    profile: "local",
  };
  return {
    config,
    received,
    ingestKeys,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
