# ADR: hafıza sahipliği, kapsam ve iş sınırı

Karar: 2026-09-11 (issue #34, M01). Durum: **M01 kapsamı uygulandı**; graph
arayüzü, LLM çıkarımı, otomatik yazım, oturum sürekliliği ve canlı AGZ
aktarımı bu ADR'nin kapsamı dışındadır ve M02–M08 issue'larında ayrıca
kararlaştırılır. Bu adımda hafıza varsayılan olarak **kapalıdır**
(`memoryEnabled=false`).

## Neden ayrı modül?

Hafıza, skill havuzundan bağımsız bir üründür: notlar, kaynak referansları,
ilişki grafiği ve oturum sürekliliği skill paketlerinin yaşam döngüsüne bağlı
değildir. Bu yüzden:

- Uygulama davranışının tek sahibi `src/memory/` modülüdür
  (`MemoryService` + statik iş türleri + model-dışı handler'lar). HTTP/MCP/CLI
  ileride yalnız adaptör olur ve aynı servis çağrılarını kullanır.
- `src/domain/memory.ts` taşınabilir sözleşmedir: Markdown formatı, kanonik
  serileştirme/hash, supersession döngüsü, wikilink çözümü ve tipli alan
  kapsamı. DB/IO/uygulama importu yoktur.
- `PackageStore` ve `EvolutionStaging` hafıza deposu veya izin kaynağı
  değildir. Hafıza işi `skill_evolve` kılığına girmez; ikinci bir kuyruk,
  servis veya ajan framework'ü eklenmez.

## Alan sahipliği ve yetki

- `memory_space_id` değişmez kimliktir. Alanın kapsamı tiplidir:
  `personal` (kiracı içinde tek kullanıcı), `project` (gerçek proje) veya
  `organization` (kiracı genelinde paylaşılan açık alan).
- Projesiz alanlar için sahte proje üretilmez. Kişisel ve organizasyon
  alanlarında `memory_spaces.project_id` `NULL`'dır; `runs.project_id` de bu
  kapsamlarda `NULL` kalır.
- Aynı adlı proje/klasör veya aynı adlı alan aynı kimlik ya da aynı yetki
  değildir; ACL yalnız kimlik satırlarından çözülür.
- Yetki modeli (`MemoryService.authorizeSpace`):
  - kişisel → yalnız sahibi; yazma ayrıca kiracı düzeyi yazma izni ister,
  - proje → proje üyeliği/rolü (`read`/`write`),
  - organizasyon → kiracı üyeliği; yazma reader/auditor'a yasaktır.
- Kiracı izolasyonu zorunludur: başka kiracının alanı "yok" sayılır (404),
  varlığı sızdırılmaz.
- Not/handoff içindeki `tenant_id`, `owner_user_id`, `acl` gibi alanlar
  yalnız bilinmeyen frontmatter olarak korunur; **yetki vermez**.

### Kabul anında ve sonrasında yetki

- Proje kapsamlı işler kabulde `authorize("run", projectId)` ile,
  kişisel/organizasyon kapsamlı işler yalnız kiracı düzeyi
  `authorize("run")` ile doğrulanır.
- Somut alan ACL'i kabul anında değil **handler içinde**
  (`MemoryService.recordEvent`/`reconcile`) ve sonraki her commit adımında
  yeniden doğrulanır. `JobQueue.get`/`cancel`/`assertLease` de kalıcı
  kapsamı yeniden yetkilendirir (proje → proje `read`/`run`, diğerleri →
  kiracı düzeyi).
- **Kapsam ↔ hedef alan eşleşmesi execution anında zorunludur**
  (`MemoryService.authorizeRunSpace`): kişisel iş yalnız iş sahibinin
  kişisel alanına, proje işi yalnız aynı `project_id`nin alanına,
  organizasyon işi yalnız organizasyon alanına yazabilir. Payload'daki
  `spaceId` işin bildirdiği kapsamı **yükseltemez**; uyuşmazlık
  `memory_scope_mismatch` (422) ile reddedilir ve hiçbir olay yazılmaz.
  Başka kiracının alanı bu kapıdan önce 404 ile aynı kalır (sızıntısız).
- `memoryEnabled` kabul anında **işin kendi bildirdiği kapsam** için
  değerlendirilip `config_json` anlık görüntüsüne yazılır; hedef alanın
  kendi kapsam/ACL politikası execution anında ayrıca ve yeniden
  doğrulanır. Böylece örneğin proje politikasında hafıza kapalıyken bir
  kişisel iş kabul edilse bile o iş proje alanına yazamaz.
- Retryable olmayan bir handler hatasında sistem, aktörün yetkisi bu arada
  düşürülmüş olsa bile çalışan işi **gerçek hata koduyla** terminalize eder
  (`JobQueue.fail` → fence-only `finish`); terminalizasyon için aktör
  yetkisi yeniden istenmez, fencing/CAS ve yalnız mevcut lease sahibi
  koşulu korunur.

## İş kapsamı genişletmesi

- `JobScope = {type:"project"; projectId} | {type:"personal"} |
{type:"organization"}`. `JobQueue.accept` ya eski `projectId` kısaltmasını
  ya da açık `scope` alanını alır; tam olarak biri zorunludur.
- `JobKindDefinition.scope` varsayılanı `"project"`tur; skill türü proje
  kapsamı zorunluluğunu korur. `"memory"` türleri projesiz kapsamları kabul
  eder ve bağımsız `memoryEnabled` bayrağıyla kapılanır.
- `runs` tablosunda `scope_kind` (`project|personal|organization`) ve
  `scope_key` (proje: projectId, kişisel: userId, organizasyon:
  `"organization"`) tutulur. Tekillik
  `(tenant_id, user_id, scope_kind, scope_key, kind, idempotency_key)`
  üzerindedir; idempotency sorgusu da bu çiftle yapılır.
- `forge_sessions.project_id` ve `runs.project_id` nullable'dır.
- `memoryEnabled` ile `evolutionEnabled` bağımsızdır: hiçbir bayrak diğerinin
  yerine geçmez. `memoryEnabled=false` iken skill sözleşmesi ve mevcut beş
  `forge_*` aracı değişmez.

## Markdown ve işletim verisinin sahipliği

- Kabul edilmiş not sürümünün metni ve anlamsal metadata'sı taşınabilir
  Markdown'dır (`format_version: 1`, `docs/tr/hafiza-format.md`).
- İşletim DB'si kimlik/ACL, kabul edilmiş head/revision manifesti, kopya
  teslim günlüğü, idempotency ve tombstone kayıtlarını tutar. FTS, backlink,
  graph ve bağlam çıktıları türetilmiştir.
- **İşletim DB'sinin tamamı silinip yalnız Markdown'dan yetki/kuyruk
  kurtarması yapılabileceği iddia edilmez.** Kurtarma, Markdown sürümleri ve
  operasyon metadata'sını aynı tutarlı sınırda kapsar.

## İlk sürümde kapalı olanlar

- Alanlar arası otomatik kalıcı ilişki, link üretimi veya bilgi kopyalama
  yoktur. Çok-alanlı okuma ileride yalnız aktörün yetkili olduğu alanların
  açık seçimiyle birleştirilebilir.
- Model tabanlı çıkarım, otomatik yazım, graph arayüzü ve oturum
  adaptörleri yoktur; `memory_ingest` ve `memory_reconcile` deterministik ve
  model-dışıdır.

## Kanıt

- `test/memory-format.test.ts` — format sözleşmesi.
- `test/memory-scope.test.ts` — kişisel/proje/organizasyon yetki matrisi;
  SQLite ve PostgreSQL.
- `test/memory-job.test.ts` — gerçek accept → claim → handler → audit
  zinciri; SQLite ve PostgreSQL.
- `test/memory-migration.test.ts` — 031'den yükseltme, taze açılış, FK
  bütünlüğü; SQLite ve PostgreSQL.
- `test/memory-boundaries.test.ts` — import sınırı ve negatif fixture.
