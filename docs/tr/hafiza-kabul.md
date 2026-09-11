# Hafıza kabul, kanıt ve benchmark rehberi

Bu belge #41 (M08) **ortak kanıt sözleşmesini**, test sınıflarını, benchmark
rotasını ve #34 (M01) için bağımsız inceleme adımlarını tanımlar. Ürün
sözleşmeleri kendi normatif yerlerinde kalır (`docs/adr/`, modül rehberleri);
burada yalnız "neyi, hangi gerçek yolla, hangi kanıtla doğruladık?" sorusunun
cevabı tutulur.

> Durum (11.09.2026): M01 (#34) bu doğrulama dalına henüz birleşmedi. Bağımsız
> kabul koşusu (`test/memory-acceptance-independent.test.ts`) bu yüzden
> **gerekçeli olarak atlanıyor**; sert kapı `MEMORY_REQUIRE_M01=1` ile
> açılır. Benchmark iskeleti ve veri kümesi kendi birim testleriyle yeşildir.
> Hiçbir ölçüm sonucu henüz üretilmemiştir.

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
FORGE_TEST_POSTGRES_URL=postgres://postgres:forge-ci-only@127.0.0.1:55433/forge_mem_verify \
  bun test test/memory-acceptance-independent.test.ts
```

## 4. M01 bağımsız kabul matrisi (#34)

Test dosyası: `test/memory-acceptance-independent.test.ts` (çekirdek ajanın
dosya adlarıyla çakışmaz). Public API sözleşmesi: `JobScope`, `accept(scope)`
veya eski `projectId`, `Run.project_id/scope_kind/scope_key`, `MemoryService`
(`ensureSpace`, `authorizeSpace`, `recordEvent`, `reconcile`) ve
`src/domain/memory.ts` parse/serialize/hash davranışları.

| #   | Senaryo                                                            | Test                         | Şimdi   |
| --- | ------------------------------------------------------------------ | ---------------------------- | ------- |
| 1   | memory kind tanımları `skillProfile:false`                         | yüzey çözümü                 | atlandı |
| 2   | Kişisel/proje/organizasyon accept + Run alanları                   | kapsam matrisi (SQLite + PG) | atlandı |
| 3   | Aynı anahtar aynı hash duplicate, farklı hash 409                  | idempotency                  | atlandı |
| 4   | Evolution kapalı: hafıza geçer, skill kapısı korunur               | evolution kapalı             | atlandı |
| 5   | Gerçek worker + handler + audit + idempotent receipt               | worker zinciri               | atlandı |
| 6   | `ensureSpace` kararlılığı, `authorizeSpace` redleri, `recordEvent` | MemoryService sözleşmesi     | atlandı |
| 7   | Yetki sahteciliği ve tenant izolasyonu                             | negatifler                   | atlandı |
| 8   | Round-trip + revision-dışı hash                                    | domain sözleşmesi            | atlandı |
| 9   | Gelecek format reddi                                               | domain sözleşmesi            | atlandı |
| 10  | Supersession döngüsü reddi                                         | domain sözleşmesi            | atlandı |
| 11  | Wikilink belirsizliği rastgele çözülmez                            | domain sözleşmesi            | atlandı |

Komutlar ve beklenen:

```bash
# Bu dalda (M01 yok): 0 pass, 12 skip, 0 fail; her skip gerekçeli.
bun test test/memory-acceptance-independent.test.ts

# M01 birleştikten sonra CI'da zorunlu sert kapı: eksik yüzey = kırmızı.
MEMORY_REQUIRE_M01=1 bun test test/memory-acceptance-independent.test.ts

# PostgreSQL hücresi paylaşılan doğrulama sunucusunda (konteyner durdurulmaz):
FORGE_TEST_POSTGRES_URL=postgres://postgres:forge-ci-only@127.0.0.1:55433/forge_mem_verify \
  bun test test/memory-acceptance-independent.test.ts
```

**Şu an çalıştırılamayanlar:** 2–11 arası gerçek koşum (M01 modülleri yok); PG
hücresi de aynı nedenle atlanır. Bu maddeler kanıtlanmış sayılmaz.
`MEMORY_REQUIRE_M01=1` koşusunun kırmızı olması beklenir ve doğru davranıştır.

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
6. **Eski regresyonu doğrula:** `bun test test/jobs-contract.test.ts`
   `skill_evolve` zorunlu proje, idempotency, fencing ve audit davranışını
   korumalı; `bun test test/job-kinds-contract.test.ts` yeşil kalmalı.
7. **Kanıtı topla:** Aşağıdaki alanlarla `docs/evidence/memory/` şemasına uyan
   bir JSON üret; üretilen raporu commit etme, artifact yolunu ve SHA-256'sını
   kaydet.

| Alan              | #34 için beklenen                                                        |
| ----------------- | ------------------------------------------------------------------------ |
| Gerçek giriş yolu | `JobQueue.accept` → `ForgeWorker` → memory handler (HTTP/MCP değil)      |
| Komut             | Bölüm 4'teki üç komut + `bun test test/benchmarks/`                      |
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
