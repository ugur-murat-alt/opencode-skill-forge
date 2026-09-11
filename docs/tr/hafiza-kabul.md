# Hafıza kabul, kanıt ve benchmark rehberi

Bu belge #41 (M08) **ortak kanıt sözleşmesini**, test sınıflarını, benchmark
rotasını ve #34 (M01) için bağımsız inceleme adımlarını tanımlar. Ürün
sözleşmeleri kendi normatif yerlerinde kalır (`docs/adr/`, modül rehberleri);
burada yalnız "neyi, hangi gerçek yolla, hangi kanıtla doğruladık?" sorusunun
cevabı tutulur.

> Durum (11.09.2026): M01 (#34) bu dala birleşti. Bağımsız kabul koşusu
> SQLite'ta 13/13, PostgreSQL'de (geçici veritabanı başına) 21/21 yeşildir;
> sert kapı `MEMORY_REQUIRE_M01=1` ile her koşumda açılır. Benchmark iskeleti
> ve veri kümesi kendi birim testleriyle yeşildir. Kalite/token/latency
> ölçümü henüz **üretilmemiştir**; eşikler ölçüm öncesi donmuş hedeflerdir.

## 1. Ortak kanıt sözleşmesi

Her doğrulama satırı şu alanları taşır:

| Alan              | Anlam                                                               |
| ----------------- | ------------------------------------------------------------------- |
| Gereksinim        | Issue maddesi veya ADR kuralı (örnek: "#34 kabul: kapsam matrisi"). |
| Gerçek giriş yolu | Ürünü gerçekten çalıştıran yol: worker/HTTP/MCP/CLI/native hook.    |
| Beklenen sonuç    | Gözlenebilir çıktı; "hata yok" tek başına yeterli değil.            |
| Komut             | Kopyalanabilir, ortam değişkenleriyle birlikte tam komut.           |
| Fixture           | Kullanılan veri dosyası veya üretici tohumu.                        |
| Commit SHA        | Koşunun yapıldığı HEAD; artifact ile aynı olmalı.                   |
| CI run            | Workflow/koşum kimliği; yerel koşum ise "yerel" açıkça yazılır.     |
| Artifact          | Temiz kökteki JSON/log dosyası; yol ve SHA-256'sı.                  |

Kurallar:

- Kod yorumu, test adı veya ajan beyanı tek başına kanıt değildir; kanıt
  çalıştırılabilir komut ve gözlenen çıktıdır.
- "HTTP" testi gerçek HTTP yolunu, "native hook" testi gerçek istemciyi,
  "crash" testi gerçek süreç öldürme/kesinti sınırını çalıştırmalıdır.
  Simülasyon canlı kabul yerine geçmez.
- Yeni çıktılar temiz bir artifact kökünde geçerli JSON ve gereken logları
  taşır: commit SHA, UTC başlangıç/bitiş, sürümler, test kimlikleri ve
  ortam bilgisi.
- Önceki izlenen evidence dosyası yeni koşumun yerine yüklenemez; yeni koşum
  yeni dosya ve yeni SHA üretir.
- Kasıtlı bir regresyonun kapıyı kırdığı gösterilir (fault-injection); kırmızı
  koşumun logu kanıt olarak saklanır, sonra düzeltilmiş koşum eklenir.
- UI ekran görüntüsü davranış assertion'ının yerine geçmez; yalnız destekleyici
  görseldir.
- Sırlar ve gerçek kullanıcı transcript'i evidence'a girmez. Zehirleme/negatif
  fixture'lar sentetiktir.

## 2. Test sınıfları

| Sınıf          | Ne çalışır                                  | Ne kanıtlar                         | Kanıt sayılmaz                   |
| -------------- | ------------------------------------------- | ----------------------------------- | -------------------------------- |
| Yerel fixture  | Gerçek modül + SQLite + `test/fixtures/**`  | Sözleşme, ACL, idempotency, recover | Gerçek istemci/dağıtım davranışı |
| PostgreSQL     | `FORGE_TEST_POSTGRES_URL` ile gerçek sunucu | İki arka uç eşdeğerliği             | Üretim ölçeği/canlı veri         |
| Native istemci | Gerçek Codex/Claude sürümü + olay matrisi   | Hook/oturum sürekliliği             | Sahte hook fixture'ı             |
| Canlı model    | Gerçek provider                             | Model çağıran akış                  | Model yokluğu/gölge koşum        |
| Sandbox        | Docker/paket script yolu                    | İzolasyon ve script doğrulaması     | Host fallback                    |
| Desteklenen OS | Linux/macOS/Windows ayrı koşum              | Platform farkları                   | Tek platformdan genelleme        |

Her raporda bu sınıflar **ayrı işaretlenir**. Model gerektirmeyen testler
`evolutionEnabled=false` iken de geçmelidir; model çağıran bir test model
yokluğunda "başarısız" değil "çalıştırılmadı" olarak raporlanır.

## 3. Benchmark rotası

### 3.1 Veri bölümleri

- `test/fixtures/memory-benchmark/tuning.json` — ayar bölümü, serbest.
- `test/fixtures/memory-benchmark/acceptance.json` — held-out; eşik ve prompt
  buna bakılarak değiştirilemez.
- `test/fixtures/memory-benchmark/thresholds.json` — ölçümden önce donmuş
  eşikler.
- `test/fixtures/memory-benchmark/synthetic.ts` — tohumlu 1.000/10.000+ not
  üreticisi; `needles` güçlü eşleşmeleri listenin son %2'sine koyar.

Kapsam: eski/yeni karar, aynı isim farklı kapsam, zamanlı bilgi, çok oturumlu
süreklilik, görev/engel/sonraki adım, ilgisiz sorgu (çekimserlik), çelişki ve
kasıtlı hafıza zehirleme. Her kategori en az bir TR ve bir EN senaryo içerir;
iki bölüm kimlik paylaşmaz. Veri sentetiktir; gerçek kullanıcı verisi, transcript
veya sır içermez (test edilir).

### 3.2 Metrikler

`test/benchmarks/metrics.ts` şu ölçümleri üretir; her oran pay/payda taşır:

| Metrik                  | Tanım                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `recall_at_k`           | İlk k sonuçta bulunan beklenen kaynak oranı; boş kümede N/A.         |
| `source_hit_at_k`       | İlk k içinde en az bir doğru kaynak var mı.                          |
| `stale_claim_rate`      | Eski/superseded kaynağı güncel sayan senaryo oranı.                  |
| `scope_leak_rate`       | Kapsam dışı kimliğin sonuca/alıntıya sızma oranı.                    |
| `false_auto_write_rate` | Yanlış otomatik yazım / toplam yazım; yazım yoksa N/A.               |
| `auto_write_recall`     | Doğru yazılan uygun fırsat / toplam fırsat (boş yazım oyunu engeli). |
| `abstention_accuracy`   | Konu dışı sorguda çekimser kalma oranı.                              |
| `false_abstention_rate` | Yanıtı olan sorguda gereksiz çekimserlik.                            |
| `task_success_rate`     | Görev durumu + engel + sonraki adım birlikte doğru mu.               |
| `poison_follow_rate`    | Kayıt içi talimatı uygulama oranı (sıfır tolerans).                  |
| `context_tokens`        | Tokenizer varsa ölçüm, yoksa etiketli bayt tahmini.                  |
| `latency_ms`            | Sıcak lexical+graph ve önbellekli başlangıç için ayrı p50/p95.       |

Kısa ama yanlış yanıt tasarruf değildir; daha fazla kayıt depolamak tek başına
başarı değildir.

### 3.3 Eşik politikası

- Eşikler ölçümden önce `thresholds.json` içinde donar
  (`frozenBeforeMeasurement: true`, `measured: false`, `guarantee: false`).
- Sonuç görüldükten sonra eşik düşürülemez; değişiklik yeni `version` ve
  gerekçe gerektirir. Sıfır toleranslı satırlar (`stale_claim_rate`,
  `scope_leak_rate`, `false_auto_write_rate`, `poison_follow_rate`) politika
  tabanıdır, ölçüm iddiası değildir.
- #41'deki 1024/2048 token, 8 kart ve sıcak p95 ≤250 ms / önbellekli başlangıç
  p95 ≤100 ms değerleri **başlangıç değerlendirme hedefidir**; mevcut ölçüm
  veya garanti sayılmaz. Donanım ve korpus ilk koşum raporunda yazılır.
- En az 30 örnek olmadan p95 kararı verilmez; değerlendirici "ölçülmedi"
  der. Eksik ölçüm asla "geçti" sayılmaz.

### 3.4 Token ve maliyet

- Gerçek tokenizer varsa kullanılır (`estimated:false`); yoksa bayt tabanlı
  tahmin açıkça etiketlenir (`utf8_bytes_div_2.5_estimate`). Karakter sayısı
  token diye raporlanmaz.
- Zarf, kaynak referansları, pinler ve tool sonucu bütçeye dahildir.
- Cache-read tokenları bağlam boyutuna dahil raporlanır; faturalama maliyetiyle
  karıştırılmaz.
- Normal teslim ile compaction sonrası teslim ayrı raporlanır. Kritik bilgi
  sığmazsa açık truncation/continuation bilgisi verilir.

### 3.5 Karşılaştırma kolları

Hafızasız temel, AGZ lexical/graph eşdeğeri ve yeni lexical+graph+derleyici aynı
görev/model koşullarında koşar; semantic yalnız ayrı ve isteğe bağlı koldur.
Koşum komutu (iskelet):

```bash
bun test test/benchmarks/                    # metrik ve sözleşme testleri
MEMORY_REQUIRE_M01=1 \
FORGE_TEST_POSTGRES_URL=postgres://postgres:forge-ci-only@127.0.0.1:55433/forge_mem_verify \
  bun test test/memory-acceptance-independent.test.ts
```

PostgreSQL hücresi her koşum için kendi **geçici veritabanını** açar ve
sonunda düşürür; paylaşılan `forge_mem_verify`/`forge_test` düşürülmez.

## 4. M01 bağımsız kabul matrisi (#34)

Test dosyası: `test/memory-acceptance-independent.test.ts` (çekirdek ajanın
dosya adlarıyla çakışmaz). Doğrulanan public sözleşme:

- `src/memory/service.ts`: `new MemoryService(db, identities?)`;
  `ensureSpace(identity, {type:"personal"|"project",projectId})`;
  organizasyon alanı `createOrganizationSpace(identity, name)` ile açılır ve
  `ensureSpace({type:"organization"})` 422 `invalid_scope` verir;
  `authorizeSpace(identity, spaceId, "read"|"write")`;
  `recordEvent(identity, {spaceId,sourceEventKey,sourceKind,contentHash,observedAt?})`
  → `{status:"recorded"|"duplicate", event}` (aynı anahtar+farklı hash 409);
  `reconcile(identity, {spaceId?,limit?})` → sayaç raporu.
- `src/memory/job-kinds.ts`: `memoryJobKinds`/`productionJobKinds`;
  iki kind da `skillProfile:false`, `scope:"memory"`; payload alan adları
  yukarıdakiyle aynı ve strict'tir.
- `src/memory/worker.ts`: `memoryJobHandlers(service)` gerçek handler'lar.
- Queue: `accept(identity, {kind,key,payload,scope})` veya eski `projectId`;
  `Run.project_id: string|null`, `scope_kind`, `scope_key` (proje: projectId,
  personal: userId, organization: `"organization"`); memory işleri bağımsız
  `memoryEnabled` bayrağıyla kapılanır.
- `src/domain/memory.ts`: `parseMemoryDocument` (durum döndürür),
  `serializeMemoryDocument`, `memoryRecordHash` (revision hariç),
  `detectSupersessionCycle`, `resolveWikilink`.

| #   | Senaryo                                                                 | Test                     | SQLite | PG    |
| --- | ----------------------------------------------------------------------- | ------------------------ | ------ | ----- |
| 1   | memory kind tanımları `skillProfile:false`, handler fabrikası           | yüzey çözümü             | geçti  | geçti |
| 2   | Kişisel/proje/organizasyon accept + Run alanları                        | kapsam matrisi           | geçti  | geçti |
| 3   | Aynı anahtar aynı hash duplicate, farklı hash 409                       | idempotency              | geçti  | geçti |
| 4   | Evolution kapalı: hafıza geçer; memory kapalı ve skill kapıları korunur | bayraklar                | geçti  | geçti |
| 5   | Lease fencing (fence 2, eski worker 409) ve cancel                      | fencing                  | geçti  | geçti |
| 6   | Gerçek worker + handler + audit + idempotent event + yabancı uzay reddi | worker zinciri           | geçti  | geçti |
| 7   | `ensureSpace`/`recordEvent`/accept yarışta tek sonuç                    | yarış güvenliği          | geçti  | geçti |
| 8   | ACL red matrisi: kişisel/proje/organizasyon, reader/non-member/tenant   | MemoryService sözleşmesi | geçti  | geçti |
| 9   | Yetki sahteciliği ve tenant izolasyonu negatifleri                      | negatifler               | geçti  | geçti |
| 10  | Round-trip + revision-dışı hash + bilinmeyen frontmatter                | domain sözleşmesi        | geçti  | —     |
| 11  | Gelecek format reddi (durum, mutasyon yok)                              | domain sözleşmesi        | geçti  | —     |
| 12  | Supersession döngüsü tespiti                                            | domain sözleşmesi        | geçti  | —     |
| 13  | Wikilink resolved/ambiguous/missing                                     | domain sözleşmesi        | geçti  | —     |

Komutlar ve gözlemler (11.09.2026, kararlılık için üçer koşum):

```bash
# SQLite: her koşum 13 pass, 0 fail.
MEMORY_REQUIRE_M01=1 bun test test/memory-acceptance-independent.test.ts

# SQLite + PostgreSQL: her koşum 21 pass, 0 fail (PG kendi geçici DB'sini açar).
MEMORY_REQUIRE_M01=1 \
FORGE_TEST_POSTGRES_URL=postgres://postgres:forge-ci-only@127.0.0.1:55433/forge_mem_verify \
  bun test test/memory-acceptance-independent.test.ts
```

Bu maddelerin tamamı gerçek modüllerle koşulmuştur; hiçbiri "çalıştırılmadı"
değildir. HTTP/MCP/Native-müşteri sınıfları bu matrisin dışındadır (M01'de bu
yüzeyler yoktur); M03+ ile ayrıca kanıtlanır.

## 5. #34 için bağımsız inceleme adımları

1. **Kapsam doğrula:** Yalnız `src/` hafıza modülleri, migration ve testler
   değişmiş olmalı; skill deposu/izin kaynağı değişmemeli. `git diff --stat`
   ile modül sınırı kontrol edilir.
2. **Sözleşmeyi doğrula:** Kabul testini `MEMORY_REQUIRE_M01=1` ile koştur;
   `skip` varsa inceleme durur (eksik yüzey kanıtlanmamış sayılır).
3. **Pozitifleri doğrula:** Kişisel/proje/organizasyon matrisi, worker zinciri,
   audit ve idempotent receipt yeşil olmalı.
4. **Negatifleri doğrula:** Aynı anahtar farklı hash 409; yetki sahteciliği
   run sahibini değiştirmemeli; başka tenant `queue.get` 404 almalı; kapsam
   dışı uzay okuma/yazma reddedilmeli.
5. **Domain doğrula:** Round-trip, revision-dışı hash, gelecek format reddi,
   supersession döngüsü reddi, wikilink belirsizliği.
6. **Kapsam-hedef tutarlılığını doğrula:** Bildirilen `scope` ile payload
   `spaceId` aynı alanı göstermelidir ve hedef alanın etkin `memoryEnabled`
   değeri commit anında yeniden kontrol edilmelidir. M01'de kabul anındaki
   bildirilen kapsamın dışındaki bir hedefe yazım engellenmez (bağımsız
   inceleme probe'u, 11.09.2026; ayrıntı koordinatör raporunda).
7. **Eski regresyonu doğrula:** `bun test test/jobs-contract.test.ts`
   `skill_evolve` zorunlu proje, idempotency, fencing ve audit davranışını
   korumalı; `bun test test/job-kinds-contract.test.ts` yeşil kalmalı.
8. **Kanıtı topla:** Aşağıdaki alanlarla `docs/evidence/memory/` şemasına uyan
   bir JSON üret; üretilen raporu commit etme, artifact yolunu ve SHA-256'sını
   kaydet.

| Alan              | #34 için beklenen                                                        |
| ----------------- | ------------------------------------------------------------------------ |
| Gerçek giriş yolu | `JobQueue.accept` → `ForgeWorker` → `memoryJobHandlers` (HTTP/MCP değil) |
| Komut             | Bölüm 4'teki iki komut + `bun test test/benchmarks/`                     |
| Fixture           | `test/fixtures/memory-benchmark/*` (benchmark) ve test içi sentetik veri |
| Commit SHA        | Koşulan HEAD                                                             |
| CI run            | Workflow run kimliği veya "yerel"                                        |
| Artifact          | `report.schema.json` biçiminde JSON + komut logu                         |

İnceleme sonucu üç durumdan biridir: **geçti** (komutlar yeşil, artifact
tam), **kısmi** (hangi hücre neden koşmadı yazılı), **kaldı** (sözleşme
uyuşmazlığı; örnek dosya satırı düzeltilmeden kabul yok).

## 6. M02 bağımsız kabul matrisi (#35)

Test dosyaları: `test/memory-pipeline-independent.test.ts`,
`test/memory-writer-lock-independent.test.ts`,
`test/memory-scan-independent.test.ts`, `test/memory-http-independent.test.ts`,
`test/memory-files-independent.test.ts`,
`test/memory-pipeline-migration-independent.test.ts`; gerçek çocuk süreçler
`test/fixtures/memory/commit-crash-child.ts` ve `writer-lock-child.ts`.

Doğrulanan public sözleşme:

- `MemoryCommitService.commit({identity, run?, spaceId, eventId, sourceKind,
content, noteId?, baseRevision?, kind?})` → `{status, noteId, revision,
recordHash, fileHash, filePath, byteSize, redacted, indexed}`. `afterPublish`
  ve `afterCommitBeforeIndex` yalnızca test kesinti enjeksiyonudur.
- Sıra: boyut + ACL → olay/hash doğrulama → redaksiyon → yazıcı kilidi →
  geçici dosya + fsync → immutable revision → çalışma kopyası → DB (revision +
  head CAS + event committed + receipt) → indeks işareti.
- `MemorySourceService.registerSource/scan/listCandidates`; `ScanReport`
  sayaçları (scanned/read/unchanged/candidates/conflicts/skipped/errors/
  missing/done/cursor); tombstone `deleted_at`; açık
  `archiveNote`/`restoreNote`.
- HTTP: GET uçları salt okunur; yazma uçları ACL + audit; receipt ayrı GET.

| #   | Senaryo                                                                 | Test                          | SQLite | PG    |
| --- | ----------------------------------------------------------------------- | ----------------------------- | ------ | ----- |
| 1   | create/edit/read, replay tek receipt+revision, farklı hash 409          | pipeline test 1               | geçti  | geçti |
| 2   | Gerçek SIGKILL (b) dosya benimseme, (c) indeks tamamlama                | pipeline test 3 (çocuk süreç) | geçti  | geçti |
| 3   | CAS: kaybeden yalnız kendi adayını siler; iki yazıcı yarışı temiz hata  | pipeline test 2               | geçti  | geçti |
| 4   | SIGSTOP canlı yazıcı force ile bloke; ölü pid devralınır; foreign force | writer-lock testleri          | geçti  | —     |
| 5   | Bounded tarama 1005 dosya (PG 61), cursor ortası, tüm sınıflar          | scan testleri                 | geçti  | geçti |
| 6   | Tombstone dirilmez; açık restore sonrası dış değişiklik aday olur       | pipeline test 4 + scan test 4 | geçti  | geçti |
| 7   | HTTP GET salt okunur, mutasyon audit+ACL, kiracı izolasyonu, hata kodu  | http testleri                 | geçti  | geçti |
| 8   | 032→033 migration veri korur, yeni kolonlar varsayılanlı                | migration testi               | geçti  | geçti |
| 9   | Dosya katmanı: atomik yazım, ezme reddi, safeJoin; symlink (bekleyen)   | files testi                   | kısmi  | —     |

```bash
# Bağımsız M02 paketi (SQLite + scratch PostgreSQL):
MEMORY_REQUIRE_M01=1 \
FORGE_TEST_POSTGRES_URL=postgres://postgres:forge-ci-only@127.0.0.1:55433/forge_mem_verify \
  bun test test/memory-pipeline-independent.test.ts \
    test/memory-writer-lock-independent.test.ts \
    test/memory-scan-independent.test.ts \
    test/memory-http-independent.test.ts \
    test/memory-files-independent.test.ts \
    test/memory-pipeline-migration-independent.test.ts
```

Bekleyen uçlar (bağımsız inceleme, 11.09.2026; her biri `test.failing`):

- `src/memory/writer.ts:166` — bozuk/okunamayan kilit `throw` edilmediği için
  force olmadan devralınıyor (bilinen; çekirdek düzeltmesi bekleniyor).
- `src/memory/sources.ts:736` — silinen kaynak kökü `scan`'i ham `ENOENT` ile
  düşürüyor; kaynak durumu raporlanmalı.
- `src/memory/commit.ts:378-387` — çalışma kopyası yazıldıktan sonra DB
  öncesi kesintide replay kendi yazdığı kopyayı dış değişiklik sanıp hayalet
  `working_copy_changed` çatışması üretiyor.
- `src/memory/commit.ts:646-679` — `receipt_json` yokken `reconstructReceipt`
  revizyonu yalnız `(space, revision)` ile aradığından aynı alandaki başka
  notun dosyasını döndürebiliyor.
- `src/memory/files.ts:245` — `gcTempFiles` üretimde çağrılmıyor; çökmüş
  geçici dosyalar hiç temizlenmiyor (grep + probe kanıtı).
- `src/memory/files.ts` `publishRevisionFile`/`atomicWriteFile` — vault
  içindeki bir ara dizin symlink'e çevrilirse dosya vault kökünün dışına
  yazılıyor; yazma yolu symlink ara dizinleri doğrulamıyor (probe + test).
- `src/memory/service.ts` `listNotes` — `display_path` türü sırasız revizyon
  kümesinden seçiliyor (yalnız sunum; bilgi).

Çekirdek düzeltmesi gelince ilgili test yeşile döner; `.failing` işareti
kaldırılmalıdır (Bun aksi halde "failing ama geçti" diye kırmızı verir).

## 7. Entegrasyon turu bağımsız doğrulaması (M03-B / M04-A / M06 / M07 + retry)

Yeni bağımsız dosyalar ve kapsadıkları sözleşmeler:

| Dosya                                        | Kapsam                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/memory-writes-independent.test.ts`     | `MemoryWriteService` create/patch CAS, event_key, archive/restore, link iki uç, checkpoint otomatik-done yasağı, `MemoryContextService` kart/bölüm/delta, bütçe ve supersede uçları             |
| `test/memory-surface-independent.test.ts`    | Gerçek HTTP + gerçek MCP istemcisi: `memoryEnabled=false` kataloğu (5 `forge_*`), `=true` kataloğu (6 `memory_*`), MCP↔HTTP aynı sonuç, revisions/context eşleşmesi                             |
| `test/memory-m04-independent.test.ts`        | Taslak kapsam anahtarı (tenant+space+note+base), yayımlanmamış iş, belge kayıpsız düzenleme; sürüm geçmişi salt-okunurluğu + kiracı izolasyonu, 409 + yeniden tabanlama, alan oluşturma audit'i |
| `test/memory-curator-independent.test.ts`    | Finalize kapısı, `off` modda sağlayıcı çağrılmaması, sert çağrı bütçesi, auto-write tür tavanı, beş araçlık dar yüzey + `run_closed`                                                            |
| `test/agz-import-guards-independent.test.ts` | Güvensiz not kimliği reddi, `%` databaseId sahiplik yanılgısı, rollback receipt digest bağı                                                                                                     |
| `test/worker-db-retry-independent.test.ts`   | SQLITE_BUSY/40001 yeniden deneme, gerçek hatanın terminal kalması, sınıflama matrisi                                                                                                            |

Koşum: yukarıdaki altı dosya SQLite'ta; M01/M02 paketleri ayrıca PostgreSQL'de
yeşil. Benchmark kabulü (`test/benchmarks/memory-acceptance.test.ts`) gerçek
ölçüm üretir: kalite metrikleri ölçülü ve eşik üstü, otomatik yazım
`not-measured`, p95 30 örnek dolmadan `not-measured`; token sayıları
`utf8_bytes_div_2.5_estimate` etiketli tahmindir, garanti değildir.

Bağımsız incelemede açık kalan ve `test.failing` ile işaretlenen uçlar
(11.09.2026):

- `src/memory/context.ts` — bütçe yalnız kartlardan kırpılıyor; bölüm
  kimlikleri (`active_tasks`/`blockers`/`decisions`/`pins`) ve zarf
  sınırsız olduğundan `used_tokens_estimate` `max_tokens`'ı aşabiliyor
  (30 not, `max_tokens=128` → ölçüm 628).
- `src/memory/writes.ts` — `loadParsed` metadata'daki `sources`'u, bilinmeyen
  frontmatter'ı, `created_at` ve `valid_from/valid_until` alanlarını
  taşımıyor; her tipli düzenleme bu alanları sessizce düşürüyor.
- `src/memory/writes.ts` — aynı `event_key` ile idempotent retry
  `memory_event_conflict` (409) dönüyor; M02 replay receipt'i yerine hata
  üretiliyor.
- `src/memory/writes.ts` — `supersede_target` kaynağı `superseded` yaparken
  aynı anda kaynaktan hedefe `SUPERSEDES` kenarı ekliyor (anlamsal çelişki;
  sözleşmede hedefin mi yoksa kaynağın mı yaşam döngüsünün değişeceği
  netleşmeli).

M07 düzeltmeleri (`509f92c`, `622d560`) bağımsız olarak doğrulandı: hostile
kimlik stage dışına yazamıyor, `%` sahiplik yanılgısı yok, rollback digest
bağı kopuksa hiçbir not arşivlenmiyor; rollback sonrası replay tombstone'ları
görünür sayıyor.

## 8. Sonraki M'ler için doğrulama başlıkları

M01–M04, M06 ve M07 bağımsız kapıları yukarıda; kalan başlıklar:

- **M05 (#38) native istemci:** Gerçek Codex/Claude sürüm + olay matrisi;
  offline spool; interrupt'ta alınmamış son olayın uydurulmaması.
- **M08 (#41) backup/restore/retention/işletim:** Aynı commit sınırında
  Markdown + işletim DB snapshot'ı; boş hedefe restore → yeniden indeks →
  aynı yetkili not/graph/bağlam; unut/purge ve eski yedekten dirilme negatifi;
  tanılama ekranı/doctor; public health'te not/tenant adı yok; kademeli açılış
  matrisi.

## 9. Final ölçüm turu ve entegrasyon bulguları (11.09.2026, `db63dab`)

### 9.1 Kalite/token/gecikme (donmuş eşikler; ölçüm, garanti değil)

Koşum: `bun test test/benchmarks/memory-acceptance.test.ts`
(`new_lexical_graph_compiler`, k=8, 16 senaryo, SQLite):

| Metrik                  | Ölçüm            | Eşik  | Durum                                    |
| ----------------------- | ---------------- | ----- | ---------------------------------------- |
| `recall@8`              | 0.964 (13.5/14)  | ≥0.80 | pass                                     |
| `source_hit@8`          | 1.0 (14/14)      | ≥0.90 | pass                                     |
| `stale_claim_rate`      | 0 (0/4)          | ≤0    | pass                                     |
| `scope_leak_rate`       | 0 (0/2)          | ≤0    | pass                                     |
| `abstention_accuracy`   | 1.0 (2/2)        | ≥0.90 | pass                                     |
| `false_abstention_rate` | 0 (0/14)         | ≤0.10 | pass                                     |
| `task_success_rate`     | 1.0 (2/2)        | ≥0.90 | pass                                     |
| `poison_follow_rate`    | 0 (0/2)          | ≤0    | pass                                     |
| `startup_max_tokens`    | 978              | ≤1024 | pass (bayt tahmini)                      |
| `recall_max_tokens`     | 694              | ≤2048 | pass (bayt tahmini)                      |
| p95 gecikme             | 60 ms / 16 örnek | ≤250  | **not-measured** (en az 30 örnek kuralı) |
| auto-write (bu koşumda) | —                | —     | **not-measured** (yazma yolu yok)        |

### 9.2 Küratör auto-write ölçümü (deterministik sahte stream, TR/EN)

Koşum: `M08_EVIDENCE_DIR=/tmp/opencode/m08-evidence bun test test/memory-curator-benchmark-independent.test.ts`

| Metrik                                                                        | Ölçüm                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------- |
| Uygun aday (user_declared preference)                                         | 2/2 yazıldı; `auto_write_recall` = 1     |
| Uygun olmayan aday (tamamlama, çelişki, plan, allowlist dışı tür, enjeksiyon) | 0/6 yazıldı; `false_auto_write_rate` = 0 |
| Allowlist ihlali                                                              | 0                                        |
| Yazılan notlarda kaynak hash desteği                                          | 2/2                                      |
| Uydurma citation / enjeksiyon                                                 | yazım yok                                |

Donmuş eşikler değiştirilmedi (`false_auto_write_rate ≤ 0`, `auto_write_recall ≥ 0.6`).
Örneklem küçüktür (uygun aday n=2) ve claim sınıflaması model bayraklarına
dayanır; "model yanlış sınıflandırırsa" riski bu ölçümün dışındadır. Üretilen
rapor (şemaya uygun) `/tmp/opencode/m08-evidence/` altındadır; commit edilmez.

### 9.3 Açık bulgular (düzeltme çekirdeğe ait; `test.failing` ile işaretli)

1. **[Kritik] `src/memory/invalidation.ts:15-31`** — `memory_index_edges`
   tablosunda `note_id` yok; invalidation yanlış kolonu siliyor. PostgreSQL'de
   arşiv/purge `42703 column "note_id" does not exist` ile düşüyor (probe);
   SQLite'ta hata sessizce yutulup kenar satırı kalıyor (probe: arşiv sonrası
   `source_note_id=inv-a` kenarı duruyor). Ayrıca PG purge'unda dosyalar
   silindikten sonra transaction düşüyor: not satırı kalır, revision dosyası
   yok olur (probe). Bu bulgu nedeniyle M02/M04 bağımsız paketlerinin ilgili
   **üç PostgreSQL hücresi kırmızıdır**; SQLite hücreleri yeşildir ve bulgu
   `test/memory-m08-independent.test.ts` içinde `test.failing` ile ayrıca
   işaretlenmiştir.
2. **[Kritik] `src/storage/retention-migration.ts:23,36,37,48,49`** — ms
   zaman damgası tutan kolonlar `integer` (PG int4). PostgreSQL'de retention
   koşumu ve purge/restore makbuzları `22003 value out of range for type
integer` ile yazılamıyor (probe); SQLite 64-bit olduğu için gizli kalıyor.
3. **[Düşük] `src/memory/curator/apply.ts:112-126`** — otomatik uygulanan
   adayda üretilen `note_id` change satırına yazılmıyor (review.ts yazıyor);
   panel/liste ile oluşturulan not arasındaki bağ kaybolur.
4. **[Düşük/Orta] `writes.ts` ↔ `review.ts` kanonik gövde farkı** — aynı
   mantıksal düzenleme review yolunda izleyen `\n` ile, typed write yolunda
   `\n` olmadan yazılıyor; hash/replay eşleşmesi yola bağlı hale geliyor
   (`test/memory-curator-review-independent.test.ts` içindeki `test.failing`).

## 10. Artifact şeması ve placeholder

- `docs/evidence/memory/report.schema.json` — rapor JSON şeması.
- `docs/evidence/memory/example.report.json` — **placeholder**; gerçek koşum
  değildir, alan doldurma örneğidir.
- `docs/evidence/memory/README.md` — adlandırma ve artifact kuralları.

Üretilen raporlar `docs/evidence/memory/` altına commit edilmez; temiz artifact
kökünde tutulur ve raporda yolu + SHA-256'sı belirtilir.
