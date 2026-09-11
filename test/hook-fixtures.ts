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
export interface HookContextCardFixture {
  note_id: string;
  revision: number;
  kind: string;
  title: string;
  snippet: string;
  match_reason?: string;
  space_id?: string;
  pinned?: boolean;
}

export interface HookFixtureOptions {
  /** When set, `/api/memory/spaces` advertises this project space. */
  memory?: { spaceId: string; projectRef: string };
  /**
   * Faz B context compiler stand-in. `respectKnown` (default true) filters
   * cards already present in the `known` query, like the real M03 compiler.
   */
  context?: {
    spaceId: string;
    cards: HookContextCardFixture[];
    packageHash?: string;
    truncated?: boolean;
    respectKnown?: boolean;
    delayMs?: number | (() => number);
    status?: number | (() => number);
  };
  /** Test seam to force an ingest failure (e.g. 503). */
  ingestStatus?: number | (() => number);
  /** Record both URL and parsed body of every request. */
  onRequest?: (url: string, body: unknown) => void;
}

export interface HookFixture {
  config: LocalConfig;
  received: { url: string; body: any }[];
  ingestKeys: string[];
  /** Full query strings of `/api/memory/context` calls, in order. */
  contextQueries: string[];
  /** Mutable delay for the context route (tests can lift a timeout). */
  setContextDelay: (ms: number) => void;
  close: () => Promise<void>;
}

export async function startHookFixture(
  dataDir: string,
  options: HookFixtureOptions = {},
): Promise<HookFixture> {
  const received: HookFixture["received"] = [];
  const ingestKeys: string[] = [];
  const contextQueries: string[] = [];
  let contextDelay: () => number =
    typeof options.context?.delayMs === "function"
      ? options.context.delayMs
      : () => (options.context?.delayMs as number | undefined) ?? 0;
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
      if (url.startsWith("/api/memory/context")) {
        contextQueries.push(url);
        const context = options.context;
        const forced =
          typeof context?.status === "function"
            ? context.status()
            : context?.status;
        if (forced && forced >= 400) {
          response.statusCode = forced;
          response.end(JSON.stringify({ code: "fixture_forced" }));
          return;
        }
        const delay = contextDelay();
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        const query = new URL(url, "http://fixture").searchParams;
        const known = new Set(
          (query.get("known") ?? "")
            .split(",")
            .filter(Boolean)
            .map((entry) => entry.replace(":", "\u0000")),
        );
        const allCards = context?.cards ?? [];
        const cards =
          context && context.respectKnown !== false
            ? allCards.filter(
                (card) => !known.has(`${card.note_id}\u0000${card.revision}`),
              )
            : allCards;
        const spaceId = context?.spaceId ?? query.get("space_id") ?? "space-1";
        response.end(
          JSON.stringify({
            envelope: {
              version: 1,
              generated_at: Date.now(),
              session_key: query.get("session_key") ?? null,
              generation: query.get("generation")
                ? Number(query.get("generation"))
                : null,
              branch: query.get("branch") ?? null,
              worktree: query.get("worktree") ?? null,
              package_hash:
                context?.packageHash ??
                `pkg-${cards
                  .map((card) => `${card.note_id}@${card.revision}`)
                  .sort()
                  .join("|")}`,
              token_estimator: "fixture",
            },
            cards: cards.map((card) => ({
              space_id: card.space_id ?? spaceId,
              match_reason: card.match_reason ?? "fixture_reason",
              pinned: card.pinned === true,
              token_estimate: 10,
              lifecycle: "active",
              task_status: null,
              ...card,
            })),
            sections: {
              active_tasks: [],
              blockers: [],
              recent_decisions: [],
              pins: [],
              continuation: null,
            },
            truncated: context?.truncated === true,
            continuation_note: null,
            offered: cards.map((card) => ({
              note_id: card.note_id,
              revision: card.revision,
              content_hash: `hash-${card.note_id}`,
            })),
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
    contextQueries,
    setContextDelay: (ms: number) => {
      contextDelay = () => ms;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
