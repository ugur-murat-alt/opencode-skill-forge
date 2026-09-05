# Skill Forge MCP — Uçtan Uca Uygulama Planı

**Durum:** Uygulama bekliyor; bu dosyanın oluşturulması ürünün tamamlandığı anlamına gelmez.  
**Hazırlanma tarihi:** 5 Eylül 2026  
**Depo:** `ugur-murat-alt/opencode-skill-forge`  
**İncelenen başlangıç:** `main`, commit `ed4c4b42b198ab8ae1088847e1b6ea0aa38ee048`, paket sürümü `0.5.6`  
**Plan kimliği:** `skill-forge-mcp-v1`  
**Hedef istemciler:** Claude Code, Codex, ChatGPT App  
**Dil:** Kullanıcı arayüzü ve ana dokümantasyon Türkçe; kod, API ve olay adları ekosistemle uyumlu İngilizce.

> Bu belge bir fikir listesi veya yeniden planlama görevi değildir. Uygulayıcı ajan, mevcut depoyu bu sözleşmeye göre çalışan ürüne dönüştürür. Kapsamın tamamı; kod, veri geçişi, kullanıcı arayüzü, istemci kurulumu, testler, benchmarklar, paketleme ve işletim belgelerini içerir.

## 0. Uygulayıcı için çalışma sözleşmesi

1. Önce mevcut `AGENTS.md`, bu plan, ilgili kaynaklar ve testler okunur. Başlangıç commit'inden sonraki kullanıcı değişiklikleri korunur. Dosyanın mevcut durumundan devam edilir; tamamlanmış işler tekrar yapılmaz.
2. P01–P16 iş paketleri bağımlılık sırasıyla uygulanır. Araştırma ve plan güncelleme yalnız uygulamanın gerektirdiği kadar yapılır; teslimat yerine yeni bir plan veya iskelet bırakılmaz.
3. Kapsam içindeki hata, eksik, uyumsuzluk, performans sorunu ve kullanım engeli kök nedeninden çözülür. Rutin mühendislik kararları için sürekli kullanıcı onayı beklenmez.
4. Gerekli bir teknik karar değişirse veya kapsam dışına çıkmadan hedef sağlanamıyorsa önce bu dosyanın ilgili bölümü ve değişiklik kaydı güncellenir: kanıt, gerekçe, kapsam etkisi, etkilenen işler ve kabul testleri yazılır. Sonra uygulama ve testler birlikte değiştirilir.
5. Plan değişikliği; kullanıcı gereksinimini silmek, işi sonraya atmak, başarısız testi kaldırmak, kalite eşiğini sonucu geçirecek biçimde düşürmek veya yeni ilgisiz ürünler eklemek için kullanılamaz. Temel ürün hedefleri korunur.
6. İşaretlenen her tamamlanmış işin kod/test/rapor kanıtı bulunur. Mock test, canlı istemci testi diye; kuyruk kabulü, tamamlanmış geliştirme diye; araç yüklenmesi, fayda diye sunulmaz.
7. Test, derleme, paketleme ve gerçek kullanım kontrollerinde çıkan sorunlar düzeltilir; ardından kontroller yeniden çalıştırılır. İşleyen mevcut davranışlar korunur; bilerek değiştirilen sözleşmeler test ve belgeleriyle birlikte taşınır.
8. Kimlik bilgisi, sağlayıcı kotası, hesap erişimi veya desteklenmeyen istemci özelliği gibi gerçek dış engeller saklanmaz. Ajan erişilebilir bütün işleri tamamlar, güvenli alternatifleri dener ve engeli kanıtıyla kaydeder. Doğrulanamayan kabul ölçütü tamamlandı işaretlenmez.
9. Bu plan bir API anahtarı satın alma, ücretli abonelik açma, kullanıcı verilerini silme, üretim hesabına dağıtım veya kamuya paket yayımlama yetkisi değildir. Gerekli paket ve dağıtım akışı hazırlanır; gerçek harcama ve yayın mevcut kullanıcı yetkileri/politikalarıyla yürütülür.
10. Tamamlanma hedefi P16'dır. Yalnız MCP'nin bağlanması, bir demo ekranının açılması veya testlerin dar bir bölümünün geçmesi teslim değildir.

**İlerleme kaydı:** Her P iş paketinde durum, ilgili commit/dosyalar, çalıştırılan komutlar, sonuç ve açık engeller tutulur. Ayrı ve çelişen yol haritaları oluşturulmaz. Uzun test çıktıları `docs/evidence/` altında özet/manifest ile ilişkilendirilir; hassas ham veriler Git'e eklenmez.

## 1. Ürün hedefi ve değiştirilmeyecek gereksinimler

Skill Forge; kendi model bağlantısı, oturumları ve sınırlı ajan döngüsü olan, eklentisiz kullanılan bir MCP servisidir. Ana ajan doğrulanmış deneyimi son handoff çağrısıyla teslim eder; bağımsız SPR işi tamamlar. Aynı çalıştırıcı Prompt Editor tarafından da kullanılır. Skill'ler standart dosya paketleri olarak saklanır ve ihtiyaç kadar yüklenir. Yerel kurulum ile çok kullanıcılı sunucu aynı iş kurallarını çalıştırır.

| ID | Gereksinim | Uygulama karşılığı | Kabul kanıtı |
|---|---|---|---|
| G01 | Ana ajan son handoff'tan sonra kapanabilir; SPR bağımsız bitirir | Kalıcı kabul, bağımsız servis/işçi, uygulama oturumu | K01–K04, P04/P09 |
| G02 | Skill yalnız `SKILL.md` değildir | Referans, script, asset, bağımlılık ve test içeren sürümlü paket | K05–K08, P05/P06 |
| G03 | Hazır SDK, az token/tur, ortak ajan altyapısı | Pi tabanlı tek `ForgeRunner`, iki görev profili | K09–K11, P04/P08 |
| G04 | Rutin onay yok; 1–1000 kullanıcıda izolasyon ve çakışma yönetimi | Önceden tanımlı politika, adil kuyruk, CAS ve fencing | K03/K04/K12/K13, P03/P05/P13 |
| G05 | OpenRouter, Ollama, OpenAI, Anthropic API desteği | Sağlayıcı adaptörü, yetenek kontrolü, hesap/bütçe ayrımı | K10/K14, P02/P04 |
| G06 | İnsan ve ajan için telemetri, log ve teşhis | Web, rapor API'si, `forge_report`, izlenebilir olaylar | K15/K16, P10/P11 |
| G07 | İlk hedefler Claude Code, Codex, ChatGPT App | Eklentisiz kurulum ve gerçek istemci senaryoları | K17–K19, P09/P12 |
| G08 | MCP katkısı gerçek görevlerde benchmark edilir | Ayrıştırılmış deneyler, sabit sürümler, holdout ve maliyet | K20/K21, P12 |
| G09 | Kullanılmayan skill raporu ve seçerek/toplu temizlik | Gözlem kapsamlı analiz, arşivleme, geri alma, silme | K22/K23, P11 |
| G10 | Bağlamı şişirmeyen arama/yükleme/alt dosya/script erişimi | Altı küçük araç; sayfalama, sürüm sabitleme, giriş şemaları | K06/K24, P07 |
| G11 | Paketler ve veriler Skill Forge'un kendi dizininde | Klasik skill klasörleri, veri dizini, DB indeksleri | K05/K25, P03/P05/P14 |
| G12 | Prompt Editor mevcut altyapıyı tekrar yazmaz | Ortak runner/model/config/telemetri; ayrı profil | K09/K11/K26, P08 |
| G13 | Proje/global ayarlar ve sahiplik doğru çalışır | Kapsam çözümleme, etkin ayar kaynağı, ACL | K12/K27, P03/P07 |
| G14 | Girişli web üzerinden tam yönetim ve kurulum durumu | Kullanıcı kimliği, proje yetkileri, cihaz eşleştirme, ekranlar | K15/K17–K19/K28, P09/P10 |

### Kapsam dışı

Yeni genel amaçlı ajan framework'ü, Pi CLI/TUI çatallaması, yeni LLM sağlayıcı yönlendiricisi, zorunlu vektör veritabanı, özel mesaj kuyruğu motoru, başlangıçtan mikroservis/Kubernetes mimarisi, tüm konuşmaları izleyen gizli kayıt sistemi ve tarayıcıya kod enjekte eden istemci müdahalesi yapılmaz. OpenCode eklentisi kalıcı adaptör olarak tutulmaz. OpenCode hedef istemci listesine eklenmez; mevcut veri ve davranışlar göç kaynağıdır.

Buradaki “eklentisiz” şartı, host'a özel çalışma zamanı eklentisini kaldırır. Yerleşik Claude/Codex ayarları, aynı ürünün stdio köprüsü ve resmî ChatGPT MCP App bağlantısı bu şartla uyumludur; eklenti iş mantığı başka isimle geri getirilmez.

## 2. Mevcut depo incelemesi ve dönüşüm haritası

Bu bölüm statik kaynak/test incelemesine dayanır. Plan hazırlanırken uygulamanın testleri, derlemesi veya canlı platform entegrasyonları çalıştırılmış kabul edilmez. Uygulamanın ilk işi başlangıç ölçümünü gerçekten almaktır.

| Mevcut dosya/alan | Doğrulanan durum | Taşıma kararı |
|---|---|---|
| `package.json` | ESM/TypeScript; Bun test/derleme; `@vaur94/opencode2-skill-forge@0.5.6`; OpenCode beta bağımlılıkları; giriş `dist/plugin.js` | Paket girişi/CLI ve bağımlılıklar yeni servise taşınır; test birikimi korunur |
| `src/index.ts` | Önce Prompt Editor kaydı, sonra korunmuş çekirdeğin `setup`; OpenCode ajan/model kaydı | Servis girişine dönüşür; OpenCode `ctx` nesnesini taklit eden kalıcı shim yazılmaz |
| `dist/skillforge-core.js` | Yaklaşık 1,49 MB korunmuş çekirdek; bakım yapılan kaynak modülleri yerine bundle kullanılıyor | Kaynak kökeni/lisansı araştırılır; davranışlar karakterizasyon testleriyle kaynak modüllere çıkarılır |
| `scripts/build-plugin.sh` | Çekirdeği yeniden üretmez; dosyanın varlığını şart koşar; Bun wrapper derler | Temiz checkout'tan bütün çalışma zamanı çıktısını üreten taşınabilir build gerekir |
| `src/spr-handoff.ts` | 4000 karakter özet; oturum/mesaj anahtarlı bellek içi tekilleştirme; `session.get` ile konum; son cevap öncesi aktarım | Kısa kanıt sözleşmesi korunur; kalıcı dedup, yetkili proje eşleme ve bağımsız kabul eklenir |
| `src/spr-handoff.ts` | Host'un `skill_manage/list/view` araçlarını bağlamdan kaldırıyor | Yeni MCP başka sunucunun/host'un araçlarını silemez; bu müdahale taşınmaz |
| `src/core-runtime.ts` | `globalThis`/`Symbol.for`, Map tabanlı sahiplik/yönlendirme ve `AsyncEventQueue` | Tek proses içi yönlendirme yerine kalıcı uygulama oturumu ve iş sahipliği kurulur |
| `src/prompt-editor/system.ts` | Niyet koruma ve bağlamı veri sayma kuralları var; `always` modunda farklı yazma/öğrenme zorunluluğu üretilebiliyor | Niyet kuralları korunur; varsayılan `when-needed`, `unchanged` ve ilgili öğrenme seçimi getirilir |
| `src/prompt-editor/agent.ts`, `runner.ts`, `editor-session.ts` | Gizli OpenCode ajanı/oturumu oluşturma ve kayıt bağımlılığı | Ortak SDK runner ile değiştirilir; salt görev mantığı tekrar yazılmaz |
| `context-snapshot.ts`, `capabilities.ts`, `workspace-context.ts` | Sınırlı bağlam ve araca/projeye dair bilgi hazırlama | Saf sanitizasyon/seçme işlevleri korunur; host veri toplama kısmı güvenilen giriş sözleşmesine ayrılır |
| `context-hook.ts`, `persist.ts`, `external.ts`, `index.ts` | Mesaj kancası, `part.update` ve OpenCode web köprüsüne özgü işlemler | Genel MCP yeteneği gibi sunulmaz; istemci destek seviyesine göre sonuç adaptörü kullanılır |
| `learn.ts`, `system.ts` | Tek global `learn.md`, dosya okuma/değiştirme ve tekrar prompta ekleme | Kullanıcı/proje/kurum kapsamlı, sürümlü ve seçici öğrenme; çok yazarlı kayıp güncelleme önlenir |
| `approval-gate.ts`, `live.ts`, `rewrites.ts`, `session-flags.ts` | UI onayı ve JSONL/dosya tabanlı yaşam döngüsü | İş olayları ve politikaya taşınır; rutin onay kapıları kaldırılır, geçmiş veri içe alınabilir |
| `SPR_SKILL_AUTHORING.md`, `spr-agent.jsonc` | create/update/no-op/reject, kapsam/aktivasyon ve kanıt kuralları; script geliştirme yasağı | Kalite ilkeleri korunur; tam paket geliştirme ve sandbox sözleşmesine uyarlanır |
| `test/security-regressions.test.ts` | Bundle export'larını enjekte ederek path, symlink, işlem ve yöneticiyi sınayan testler | Aynı tehditleri yeni kaynak API'lerine taşı; bundle bağımlılığı ancak eşdeğer kanıt sonrası çıkar |
| `test/spr-handoff.test.ts`, `test/core-runtime.test.ts` | Tekilleştirme, kaynak oturum ayrımı, temizlik ve sahiplik senaryoları | Host bağımlı assertion'lar yeniden eşlenir; yeni süreçler arası/çökme testleri eklenir |
| `test/prompt-editor/`, `test/spr-authoring-policy.test.ts` | Prompt ve politika regresyon tabanı | Korunan/değişen gereksinim matrisiyle yeni sözleşmeye taşınır; topluca silinmez |
| `dist/bin/skill-fs-helper-linux-x64` | Linux x64'e özel mevcut yardımcı artifact | Kaynağı ve kullanımını doğrula; Windows/macOS desteğini var sayma; yeni dosya katmanı için gerçek platform testleri |
| `AGENTS.md` | Çekirdeği değiştirmeme, eski araçlar ve script yasağı normatif | P01'de yeni kullanıcı hedefleriyle güncellenir; eski yasak ile yeni plan aynı anda normatif bırakılmaz |

### Yeniden kullanım sınırı

Niyet koruma, sanitizasyon, bounded context, kapsam ayrımı, no-op/reject, yol güvenliği, işlem/geri alma ve test verileri korunacak adaylardır. Bundle'ın bütün iç yapısı yeni mimari diye kopyalanmaz. Kaynak geri kazanımı mümkün değilse yalnız gerekli domain davranışları, okunan sözleşme ve karakterizasyon testleriyle modüler kaynaklara çıkarılır. Lisans/atıf korunur; okunmayan bundle davranışı biliniyormuş gibi kabul edilmez.

Eski sürüm davranış tablosu oluşturulur: `preserve`, `replace`, `remove`, `migrate`. Bilerek kaldırılacak davranışlar özellikle şunlardır: zorunlu farklı prompt, her işten zorunlu öğrenme, paylaşılan global kullanıcı bağlamı, host araçlarını gizleme, scriptleri kategorik yasaklama ve rutin onay bekleme.

## 3. Mimari kararlar

### 3.1 Tek ürün, ortak uygulama servisleri

```text
Claude Code / Codex / ChatGPT App
                 |
       MCP: stdio köprüsü / HTTP
                 |
       Kimlik + kapsam + sözleşme
                 |
   Arama | Yükleme | Çalıştırma | Prepare | Handoff | Rapor
                 |
   Uygulama servisleri / politikalar / sürüm yöneticisi
       |                 |                  |
 Ortak ForgeRunner   Paket deposu        İş kuyruğu
  skill_evolve       indeks/sürümler     kalıcı oturum
  prompt_edit            |                  |
       +------------- SQLite / PostgreSQL --+
                 |
       HTTP API + girişli web + olay akışı
```

Web, MCP ve iç ajan aynı uygulama servislerini kullanır. Web editörü ayrı bir dosya yazıcısı, Prompt Editor ayrı model sistemi ve raporlama ayrı yetkilendirme yolu oluşturmaz.

### 3.2 Teknoloji seçimi

- **Dil:** TypeScript/ESM. Yeni Rust/Python ana servis yazılmaz. Mevcut Bun testleri korunur; dağıtım çalışma zamanı desteklenen Node LTS üzerinde doğrulanır. Sürümler P02'de sabitlenir; taşınabilir olmayan kabuk betikleri ürün başlatma şartı yapılmaz.
- **MCP:** Resmî TypeScript SDK. İnceleme tarihinde v2 kararlı hat olarak belgeleniyor; gerçek istemci uyumluluğu sabitlenmiş sürümlerle test edilir. İstemci desteği olmayan uzantılar çekirdek işlevin ön koşulu yapılmaz. [S01]
- **Ajan/model:** `@earendil-works/pi-agent-core` ve `@earendil-works/pi-ai`; bütün Pi CLI/TUI değil. Pi'nin sağladığı döngü/sağlayıcı arayüzleri kullanılır, izin ve sandbox sınırları Skill Forge'a aittir. [S02][S03]
- **HTTP:** Fastify ve aynı kimlik/politika katmanını kullanan MCP/REST yönlendirmesi. Gerekmeyen ikinci backend framework'ü eklenmez.
- **Veri:** Yerelde SQLite, ortak sunucuda PostgreSQL. İnce repository arayüzleri ve gerçek iki-backend sözleşme testleri; genel amaçlı ORM yazılmaz. Hazır migration/SQL aracı P02'de seçilip kilitlenir.
- **Kuyruk:** Sunucuda pg-boss; yerelde küçük bir SQLite kalıcı job/lease adaptörü. Yerel adaptör yeni genel kuyruk ürünü değildir. Aynı kabul/dedup/retry testleri iki adaptörde de çalışır. [S04]
- **Web:** React + Vite; mevcut bileşen/tablo/kod editörü kütüphaneleri kullanılır. Gereksiz SSR veya ayrı UI sunucusu üretim şartı yapılmaz.
- **Kimlik:** Sunucuda mevcut OIDC/OAuth çözümü ve bakımlı istemci kütüphanesi; özel parola/kripto protokolü yazılmaz. Yerelde sahip kullanıcıya bağlı güvenli ilk kurulum/eşleştirme oturumu bulunur.
- **Test:** Mevcut Bun birim testleri; HTTP/MCP integration; web için Playwright; karşılaştırma için Promptfoo veya aynı işi karşılayan mevcut bir harness. Tek benchmark motoru seçilir. [S11]

SDK değişikliği ancak gerçek uyumsuzluk/kalite/maliyet kanıtıyla bu plana işlenir. Aynı anda Pi, LangGraph ve birden fazla Agents SDK'yı üst üste koyma. OpenAI/Anthropic API desteği, her biri için ayrı ajan framework'ü gerektirmez.

### 3.3 Hedef kaynak düzeni

```text
src/
  cli/                 serve, worker, mcp, install, doctor, migrate, backup
  domain/              skill/run/proje sözleşmeleri ve saf kurallar
  application/         ortak kullanım senaryoları
  runner/              Pi bağlantısı, profiller, bütçe ve araç yürütme
  storage/             SQLite/PostgreSQL, migration, paket deposu
  jobs/                kalıcı kabul, lease, dedup, scheduler
  skills/              arama, paket doğrulama, sürüm ve yayın
  execution/           script girişleri ve sandbox adapter
  prompt-editor/       yeniden kullanılan niyet/bağlam kodu ve yeni profil
  mcp/                 altı araç ve transport
  http/                web API, auth, olay akışı
  integrations/        claude-code, codex, chatgpt; yalnız kurulum/format
  telemetry/           olaylar, kullanım/maliyet, redaksiyon
web/                   girişli yönetim arayüzü
prompts/               kısa skill-evolve ve prompt-edit sistem metinleri
test/                  eski testlerin taşındığı ve yeni testlerin eklendiği alan
benchmarks/            görevler, koşucular, graders, sonuç şemaları
docs/                  Türkçe kurulum, işletim, mimari, kanıt manifestleri
scripts/               taşınabilir build/verify/pack yardımcıları
```

Bu ağaç modül sorumluluğunu tanımlar; sırf ağaçla eşleşsin diye boş klasörler/paketler açılmaz. Var olan saf modül doğru yerdeyse taşınmadan kullanılabilir; değişiklik plana kaydedilir.

## 4. Dış MCP sözleşmesi: altı araç

Bütün araçlarda kimlik bağlantıdan çözülür. Modelden gelen `tenant_id`, kullanıcı adı veya `agent: spr` yetki kanıtı değildir. `project_ref` yetkili proje bağlamına çözülür. Bilinmeyen proje/global kapsam sessizce varsayılmaz. Girdi/çıktı şemaları tek kaynaktan üretilir, istemcilerin desteklediği JSON Schema alt kümesiyle doğrulanır.

| Araç | Asgari girdi | Asgari çıktı | Yan etki |
|---|---|---|---|
| `forge_search` | query, project_ref, isteğe bağlı scope/cursor/limit | skill_id, scope, kısa description, revision, uygunluk/kısa gerekçe, next_cursor | İş verisi değiştirmez |
| `forge_load` | skill_id, revision veya yetkili latest, isteğe bağlı files/range/cursor | SKILL içeriği veya seçilen dosyalar; sürüm, manifest özeti, çağrılabilir girişler, truncation | İş verisi değiştirmez |
| `forge_run` | skill_id, revision, entrypoint, şemalı arguments, execution_target, idempotency_key | execution_id, durum, sınırlı stdout/stderr/sonuç, artifact referansları | Manifest/politika kapsamındaki script etkisi |
| `forge_prepare` | özgün metin, sınırlı bağlam, project_ref, istemci/mesaj ilişkisi, format | run_id, original_hash, improved/unchanged/fallback durumu, hazırlanmış metin, uyarılar, skill adayları | Prompt iş kaydı; skill yayınlamaz |
| `forge_handoff` | kısa kanıt özeti, project_ref, idempotency_key, kaynak metadata, isteğe bağlı skill/evidence referansları | accepted/duplicate/rejected, run_id, tekrar bilgisi | Kalıcı inceleme işi |
| `forge_report` | report_type, yetkili scope/run/skill filtreleri, zaman/pagination | Filtrelenmiş metrik/iş/hata/benchmark/bakım özeti ve artifact referansları | Salt okunur rapor |

### Ortak kurallar

- Ayrı `list_refs`, `read_script`, `get_job`, `delete_skill` gibi her işlem için yeni model aracı eklenmez. Listeleme ihtiyacı filtreli boş/isteğe bağlı sorgu davranışıyla `forge_search` içinde belgelenir; sıralı envanter ve anlamsal arama karıştırılmaz.
- Arşiv/silme, kullanıcı yönetimi, kurulum değiştirme ve benchmark başlatma web/CLI/REST üzerindedir. `forge_report` okuma aracı kalır. Sonradan yeni araç ancak ölçülmüş ihtiyaç ve plan değişikliğiyle eklenir.
- `readOnlyHint`, `destructiveHint`, `openWorldHint` ve idempotence açıklamaları gerçek davranışa göre tanımlanır. Model API'sine veri gönderen veya script çalıştıran araç salt okunurmış gibi sunulmaz. İstemci onayını azaltmak için yanlış metadata verilmez. [S10]
- Her sonuç anlaşılır hata kodu, correlation/run kimliği ve gerekiyorsa retry_after taşır. Yetkisiz nesnenin varlığı sızdırılmaz. `isError`/iş sonucu ayrımı SDK sözleşmesine uygun olur.
- Büyük dosya/çıktı açıkça sınırlanır; `truncated`, devam cursor'u ve tam artifact'e yetkili erişim döner. Sessiz kesme ile tam içerik okunmuş gibi gösterilmez.
- `forge_load` seçilen sürümün referanslarını ve script girişlerinin ad/amaç/girdi şemasını verir. Ajan scripti çalıştırmak için bütün kaynak kodunu bağlama almak zorunda kalmaz.
- Alt dosyalar aynı `forge_load` ile toplu ve aralıklı okunabilir. Cursor; kullanıcı kapsamı, skill, revision ve dosyaya bağlıdır. Başka sürüme/kuruma taşınamaz.
- `forge_run` genel shell aracı değildir. Çalıştırılabilir giriş, paket manifestinde kayıtlı ve ilgili sürüme bağlıdır.
- İç ajan yalnız ihtiyaç duyduğu read/patch/test/finish yeteneklerini alır. İç dosya yazım araçları dış model araç listesini büyütmez; uygulama servislerini kullanır.

### Bağlam bütçesi başlangıçları

Arama varsayılanı 5 sonuç; hard üst sınır 20. Yükleme varsayılanı 4000 çıktı tokenı eşdeğeri; toplu okumada dosya/byte sınırı ayrıca vardır. Handoff özeti başlangıçta 4000 Unicode karakterle sınırlıdır; toplam istek için ayrı byte sınırı uygulanır. Bütün katalog ilk mesajda yüklenmez. Araç şemaları ve sabit bootstrap metni için toplam token maliyeti kaydedilir; ilk hedef yaklaşık 2500 tokenı aşmamaktır. Bunlar ölçülecek tasarım bütçeleridir, mevcut performans iddiası değildir.

## 5. Skill keşfi ve içerik yükleme

Resmî belgeler Claude Code ile ChatGPT/Codex için ad/açıklama üzerinden keşif ve ihtiyaçta tam içerik yükleme yaklaşımını açıklıyor. Skill Forge deposu host'un kendi skill klasörü değildir; sırf dosya yazıldı diye host tarafından keşfedildiği varsayılmaz. [S05][S06]

1. MCP araçları ve kısa sunucu talimatı Skill Forge'u tanıtır. İlk 512 karakter kendi başına anlaşılır olur; bütün kullanım el kitabı burada taşınmaz. [S07]
2. Claude/Codex kurulumu, mevcut kullanıcı talimatlarına çarpmayan küçük yönetilen bölümle arama/yükleme ve son handoff kuralını ekler. Bütün skill kütüphanesi istemci dizinlerine kopyalanmaz.
3. `forge_prepare`, zaten çalışıyorsa aynı istekte ilgili skill metadata adaylarını hesaplayabilir. Bu, otomatik ayrı `forge_search` çağrısını gereksiz kılabilir; bütün içerik zorunlu eklenmez.
4. Arama önce ACL/kapsamla filtrelenmiş metin indeksi ve etiketlerle yapılır. Türkçe/İngilizce yazım, casing ve kod terimleri test edilir. Embedding ancak kaçırılan örnekler faydasını kanıtlarsa eklenir; ilk sürüm şartı değildir.
5. Seçimden sonra `forge_load` bir revision döndürür. Referanslar, scriptler ve testler aynı revision'a sabitlenir. Devam eden iş aktif skill güncellendiğinde sessizce sürüm değiştirmez.
6. Aynı isimli proje/global skill'ler kaynaklarıyla gösterilir. Örtük gölgeleme yerine açık effective-scope politikası ve override kaydı vardır. Belirsiz çakışmada arama kullanıcı/ajana seçenekleri ayırt eder; yanlış paketi kullanmaz.
7. Native skill özelliği olmayan istemci için bu altı araç yeterli olur. Yeni Skills-over-MCP uzantıları desteklendikçe aynı domain servisine adaptör olabilir; yayınlanmamış veya istemcide uygulanmamış uzantı zorunlu kabul edilmez.

İçeriği okumak script çalıştırmaz; Markdown içindeki gömülü komutlar/uzak referanslar otomatik yürütülmez. Skill metni yetki yükseltemez.

## 6. Kalıcı handoff, oturum ve iş yaşam döngüsü

### 6.1 Kimlikler ve durumlar

`client_session_id`/`client_message_id` kaynak ilişkisidir; istemci sağlamıyorsa bilinmiyor kalır. `forge_session_id` uygulama oturumudur. `run_id` tek iş, `attempt_id` yürütme denemesi, `revision_id` paket sürümüdür. Kimliği bilmek yetki vermez.

```text
validated -> accepted -> queued -> running -> validating -> publishing
                                                |              |
                                                +-> no_op       +-> completed
                                                +-> rejected
technical failure -> retry_wait -> running -> failed
explicit stop -> cancelled
newer merged work supersedes old work -> superseded
```

Prompt işleri daha kısa aynı altyapıyı kullanır: `accepted -> running -> improved | unchanged | fallback | cancelled`. Modelin semantik reject/no-op sonucu ile altyapı hatası ayrı kodlanır.

### 6.2 Kabulün dayanıklılığı

- Yetki, proje, payload sınırları ve politika kabulden önce kontrol edilir. Gelen summary/kanıt/metadata güvenilmeyen veridir.
- İş kaydı, dedup anahtarı ve kuyruk teslim yükümlülüğü kalıcılaşmadan `accepted` dönmez. pg-boss ile ortak DB işlemi sürümde doğrulanır; uygun değilse küçük bir transactional outbox kullanılır. Kayıt ile kuyruğa ekleme arasındaki çökme işi kaybettiremez.
- Aynı yetkili kaynak isteğinin tekrarında aynı run döner. Ağ cevabı kaybolup istemci tekrar ettiğinde ikinci geliştirme oluşmaz.
- Güvenilir mesaj kimliği olmayan istemcide kısa ömürlü kapsamlı fingerprint yardımcı olabilir; aynı metinli iki gerçek görevi sonsuza kadar aynı iş sayma. Dedup güvence seviyesi telemetride belirtilir.
- Ana istemci yalnız kabulü bekler. Kabul sonrası bağlantı kapanması job iptali değildir. Web'den açık iptal, yetki kaldırılması veya servis politikası ayrıdır.
- Handoff için final cevap kopyası, gizli muhakeme, tam sohbet ve ham tool dump gönderilmez. Yapılmış doğrulama ile yalnız ajanın iddiası ayrılır. Kanıt referansları kaybolacaksa izinli içerik kabul sırasında sabitlenir.
- `source_model` teşhis bilgisidir; iç model/anahtar seçimini modelin keyfî girdisi belirlemez. Politikanın seçtiği model ve ayar sürümü işte saklanır.

### 6.3 Çalıştırma, tekrar ve kurtarma

İşçi lease/heartbeat ve artan fencing numarasıyla sahiplik alır. Lease bitip yeni işçiye geçildiyse eski işçi yayın yapamaz. DB işlemi LLM veya script çağrısı boyunca açık tutulmaz. Süre aşımı/429/geçici ağ hatası sınırlı retry/backoff ile ele alınır; bütçe bütün denemeleri kapsar.

Kuyruk en az bir kez teslim edebilir; yayın ve yönetilen iş etkileri tekilleştirilir. Dış model çağrısının ücretinin bütün çökme noktalarında tam bir kez oluşacağı iddia edilmez. Belirsiz dış yan etkili scriptler körlemesine yeniden denenmez; script sözleşmesi/idempotence politikası uygulanır.

Aynı skill'e gelen birbirini tekrar eden kanıtlar kısa pencerede birleştirilebilir. Birleştirme yetki kapsamını aşmaz, çelişkileri silmez ve her kaynağın run ilişkisini korur. Ana oturum yeniden okunmaz veya çalıştırılmaz. SPR ve Prompt Editor çıktıları kendilerini tekrar tetikleyemez; çalışma türü/provenance sunucu tarafından atanır.

### 6.4 Adil kapasite

Prompt işleri etkileşimli, SPR/bakım/benchmark işleri arka plan sınıfıdır. Ayrı sınırlamalar ve adil zamanlama vardır; uzun testler kullanıcı mesajını bekletmez, sürekli öncelikli trafik arka planı sonsuza kadar aç bırakmaz. Kullanıcı, proje, tenant ve sağlayıcı başına eşzamanlılık/bütçe sınırları uygulanır. Kuyruk dolduğunda kabul etmeden anlaşılır retry_after verilir; kabul edilmiş iş sessizce atılmaz.

## 7. Skill paket deposu, sürümleme ve güvenli yayın

### 7.1 Dizin sözleşmesi

Tek yapılandırılabilir `SKILL_FORGE_DATA_DIR` kullanılır; OS'nin kullanıcı veri dizini varsayılandır. Repo checkout'u, çalışma dizini veya eski `.opencode` ağacı varsayılan yeni veri deposu değildir.

```text
<data-dir>/
  config/
  local.sqlite                    # yalnız yerel profil
  tenants/<tenant-id>/
    packages/<scope-key>/<skill-id>/revisions/<revision>/<skill-name>/
      SKILL.md
      references/                 # gerekiyorsa
      scripts/                    # gerekiyorsa
      assets/                     # gerekiyorsa
      tests/                      # gerekiyorsa
      forge.json                  # yalnız çalıştırma metadata'sı gerekiyorsa
    staging/<run-id>/
    run-artifacts/<run-id>/
    telemetry/
    benchmarks/
  backups/
```

Her revision içindeki `<skill-name>/` tek başına dışarı aktarılabilir klasik pakettir. Frontmatter adı/klasör uyumu korunur. Veritabanı aktif revision, metadata, ACL, işler ve indeksleri tutar; skill içeriğinin tek sahibi DB blob'u olmaz. `forge.json` küçük bir giriş/çalıştırma manifestidir, yeni skill formatı veya workflow dili değildir. Tamamı Markdown olan skill için zorunlu olmaz.

### 7.2 Paket doğrulama

Frontmatter/isim/description; relative linkler; dosya envanteri/hash; aynı skill'in sorumluluk sınırı; script girişleri, çalışma ortamı, input/output şemaları ve test kanıtları doğrulanır. Gereksiz şablon dosyalar üretilmez. Uzun bilgi referanslara ayrılır; tek kural birden fazla dosyada kopyalanmaz. Genel Agent Skills paket yapısı korunur. [S08]

Unicode, case-insensitive dosya sistemleri, Windows ayrılmış adları, `..`, mutlak yollar, separator farklılıkları, symlink/hardlink yönlendirmeleri ve arşiv çıkartma yolları test edilir. Tarama anı ile kullanım anı arasında dosya değişmesi göz ardı edilmez. İçe aktarılan paketler boyut/dosya sayısı/zip-bomb sınırından geçer. Paket okunurken URL veya script otomatik çalıştırılmaz.

### 7.3 Yayın işlemi

1. Kanonik hedef, kapsam, yönetim hakkı ve `base_revision` belirlenir.
2. İş sadece kendi staging kopyasına yazar; mevcut dosya değişmeden önce ilgili içerik okunur.
3. Paket doğrulanır, gerekli testler çalışır, içerik hash'i/manifest sabitlenir.
4. Tam revision dizini yazılır ve dayanıklılık işlemleri tamamlanır. Yarım paket aktifleşmez.
5. Kısa DB işlemi; yetkiyi tekrar kontrol eder, fencing ve `base_revision` eşleşmesini sınar, aktif işaretçiyi compare-and-swap ile değiştirir ve yayın olayını kaydeder.
6. İndeks/önbellek revision anahtarıyla yenilenir. Sonuç run kaydına bağlanır.

Dosya sistemi ve DB'nin tek atomik işlem olduğu varsayılmaz. Çökme sonrası reconciliation; sahipsiz staging, DB'de henüz aktif olmayan tam revision ve eksik yayın durumlarını güvenli biçimde ele alır. Eski sürüm hâlâ okunabiliyorsa yeni aday hatasında etkilenmez.

Aynı skill'e bir ajan/insan yazarken ikinci yazarın verisi sessizce ezilmez. Çakışmayan diff yeniden uygulanıp test edilir; anlamlı çakışmada sınırlı yeniden değerlendirme yapılır. Sürekli çakışan işler birleştirilir/superseded olur; sonsuz retry veya zorunlu onay kuyruğu kurulmaz.

Yatay işçiler birbirinden bağımsız değiştirilebilir skill depoları kullanamaz. İlk sunucu dağıtımı tek paket yayın otoritesi/paylaşılan dayanıklı volume kullanır. Çok düğümlü çalışmada aynı yayın protokolü ve immutable revision erişimi sağlanmadan destek iddiası yapılmaz.

## 8. Script ve yardımcı araç geliştirme/çalıştırma

SPR; Markdown, Python, JavaScript/TypeScript, gerekli kabuk betikleri, şablonlar, fixture ve testleri paket sınırında oluşturabilir/güncelleyebilir. Mevcut kategorik script yasağı kalkar; onun yerine aşağıdaki somut denetim gelir.

- İlk doğrulanmış çalıştırma yolları Python ve Node.js/TypeScript'tir. Diğer runtime'lar manifest üzerinden ancak mevcut adapter ve platform desteği varsa çalışır; destek yoksa `runtime_unavailable` döner. Çalışmamış runtime destekleniyor diye listelenmez.
- Scriptler kayıtlı entrypoint ve JSON şemalı argümanlarla çalışır. String birleştirerek shell komutu kurulmaz; mümkün olduğunda argv/spawn kullanılır.
- Çalışma alanı ayrı, kaynak paket salt okunur, çıktı dizini sınırlıdır. CPU, bellek, süre, çıktı boyutu ve process-tree iptali uygulanır.
- API anahtarları, DB parolaları ve servis ortamı script environment'ına miras verilmez. Yalnız izinli girişler ve gereken kısa ömürlü, dar kapsamlı erişim sağlanır.
- Sunucuda untrusted script için container/uygun sandbox zorunludur; Pi kendi başına sandbox değildir. Docker socket'i veya host kökü sandbox'a verilmez. İzolasyon yoksa iş sandbox-unavailable olarak görünür; host üzerinde sessiz fallback olmaz.
- Bağımlılıklar mevcut paket yöneticileriyle, kilit/hashi sabit sürümlerle kurulur. Kurulum ağı ayrı politikadadır; keyfî lifecycle script ve download gizlenmez. Bağımlılık önbelleği lock/runtime/platform ve güven kapsamıyla anahtarlanır.
- Üretim script ağı varsayılan kapalıdır; gereken hedefler kurulum/proje profilinde bir kez tanımlanır. Her normal çağrıda onay isteme; sınır dışı istek otomatik reddedilir ve gerekçesi görünür.
- Runtime testleri sözdizimiyle sınırlı değildir: örnek girdi/çıktı, hata dönüşü, timeout, bağımlılık eksikliği, idempotence ve iş etkisi sınanır. Çıktı şeması doğrulanır.
- Script hangi bilgisayarda çalışacağını belirtir: sunucu çalışma alanı, aktarılmış artifact veya eşleştirilmiş yerel servis. Uzak sunucu kullanıcı diskinin yoluna kendiliğinden erişemez.
- Kullanıcı projesine yazan girişler izinli workspace ve beklenen dosya/sürüm kontrolü kullanır. Paket geliştirme ile asıl proje üzerinde iş yapma birbirine karışmaz.

Kaynağın incelenmesi, test edilmesi, sürümle bağlanması ve rollback; script dosyasını yalnız üretmiş olmaktan ayrı kabul ölçütleridir.

## 9. Ortak ajan döngüsü ve Prompt Editor

### 9.1 Runner sözleşmesi

`ForgeRunner` girdisi: profil, yetkili kapsam, model profili, değişmez başlangıç bağlamı, araçlar, deadline ve token/maliyet bütçesi. Çıktısı: semantik sonuç, aday/artifact referansları, doğrulama raporu ve ölçümler. Bir işin konuşması başka kullanıcıya ait Agent nesnesinde devam ettirilmez.

Pi'nin olay/araç arayüzü kullanılır. Sonlandırma aracı başarılıysa gereksiz son açıklama için yeni model çağrısı yapılmaz. `terminate` gibi SDK davranışları kilitli sürüm üzerinde test edilir; paralel batch içinde bitiş aracından sonra yazım yapılamaz. Model state/checkpoint ile uygulama job durumu ayrı ama ilişkilidir. [S02]

### 9.2 Kısa sistem promptlarının içeriği

**Skill profili:** Doğrulanmış yöntemi değerlendir; mevcut kanonik sahibi bul; ilgili dosyaları oku; en küçük anlamlı paket değişikliğini yap; test/validasyon sonucuna göre create/update/no-op/reject bitir. Global/proje sınırını ve doğru eski davranışı koru. Asıl işi yeniden çözme, kullanıcıya soru zinciri açma, kanıtsız test sonucu yazma.

**Prompt profili:** Yalnız hedef kullanıcı metnini netleştir; anlam, dil, olumsuzluk, sayı, path, sürüm, kapsam ve istenen çıktı korunur. Bağlamla desteklenmeyen teknoloji/teslimat/izin ekleme. Görevi çözme. Gerekmiyorsa unchanged döndür.

Uzun `SPR_SKILL_AUTHORING.md` her model çağrısına eklenmez. Denetlenebilir el kitabı olarak kalır; çalışma promptu kısa, tekrarları azaltılmış ve test edilen bir metindir. Gereken özel referans seçilerek yüklenir.

### 9.3 Bütçe ve kalite

Başlangıç hedefleri: prompt düzenleme normalde 1 model çağrısı, doğrulanmış hata varsa en fazla 1 onarım; skill inceleme tipik 2–4 çağrı, varsayılan hard limit 6 ve bir sınırlı onarım turu. Script/test süre bütçesi ayrıca vardır. İleri görevler için sınırlar yapılandırılabilir; her değişiklik maliyet/kalite benchmarkıyla gerekçelendirilir. Sınır dolduğunda yarım paketi yayınlamak yerine önceki sürüm korunur.

LLM'ye ait kalite kararı kesin doğruluk kanıtı sayılmaz. Path/schema/hash gibi kurallar kodla, davranış testleri araçla, niyet/aktivasyon gibi ölçümler değerlendirme setiyle sınanır. Varsayılan ikinci/üçüncü eleştirmen ajan yoktur. Arama, rapor toplama ve tekrar denetimi mümkün olduğunda LLM çağırmaz.

### 9.4 Prompt Editor akışı

```text
özgün istek -> güvenilir kapsam/bağlam seçimi -> hızlı skip kontrolü
           -> tek aday -> niyet/yapı kontrolleri -> gerektiğinde tek onarım
           -> improved | unchanged | needs_clarification | fallback
```

`needs_clarification`, mutlaka kullanıcıyı modal onayda bekletmek değildir: özgün belirsizlik korunur, kısa açıklama işaretlenir ve istemci politikası uygulanır. Varsayılan fail-open; model yokluğu/hata/deadline'da özgün metin değiştirilmeden devam edilir. Geç gelen sonuç artık gönderilmiş mesaja uygulanmaz.

Varsayılan `when-needed`, `autoApply=true`, öğrenme `reusable-only`. Eski `always` davranışı taşınırsa açık opt-in olur, değişiklik zorlayarak tur tüketmez. Komutlar, yalnız kontrol sinyalleri ve editör/SPR kökenli istekler yeniden düzenlenmez; `/goal` gibi komutların sözdizimi bozulmaz.

Özgün mesaj değişmez kaynak olarak saklanır; hazırlanmış sürüm ayrı revision'dır. İstemci yalnız ek bağlam destekliyorsa mesajın ekran metni değiştirilmiş gibi iddia edilmez. Metnin hash'i, istemci mesaj ilişkisi ve deadline stale sonucun yeni mesaja uygulanmasını engeller.

Konuşma bağlamı, araç yetenekleri ve workspace snapshot yalnız gerçekten sağlanan yetkili veriden alınır. MCP sunucusu diğer MCP'lerin sonuçlarını veya istemcinin tüm sohbetini görebiliyormuş gibi davranmaz. Kısa devam mesajını yorumlayacak bağlam yoksa uydurmaz.

### 9.5 Öğrenme

Tek global `learn.md` yaklaşımı kullanıcı/proje/kurum kapsamına ayrılır. Her turdan zorunlu ders yoktur. Çelişkili/eski dersler sürümlenir, birleştirilir veya kullanım dışı bırakılır. Prompta yalnız konuyla ilgili birkaç kısa kayıt eklenir. Özel proje metni global skill'e veya başka kullanıcının bağlamına taşınmaz. Prompt düzenlemesi doğrulanmış iş sonucu olmadığından doğrudan SPR kanıtı sayılmaz.

## 10. Model, token ve maliyet yönetimi

OpenRouter, Ollama, OpenAI ve Anthropic için aynı runner üzerinden bağımsız smoke/contract testleri bulunur. Model capability kaydı tool calling, JSON/şema uyumu, context, cancellation, usage ve cache alanlarını içerir. İsim benzerliğiyle uyum varsayılmaz.

- Model profilleri `prompt`, `skill`, `evaluation` için ayrılabilir; ayrı altyapı olmaz.
- Kaynak ana ajanın modeli ve iç kullanılan model ayrı kaydedilir. Birinci model erişimi ikincisine otomatik aktarılmaz.
- OpenRouter ücretsiz model listesi canlı katalogdan doğrulanır; fiyat/kota değişebilir. Ücretsiz yönlendiricinin seçtiği değişken model karşılaştırmalı benchmarkta sabit modelmiş gibi kullanılmaz. [S12]
- Ollama yerel veya izinli uzak uç nokta olabilir. Yerel servis + uzak model, tamamen yerel/gizli çalışma diye etiketlenmez. [S13]
- Ücretli fallback varsayılan kapalıdır. Kullanıcı izin vermediyse ücretsiz model hatası ücretli çağrıya dönüşmez.
- Çok kullanıcılı süreçte `process.env` kullanıcı anahtarıyla değiştirilmez. Provider çağrısı kapsamlı credential resolver kullanır; ortamdan otomatik global anahtar fallback'i sunucu profilinde kontrol altındadır.
- Base URL/URL yönlendirmeleri SSRF ve tenant sınırı açısından kontrol edilir. Yerel Ollama'ya izin verilmesi ortak sunucuda herkese keyfî iç ağ erişimi vermez.
- Çağrı öncesi bütçe rezervasyonu, sonrası ölçülmüş kullanım uzlaştırması yapılır. Eşzamanlı işler aynı son bütçeyi ayrı ayrı harcayamaz.
- Sağlayıcı usage gerçek, tahmini veya bilinmiyor olarak işaretlenir. Tokenizer tahmini faturalanmış token değildir. Cache input/output/reasoning alanlarında çift sayım yapılmaz.
- Prompt cache yalnız sağlayıcının desteklediği biçimde kullanılır. Özel kullanıcı verisi ortak cache anahtarına konulmaz. Cache/sistem prompt/model sürümü olayda tutulur.

Fiyat profilleri tarih/sürüm taşır. Eski run maliyeti yeni fiyatla sessizce yeniden yazılmaz. Ana istemci tokenı görünmüyorsa sıfır yazılmaz; toplam tasarruf bilinmiyor kalır.

## 11. Kimlik, proje ve global ayarlar

### 11.1 Yetkilendirme

Ortak sunucuda kullanıcı girişlidir; workspace/tenant üyeliği ve proje rolleri bulunur. En küçük başlangıç rolleri owner/admin, editor ve viewer'dır. Gereksiz izin matrisi ürünü büyütmez; okuma, çalışma, yayın/yönetim ve hassas ayar yetkileri açıkça ayrılır.

OIDC/OAuth callback, state/PKCE, token audience/scope, expiration ve revocation mevcut kütüphanelerle doğrulanır. ChatGPT için korumalı resource metadata ve resmî bağlantı akışı sağlanır. Tarayıcıda provider anahtarı tutulmaz. Cookie oturumunda CSRF, origin, güvenli cookie ve çıkış/iptal davranışı test edilir. [S09]

Yerel profilde de kimliği belli sahip oturumu vardır: bir defalık kurulum/eşleştirme sırrı ile cihaz sahibine giriş sağlanabilir. UI yalnız loopback'e bağlansa bile API açık ve kimliksiz bırakılmaz; diğer yerel kullanıcı/proses yetkileri, IPC dosya/pipe erişimi ve origin kontrolü sınanır.

Kullanıcı, proje, run, artifact, cursor, export, SSE ve rapor erişimleri aynı ACL'den geçer. Kimlik doğrulaması yalnız ön uç sayfasında yapılmaz. Üyelik/izin değişimi, yayın ve script çalıştırma öncesinde yeniden kontrol edilir.

### 11.2 Etkin ayar çözümleme

Katmanlar: sistem politikası -> tenant/workspace varsayılanı -> proje -> kişisel tercih -> oturumluk tercih. Her anahtar için override kuralı şemada tanımlıdır.

Normal tercihlerde daha özel değer geçebilir. Yetki/veri paylaşımı/harcama üst sınırında alt kapsam üst sınırı genişletemez; izin kümeleri güvenli kesişimle, limitler izin verilen dar sınırla çözülür. `null`, miras al ve devre dışı değerleri karıştırılmaz.

UI ve `doctor`, etkin değer ile kaynağını gösterir. Ayarlar validate edilmeden aktifleşmez; revision ve audit kaydı vardır. Devam eden iş immutable config snapshot'ını kullanır; acil yetki iptali güncel kontrolde uygulanır.

Proje kimliği repository/workspace eşlemesidir; klasör ismi veya modelin verdiği path yeterli değildir. Farklı geliştirici yolları/worktree'ler aynı projeye açık eşleme ile bağlanabilir. Kimliksiz/bağlanmamış istek global'e düşürülmez.

“Global” bütün sunucu kullanıcıları arasında ortak bellek değildir. Personal-global, workspace-global ve project kapsamları ayrı kimlik taşır. Aynı isimli skill için açık override/provenance gösterilir. Kullanıcının yönetime aldığı skill normal politika içinde otomatik gelişebilir; tüm user-owned skill'leri kategorik olarak kullanılamaz yapmak yerine managed/pinned/protected ayrımı yapılır.

## 12. İstemci kurulumu ve destek sözleşmesi

### 12.1 Claude Code

Yerleşik MCP yapılandırması ve `UserPromptSubmit` kancasıyla `forge_prepare`; kısa talimatla arama/yükleme ve final handoff kullanılır. Güncel belgede MCP tool hook bağlı sunucuyu kullanır; bağlantı başlatmaz ve hata halinde devam edebilir. Kurulum yalnız config yazmak değil ilk mesajı gerçekten denemektir. [S05]

İstemci sürümüne göre input alanları ve output biçimi fixture ile doğrulanır. Kullanıcı mesajını değiştirme ile ek context döndürme ayrı destek özellikleridir. Cold start, sunucu yokluğu ve hook deadline testi bulunur.

### 12.2 Codex

Yerleşik MCP/`UserPromptSubmit` desteği aynı domain araçlarına bağlanır. `SessionEnd` MCP handoff yolu yapılmaz; son gerçek tool çağrısı kalıcı servise teslim eder. İstemci dokümanında oturum sonunda tamamlanmamış background hook'ların iptal edilebildiği belirtiliyor. [S06H]

CLI ile masaüstü/IDE yüzeyi aynı sürüm ve yeteneğe sahip varsayılmaz. Destek matrisi hedef yüzey ve test edilen sürümü ayrı gösterir. Host'un kanca/tool onayları ürün tarafından sahte metadata ile atlatılmaz.

### 12.3 ChatGPT App

Resmî MCP App bağlantısı, doğru server instructions, altı araç ve gerektiğinde küçük rapor/durum bileşeni sağlanır. Normal ChatGPT mesajlarının hepsini zorunlu yakalayan genel ön işleme kancası varmış gibi davranılmaz. İlk araç seçimi/tetik başarısı gerçek konuşmalarda ölçülür; destek seviyesi `best-effort` veya `explicit invocation` olarak görünür. [S07][S10]

ChatGPT App hedefi, OpenCode/Claude için özel runtime eklentisine dönüş izni değildir. ChatGPT'nin kendi onay/hesap/bağlantı sınırları korunur. Geliştirme bağlantısı ile herkese açık App dizini yayını ayrıdır; public yayın bu planın otomatik yetkisi değildir.

Widget gerekiyorsa resmî MCP Apps/UI başlangıç örneği ve izin/CSP kuralları kullanılır; ikinci bir yönetim paneli yazılmaz. Ana yönetim web uygulamasıdır.

### 12.4 Kurulum yöneticisi

CLI hedef komutları: `skill-forge serve`, `worker`, `mcp`, `install <client>`, `doctor`, `migrate`, `backup`, `restore`. Komutlar P02/P09'da gerçekten oluşturulur; plan metninde var diye mevcut sayılmaz.

Kurulum; mevcut JSON/JSONC/TOML dosyasını parser ile okur, yalnız kendi yönetilen bölümünü birleştirir, yedek alır, tekrar kurulunca çoğaltmaz, kaldırılınca kullanıcıya ait alanları silmez. Kancalara API sırrı veya iş mantığı gömülmez. Sürüm desteklemiyorsa açık hata/uygun mevcut komut köprüsü kullanılır; sessizce çalışanmış gibi gösterilmez.

Web tarayıcısı kullanıcı bilgisayarındaki kurulumları kendiliğinden okuyamaz. Eşleştirilmiş yerel servis OS/sürüm/yapılandırma ve sağlık bilgisini raporlar. Eşlenmemiş cihaz `unknown`; bağlantısı eskimiş cihaz `stale`; kurulum eksikliği ancak ölçülmüşse `missing` olur. Eşleştirme tek kullanımlık ve geri alınabilir olmalıdır.

Kurulum testi zinciri: servis sağlığı -> kimlik -> araç keşfi -> search/load -> prepare -> handoff kabulü -> istemci kapanınca tamamlama. Her adımın bağımsız durumu ve log bağlantısı bulunur.

## 13. Girişli web platformu ve yönetim API'si

Web ekranları sahte veriyle doldurulmuş demo olarak teslim edilmez. Yükleniyor/boş/hata/yetkisiz/çevrimdışı durumları, klavye kullanımı ve uzun metin/dosya ağaçları test edilir. Tablo filtreleri, sayfalama ve seçili öğeler kalıcı bağlantı ile yeniden açılabilir.

| Yüzey | Zorunlu işlevler |
|---|---|
| Genel durum | İstemciler, kuyruklar, aktif/tamamlanan/atlanmış/hatalı işler; model sağlık/kota; latency; son olaylar |
| Skill kütüphanesi | Kapsam/etiket/kullanım filtresi; dosya ağacı; Markdown ve script inceleme/düzenleme; revision diff; test sonucu; pin/protect; import/export |
| İş ayrıntısı | Handoff -> model/araç/test -> yayın zaman çizelgesi; denemeler; hata; kaynak ve config sürümü; retry/cancel; ilişkili skill |
| Prompt Editor | Özgün/düzeltilmiş görünüm; korunmuş kısıtlar; sonuç ve fallback nedeni; model/süre/token; etkin ayarlar; isteğe bağlı yeniden değerlendirme |
| Benchmark | Dataset/split/sürüm seçimi; çalıştırma; ilerleme; baseline/candidate karşılaştırma; başarısız örnekler; JSON/CSV/Markdown rapor |
| Bakım | Kullanılmayan/az görünen/bozuk/eski skill raporu; seçerek/toplu archive; restore; kontrollü kalıcı silme; etki önizlemesi |
| Kurulumlar | Claude Code/Codex/ChatGPT bağlantısı, cihaz eşleme, sürüm, yetenek matrisi, testler, yapılandırma farkı, kaldırma |
| Projeler ve ayarlar | Üyeler/roller; global-proje eşleme; etkin değerin kaynağı; limitler; öğrenme/telemetri saklama |
| Modeller ve tüketim | Sağlayıcı bağlantısı, masked credential durumu, tool-calling denemesi, model profilleri, maliyet ve kota |
| Log ve teşhis | Yetkili arama/filtre, correlation zinciri, hata sınıfı, redakte destek paketi, kaynak/sürüm bazlı dağılım |

API kaynakları aynı servislerin ince dış yüzeyidir: `/api/projects`, `/api/skills`, `/api/runs`, `/api/prompts`, `/api/benchmarks`, `/api/maintenance`, `/api/installations`, `/api/settings`, `/api/providers`, `/api/reports`, `/api/events`. Kesin endpoint/şema P07/P10'da tek sözleşmeden belgelenir. CSRF/yetki/idempotence; toplu işlem ve tek işlemde tutarlıdır.

Olay akışında SSE veya eşdeğer basit mekanizma kullanılır. Her token DB'ye veya UI'ya ayrı kalıcı satır olmaz; olaylar sınırlanır/birleştirilir. Yeniden bağlanmada sequence/cursor ile devam edilir, tenant sınırı korunur. İlk yükleme sayfalıdır; büyük tablolar sanallaştırılır. UI yazımı stale revision'da çakışma gösterir; overwrite yapmaz.

Model tarafından üretilen Markdown/HTML güvenli render edilir. Kod görüntüleme ile kod yürütme ayrıdır. Artifact indirmeleri kısa ömürlü/yetkili; cookie/tokenlar loglara dökülmez.

## 14. Telemetri, raporlar ve saklama

Her işte asgari kayıt: tenant/project/user erişim bağlamı, client/install kimliği, kaynak ve iç model, run/attempt/revision/config/prompt sürümleri, başlama/bitiş, queue_wait, model/tool/test/publish süreleri, input/output/cache/reasoning kullanım alanları, cost ve kalite etiketi, tetik/dedup/no-op/reject/fallback nedeni, hata sınıfı ve correlation.

- Modelin gizli muhakemesi telemetri hedefi değildir; kısa karar gerekçesi ve doğrulanabilir olaylar yeterlidir. Raw düşünme içeriği varsayılan kayda girmez.
- Özel prompt/tool içerikleri için metadata-only ve içerik saklama modları ayrıdır. Retention, şifreleme ve silme politikası bulunur; varsayılan gereksiz tam transcript saklanmaz.
- SDK checkpoint'in devam için gereken özel state'i erişim kontrollüdür; rapor ekranı otomatik raw state dökmez.
- Ölçülmüş, tahmini ve bilinmeyen token/maliyet ayrılır. Yerel model için API faturası sıfır olabilir; donanım/enerji bedeli ölçülmediyse sıfır toplam maliyet yazılmaz.
- OpenTelemetry uyumlu olay/trace yapısı tercih edilir. Run ID gibi yüksek kardinaliteli alanlar sınırsız metric label olmaz. Log/index retention ve disk doluluğu izlenir.
- `forge_report` varsayılan kısa özet verir; detay istenen filtreyle alınır. Başka kullanıcının özel promptunu bütün takımın raporuna koyma.
- Ajanın inceleyebildiği hata/performans raporu, servis kodunu veya yetkilerini otomatik değiştirme yetkisi değildir. Geliştirme ajanı düzeltmeyi normal repo geliştirme akışında yapar.

## 15. Kullanılmayan skill incelemesi ve toplu bakım

Ölçümler birbirinden ayrılır: indexed, search_impression, selected/loaded, entrypoint_executed, reported_applied, outcome_observed. `loaded` başarılı kullanım değildir. MCP dışında kullanılan/export edilmiş skill için gözlem eksikliği açıkça yazılır.

Rapor; gözlem penceresi, ölçüm kapsamı, yeni skill grace dönemi, son sürüm tarihi, kullanım, hata ve benzerlik/çakışma adaylarını gösterir. Aramada hiç görünmeyen ile görünen ama seçilmeyen aynı sorun değildir. İlk rapor deterministik veriden oluşur; LLM yalnız seçilmiş semantik incelemede devreye girer.

Tek tuş raporlama ve filtreli seçerek/toplu archive vardır. Varsayılan temizlik geri alınabilir arşivlemedir. Korunan skill'ler, devam eden run tarafından sabitlenmiş revision'lar, referans bağımlılıkları ve benchmark bağları etki analizine girer. Arşiv yeni keşiften çıkarır, devam eden yetkili run'ın sabit sürümünü bozmaz.

Kalıcı silme tek açık toplu kullanıcı eylemi ve tek etki özetiyle yapılabilir; her dosyada onay istenmez. Yarım başarısız toplu işlem öğe bazlı sonuç verir ve yeniden çağrı güvenlidir. Restore eski kimlik/sürümle çakışıyorsa sessiz overwrite yapmaz. Kullanıcı verisi silme/retention işi ile skill paketini arşivleme ayrıdır; yedeklerde kalma politikası belgelenir.

## 16. Benchmark tasarımı ve performans hedefleri

### 16.1 Kalite deneyleri

Aynı görev kümesi ve başlangıç ortamında beş kol çalıştırılır:

A. Skill Forge kapalı.  
B. Sabit skill + search/load/run açık.  
C. Geliştirilmiş ama deney boyunca sabit revision'lı skill'ler.  
D. Yalnız Prompt Editor açık.  
E. Bütün sistem açık.

Görevler; dil/framework bağımsız iş akışı, Python/JS araç paketi, Rust kodlama, yanlış tetikleme, proje/global karışıklığı, Türkçe belirsizlik/olumsuzluk, eksik kanıt ve bozuk script senaryolarını kapsar. Başlangıç hedefi en az 30 görev, ayrı aktivasyon pozitif/negatif sorguları ve en az 3 tekrar; kesin örnek sayısı güç/maliyet gerekçesiyle deney başlamadan kaydedilir.

Eğitim/skill geliştirme, doğrulama ve holdout ayrılır. Holdout içeriği skill geliştirmede kullanılmaz. Model/istemci/SDK sürümü, temperature/reasoning ayarı, başlangıç commit'i, skill/config/prompt hash'i, tool listesi ve bütçeler sabitlenir. Koşu sırası etkisini azaltmak için dengeli/rastgele sıra kullanılır. Cold/warm cache sonuçları ayrılır.

Metrikler: görev başarısı, regresyon, yanlış/kaçan skill seçimi, insan müdahalesi, doğru artifact/test, uçtan uca süre, ana ajan ve Forge toplam tüketimi, başarılı görev başına maliyet. Skill üretme/eval maliyeti ayrıca ve amortisman varsayımı açık hesaplanır.

Kalite eşiği ve güven aralığı yöntemi sonuç görülmeden tanımlanır. Kritik deterministik regresyon sıfır olmalıdır. Model hakeminin beğenisi tek başarı ölçütü değildir. Olumsuz/etkisiz sonuç gizlenmez; ürün davranışı iyileştirilir, maliyetli etkisiz özellik varsayılan aktif tutulmaz. Değişen kapsamı avantajlı göstermek için baseline bozulmaz.

### 16.2 Gerçek istemci doğrulaması

Claude Code, Codex ve ChatGPT App için ayrı akış kaydı tutulur: otomatik tetik, arama/seçim, alt dosya erişimi, script giriş çağrısı, final handoff ve kapanış sonrası SPR tamamlama. API harness'i gerçek ChatGPT UI koşusu diye etiketlenmez. Erişim olmayan platform için fixture testi ile canlı doğrulama durumu ayrı tutulur.

### 16.3 Yük ve dayanıklılık

1000 kayıtlı kullanıcı, 1000 bağlı istemci ve 1000 eşzamanlı LLM üretimi ayrı senaryolardır. Sonuncusu sağlayıcı/hardware kapasitesine bağlıdır; diğerlerinden çıkarılmaz.

Referans ortamın CPU/RAM/disk/OS/DB sürümü ve dataset'i her raporda yazılır. Başlangıç referansı 8 vCPU, 16 GiB RAM, SSD üzerinde ortak sunucu profilidir. 1/10/100/1000 sanal istemci; en az 10.000 skill metadata kaydı; farklı ve aynı skill'e yoğun istek çalıştırılır. LLM stub kullanan sistem yük testi açıkça ayrılır.

İlk mühendislik hedefleri: 100 istek/s karma katalog yükünde p95 search/load <= 250 ms; modelden bağımsız durable handoff kabulünde p95 <= 300 ms, p99 <= 1 s. Sonuçlar warm/cold ve payload büyüklüğüyle raporlanır. Bunlar ölçülmüş vaat değil test hedefleridir; değişiklik gerekirse benchmark başlamadan gerekçesi plana kaydedilir.

Isınma, sürekli yük, kısa aşırı yük ve toparlanma aşamaları; ayrıca en az 30 dakika soak testi bulunur. Kuyruk ve bellek zamanla sınırsız büyümemeli. Hata oranı yalnız başarılı talepleri seçerek hesaplanmaz; backpressure yanıtları ayrıca raporlanır.

Zorunlu değişmezler: kabul edilmiş iş kaybı yok; yetkisiz veri geçişi yok; stale işçiden yayın yok; yarım paket görünürlüğü yok; aynı revision'a kayıp yazım yok. SIGTERM/SIGKILL, DB kesintisi, disk doluluğu, provider 429/timeout, bozuk script ve yetki iptali senaryoları çalıştırılır.

## 17. Uygulama iş paketleri

Her iş paketinin altında kayıt biçimi: `Durum / commit-dosyalar / komutlar / sonuç / kanıt / engel`. Başlangıçta bütün kutular boştur. İş paketleri gereksiz bağımsız servisler anlamına gelmez.

### P01 — Başlangıç tabanı ve sözleşme geçişi

**Bağımlılık:** Yok. **Gereksinimler:** Tümü için temel.

- [ ] Güncel HEAD/çalışma ağacı, source/dist ilişkisi, bağımlılıklar ve test envanterini kaydet; başlangıç `typecheck`, `test`, `build:plugin`, `npm pack --dry-run` sonuçlarını al. Başlangıç hatalarını yeni hatalardan ayır.
- [ ] Bundle'ın kaynak kökeni/lisansını ve native yardımcının kullanımını araştır; geri kazanılabilir kaynakları belirle. Kurtarılamayan davranışlar için somut extraction listesi ve karakterizasyon testleri yaz.
- [ ] Eski davranışları preserve/replace/remove/migrate tablosuyla eşle; özellikle scope, dedup, editor fail-open, rollback ve injection sınırlarını testlere bağla.
- [ ] `AGENTS.md`, `SPR_SKILL_AUTHORING.md` ve runtime prompt sözleşmesini yeni hedefle tutarlı güncelle. Kullanıcıya ait değişiklikleri koru; eski script yasağını yeni sandbox testleriyle değiştir.
- [ ] Bu planın sürüm ve değişiklik kaydını başlat; çekirdekten dönüşüm sırasında çalışan eski tabanı erken silme.

**Çıkış:** Kaynak dönüşüm yolu ve çalıştırılmış başlangıç raporu; çelişen normatif talimat yok. Kanıt: `docs/evidence/baseline.md`, davranış eşleme tablosu.

### P02 — Tek servis iskeleti, SDK ve derleme temeli

**Bağımlılık:** P01. **Gereksinimler:** G03/G05/G11.

- [ ] Node/TypeScript/Bun test uyumluluğunu doğrula; Pi/MCP/Fastify/DB-migration/UI bağımlılıklarının gerekli sürümlerini kilitle. Wildcard/latest sürüm yerine lockfile üret.
- [ ] Gerçek `serve`, `worker`, `mcp` girişlerini, startup/shutdown ve health/readiness akışını oluştur. stdout MCP protokolüne, loglar stderr/telemetriye gider.
- [ ] Yerel daemon + stdio köprüsü iletişimini, tek-instance başlangıç yarışını, IPC erişimini ve sürüm uyumsuzluğunu çöz. İstemci kapanması daemon'ı sonlandırmaz.
- [ ] Pi üzerinden dört sağlayıcı için küçük tool-call/usage/cancel probes oluştur; sahte sağlayıcı deterministik testlerde çalışsın. Ücretli çağrı ancak yapılandırılmış izinle olsun.
- [ ] Temiz kaynak checkout'undan build, paket dosya listesi ve smoke çalıştırmasını kur; henüz yapılmayan işlevleri hazır endpoint gibi göstermeyen error sözleşmeleri kullan.

**Çıkış:** Bağımsız servis açılıyor; sağlayıcı/SDK seçimi kanıtlı; build eski wrapper'a mahkûm değil. Testler: K10/K14/K25.

### P03 — Kalıcı veri, kullanıcı/proje ve etkin ayarlar

**Bağımlılık:** P02. **Gereksinimler:** G04/G11/G13/G14.

- [ ] SQLite/PostgreSQL migration'larını ve tenant/user/project/membership/client/run/revision/config/usage temel şemalarını oluştur. Tenant-scope birleşik foreign key/unique/index kurallarını kur.
- [ ] Sunucu kimliği ve yerel sahip girişini; token/session doğrulama, role/ACL ve artifact erişimini uygula. UI login ilk kez gerçek API'ye bağlansın.
- [ ] Proje/yerel path/worktree/client eşlemelerini ve personal/workspace/project kapsamlarını uygula; aynı isimli kaynak çakışmalarını görünür yap.
- [ ] Etkin ayar çözümleyici, policy limitleri, config revision ve kaynak gösterimini uygula. Geçersiz ayar etkinleşmesin.
- [ ] Secret resolver, redaksiyon ve güvenli data-dir izinlerini kur; çok kullanıcılı süreçte global credential/env sızıntısını test et.

**Çıkış:** İki kullanıcı aynı ID/path denemeleriyle birbirinin verisine erişemiyor; ayar mirası iki DB'de aynı. Testler: K12/K27/K28.

### P04 — Kalıcı işler ve ortak ForgeRunner

**Bağımlılık:** P03. **Gereksinimler:** G01/G03/G04/G05/G12.

- [ ] Durable kabul/dedup/outbox veya doğrulanmış ortak kuyruk transaction'ını; SQLite adapter ve pg-boss worker'ı uygula.
- [ ] Job/attempt/lease/fencing, deadline, retry/cancel, restart recovery ve adil öncelikleri kur.
- [ ] Pi tabanlı tek runner; `skill_evolve` ve `prompt_edit` profilleri; tekilleştirilmiş usage, config/model snapshot ve sonlandırma aracını uygula.
- [ ] Model tur/token/maliyet bütçesi ile provider quota/backoff/reservation ekle. Her onarım ve fallback aynı toplam bütçeye girsin.
- [ ] İç işlerin yeniden handoff/prepare üretmesini engelle; kabulden sonra ana istemci kapanınca işin tamamlandığını gerçek ayrı süreç testinde göster.

**Çıkış:** Bağımsız çalışma ve çökme kurtarma gerçek; otomatik onay bekleme yok. Testler: K01–K04/K09/K10.

### P05 — Paket deposu, arama indeksi ve atomik yayın

**Bağımlılık:** P03/P04. **Gereksinimler:** G02/G04/G10/G11/G13.

- [ ] Klasik paket/revision/staging dizinlerini, manifest/hash, import/export ve index oluşturmayı uygula.
- [ ] Frontmatter, yol/link, dosya tipi/boyut ve platform isim kontrollerini; eski güvenlik regresyonlarını yeni kaynak API'lerinde çalıştır.
- [ ] CAS/fencing kontrollü yayın, config/ACL yeniden kontrolü, snapshot okuma ve restart reconciliation ekle.
- [ ] Aynı skill writer koordinasyonu, semantik owner araması ve sınırlı merge/rebase yolunu uygula; insan editörü aynı servisleri kullanabilsin.
- [ ] Scope filtreli arama, pagination ve revision-keyed cache'i oluştur; cache invalidation/tenant kaçış testlerini ekle.

**Çıkış:** Tam paket sürümü dışında görünür durum yok; eski okuyucu sabit sürümü kullanıyor. Testler: K04–K06/K12/K24/K25.

### P06 — Tam paket SPR ve script yürütme

**Bağımlılık:** P04/P05. **Gereksinimler:** G01/G02/G03/G04.

- [ ] SPR'nin create/update/no-op/reject akışını mevcut kalite ilkeleriyle runner'a taşı; mevcut skill'i incelemeden değiştirme ve yeni gereksiz duplicate üretme.
- [ ] Markdown, referans, script, fixture ve test patch araçlarını staging'e bağla; read-before-change ve minimal semantic diff uygula.
- [ ] Python/Node giriş manifesti, input/output doğrulama, sandbox, runtime/dependency cache ve process-tree iptalini kur.
- [ ] Script test/validasyon sonuçlarını yayın kapısına bağla; olmayan testin sonucunu ajan beyanıyla geçirme. Global taşınabilirlik ve aktivasyon regresyonlarını değerlendir.
- [ ] Yönetilen rutin güncellemeyi otomatik yayınla; protected/pinned/izin dışı talepleri modalsız net sonuçla bitir. Başarısız aday eski skill'i bozmasın.

**Çıkış:** Alt Markdown ve çalışan script/test ekleyen, ardından onu güvenle güncelleyen gerçek SPR senaryosu. Testler: K05/K07/K08/K09/K13.

### P07 — Altı MCP aracı ve bağlam ekonomisi

**Bağımlılık:** P05/P06. **Gereksinimler:** G06/G10/G13.

- [ ] Altı aracın tek kaynaklı şemalarını, açıklamalarını, annotations ve hata zarfını uygula; internal writer araçları dışa sızmasın.
- [ ] Search -> load -> reference -> run zincirini aynı revision üzerinde çalıştır; cursor/byte/token sınırları ve artifact erişimi olsun.
- [ ] Kısa bootstrap/server instructions; görevle ilgili metadata ve az çağrıyla yükleme akışını oluştur. Tüm kütüphane başlangıç context'ine girmesin.
- [ ] MCP lifecycle/transport/auth/cancel/reconnect ve istemci şema uyumluluğunu resmi client ile integration test et.
- [ ] `forge_report` için filtreli temel run/skill/error raporunu; UI/MCP ortak servis erişimini tamamla.

**Çıkış:** Gerçek MCP istemcisi Python/TS yardımcı scriptli skill'i az araçla kullanıyor. Testler: K06/K15/K24.

### P08 — Ortak altyapıyla Prompt Editor

**Bağımlılık:** P04/P07. **Gereksinimler:** G03/G12/G13.

- [ ] Mevcut sanitizasyon, intent ve bounded-context işlevlerini yeniden kullan; OpenCode session/part/update bağımlılığını çıkar.
- [ ] `forge_prepare`, immutable original, aday revision, dedup ve stale/deadline korumasını uygula. Normalde bir çağrı; gerekli tek onarım.
- [ ] Improved/unchanged/needs_clarification/fallback sonuçları, bağımsız enabled bayrakları ve auto-apply varsayılanını tamamla.
- [ ] Kapsamlı öğrenme deposu ve seçici retrieval ekle; eski global learn importunu özel kapsamda tut; her prompttan zorunlu ders üretme.
- [ ] Türkçe olumsuzluk, sayı/birim/path/sürüm, kısa devam, yanlış araç kataloğu, injection, komut ve timeout testlerini çalıştır.

**Çıkış:** Prompt düzeltme skill sisteminden ayrı açılıp kapanıyor ama ikinci runner/model/queue oluşturmuyor. Testler: K09/K11/K26/K27.

### P09 — Claude Code, Codex ve ChatGPT kurulumu

**Bağımlılık:** P07/P08. **Gereksinimler:** G01/G07/G10/G14.

- [ ] Test edilen istemci sürümleri/yüzeyleri için capability matrisi oluştur; config input/output fixture'larını gerçek doküman ve smoke ile doğrula.
- [ ] İdempotent installer/uninstaller, parser tabanlı merge/yedek, yönetilen talimat bölümü ve doktor komutlarını uygula.
- [ ] Claude/Codex ilk kullanıcı mesajı prepare ve final handoff akışlarını bağla; cold-start ve server-unavailable davranışını test et.
- [ ] ChatGPT App OAuth/MCP bağlantısı, doğru araç metadata ve rapor görünümünü tamamla; best-effort tetik ile zorunlu hook'u ayrıştır.
- [ ] Yerel cihaz eşleme/heartbeat/health/installation test kayıtlarını web'e aktar; unknown/stale/supported/unsupported durumlarını doğru göster.

**Çıkış:** Üç hedef için gerçek kurulum yolu ve platforma özgü kanıt; custom host eklentisi yok. Testler: K01/K17–K19/K28.

### P10 — Tam web yönetimi

**Bağımlılık:** P03/P05/P07/P08/P09. **Gereksinimler:** G06/G09/G14.

- [ ] Bölüm 13'teki on yüzeyi gerçek API'lere bağla; bütün menü/route/action'lar işlesin. Placeholder buton veya yalnız mock veriyle ekran bırakma.
- [ ] Skill dosya ağacı, kod/Markdown editörü, diff, test, revision ve rollback'i aynı yayın servisine bağla.
- [ ] Run/prompt ayrıntısı, SSE yeniden bağlanma ve filtreli rapor; hata/cancel/retry/empty/loading durumlarını tamamla.
- [ ] Proje/user/model/config/kurulum ekranlarını ve etkin ayar kaynağını tamamla; bütün işlemlerde server ACL denetlensin.
- [ ] Playwright ile login, filtre/detay, stale edit, modal gerektirmeyen rutin yayın, installation ve yetkisiz erişim senaryolarını çalıştır; klavye ve büyük veri görünümünü kontrol et.

**Çıkış:** İnsan servis işletimini terminale bağımlı kalmadan yönetebiliyor; ajan aynı raporu araçtan alabiliyor. Testler: K15/K16/K28.

### P11 — Telemetri, kullanım analizi ve bakım

**Bağımlılık:** P04/P05/P10. **Gereksinimler:** G06/G09/G11.

- [ ] Bölüm 14 olay/metrik/cost şemasını ve gerçek/tahmini/bilinmiyor ayrımını bütün akışlarda tamamla.
- [ ] Retention, redaksiyon, export ve destek paketi; disk/index/olay backpressure kontrollerini uygula.
- [ ] Kullanım funnel'ı, gözlem kapsamı ve kullanılmayan/yeni sürümü denenmemiş skill raporlarını kur.
- [ ] Seçerek/toplu archive/restore/delete; dependency/pinned/active-run kontrolü ve öğe bazlı sonuç/tekrar güvenliği ekle.
- [ ] Bakım raporu/temizlik ekranı ve `forge_report` sonuçlarını karşılaştır; hesapları küçük bilinen fixture üzerinde doğrula.

**Çıkış:** Tek tuş rapor ve toplu bakım gerçek; izlenmeyen kullanım yanlış sıfır sayılmıyor. Testler: K16/K22/K23.

### P12 — Fayda ve istemci benchmarkları

**Bağımlılık:** P06–P11. **Gereksinimler:** G03/G05/G07/G08/G10/G12.

- [ ] A–E deney kolları, dataset/split, repeat, model/istemci/skill sabitleme ve grader'ları uygula.
- [ ] Mevcut harness'i gerçek agent path'e bağla; fixture veya API-only koşularını canlı host koşusundan açıkça ayır.
- [ ] Claude Code/Codex/ChatGPT tetik/search/load/run/handoff doğruluğunu ve context maliyetini ölç.
- [ ] Başarısız görevleri, yanlış tetiklemeleri ve prompt anlam kaymalarını düzelt; holdout'u geliştirme verisine çevirmeden yeniden değerlendir.
- [ ] Sürüm karşılaştırması, güven aralığı/belirsizlik, toplam maliyet ve olumsuz sonuçları web/JSON/Markdown raporuna çıkar.

**Çıkış:** Faydalı/faydasız ayrımını sonuçla gösterebilen tekrarlanabilir sistem; pazarlama iddiası değil kanıt. Testler: K20/K21.

### P13 — Ölçek, çakışma ve arızadan kurtarma

**Bağımlılık:** P04–P12. **Gereksinimler:** G01/G04/G06/G11.

- [ ] 1/10/100/1000 istemci, farklı/aynı skill yoğunluğu, 10.000 katalog ve referans yük profilini çalıştır.
- [ ] DB sorgu/index, dosya okuma, cache, queue fairness, connection pool ve event loop darboğazlarını kanıtla düzelt.
- [ ] Kill/restart, lease expiry, eski işçi yayını, DB kesintisi, disk doluluğu, model 429, script timeout ve yetki iptali senaryolarını çalıştır.
- [ ] Başarılı iş/ücret tekrarının sınırlarını doğrula; kabul edilmiş iş kaybı ve cross-tenant sızıntı olmamasını kanıtla.
- [ ] Donanım/sağlayıcı kapasitesiyle sonuçları raporla; gerçek LLM kapasitesi ile stub throughput'u karıştırma.

**Çıkış:** Bölüm 16'daki ölçülmüş yük/kurtarma kanıtı ve kalan kapasite sınırları. Testler: K02–K04/K12/K13/K29.

### P14 — Eski verinin taşınması ve eklentinin kaldırılması

**Bağımlılık:** P05/P08/P09/P11/P13. **Gereksinimler:** G02/G07/G11/G12/G13.

- [ ] `.opencode/skills`, `~/.config/opencode/skills`, ilgili `.skill-power` alanları ve prompt-editor JSONL/learn/flags için read-only keşif ve dry-run manifest oluştur.
- [ ] Sahip/proje eşleme, duplicate/case collision, malformed kayıt, relative link ve script paketlerini kayıpsız içe al. Kişisel learn kayıtlarını ortak global'e terfi ettirme.
- [ ] İçe aktarmayı idempotent, checksum'lı ve geri alınabilir yap; orijinaller varsayılan silinmez. Geçersiz/kısmi veri için öğe bazlı rapor ver.
- [ ] Yeni yol eşdeğerlik ve güvenlik testlerinden geçtikten sonra runtime'dan OpenCode bağımlılıklarını, `setup(ctx)` wrapper'ını ve eski host hook/persist kodunu kaldır. Gerekli legacy fixture Git geçmişi/test alanında kalabilir; dağıtım girişinde olamaz.
- [ ] `AGENTS.md`, README, paket exports/files ve build komutlarını son mimariye temizle; source'dan üretilemeyen çekirdek/native artifact üretim bağımlılığı kalmasın.

**Çıkış:** Eski kullanıcı verisi kullanılabilir; ürün OpenCode/plugin kurulumu olmadan çalışır. Testler: K25/K26/K30.

### P15 — CI, paketleme, işletim ve Türkçe belgeler

**Bağımlılık:** P01–P14. **Gereksinimler:** Tümü.

- [ ] Typecheck/lint/format/unit/integration/web/build/package doğrulamalarını CI'ya bağla. SQLite/PostgreSQL ve desteklenen OS job'ları; ücretli/live testler açık secret/izinle ayrı yürüsün.
- [ ] Temiz geçici dizinde paket kur -> daemon başlat -> MCP bağla -> skill script kullan -> handoff -> istemci kapat -> rapor al senaryosunu paket artifact'iyle çalıştır.
- [ ] Linux/macOS/Windows kurulum/başlatma/stop/uninstall ve Python/Node runtime sınırlamalarını doğrula; shell/bash şartlarını kaldır veya açık platform adapter'ı yap.
- [ ] Container/Compose sunucu örneği, TLS/reverse proxy, veri volume, health/readiness, graceful shutdown, upgrade/migration ve rollback adımlarını hazırla.
- [ ] Backup/restore'ı DB + referans verilen revision tutarlılığıyla test et; silinmiş kullanıcı/secret ve yedek retention davranışını belgele.
- [ ] Türkçe README hızlı başlangıç, üç istemci rehberi, model/credential, proje/global ayar, script geliştirme, benchmark, gizlilik, sorun giderme ve bilinen sınırları tamamla. Lisans/atıf, desteklenen sürümler ve paket içerikleri açık olsun.

**Çıkış:** Başka bir geliştirici sohbet geçmişini bilmeden ürünü kurup kullanabiliyor. Testler: K25/K28–K30 ve paket smoke.

### P16 — Uçtan uca son denetim ve teslim

**Bağımlılık:** P01–P15.

- [ ] G01–G14 -> uygulama dosyası -> K testi -> rapor zincirini tek tek doğrula. Boş kapsam, stub, TODO/FIXME ve bozuk route/araç için kod tabanını tara; kalanları sınıflandırıp gerekenleri çöz.
- [ ] Tam test/build/pack ve üç istemci senaryosunu son commit üzerinde çalıştır; eski başarı çıktısını yeni commit kanıtı sayma.
- [ ] Yarış, yetki, performans ve usability bulgularını düzelt; değişen alandaki regresyonları yeniden çalıştır.
- [ ] Bu planın iş durumlarını, karar değişikliklerini ve evidence manifestini gerçek sonuçlarla güncelle; external-blocked alanları gizleme.
- [ ] Çalışan özellikler, komutlar, commit/sürüm, test/benchmark sonuçları, veri geçişi ve doğrulanmış sınırları içeren kısa teslim notu hazırla. Bütün zorunlu kabul ölçütleri sağlanmadan tam tamamlandı deme.

## 18. Zorunlu kabul senaryoları

| ID | Senaryo | Beklenen gözlenebilir sonuç |
|---|---|---|
| K01 | Gerçek ana istemci son handoff kabulünden sonra kapatılır | Bağımsız servis aynı run'ı tamamlar; istemciye polling/geri çağrı gerekmez |
| K02 | Kabul/queue/yayın farklı noktalarında proses öldürülür | Kabul edilmiş iş kaybolmaz; restart sonrası doğru terminal durum ve tek aktif revision |
| K03 | Aynı istek paralel/tekrarlı teslim edilir | Aynı run veya açıklanmış duplicate; çift iş etkisi yok |
| K04 | İki işçi/insan aynı skill'i değiştirir; lease el değiştirir | Kayıp güncelleme ve stale işçi yayını yok; revision çatışması çözülür |
| K05 | SKILL + referans + asset + script + test paketi gelişir | Tam paket birlikte doğrulanır/yayınlanır; export klasik klasördür |
| K06 | Yükleme sonrası aktif sürüm değiştirilir | Alt dosya/script eski yüklenen revision ile tutarlıdır |
| K07 | Script geçerli/bozuk/timeout/bağımlılık eksik girdiler alır | Şemalı sonuç, sınırlı çıktı, process temizliği; test edilmemiş aday aktif değil |
| K08 | Traversal/symlink/arşiv kaçışı/özel dosya/yanlış workspace denenir | Paket ve izinli workspace dışına erişim/yazım yok |
| K09 | Basit prompt ve skill işi normal bitişe ulaşır | Gereksiz ek model turu yok; bütçe ve no-op sonucu doğru |
| K10 | Dört sağlayıcıya tool-call/cancel/usage ve 429 deneyi | Destek açık, hata sınıflı, ücretli gizli fallback yok |
| K11 | Türkçe istek olumsuzluk/sayı/path/kapsam/komut içerir | Niyet korunur; belirsizlik uydurulmaz; sürede özgün istek korunur |
| K12 | Aynı ID, cursor, cache, run/artifact başka kullanıcıdan istenir | Cross-tenant/proje/özel bağlam sızıntısı yok |
| K13 | Bir kullanıcı ağır iş/aynı skill kuyruğunu doldurur | Başka kullanıcı promptu aç kalmaz; sınırlar ve backpressure doğru |
| K14 | Kullanıcı modelleri/anahtarları eşzamanlı değiştirilir | Credential karışması yok; config snapshot ve maliyet profili doğru |
| K15 | Aynı run web ve MCP raporundan incelenir | Tutarlı olay/sonuç/izin ve sınırlı detay |
| K16 | Eksik usage, cache, retry ve retention birlikte denenir | Bilinmeyen sıfır değildir; çift maliyet yok; sırlar redakte |
| K17 | Claude Code ilk mesaj/kapanış/cold start | Kurulum test zinciri gerçek; desteklenmeyen özellik açık |
| K18 | Codex ilk mesaj/final handoff/session end | SessionEnd'e bağımlı olmayan aktarım; kurulum korunur |
| K19 | ChatGPT App gerçek bağlantı ve görev çağrısı | OAuth/araç zinciri çalışır; otomatik tetik ve onay sınırlamaları raporlanır |
| K20 | A–E aynı görev/model/sürümle çalıştırılır | Tekrar üretilebilir karşılaştırma, holdout ayrımı ve başarısız örnekler |
| K21 | Skill yüklenir ama görevi bozarsa / prompt uzarsa | Sırf kullanım/uzunluk başarı sayılmaz; gerçek davranış grader'ı yakalar |
| K22 | Yeni, az görünür, hiç yüklenmemiş ve dışarıda kullanılan skill'ler | Kullanım kapsamı doğru; ölçülmeyen kullanım yanlış sıfır değil |
| K23 | Toplu arşiv/silme yarıda kesilir ve tekrar edilir | Öğe bazlı sonuç, güvenli tekrar/restore; sabit sürümlü işler bozulmaz |
| K24 | 10.000 skill ile discovery ve büyük dosya okuma | İlk context katalogla büyümez; pagination/truncation ve tool sayısı sabit |
| K25 | Temiz paket kurulumu ve eski veri import/export | Source build, klasik dosyalar ve çalışan CLI; orijinaller korunur |
| K26 | Prompt Editor açık, skill evolution kapalı; tersi | Bayraklar bağımsız; ortak altyapı korunur; recursion yok |
| K27 | Global/proje/kişisel/oturum ayarı ve policy çakışır | Etkin değer/kaynak belli; alt kapsam yetki veya bütçeyi genişletemez |
| K28 | UI login, yetkisiz action, stale edit, offline cihaz | API ACL, çatışma ve unknown/stale durumları doğru; kırık akış yok |
| K29 | 1–1000 istemci, kill, disk/DB/provider arızası | Bölüm 16 değişmezleri ve ölçülmüş latency/kuyruk raporu |
| K30 | Tam yedek geri yüklenir; yükseltme geri alınır | DB-revision tutarlılığı, sürüm/migration uyumu; kullanıcı işi kaybolmaz |

Bir testin varlığı geçmesi anlamına gelmez. Rapor, komut/çevre/commit/zaman/sonuç bilgisini taşır. Live test erişimi yoksa test kodu ve fixture kanıtı tutulur, canlı satır `external-blocked` kalır.

## 19. Veri şeması ve indeks gereksinimleri

Başlangıç veri modelleri: users, tenants/workspaces, memberships, projects/project_bindings, client_installations, config_revisions, provider_profiles/secret_refs, forge_sessions, runs/attempts, jobs/leases/outbox, skills, skill_revisions/file_manifests, skill_overrides, evidence_refs, usage_events/cost_records, learning_entries, benchmark_runs/cases/results, maintenance_batches/items ve audit_events.

Bunlar zorunlu ayrı tablo sayısı değil domain envanteridir; sade bir şema aynı sorumlulukları birleştirebilir. Gereksiz generic entity/event-sourcing framework'ü yazılmaz.

Asgari DB değişmezleri: tenant-scope FK; run idempotency unique; scope + skill slug unique; revision immutable; aktif revision geçerli pakete bağlı; lease/fencing monotonic; budget reservation tekil; batch item tekrar güvenli. Query'ler yetki filtresini indeksli alanlarla uygular; sonradan uygulama belleğinde filtreleyerek önce tüm tenant verisi okunmaz.

Zamanlar UTC saklanır; UI kullanıcı zaman diliminde gösterir. Para decimal/mikro-birim olarak, token sayıları integer olarak tutulur. Sayfa cursor'ları kararlı sıralama kullanır. Saat kayması/lease için DB zamanı tercihi ve process monotonic süre ölçümü ayrılır.

## 20. Son teslim ölçütleri

Aşağıdakilerin tamamı teslim sözleşmesidir:

- Eklenti olmadan yerel ve ortak sunucu profili çalışır; eski OpenCode runtime üretim bağımlılığı değildir.
- Ana ajan handoff sonrası kapansa da SPR tamamlar; model/proje/session ilişkisi ve kanıt kaydı vardır.
- Skill geliştirme tam paketi kapsar; scriptler gerçekten test edilir ve güvenli çalıştırılır.
- Prompt Editor aynı altyapıyı kullanır, niyet korur, rutin onay istemez ve fail-open davranışı doğrulanır.
- Kullanıcı/proje/global ayar ve veri sınırları; aynı skill eşzamanlı yazımı; restart/rollback testlerden geçer.
- Altı araç gereksiz katalog/context büyümesi olmadan görev, referans ve script akışını taşır.
- Web'de kullanıcı girişi, bütün yönetim yüzeyleri, kurulum durumu, telemetry ve bakım işlemleri çalışır.
- Claude Code, Codex ve ChatGPT App için gerçek destek düzeyi ve canlı doğrulama durumu bellidir.
- Benchmark sistemi fayda/faydasızlığı ve tüketimi dürüst gösterir; 1–1000 kullanıcı iddiası uygun yük kanıtıyla sınırlandırılır.
- Veri göçü, temiz paket kurulumu, backup/restore, işletim ve Türkçe belgeler tamamdır.
- P01–P16 ve K01–K30 kanıt tablosu günceldir; başarısız/çalıştırılmamış zorunlu satır tamamlanmış gibi işaretli değildir.

## 21. Karar ve kapsam değişiklik kaydı

Her değişiklik bu şemayla eklenir; eski gerekçe silinmez:

| Tarih | Değişiklik | Kanıt/gerekçe | Etkilenen G/P/K | Kapsam ve test etkisi | Sonuç |
|---|---|---|---|---|---|
| 2026-09-05 | İlk uygulama planı | Mevcut repo kaynak/test sözleşmesi + kullanıcının 14 gereksinimi | G01–G14, P01–P16, K01–K30 | Henüz uygulama yapılmadı; bütün kabul işleri açık | Plan oluşturuldu |

## 22. Kaynaklar ve yeniden doğrulama

Repo inceleme tabanı yukarıdaki commit'e sabittir. Dış API/SDK/istemci bilgileri 5 Eylül 2026'da kontrol edilmiştir; uygulayıcı kesin sürümleri kilitlemeden önce ilgili resmî kaynağı yeniden kontrol eder. Kaynak bir entegrasyonun belgeli olduğunu gösterir; bu depoda çalıştığının kanıtı değildir.

- [S01 — Resmî MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk): SDK/transport ve sürüm hattı.
- [S02 — Pi agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md): ajan döngüsü, olaylar, araç yürütme ve sonlandırma.
- [S03 — Pi AI](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md): sağlayıcılar, kullanım ve model bağlantısı.
- [S04 — pg-boss](https://github.com/timgit/pg-boss): PostgreSQL üzerinde mevcut iş kuyruğu.
- [S05 — Claude Code hooks](https://code.claude.com/docs/en/hooks) ve [skills](https://code.claude.com/docs/en/skills): yerleşik tetik, keşif ve destek dosyaları.
- [S06 — ChatGPT/Codex skill belgeleri](https://developers.openai.com/codex/skills): ihtiyaçta içerik yükleme.
- [S06H — Codex hooks](https://developers.openai.com/codex/hooks): MCP tool hook ve oturum sonu sınırları.
- [S07 — ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode): araç seçimi, sunucu talimatları ve onay davranışı.
- [S08 — Agent Skills specification](https://agentskills.io/specification): taşınabilir klasör/metadata sözleşmesi.
- [S09 — ChatGPT App authentication](https://developers.openai.com/apps-sdk/build/auth): resmî OAuth/korumalı kaynak bağlantısı.
- [S10 — MCP App server](https://developers.openai.com/apps-sdk/build/mcp-server) ve [tool design](https://developers.openai.com/apps-sdk/plan/tools): araç metadata'sı ve uygulama yüzeyi.
- [S11 — Promptfoo](https://github.com/promptfoo/promptfoo): mevcut değerlendirme altyapısı; kullanılacak adapter gerçek sürüm üzerinde doğrulanır.
- [S12 — OpenRouter limits](https://openrouter.ai/docs/api/reference/limits): ücretsiz/ücretli kapasite sınırları ve hata davranışı.
- [S13 — Ollama usage](https://docs.ollama.com/api/usage): yerel model kullanım/süre ölçümü.

**Uygulayıcının son kontrolü:** Bu dosya artık yeniden yazılacak bir öneri değil, uygulanacak iş sözleşmesidir. Kanıta dayalı gerekli değişiklikleri kaydet; hedefi küçültme; kodu, testleri, arayüzü ve işletim yolunu birlikte tamamla.
