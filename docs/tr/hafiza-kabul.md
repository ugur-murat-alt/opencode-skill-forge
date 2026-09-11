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

## 6. Sonraki M'ler için doğrulama başlıkları

- **M02 (#35) dayanıklı kayıt:** ACK öncesi/sonrası ve dosya-DB-indeks arası
  süreç öldürme; spool teslimi; watcher kaçıran turda bounded tarama; tombstone
  replay; CAS yarışı. Kanıt: gerçek crash child + yeniden başlatma logu.
- **M03 (#36) retrieval/context:** 1.000/10.000 ölçekte son %2 eşleşmesi;
  kapsam sızıntısı; token zarfı ve continuation; compaction/resume delta;
  HTTP–MCP eşdeğerliği. Kanıt: benchmark raporu + gerçek HTTP/MCP çağrısı.
- **M05 (#38) native istemci:** Gerçek Codex/Claude sürüm + olay matrisi;
  offline spool; interrupt'ta alınmamış son olayın uydurulmaması.
- **M06 (#39) otomasyon:** Tek MemoryCurator profili, dar iç araçlar, ölçülmüş
  auto-write; yanlış yazım ve yetki genişletme negatifleri.
- **M07 (#40) AGZ geçişi:** Kaynak değişmeden kimlik/sürüm/ilişki aktarımı,
  receipt ve rollback; kaynak veriye yazma yok.
- **M08 (#41) backup/restore/retention/işletim:** Aynı commit sınırında
  Markdown + işletim DB snapshot'ı; boş hedefe restore → yeniden indeks →
  aynı yetkili not/graph/bağlam; unut/purge ve eski yedekten dirilme negatifi;
  tanılama ekranı/doctor; public health'te not/tenant adı yok; kademeli açılış
  matrisi.

## 7. Artifact şeması ve placeholder

- `docs/evidence/memory/report.schema.json` — rapor JSON şeması.
- `docs/evidence/memory/example.report.json` — **placeholder**; gerçek koşum
  değildir, alan doldurma örneğidir.
- `docs/evidence/memory/README.md` — adlandırma ve artifact kuralları.

Üretilen raporlar `docs/evidence/memory/` altına commit edilmez; temiz artifact
kökünde tutulur ve raporda yolu + SHA-256'sı belirtilir.
