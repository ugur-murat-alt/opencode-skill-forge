import { createHash } from "node:crypto";
import { sql } from "kysely";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, availableParallelism, platform, arch } from "node:os";
import { createServer } from "node:net";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
const [inputPath, outputPath] = process.argv.slice(2),
  input = JSON.parse(await readFile(inputPath, "utf8"));
const entry = new URL(
  input.runtime_entry ?? "../dist/index.js",
  import.meta.url,
);
const { localConfig, createHttpServer } = await import(entry.href);
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const config = await localConfig(input.dataDir, port),
  app = await createHttpServer(config);
const client = new Client({ name: "catalog-benchmark", version: "1" });
const values = [];
const report = {
  captured_at: new Date().toISOString(),
  status: "running",
  kind: "real-local-mcp-catalog-fixture-no-model",
  hardware: {
    platform: platform(),
    arch: arch(),
    node: process.version,
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    available_parallelism: availableParallelism(),
    memory_bytes: totalmem(),
    disk_media: "not_measured",
  },
  dataset: {
    count: input.count,
    sha256: input.dataset_sha256,
    seed_ms: input.seed_ms,
  },
  samples: values,
};
const extraClients = new Set();
let soakSamples = [];
const measure = async (tool, args, phase, sender = client) => {
  const start = performance.now();
  const response = await sender.callTool({ name: tool, arguments: args });
  const elapsed = performance.now() - start;
  if (response.isError) throw Error(JSON.stringify(response));
  const value = JSON.parse(
    response.content.find((c) => c.type === "text").text,
  );
  (phase === "soak" ? soakSamples : values).push({
    tool,
    phase,
    elapsed_ms: elapsed,
    response_bytes: Buffer.byteLength(JSON.stringify(response)),
  });
  return value;
};
try {
  const boot = performance.now();
  await app.listen({ host: config.host, port: config.port });
  report.startup_ms = performance.now() - boot;
  report.bundle_sha256 = createHash("sha256")
    .update(await readFile(entry))
    .digest("hex");
  report.lock_sha256 = createHash("sha256")
    .update(
      await readFile(
        new URL(input.runtime_lock ?? "../bun.lock", import.meta.url),
      ),
    )
    .digest("hex");
  report.database = {
    backend: "sqlite",
    version: (
      await sql`select sqlite_version() as version`.execute(
        app.forge.storage.db,
      )
    ).rows[0].version,
  };

  const scanStarted = performance.now(),
    scanDeadline = Date.now() + 120000;
  let health;
  do {
    health = await fetch(config.url + "/health", {
      headers: { authorization: "Bearer " + config.token },
    }).then((r) => r.json());
    if (health.package_integrity.status !== "checking") break;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < scanDeadline);
  report.integrity_scan_ms = performance.now() - scanStarted;
  report.integrity = health.package_integrity;
  if (
    health.package_integrity.status !== "verified" ||
    health.package_integrity.checked !== input.count
  )
    throw Error("Full integrity scan did not complete");

  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + config.token } },
    }),
  );
  const tools = (await client.listTools()).tools;
  report.tool_count = tools.length;
  if (tools.length !== 6) throw Error("Tool count changed");
  const first = await measure(
    "forge_search",
    { project_ref: input.project, limit: 5 },
    "first_request_after_integrity_scan",
  );
  report.context = {
    ten_package_application_bytes: input.baseline_bytes,
    catalog_application_bytes: Buffer.byteLength(JSON.stringify(first)),
    items: first.items.length,
    catalog_count: input.count,
  };
  if (
    first.items.length !== 5 ||
    report.context.catalog_application_bytes > 16384 ||
    report.context.catalog_application_bytes > input.baseline_bytes + 512
  )
    throw Error("Discovery context bound violated");
  const second = await measure(
    "forge_search",
    { project_ref: input.project, limit: 5, cursor: first.next_cursor },
    "pagination",
  );
  if (
    second.items.some((item) =>
      first.items.some((before) => before.skill_id === item.skill_id),
    )
  )
    throw Error("Pagination repeated item");
  const load = {
    project_ref: input.project,
    skill_id: input.sample.skill_id,
    revision: input.sample.revision,
  };
  await measure("forge_load", load, "first_load_after_integrity_scan");
  const started = performance.now(),
    count = 300,
    rate = 100,
    pending = [];
  for (let i = 0; i < count; i++) {
    const delay = started + (i * 1000) / rate - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    pending.push(
      measure(
        i % 2 ? "forge_load" : "forge_search",
        i % 2
          ? load
          : { project_ref: input.project, query: "category", limit: 5 },
        "warm_100_rps",
      ).then(
        () => null,
        (error) => String(error),
      ),
    );
  }
  const outcomes = await Promise.all(pending);
  const errors = outcomes.filter(Boolean);
  report.errors = errors;
  report.load = {
    requested_rps: rate,
    requests: count,
    elapsed_ms: performance.now() - started,
    achieved_rps: (count * 1000) / (performance.now() - started),
    clients: 1,
    pattern:
      "half search, half same-package load; overlapping official MCP calls",
  };
  report.latency = {};
  for (const tool of ["forge_search", "forge_load"]) {
    const samples = values
      .filter((v) => v.phase === "warm_100_rps" && v.tool === tool)
      .map((v) => v.elapsed_ms)
      .sort((a, b) => a - b);
    const percentile = (p) =>
      samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
    report.latency[tool] = {
      n: samples.length,
      p50_ms: percentile(0.5),
      p95_ms: percentile(0.95),
      p99_ms: percentile(0.99),
    };
  }
  report.engineering_target_met =
    errors.length === 0 &&
    Object.values(report.latency).every((v) => v.p95_ms <= 250);

  if (input.matrix) {
    report.client_matrix = [
      { ...report.load, latency: report.latency, errors: errors.length },
    ];
    for (const clientCount of [10, 100, 1000]) {
      const connectionStart = performance.now(),
        group = [];
      for (let offset = 0; offset < clientCount; offset += 25) {
        await Promise.all(
          Array.from(
            { length: Math.min(25, clientCount - offset) },
            async (_, index) => {
              const item = new Client({
                name: `catalog-matrix-${clientCount}-${offset + index}`,
                version: "1",
              });
              extraClients.add(item);
              group.push(item);
              await item.connect(
                new StreamableHTTPClientTransport(
                  new URL(config.url + "/mcp"),
                  {
                    requestInit: {
                      headers: { authorization: "Bearer " + config.token },
                    },
                  },
                ),
              );
            },
          ),
        );
      }
      const connectionMs = performance.now() - connectionStart,
        phase = `clients_${clientCount}_100_rps`,
        samplesCount = Math.max(300, clientCount),
        pending = [];
      const started = performance.now();
      for (let i = 0; i < samplesCount; i++) {
        const delay = started + i * 10 - performance.now();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        pending.push(
          measure(
            i % 2 ? "forge_load" : "forge_search",
            i % 2
              ? load
              : { project_ref: input.project, query: "category", limit: 5 },
            phase,
            group[i % group.length],
          ).then(
            () => null,
            (error) => String(error),
          ),
        );
      }
      const failures = (await Promise.all(pending)).filter(Boolean),
        elapsed = performance.now() - started,
        latency = {};
      for (const tool of ["forge_search", "forge_load"]) {
        const samples = values
          .filter((v) => v.phase === phase && v.tool === tool)
          .map((v) => v.elapsed_ms)
          .sort((a, b) => a - b);
        const percentile = (p) =>
          samples[
            Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)
          ];
        latency[tool] = {
          n: samples.length,
          p50_ms: percentile(0.5),
          p95_ms: percentile(0.95),
          p99_ms: percentile(0.99),
        };
      }
      const profile = {
        clients: clientCount,
        idle_control_clients: 1,
        requests: samplesCount,
        requested_rps: 100,
        achieved_rps: (samplesCount * 1000) / elapsed,
        elapsed_ms: elapsed,
        connect_ms: connectionMs,
        latency,
        errors: failures.length,
        rss_bytes: process.memoryUsage().rss,
      };
      report.client_matrix.push(profile);
      errors.push(...failures);
      if (failures.length || Object.values(latency).some((v) => v.p95_ms > 250))
        report.engineering_target_met = false;
      console.log(JSON.stringify({ profile }));
      for (let offset = 0; offset < group.length; offset += 25)
        await Promise.all(
          group.slice(offset, offset + 25).map(async (item) => {
            await item.close();
            extraClients.delete(item);
          }),
        );
    }
  }

  if (input.soak_minutes) {
    const soakStarted = performance.now();
    report.soak = {
      minutes: input.soak_minutes,
      requested_rps: 100,
      windows: [],
      errors: 0,
      requests: 0,
      status: "running",
    };
    for (let minute = 0; minute < input.soak_minutes; minute++) {
      soakSamples = [];
      const windowStart = performance.now(),
        scheduled = [];
      for (let i = 0; i < 6000; i++) {
        const delay = windowStart + i * 10 - performance.now();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        scheduled.push(
          measure(
            i % 2 ? "forge_load" : "forge_search",
            i % 2
              ? load
              : { project_ref: input.project, query: "category", limit: 5 },
            "soak",
          ).then(
            () => null,
            (error) => String(error),
          ),
        );
      }
      const failures = (await Promise.all(scheduled)).filter(Boolean),
        latency = {};
      const remaining = windowStart + 60000 - performance.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      for (const tool of ["forge_search", "forge_load"]) {
        const samples = soakSamples
          .filter((v) => v.tool === tool)
          .map((v) => v.elapsed_ms)
          .sort((a, b) => a - b);
        const percentile = (p) =>
          samples[
            Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)
          ];
        latency[tool] = {
          n: samples.length,
          p50_ms: percentile(0.5),
          p95_ms: percentile(0.95),
          p99_ms: percentile(0.99),
        };
      }
      const window = {
        minute: minute + 1,
        requests: 6000,
        errors: failures.length,
        elapsed_ms: performance.now() - windowStart,
        latency,
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
      };
      report.soak.windows.push(window);
      report.soak.errors += failures.length;
      report.soak.requests += 6000;
      if (failures.length || Object.values(latency).some((v) => v.p95_ms > 250))
        report.engineering_target_met = false;
      errors.push(...failures.slice(0, 20));
      console.log(JSON.stringify({ soak_window: window }));
      await writeFile(
        outputPath.replace(/\.json$/, ".progress.json"),
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            status: "running",
            bundle_sha256: report.bundle_sha256,
            soak: report.soak,
          },
          null,
          2,
        ) + "\n",
      );
    }
    report.soak.elapsed_ms = performance.now() - soakStarted;
    report.soak.status = report.soak.errors ? "failed" : "measured";
    report.soak.raw_samples_policy =
      "Per-minute exact quantiles; bounded minute buffer; no accumulated per-request heap.";
    soakSamples = [];
  }
  report.status = errors.length ? "failed" : "measured";
  report.limitations = [
    "Synthetic deterministic skill contents; real storage, filesystem, Node server and official HTTP MCP client.",
    input.matrix
      ? "1/10/100/1000 ayrı resmî MCP istemcisi; aynı yetkili kullanıcı/proje, farklı kullanıcı veya tenant ölçeği değildir."
      : "Tek istemciden örtüşen istekler; 10/100/1000 ayrı istemci ölçümü değildir.",
    "OS cache was not flushed; startup integrity scan warms files.",
    input.soak_minutes
      ? "Soak katalog içindir; LLM, handoff, PostgreSQL yükü veya model kalitesi iddiası yoktur. Aynı host üzerindeki diğer işler sonuçları etkileyebilir."
      : "LLM, handoff, sağlayıcı kapasitesi, 30 dakika soak, PostgreSQL yükü veya model kalitesi iddiası yoktur.",
  ];
  if (!report.engineering_target_met) process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...extraClients].map((item) => item.close()));
  await client.close();
  await app.close();
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    outputPath.replace(/\.json$/, ".csv"),
    "tool,phase,elapsed_ms,response_bytes\n" +
      values
        .map((v) => `${v.tool},${v.phase},${v.elapsed_ms},${v.response_bytes}`)
        .join("\n") +
      "\n",
  );
  await writeFile(
    outputPath.replace(/\.json$/, ".md"),
    `# Gerçek katalog ölçümü\n\nDurum: ${report.status}. Paket: ${input.count}. Node: ${process.version}.\n\n\`\`\`json\n${JSON.stringify({ context: report.context, load: report.load, latency: report.latency, client_matrix: report.client_matrix, soak: report.soak, target_met: report.engineering_target_met }, null, 2)}\n\`\`\`\n\n${(report.limitations ?? []).join("\n\n")}\n`,
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    context: report.context,
    load: report.load,
    latency: report.latency,
    report: outputPath,
  }),
);
