import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import type { Identity } from "../application/identity.js";
import type { DatabaseHandle } from "../storage/database.js";
import type { Run } from "../storage/schema.js";
import { BudgetService } from "../jobs/budgets.js";
import { JobQueue } from "../jobs/queue.js";

/**
 * Issue #39 (M06): one shared budget/lease wrapper for the curator profile.
 *
 * It mirrors the production skill path exactly: every provider call asserts
 * the run lease in the same transaction, reserves a bounded estimate against
 * this job's snapshot limit and settles the real usage. An unknown provider
 * cost is settled as `null`, never silently zero.
 */
export function budgetedStream(input: {
  storage: DatabaseHandle;
  run: Run;
  identity: Identity;
  maxCostMicros: number;
  providerStream?: StreamFn;
  resolve: (
    model: Model<Api>,
    context: Parameters<StreamFn>[1],
    options: Parameters<StreamFn>[2],
  ) => AsyncIterable<any> | Promise<AsyncIterable<any>>;
}): StreamFn {
  const budget = new BudgetService(input.storage);
  let call = 0;
  return async (model, context, options) => {
    await input.storage.db
      .transaction()
      .execute((tx) => new JobQueue(input.storage).assertLease(tx, input.run));
    const id = `${input.run.id}:${input.run.fence}:curator:${++call}`;
    const estimate = Math.ceil(
      model.contextWindow *
        Math.max(
          model.cost.input,
          model.cost.cacheRead,
          model.cost.cacheWrite,
        ) +
        (options?.maxTokens ?? model.maxTokens) * model.cost.output,
    );
    await budget.reserve(
      input.identity,
      input.run.id,
      id,
      estimate,
      input.maxCostMicros,
    );
    const result = createAssistantMessageEventStream();
    void (async () => {
      let terminal = false;
      const fail = () =>
        result.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [],
            timestamp: Date.now(),
            stopReason: "error",
            errorMessage: "provider_or_usage_error",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        });
      try {
        const events = await (input.providerStream
          ? input.providerStream(model, context, options)
          : input.resolve(model, context, options));
        for await (const event of events) {
          if (event.type === "done" || event.type === "error") terminal = true;
          if (event.type === "done")
            await budget.settle(
              input.identity,
              id,
              Math.ceil(event.message.usage.cost.total * 1_000_000),
            );
          else if (event.type === "error")
            await budget.settle(input.identity, id, null);
          result.push(event);
        }
        if (!terminal) {
          await budget.settle(input.identity, id, null);
          fail();
        }
      } catch {
        try {
          await budget.settle(input.identity, id, null);
        } catch {}
        fail();
      }
    })();
    return result;
  };
}
