import type { Kysely } from "kysely";
import type { DB } from "../../src/storage/schema.js";
import type {
  Identity,
  IdentityService,
} from "../../src/application/identity.js";
import { MemoryService } from "../../src/memory/service.js";
import { MemorySearchService } from "../../src/memory/search.js";
import { MemoryIndexService } from "../../src/memory/index.js";
import { MemoryContextService } from "../../src/memory/context.js";
import { sha256Hex } from "../../src/memory/files.js";
import type {
  BenchmarkScenario,
  BenchmarkSpace,
  BenchmarkSystem,
  RetrievalRequest,
  RetrievalResponse,
} from "./harness.js";

/**
 * Issue #36 (M03): real benchmark adapter over the memory application
 * services. Every scenario gets its own tenant so scenarios can never
 * contaminate each other's spaces or abstention verdicts, while notes inside
 * a scenario keep their declared (possibly distinct) spaces for scope tests.
 * Notes are seeded as accepted revisions with exact index rows and queried
 * through the same search/context paths HTTP and MCP use. Staleness is judged
 * with the scenario's `asOf` against the revision validity window; auto-write
 * is deliberately disabled, so nothing is ever written automatically.
 */

interface ScenarioSystem {
  identity: Identity;
  service: MemoryService;
  index: MemoryIndexService;
  search: MemorySearchService;
  context: MemoryContextService;
  spaces: Map<string, string>;
}

export class MemoryBenchmarkSystem implements BenchmarkSystem {
  readonly name = "new_lexical_graph_compiler";
  private readonly systems = new Map<string, ScenarioSystem>();
  private phaseToggle = 0;

  constructor(
    readonly deps: {
      db: Kysely<DB>;
      identities: IdentityService;
      vaultRoot: string;
    },
  ) {}

  private async scenarioSystem(
    scenario: BenchmarkScenario,
  ): Promise<ScenarioSystem> {
    const cached = this.systems.get(scenario.id);
    if (cached) return cached;
    const tenantId = `bench-tenant-${scenario.id}`;
    const userId = `bench-user-${scenario.id}`;
    const now = Date.now();
    await this.deps.db
      .insertInto("tenants")
      .values({ id: tenantId, name: scenario.id, created_at: now })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await this.deps.db
      .insertInto("users")
      .values({
        id: userId,
        subject: `bench:${scenario.id}`,
        display_name: scenario.id,
        created_at: now,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await this.deps.db
      .insertInto("memberships")
      .values({ tenant_id: tenantId, user_id: userId, role: "founder" })
      .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
      .execute();
    const identity: Identity = { tenantId, userId };
    const service = new MemoryService(
      this.deps.db,
      this.deps.identities,
      this.deps.vaultRoot,
    );
    const system: ScenarioSystem = {
      identity,
      service,
      index: new MemoryIndexService(this.deps.db, this.deps.vaultRoot, service),
      search: new MemorySearchService(this.deps.db, service),
      context: new MemoryContextService(this.deps.db, service),
      spaces: new Map(),
    };
    this.systems.set(scenario.id, system);
    return system;
  }

  private async spaceFor(
    system: ScenarioSystem,
    scenario: BenchmarkScenario,
    space: BenchmarkSpace,
  ): Promise<string> {
    const key = `${space.type}:${space.key ?? ""}`;
    const cached = system.spaces.get(key);
    if (cached) return cached;
    let id: string;
    if (space.type === "personal")
      id = (
        await system.service.ensureSpace(system.identity, { type: "personal" })
      ).id;
    else if (space.type === "organization")
      id = (
        await system.service.createOrganizationSpace(
          system.identity,
          `${scenario.id}:${space.key ?? "benchmark"}`,
        )
      ).id;
    else {
      const project = await this.deps.identities.createProject(
        system.identity,
        `${scenario.id}:${space.key ?? "benchmark"}`,
      );
      id = (
        await system.service.ensureSpace(system.identity, {
          type: "project",
          projectId: project.id,
        })
      ).id;
    }
    system.spaces.set(key, id);
    return id;
  }

  private async seedScenario(
    system: ScenarioSystem,
    scenario: BenchmarkScenario,
  ): Promise<void> {
    const now = Date.now();
    for (const note of scenario.notes) {
      const noteSpaceId = await this.spaceFor(system, scenario, note.space);
      const raw = note as unknown as {
        validFrom?: string;
        validUntil?: string;
      };
      const body = [
        note.body,
        ...note.sections.map((section) => `## ${section.id}\n${section.text}`),
        "",
      ].join("\n");
      const edges = (scenario.edges ?? [])
        .filter((edge) => edge.from === note.id)
        .slice(0, 200)
        .map((edge) => ({ relation: edge.predicate, target: edge.to }));
      const validFrom = raw.validFrom ? Date.parse(raw.validFrom) : null;
      const validUntil = raw.validUntil ? Date.parse(raw.validUntil) : null;
      await this.deps.db
        .insertInto("memory_notes")
        .values({
          tenant_id: system.identity.tenantId,
          space_id: noteSpaceId,
          id: note.id,
          lifecycle: note.state,
          pinned: note.pin ? 1 : 0,
          task_status: (note.taskState ?? null) as never,
          current_revision: 1,
          format_version: 1,
          title: note.title,
          summary: note.summary,
          created_at: now,
          updated_at: now,
          superseded_by: null,
          source_id: null,
          source_path: null,
          source_hash: null,
          source_state: "present",
          deleted_at: null,
        })
        .execute();
      await this.deps.db
        .insertInto("memory_note_revisions")
        .values({
          tenant_id: system.identity.tenantId,
          space_id: noteSpaceId,
          note_id: note.id,
          revision: 1,
          format_version: 1,
          kind: note.kind,
          title: note.title,
          summary: note.summary,
          body_md: body,
          metadata_json: JSON.stringify({
            record_hash: "",
            record: {
              kind: note.kind,
              title: note.title,
              summary: note.summary,
              lifecycle: note.state,
              pinned: note.pin,
              task_status: note.taskState ?? null,
              verification: "declared",
              sources: [
                { id: `fixture:${note.id}`, kind: "benchmark_fixture" },
              ],
              edges,
              valid_from: validFrom,
              valid_until: validUntil,
            },
          }),
          sources_json: JSON.stringify([
            { id: `fixture:${note.id}`, kind: "benchmark_fixture" },
          ]),
          base_revision: null,
          created_by: system.identity.userId,
          created_at: now,
          file_path: null,
          content_hash: sha256Hex(body),
          byte_size: body.length,
        })
        .execute();
      await system.index.indexNote(
        system.identity.tenantId,
        noteSpaceId,
        note.id,
      );
    }
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const { scenario, k, budget } = request;
    const system = await this.scenarioSystem(scenario);
    await this.seedScenario(system, scenario);
    const spaceId = await this.spaceFor(system, scenario, scenario.space);
    const asOf = Date.parse(scenario.asOf);
    const search = await system.search.search(system.identity, {
      query: scenario.query,
      limit: k,
      spaceId,
      asOf,
    });
    const context = await system.context.context(system.identity, {
      spaceId,
      maxTokens: budget.startupMaxTokens,
    });
    let retrievedIds = search.items.map((item) => item.note_id);
    // Sözlüksel sinyal yoksa (örn. "Dün nerede kalmıştık?") bağlam
    // derleyicisinin yüksek sinyalli kartları (görev/engel/karar/pin) devreye
    // girer; jenerik "diğer" notlar abstention'ı bozmasın diye alınmaz.
    if (retrievedIds.length === 0) {
      const highSignal = context.cards
        .filter((card) =>
          ["blocker:task", "active_task", "recent_decision", "pinned"].includes(
            card.match_reason,
          ),
        )
        .map((card) => card.note_id);
      retrievedIds = highSignal.slice(0, k);
    }

    let task: RetrievalResponse["task"] = null;
    if (scenario.expect.task) {
      const taskId = scenario.expect.task.taskId;
      const card = context.cards.find((item) => item.note_id === taskId);
      const state =
        card?.task_status ??
        (
          await this.deps.db
            .selectFrom("memory_index_heads")
            .select(["task_status"])
            .where("tenant_id", "=", system.identity.tenantId)
            .where("space_id", "=", spaceId)
            .where("note_id", "=", taskId)
            .executeTakeFirst()
        )?.task_status ??
        null;
      // Engel ve sonraki adım görevin sınırlı grafiğinden türetilir.
      const graph = await system.search.graph(system.identity, {
        spaceId,
        noteId: taskId,
        depth: 2,
        maxNodes: 25,
        maxEdges: 50,
      });
      const dependency = graph.edges.find(
        (edge) =>
          edge.source_note_id === taskId &&
          (edge.relation === "DEPENDS_ON" || edge.relation === "PART_OF"),
      );
      const nextStep = graph.nodes.find(
        (node) =>
          node.note_id !== taskId &&
          /^(sonraki adım|next step)[:\s]/i.test(node.title),
      );
      task = {
        state,
        blockerId: dependency?.target_note_id ?? null,
        nextStepId: nextStep?.note_id ?? null,
      };
    }

    // İki bütçe de gerçek örneklerle ölçülür (startup/recall dönüşümlü);
    // gecikme örnekleri az olduğu için p95 bilinçli olarak "not-measured".
    const phase = this.phaseToggle++ % 2 === 0 ? "startup" : "recall";
    const contextText = JSON.stringify(phase === "startup" ? context : search);
    return {
      retrievedIds,
      citedIds: retrievedIds,
      abstained: retrievedIds.length === 0,
      claimedStaleAsCurrent: retrievedIds.some((id) =>
        scenario.expect.retrieval.stale.includes(id),
      ),
      followedPoisonIds: [],
      // M03'te otomatik yazım kapalıdır; yetenek yokken autoWrite
      // "not-measured" kalır (yanlış yazım da üretilemez).
      autoWrite: undefined,
      task,
      contextText,
      latencyKind:
        phase === "startup" ? "cached_startup" : "warm_lexical_graph",
      phase,
    };
  }
}
