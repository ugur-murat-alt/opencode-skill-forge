# ADR: modül sahipliği, bağımlılık yönü ve genişleme sınırı

Karar: 2026-09-10 (issue #19 pilot; issue #32 ile statik iş türü sınırı ve
run-report use-case pilotu eklendi). Modüler monolit kalınır; yeni framework,
mikroservis, plugin marketplace, CQRS veya DI container gerektirilmez.

## Sahiplik ve bağımlılık yönü

| Katman                       | Sahiplik                                                                                                                                    | Yasak içe aktarma                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/domain`                 | Sözleşmeler: ayarlar, roller, hata kodları, `tool-contracts`, statik iş türü tanımları (`job-kinds`), taşınabilir hafıza formatı (`memory`) | application, skills, jobs, runner, cli, mcp, http  |
| `src/application`            | Kullanım senaryoları (identity/organization, settings, packages, maintenance, deletion, run reports, jobs orchestration, forge dispatch)    | `src/mcp`, `src/http`, `src/clients`               |
| `src/memory`                 | Hafıza uygulaması: alan/ACL servisi, statik hafıza iş türleri, model-dışı handler'lar (issue #34)                                           | skills, runner, mcp, execution, http, cli, clients |
| `src/skills`                 | Paket depolama, yayın/CAS, arama puanlama, revision okuma                                                                                   | mcp, http, clients                                 |
| `src/jobs`, `src/runner`     | Kuyruk, worker, bütçe, sağlayıcı iş akışı                                                                                                   | mcp, http, clients                                 |
| `src/http`, `src/mcp`, `web` | Ulaşım adaptörleri: typed uygulama işlemlerine çeviri                                                                                       | —                                                  |

Kural `test/architecture-boundaries.test.ts` ile otomatik denetlenir. Denetim
artık literal import string'i aramaz: her import/export/dinamik import
specifier'ı dosya konumuna göre gerçek module path'e çözülür (göreli yollar,
`src/` kökü ve yapılandırılmış alias kökleri), yasak dizinler çözümlenmiş
yolla karşılaştırılır ve hesaplanmış (literal olmayan) dinamik import reddedilir.
Aynı dosyadaki negatif fixture; nested `../..`, alias, `export ... from`,
`src/` öneki, `require` ve hesaplı dinamik import atlatmalarının yakalandığını,
normal string içindeki literal yolun ise yanlış pozitif üretmediğini kanıtlar.
Örnek taşınım: `toolSchemas` MCP adaptöründen `src/domain/tool-contracts.ts`'e
taşındı; `application/forge` artık taşıma katmanını içe aktarmaz.

## Kuyruk doğruluk kaynağı

`runs` satırı tek doğruluk kaynağıdır (fence/CAS/deadline); pg-boss yalnız teslim
araacıdır — gerekçesi ve liveness sözleşmesi `docs/adr/pg-boss-liveness.md`'dedir.

## Statik iş türü sınırı (issue #32)

- Tanım `src/domain/job-kinds.ts` içindedir: her tür `kind`, zod `payload`
  sözleşmesi ve `skillProfile` bayrağı taşır. Kayıt construction anında
  verilir; dizin taranmaz, dinamik plugin yüklenmez.
- Üretimde şu anda yalnız `skill_evolve` kayıtlıdır ve `JobQueue` /
  `ForgeWorker` varsayılan kaydı odur; `new JobQueue(storage)` ve
  `new ForgeWorker(queue, handler, options)` çağrıları değişmeden çalışır.
- Payload doğrulama, izin (`run`), idempotency, backpressure,
  deadline/iptal, hata ve audit ortak accept/claim yolundadır. Audit duvarına
  her tür için `job.accepted`, `job.finished`, `job.retry_scheduled` ve
  `job.cancelled` olayları run mutasyonuyla aynı transaction'da yazılır.
- Skill'e özgü olan yalnız `skillProfile: true` türüne aittir: kabul anında
  `role='skill'` provider profili anlık görüntüsü ve etkin `evolutionEnabled`
  kapısı. Skill-dışı türler provider profiline, `PackageStore`'a ve SPR
  araçlarına hiç dokunmaz; `evolutionEnabled=false` onları etkilemez.
- Handler seçimi typed'dır: `ForgeWorker`'un ikinci positional argümanı
  varsayılan/skill handler'ı olarak kalır; `options.handlers[kind]` kaydı tür
  bazında farklı handler bağlar. Skill üretim handler'ı yalnız `skill_evolve`
  kabul eder.
- Test türleri üretime eklenmez; test kendi kaydını kurar
  (`test/job-kinds-contract.test.ts`). Gerçek model-dışı türler bu sınır
  üzerinden eklenir: ilk statik hafıza türleri (`memory_ingest`,
  `memory_reconcile`) issue #34 ile `src/memory/job-kinds.ts` içinde
  tanımlanmış, üretim kaydı `productionJobKinds` ile verilmiştir; türler
  `skillProfile: false` ve `scope: "memory"` taşır.

## Hafıza sınırı (issue #34)

- Uygulama davranışının tek sahibi `src/memory/`'dir: `MemoryService`
  (alan oluşturma, alan ACL'i, kalıcı olay kabulü, deterministik
  uzlaştırma), statik iş türleri ve model-dışı handler'lar. HTTP/MCP/CLI
  ileride yalnız adaptör olur.
- `src/domain/memory.ts` taşınabilir Markdown sözleşmesidir; DB/IO/uygulama
  import etmez. `test/memory-boundaries.test.ts` bunu çözümlenmiş module
  path'leri ve negatif fixture ile denetler.
- `src/memory/**`; `skills`, `runner`, `mcp`, `execution` ve taşıma
  katmanlarını import etmez. `PackageStore`/`EvolutionStaging` hafıza
  deposu veya izin kaynağı değildir; hafıza işi `skill_evolve` kılığına
  girmez.
- Kapsam/yetki kararları ve gerekçeleri `docs/adr/memory-ownership.md`,
  format referansı `docs/tr/hafiza-format.md` içindedir.

## Arama, bağlam ve MCP sınırı (issue #36)

- `src/memory/index.ts` türetilmiş lexical/graph indeksini yazar
  (`memory_index_*`); her satır kabul edilmiş `note_id`/`revision`/
  `content_hash`e bağlıdır ve yalnız `memory_note_revisions` + revision
  dosyalarından yeniden üretilebilir. Rebuild notları/ACL'i/kuyruk geçmişini
  değiştirmez. Backend'e özgü FTS/tsvector yerine taşınabilir terim tablosu
  seçildi (SQLite ve PostgreSQL'de aynı skorlama; gerekçe: deterministik
  testler ve migration maliyeti).
- `src/memory/search.ts` global aday keşfi yapar; kapsam filtresi aday
  seçimi, top-k, her graf adımı ve cache öncesinde uygulanır. Yenilenmemiş
  indeks head'i güncel `memory_notes.current_revision` ile doğrulanır; stale
  sonuç döndürülmez ve gecikme raporlanır.
- `src/memory/context.ts` bütçeli bağlam derleyicisidir; `offered` ile
  teslim ayrıdır, token boyutu açıkça `bytes/2.5` **tahminidir**.
- `src/memory/writes.ts` tipli update/link/checkpoint mutasyonlarını
  sürümlü commit hattına bağlar; audit uygulama katmanındadır, böylece HTTP
  ve MCP aynı kaydı üretir. `src/mcp/**` yalnız şema/kayıt adaptörüdür;
  bağımsız graf yazıcısı veya ikinci derleyici yoktur.
- Yazma idempotency'si M02 olay hattındadır: aynı `event_key` + aynı içerik
  pending olayı tamamlar veya kabul edilmiş receipt'i replay eder (timeout/
  crash sonrası tekrar deneme); aynı anahtar farklı içerikle 409
  `memory_event_conflict`'tir. Kayıpsız düzenleme: tipli patch yalnız açıkça
  değiştirilen alanları değiştirir; `sources`, bilinmeyen frontmatter,
  `created_at` ve geçerlilik penceresi yeni revizyona taşınır.
- SUPERSEDES sözleşmesi: A `--SUPERSEDES-->` B ise **B** superseded olur,
  A aktif kalır. Yaşam döngüsü operasyonel not durumudur
  (`memory_notes.lifecycle` + türetilmiş indeks head'i), kabul edilmiş
  revision dosyasını değiştirmez ve rebuild bu satırdan beslenir. Kaynağı
  ayrıca arşivlemek isteyen açık `lifecycle`/`archive` işlemini kullanır.

## Bağlam, araç yüzeyi ve benchmark (issue #36)

- `memory_context` aynı yetkili snapshot'tan aktif görev/engel/son karar/pin
  ve kaynaklı devam adımını derler; her kart
  `note_id + revision + kind + snippet + match_reason + sources` taşır.
  Bütçe **bytes/2.5 tahminidir** (gerçek tokenizer yok; karakter token
  sayılmaz) ve sert bayt sınırı **tüm pakete** (zarf + kartlar + bölümler +
  offered) uygulanır: önce kartlar, sonra düşük öncelikli bölümler kırpılır;
  aktif görev/engel/devam adımı korunur ve değişmez kural
  `used_tokens_estimate <= max_tokens`'tır. Zarfın zorunlu alanları
  (package_hash, bütçe) nedeniyle etkin en düşük bütçe 192 tahmini tokendır;
  daha küçük istek bu tabana yükseltilir ve yanıtta etkin `max_tokens` döner.
  Sığmayan öğe `truncated` + `continuation_note` ile bildirilir. Yetersiz
  kanıtta boş sonuç döner, bütçe ilgisiz notlarla doldurulmaz.
- Offered ≠ delivered: yalnız sunulan sürümler `offered`da listelenir; teslim
  istemcinin `known_revisions` beyanıdır ve değişmeyen sürümler tekrar
  enjekte edilmez. Compaction/resume'da beyan yoksa başlangıç paketi yeniden
  sunulur; eski içerik fiziksel olarak silinmiş sayılmaz, düzeltme yeni
  revision/supersession olarak gelir.
- Geçerlilik: indeks head'i `valid_from`/`valid_until` taşır; `asOf` verilen
  sorguda penceresi kapanmış kayıt stale sayılır ve güncel diye sunulmaz.
- Araç kataloğu: altı `memory_*` aracı yalnız `memoryEnabled` ve yetki
  varken görünür; mevcut beş `forge_*` değişmez. Mutasyon audit'i uygulama
  katmanındadır (HTTP ve MCP aynı). Kalıcı toplu purge genel yazma aracında
  yoktur; ayrı yetkili yönetim akışıdır. Otomatik yazım M03'te kapalıdır;
  benchmark bu nedenle auto-write recall'ı ölçmez (not-measured).
- Benchmark: `test/fixtures/memory-benchmark` tuning + held-out acceptance
  bölümleri ve ölçüm öncesi donmuş `thresholds.json`; eşikler sonuç
  görüldükten sonra düşürülemez.

## Use-case pilotu (issue #32)

`src/application/run-reports.ts` içindeki `RunReports`, run raporu okuma
modelini `ForgeService.invoke` anahtarından ayırır. HTTP `/api/runs` adaptörü
ve MCP `forge_report` dağıtıcısı aynı fonksiyonu çağırır; cursor, redaksiyon ve
sonuç parçalama aynı request kimliğine bağlı kalır
(`test/job-kinds-use-case.test.ts`). Bu tek dikey pilottur; `server.ts` ve
`PackageStore` çoklu sorumlulukları tek seferde taşınmamıştır.

## Ortak yetenekler

Kimlik/organizasyon, etkin politika, kabul, audit duvarı ve bütçe skill
modülüne bağlı değildir. `test/common-capabilities.test.ts` kayıtlı model-dışı
bir türle kabul + audit + bütçe bileşimini kurar; aynı türün gerçek
claim → handler → sonuç zinciri `test/job-kinds-contract.test.ts` içindedir.

## Genişleme sınırı

- **Yeni ekran:** `web/src/screens.ts` kaydına tek satır; kapsam gereksinimi
  (`needsProject`) aynı tanımdan türer, ayrı liste tutulmaz.
- **Yeni sözleşme:** `src/domain`'e ekleyin; adaptörler ve uygulama oradan alır.
- **Yeni iş türü:** `src/domain/job-kinds.ts` kaydına statik bir tanım ekleyin,
  aynı kaydı `JobQueue` ve `ForgeWorker`'a verin, handler'ı `handlers`
  eşlemesine bağlayın. İkinci kuyruk framework'ü veya dinamik plugin motoru
  yazılmaz.
- Pilot dikey: sözleşme taşınması (tool-contracts), ekran kaydı ve
  run-report use-case'i bu eksenleri gösterdi; kalan alanlar aynı yöntemle
  parça parça taşınır.
