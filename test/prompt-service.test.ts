import { test, expect } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localConfig } from "../src/cli/config.js";
import { createHttpServer } from "../src/http/server.js";
import { preservedConstraints, skipPrompt } from "../src/prompt/guard.js";
test("prompt invariant guards preserve Turkish negation, numbers, units, paths and versions", () => {
  const original =
    "Sadece src/main.ts dosyasında v1.2.3 sürümünü koru; 3 satır yaz, 50 ms sınırını aşma ve yeni bağımlılık ekleme.";
  expect(
    preservedConstraints(original, original + "\nBu sınırları uygula."),
  ).toBe(true);
  for (const [before, after] of [
    ["3 satır", "5 satır"],
    ["50 ms", "50 saniye"],
    ["ekleme", "ekle"],
    ["src/main.ts", "src/app.ts"],
    ["v1.2.3", "v1.2.4"],
    ["Sadece", ""],
  ])
    expect(
      preservedConstraints(original, original.replace(before!, after!)),
    ).toBe(false);
  expect(skipPrompt("/compact", "always")).toBe("command_or_empty");
  expect(skipPrompt("devam", "when-needed")).toBe(
    "continuation_context_required",
  );
});
test("fixture provider over actual HTTP + Pi: one prompt call, autoApply, private reusable lesson, no SPR", async () => {
  let calls = 0;
  const candidate = "Raporu 3 satır olarak yaz. Sürümü değiştirme.";
  const provider = createServer(async (request, reply) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    expect(body.tools.map((tool: any) => tool.function.name)).toEqual([
      "finalize",
    ]);
    reply.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (choices: unknown[], usage?: unknown) =>
      reply.write(
        `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture-prompt", choices, ...(usage ? { usage } : {}) })}\n\n`,
      );
    chunk([
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "finalize-call",
              type: "function",
              function: {
                name: "finalize",
                arguments: JSON.stringify({
                  status: "improved",
                  text: candidate,
                  reason: "İki açık cümle.",
                  lesson: {
                    content: "Sayısal sınırları ve olumsuzlukları açık tut.",
                    triggers: "rapor satır",
                  },
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ]);
    chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    reply.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const port = (provider.address() as { port: number }).port,
    origin = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), "forge-prompt-http-")),
    config = await localConfig(root);
  config.policy = { allowedOrigins: [origin] };
  const app = await createHttpServer(config),
    headers = {
      host: new URL(config.url).host,
      authorization: `Bearer ${config.token}`,
    };
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "Prompt fixture" },
      })
    ).json();
    const profile = await app.inject({
      method: "PUT",
      url: "/api/providers",
      headers,
      payload: {
        role: "prompt",
        base_revision: 0,
        profile: {
          provider: "ollama",
          model: "fixture-prompt",
          baseUrl: `${origin}/v1`,
          allowPaid: false,
          maxOutputTokens: 1000,
        },
      },
    });
    expect(profile.statusCode).toBe(200);
    const original =
      "Bu metni netleştir: raporu 3 satır yaz, sürümü değiştirme.";
    const prepare = await app.inject({
      method: "POST",
      url: "/api/tools/forge_prepare",
      headers,
      payload: { project_ref: project.id, original, idempotency_key: "once" },
    });
    expect(prepare.statusCode).toBe(200);
    const result = prepare.json();
    expect(result).toMatchObject({ status: "improved" });
    expect(result.original).toBe(original);
    expect(result.effective).toBe(candidate);
    expect(result.auto_applied).toBe(true);
    expect(calls).toBe(1);
    expect(result.usage.tokens).toBe(15);
    const storage = (app as any).forge.storage;
    expect(
      (await storage.db.selectFrom("skills").selectAll().execute()).length,
    ).toBe(0);
    const lessons = await storage.db
      .selectFrom("learning_entries")
      .selectAll()
      .execute();
    expect(lessons.length).toBe(1);
    expect(lessons[0].scope_key).toBe(`project:${project.id}`);
    const reservations = await storage.db
      .selectFrom("budget_reservations")
      .selectAll()
      .execute();
    expect(reservations[0].state).toBe("settled");
    expect(reservations[0].actual_micros).toBe(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
