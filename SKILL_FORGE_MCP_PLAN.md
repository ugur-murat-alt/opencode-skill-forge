# Skill Forge MCP — Uçtan Uca Uygulama Planı

**Durum:** Uygulanıyor — uzak depo eşitlendi; P01 başlangıç ölçümü ve sözleşme geçişi tamamlandı.
**V2 durumu (2026-09-08):** 1.0.0 yayımlandı. P17–P24 tamamlandı (P17 roller/davet/devir/silme/GitHub,
P18 rol-araç matrisi, P19 ortam/kapsam/bağ, P20 skorlu arama, P21 ajan prompt zinciri, P22 prompt çıkarma,
P23 web yenileme, P24 denetim + teslim notu) + 2 tur bağımsız inceleme kapatmaları. Son kapılar:
typecheck/build/pack temiz, `bun test` 354 pass / 1 skip / 10 fail / 365 test / 83 dosya
(10 fail yalnızca çevresel gerçek-Docker sandbox testleri), web kabul 28/28,
runtime harness 18/18. Kanıtlar
`docs/evidence/p17-*`, `p18-*`, `p19-*`, `p20-*`, `p21-*`, `p22-*`, `p23-web-acceptance.json`,
`p24-delivery.md`, `p25-review-round1.json`, `p26-review-round2-p19p20.json`,
`p27-review-round2-p23.json`, `p28-runtime-harness.json`. Değişiklikler commitlenmedi.
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

- [x] Güncel HEAD/çalışma ağacı, source/dist ilişkisi, bağımlılıklar ve test envanterini kaydet; başlangıç `typecheck`, `test`, `build:plugin`, `npm pack --dry-run` sonuçlarını al. Başlangıç hatalarını yeni hatalardan ayır.
- [x] Bundle'ın kaynak kökeni/lisansını ve native yardımcının kullanımını araştır; geri kazanılabilir kaynakları belirle. Kurtarılamayan davranışlar için somut extraction listesi ve karakterizasyon testleri yaz.
- [x] Eski davranışları preserve/replace/remove/migrate tablosuyla eşle; özellikle scope, dedup, editor fail-open, rollback ve injection sınırlarını testlere bağla.
- [x] `AGENTS.md`, `SPR_SKILL_AUTHORING.md` ve runtime prompt sözleşmesini yeni hedefle tutarlı güncelle. Kullanıcıya ait değişiklikleri koru; eski script yasağını yeni sandbox testleriyle değiştir.
- [x] Bu planın sürüm ve değişiklik kaydını başlat; çekirdekten dönüşüm sırasında çalışan eski tabanı erken silme.

**Çıkış:** Kaynak dönüşüm yolu ve çalıştırılmış başlangıç raporu; çelişen normatif talimat yok. Kanıt: `docs/evidence/baseline.md`, davranış eşleme tablosu.

**Kayıt (2026-09-05):** Tamamlandı. `docs/evidence/baseline.md`, `behavior-mapping.md`, legacy hash manifesti, yeni el kitabı/promptlar ve `evolution-policy.ts`. İlk ağaç hataları ayrı kaydedildi; temiz HEAD typecheck/242 test/build/pack geçti. Geçiş sonrası yerel typecheck ve 247 test geçti (`p01-tests.log`). Mevcut dist silmeleri korunuyor; yeni source build P02 işidir. Yeni K kabulü henüz işaretlenmedi.

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

> Not (P22): `prompt_edit` profili kaldırıldı; runner yalnız `skill_evolve` sunar. İlgili alt madde geçersizdir.

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

> Not (P22): dış sözleşme beş araca indi (`forge_prepare` kaldırıldı); "altı" geçen maddeler beş araçla okunmalı.

**Bağımlılık:** P05/P06. **Gereksinimler:** G06/G10/G13.

- [ ] Altı aracın tek kaynaklı şemalarını, açıklamalarını, annotations ve hata zarfını uygula; internal writer araçları dışa sızmasın.
- [ ] Search -> load -> reference -> run zincirini aynı revision üzerinde çalıştır; cursor/byte/token sınırları ve artifact erişimi olsun.
- [ ] Kısa bootstrap/server instructions; görevle ilgili metadata ve az çağrıyla yükleme akışını oluştur. Tüm kütüphane başlangıç context'ine girmesin.
- [ ] MCP lifecycle/transport/auth/cancel/reconnect ve istemci şema uyumluluğunu resmi client ile integration test et.
- [ ] `forge_report` için filtreli temel run/skill/error raporunu; UI/MCP ortak servis erişimini tamamla.

**Çıkış:** Gerçek MCP istemcisi Python/TS yardımcı scriptli skill'i az araçla kullanıyor. Testler: K06/K15/K24.

### P08 — Ortak altyapıyla Prompt Editor

> Not (P22): bu paket tamamen düştü; Prompt Editor üründen kaldırıldı. Maddeler uygulanmayacak.

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
| 2026-09-08 | V2 yönlendirmesi | Çok kullanıcılı org/ortam, skorlu arama, sürümlü ajan promptu, prompt çıkarma, web yenileme | P17–P24, bölüm 23 | P08 düştü; P14 learning/rewrites/flags kapsamı düştü; 6→5 MCP aracı | Bölüm 23 eklendi, uygulama P22 ile başlar |
| 2026-09-08 | forge_prepare kaldırma | Stub ölü sözleşme taşır; hook'lar handoff-odaklı yeniden yazılır | P22, P09 | P09 hook kabulü güncellenir | Kaldırma kararı |
| 2026-09-08 | Roller | founder/admin/writer/reader/auditor; founder dışı default roller silinebilir (üyeli rolde önce reassign) | P17–P18 | Rol migration + matris testleri | Rol kararı |

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

### 2026-09-05 uygulama kaydı — P01

- Başlangıç: `ed4c4b4`; `git fetch --prune origin` ardından `git merge --ff-only origin/main` ile `dcbc41e0c15eec0998162be35a204290387f9abc`. Uzak değişiklik yalnız bu planı ekledi.
- Kullanıcı değişiklikleri: `dist/` altındaki yedi takipli dosyanın silinmesi aynen korundu. Eşitleme öncesi binary diff `/tmp/skill-forge-before-sync.patch`; hiçbir stash/reset yapılmadı.
- Node `v24.19.0`, Bun `1.3.14`. Çalıştırılan başlangıç komutları ve çıkış kodları `docs/evidence/baseline-results.json` içinde. Typecheck 2, test 1, wrapper build 1; pack 0 fakat runtime eksik. Başarı iddiası yok.
- Teknik karar: silinmiş eski dist'i çalışma ağacına geri getirmek yerine karakterizasyon için Git'teki byte-identical bundle ve eski politika yalnız legacy fixture olarak korunacak. Yeni servis source build kullanacak. Geçişte eski runtime testleri bu fixture'a yönlendirilecek; tehdit senaryoları silinmeyecek. Etki: P01/P05/P14, K08/K25; kabul: fixture SHA-256 Git blobuyla aynı, eski karakterizasyonlar koşar, yeni paket legacy bundle'a ihtiyaç duymaz.
- Eski OpenCode config/policy yalnız legacy yürütme sözleşmesi olarak dondurulacak; yeni SPR prompt ve Türkçe el kitabı yeni runner'ın normatif sözleşmesi olacak. Paket/script yasağı yerine staging, input/output schema, sandbox, read-before-change, CAS ve gerçek test kapıları uygulanacak. Etki: P01/P06/P14; kabul: politika testleri deny-first ve create/update/no-op/reject'i korur, script yayını gerçek test olmadan yapılamaz.

### P02 sürüm kararı — 2026-09-05

Resmi MCP repository v2 kararlı hattını doğruluyor; npm `@modelcontextprotocol/server` 2.0.0. Pi `@earendil-works/pi-agent-core` ve `pi-ai` 0.85.0, minimum Node 22.19.0. Hedef dağıtım Node 24 LTS; mevcut host 24.19.0. Fastify 5.12.3; migration/query aracı Kysely 0.29.5; PostgreSQL pg 8.23.0 + pg-boss 12.30.0; yerel SQLite adapter. React 19.2.8 ve Vite 8.2.2. OIDC openid-client 6.8.7. Registry integrity/engines kaydı `docs/evidence/sdk-registry.json`. Bun testleri korunur. Kilitli sürüm SDK davranışları kaynak ve gerçek client probe ile P02–P04 içinde doğrulanacak.

### P02–P03 teknik doğrulama ve bağımlılık açıklaması

- Source build `node scripts/build.mjs` ile `dist/index.js` ve `dist/cli.js` üretir; silinmiş eski dosyaları geri getirmez. Üç ayrı resmi MCP stdio istemcisi aynı anda cold-start yaptı; üçü de bağlandı, kapanışlarından sonra daemon `/health` 200 ve aynı process sağlıklı. HTTP v2 reconnect ve auth/origin testleri geçti.
- Worker'ın gerçek lease/kuyruk tüketimi P03 DB ve P04 işler olmadan uygulanamaz. P02 entry/transport altyapısı önce, `worker` komutunun gerçek tüketimi P04 ile birlikte doğrulanacak; olmayan işlev başarılı no-op endpoint olarak sunulmayacak. Bu P02/P03/P04 arasındaki teknik döngüyü giderir; G01/K01 ve bütün worker kabul testleri aynen korunur.
- Node 24.19.0 + better-sqlite3 13.0.3 probe SQLite 3.53.4 ile geçti. Bun 1.3.14 aynı native modülde `NAPI FATAL ERROR: Error::New napi_get_last_error_info`, exit 132 verdi. Çözüm: Kysely SQLite interface'i Node'da better-sqlite3, Bun test runtime'ında bun:sqlite ile sağlanacak; aynı migration/repository/contract testleri kullanılacak ve Node subprocess doğrulaması ayrıca koşacak. Yeni DB ürünü veya alternatif domain yolu eklenmiyor. Etki P02/P03/P15, K25/K30.
- Canlı sağlayıcı ön kontrolü: bu süreçte OPENAI_API_KEY/ANTHROPIC_API_KEY/OPENROUTER_API_KEY tanımlı değil, 127.0.0.1:11434 connection refused. Ücretli çağrı yapılmadı. Dört sağlayıcının canlı K10 satırı henüz doğrulanmadı; deterministik Pi testleri canlı model başarısı değildir.

### 2026-09-05 ara kanıt — P02/P03

- Yeni kaynak CLI/HTTP/MCP ve React/Vite build çalışıyor. `src/legacy-plugin.ts` yalnız geçiş karakterizasyonuna ayrıldı; dağıtım entry'si onu import etmiyor. Eski bağımlılıkların paket manifestinden nihai kaldırılması P14'tedir.
- P03 migration/tenant-scope FK, ACL, config CAS, tek kullanımlık eşleme ve restart kalıcılığı gerçek SQLite ve PostgreSQL'de geçti: `docs/evidence/p03-database-contract.log`. PostgreSQL 17-alpine image digest `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`; test container `skill-forge-contract-postgres`, loopback port 32770; kullanıcı DB'si kullanılmadı.
- Gerçek IAB tarayıcısı, Node dağıtım entry'si ve geçici veri diziniyle giriş -> proje oluştur -> ayar revision 0→1 -> reload kalıcılığı çalıştı. Çıkışta gövdesiz POST'a JSON header ekleme hatası bulundu, `web/src/api.ts` düzeltildi; yeni build/restart ardından logout -> reload giriş ekranı doğrulandı. Bu P03 akışıdır; P10 on ekran tamamlandı iddiası değildir.
- Kapsamlı encrypted SecretVault, secret redaksiyonu, HttpOnly/CSRF/session revoke testleri geçti. OIDC discovery/PKCE/state/nonce/JWKS/audience/scope kodu eklendi; gerçek OIDC hesabı ile canlı kabul henüz çalıştırılmadı.
- Tasarım referansı ve renk/tipografi/komponent envanteri `docs/evidence/design/` içinde; P10 sonunda gerçek dashboard ile native boyutta karşılaştırılacak. Görsel konsept ürün kanıtı değildir.
- P02'nin dört sağlayıcı canlı probes ve P04'e bağlı worker kabulü; P03'ün tam server OIDC/bootstrap, rol yönetim ayrıntıları ve diğer domain tabloları henüz açıktır. K01–K30 tam başarı işaretlenmedi.

### P06 sandbox artifact aktarımı — 2026-09-05

Gerçek Docker Node/Python testinde script JSON sonucu doğruydu fakat `docker cp` tmpfs `/output` içeriğini boş döndürdü. Veri kaybını başarı sayan davranış reddedildi. Script çıktısı host bind yerine 16 MiB tmpfs'te kalacak; güvenilen, bounded Node/Python collector `docker exec` ile dosya/byte/symlink denetimi sonrası base64 zarfı aktaracak. Servis zarfı tekrar doğrulayarak artifact dizinine yazacak. Etki P06/K07/K08; kabul: gerçek Node ve Python dosya artifact'i okunur, timeout bütün container ağacını temizler, toplam çıktı sınırlıdır. Ağ/host fallback eklenmez.

### 2026-09-05 ara kanıt — P04–P07

- Kalıcı job/outbox, actor fairness, lease heartbeat, monoton fence, cancellation, bounded retry ve bütçe rezervasyon/unknown uzlaştırma: `src/jobs/`. Gerçek SQLite/PostgreSQL sözleşmesi `docs/evidence/p04-jobs-contract.log` içinde. Production handler tek Pi runner, private staging ve şifreli kapsamlı model profiline bağlandı; HTTP servis kendi işçisini başlatıyor. Bağımsız worker CLI ve ölçek/soak kabulü hâlâ açık.
- Paket path/Unicode/Windows alias/symlink/hardlink sınırları; hash'li tam immutable revision, base revision CAS ve yayın sırasında güncel ACL/fence kontrolleri `src/skills/` içinde. SQLite LIKE ESCAPE uyumsuzluğu bound parameter ile düzeltildi. Eski aktif sürüm eşzamanlı başarısız adaydan etkilenmiyor. Tam import/export/reconcile/semantic rebase kabulü açık.
- Gerçek Docker Node/Python JSON giriş/çıkışı, dosya artifact'i, aday testleri ve timeout descendant temizliği geçti: `docs/evidence/p06-execution.log`. Son timeout kontrolündeki container adı filtresi, kullanıcı dışı PostgreSQL test container'ını yanlış eşleştirmeyecek şekilde düzeltildi. Locked dependency cache yazıldı; gerçek bağımlılık kurulum kabulü ve izinli script ağı henüz tamamlanmadı.
- Private SPR inventory/select/read/exact patch/remove/validate/finalize araçları; read-before-change, tek kanonik aday, manager-controlled publish, finalize sonrası yazım reddi: `docs/evidence/p06-staging.log`. Canlı modelle script ekleyen/güncelleyen SPR kabulü henüz çalışmadı. Model beyanı script testi yerine geçmiyor.
- Dış MCP yalnız altı aracı sunuyor. Ortak Zod şemaları, kullanıcı/proje/sorguya bağlı HMAC cursor, 24 KiB dosya chunk, pinned revision, script idempotency ledger ve filtreli rapor `src/application/forge.ts` / `src/mcp/` içinde. Gerçek resmi v2 istemcisiyle reconnect, yalnız altı araç, durable handoff/duplicate/report, yetki reddi ve prompt model-missing fail-open geçti: `docs/evidence/p07-mcp.log`. Tam artifact download, client uygulamalarındaki canlı kurulum ve scriptli MCP zinciri kabulü açık.
- Bu ara ağaçta `FORGE_TEST_POSTGRES_URL=<owned-test-db> bun test`: **271 pass, 0 fail, 924 expect**, 34 dosya; `docs/evidence/p07-full-tests.log`. `bun run build:plugin`: Node source + Vite build geçti (`p07-build.log`). Son küçük budget ownership/frontmatter/stream hata kontrolü değişiklikleri ayrıca yeniden sınanacak. Bu toplam legacy karakterizasyonları da içerir; 271 test K01–K30'un tamamlandığı anlamına gelmez.
- Kullanıcının yedi `dist/` silmesi korunuyor. Commit/push/publish yapılmadı. P02–P16 kutuları bütün çıkış ölçütleri sağlanmadan topluca işaretlenmedi.

### 2026-09-05 ara kanıt — paket zinciri ve Prompt Editor

- Gerçek registry `is-number@7.0.0` integrity ile kilitlendi; npm lifecycle script'i çalışmadı. Cache yeniden kullanım ve değiştirilmiş cache reddi, ardından bağımlılığı gerçek sandbox'ta çalıştırma geçti (`p06-dependencies.log`). Salt okunur paket altındaki node_modules mount hedefi başlangıçta eksikti; servis snapshot hazırlığında dizin oluşturarak düzeltildi.
- ZIP aktarımı `fflate@0.8.3` (registry sürüm/integrity doğrulandı) ile klasik tek skill dizinini koruyor. Açılım öncesi merkez dizin/mode/path/dosya/4 MiB sınırı, ZIP64/şifreli/symlink reddi; metin ve binary asset roundtrip testleri geçti (`p05-archive.log`). Büyük arşivler için worker-thread decompression/CPU izolasyonu ayrıca tamamlanacak.
- Resmi MCP client + gerçek TypeScript sandbox ile search -> SKILL.md load -> referans load -> run **4 araç çağrısında** çalıştı; aynı revision kullanıldı. Script idempotency, yetkili artifact download, gerçek sandbox testlerinden geçen import/update/rollback/export geçti (`p07-script-chain.log`). Sonuçların bağlam bütçesi ve büyük artifact sayfalaması ayrıca daraltılacak.
- Prompt üretim handler'ı gerçek HTTP taşıması + Pi ile **açıkça fixture sağlayıcı** kullanılarak test edildi: tek model çağrısı, 15 fixture token, autoApply, private proje dersi, sıfır SPR yayını (`p08-prompt-service.log`). Bu canlı Ollama/model kalitesi kanıtı değildir.
- Bu test Pi'nin OpenAI-compatible transport'unda Ollama için boş API key reddini ortaya çıkardı. Yalnız Ollama için statik protokol işaretçisi kullanıldı; global/ambient gerçek credential fallback eklenmedi. SQLite OFFSET için LIMIT eklendi. Terminal result JSON null olduğunda prepare'ın özgün metin fallback zarfını kaybetmesi düzeltildi.
- Türkçe olumsuzluk, sayı/birim/path/sürüm/komut/kısa devam guard testleri geçti. Hassas metin eski bounded sanitizer ile kontrol ediliyor; öğrenme yalnız ilgili kullanıcı/proje kayıtlarından seçiliyor. Geçersiz aday için toplam prompt çağrısı en fazla 2 (tek onarım). Canlı niyet/aktivasyon benchmarkı ve eski learn veri geçişi hâlâ açık.
- Gerçek ayrı `worker` CLI eklendi; operator-owned 0600 `policy.json` üst sınırları konfigürasyona ve kabul anındaki snapshot'a bağlandı. Model/bağımlılık/script ağ izni alt katmandan genişletilemiyor. Dağıtım restart/paket subprocess smoke yeniden koşulacak.

### P03/P10 etkin politika yönetimi — 2026-09-05

Yalnız dosyadan okunan deny-first üst politika, yönetim ekranından ilk model/harcama/ağ yapılandırmasını tamamlamayı engelliyordu. Kullanıcı hedefi küçültülmeden, mevcut config revision tablosunda tenant'a ait admin-only `policy` kapsamı eklenecek. Operator-owned `policy.json` varsa onun üst sınırları geçerlidir; tenant politikası onları genişletemez. Operator sınırı tanımlanmamış alanların ilk güvenli varsayılanı kapalı kalır, yetkili yönetici bunları web'den açıkça ayarlayabilir. Kabul: viewer/editor policy yazamaz; tenantlar birbirini etkilemez; operator deny/harcama sınırı korunur; devam eden run snapshot'ı değişmez; yeni iş yeni revision'ı alır. Kaynak gösterimi operator/tenant policy ayrımını belirtir.

### 2026-09-05 ara kanıt — P09/P10/P11

- Resmî Codex 0.153.3 ve Claude Code 2.1.261 kurulumu yalnız geçici istemci home/proje dizinlerinde gerçek ikililerle kontrol edildi (`docs/evidence/p09-real-clients.json`). Codex proje TOML'unu okudu; Claude proje MCP kaydı için kendi native güven incelemesini istiyor. Bu kanıt canlı ana ajan/model oturumu, otomatik hook izni veya ChatGPT OAuth kabulü değildir. Native güven sınırı atlanmadı.
- Tenant admin politika ayarı ve operator üst sınırları gerçek testten geçti (`p03-tenant-policy.log`); kabul edilmiş run snapshot'ı sonraki ayar değişikliğinden etkilenmiyor.
- ZIP açılımı bellek/süre sınırlı worker-thread'e taşındı. Source ve dağıtım worker entry'leri ayrıdır. Yeni Node CLI test servisine gerçek ZIP HTTP aktarımı, worker açılımı, Docker script testi ve yayınla geçti; import ana thread üzerinde açılmıyor.
- Web artık dokuz gerçek yönetim yüzeyi içeriyor. Bakım ekranı yeni; benchmark yüzeyi hâlâ açık. Kütüphanede sayfalı dosya envanteri, tam metin düzenleme, çok dosyalı aday, kayıtlı script girdi şeması ve çalıştırma, validation kaydı, revision karşılaştırma ve rollback aynı paket servisine bağlı. Tüm P10 akışları henüz kabul edilmiş değildir.
- Edit API testinde TypeScript sonucunu bozan değişiklik gerçek Docker davranış testinden geçmedi, HTTP 422 döndü ve aktif revision korundu. Geçerli referans düzenlemesi yayımlandı; eski taban sürümüyle yazma HTTP 409 oldu (`p10-package-edit.log`). Ayar yazımı da monoton değişiklik zamanı ve CAS ile eşzamanlı koruma/sabitleme değişikliğini koruyor.
- Yeni `skill_observations` tablosu search_impression / loaded / entrypoint_executed / execution_failed olaylarını ayrı tutuyor. Script tekrar tesliminde aynı correlation ikinci gözlem üretmiyor. Görevde uygulama/sonuç ve servis dışı kullanım bilinmiyor kalıyor; “yüklendi” başarıya dönüştürülmüyor.
- Bakım raporu en fazla 50 paketle sayfalı, 1–365 günlük pencere ve 7 günlük yeni paket grace ayrımı var. Toplu archive/restore önizlemesi, her öğenin ayrı transaction/kalıcı receipt'i, tekrar güvenliği, revocation yeniden kontrolü, koruma ve stale ayar çatışmaları gerçek SQLite ve PostgreSQL'de geçti (`p11-maintenance.log`, güncel tam küme `p11-full-tests.log`). Kalıcı delete, referans/benchmark bağları, retention ve tam kullanım funnel'ı hâlâ açık; P11 bütünü işaretlenmedi.
- Geçici Node servisinin gerçek IAB akışı: model_missing durumunda özgün Türkçe istek aynı kaldı; paket referansı web'den düzenlendi, script testlerinden geçip yeni revision oldu; bakımda arşivlendi, kütüphaneden çıktı ve aynı kimlikle geri alındı. `docs/evidence/design/maintenance-browser.png` gerçek ekran görüntüsüdür. Test paketi açıkça tarayıcı kabul fixture'ıdır; model kalitesi veya gerçek kullanıcı kullanım verisi değildir.
- Bakım ve paket işlemlerinin Türkçe kullanım/API belgesi `docs/tr/bakim-ve-paket-duzenleme.md`. Kullanıcının yedi takipli dist silmesi korunmaya devam ediyor; commit/push/publish yapılmadı.

### P11 saklama ve ortak rapor — ara kabul

- `forge_report(section="maintenance")` ve web aynı `MaintenanceService` hesabını kullanıyor. Bilinen küçük fixture'da öğeler eşit; sayfalar tekrar etmiyor; bakım cursor'ı iş raporunda kullanılamıyor. SQLite/PostgreSQL kanıtı `p11-telemetry.log` / güncel `p11-full-tests.log`.
- Etkin retentionDays politika katmanlarından çözülüyor. Servis her dakika dönen, en fazla 25 yetkili kapsamlık ve öğe başına sınırlı tarama yapıyor. Eski tamamlanmış iş metni/sonucu scrub edilir; eski ders/gözlem/olay silinir. Aktif işler, bütçe ve idempotency kayıtları, paket sürümleri korunur. İşteki `usage` null alanı sıfıra çevrilmez. Eski prompt replay, content_expired gerekçesiyle özgün metni korur. Kullanıcı dışı kapsam değişmez; iki DB testleri geçti.
- Metadata-only destek paketi ve web indirme eylemi var. Prompt/credential/key/device path dışa aktarılmıyor; son 100 yetkili iş/olay/kurulum ve sürüm/limit kaynağı sınırında. Servis kimlik/proje ACL'si yeniden uygulanır. Eski yedeklerin imhası yapılmış gibi gösterilmez.
- Bu çalışma kalıcı paket delete/GC, bütün execution artifact saklama politikası, disk kotası, ayrıntılı run timeline ve bütün telemetri metriklerini bitirmiş sayılmaz; ilgili P11/P10 kutuları açık.

### Güncel doğrulama noktası

`docs/evidence/p11-checkpoint.json` bu ağacın `p11-source-fingerprint.json` kaynak hash'ine bağlıdır. Sırasıyla `bun run typecheck`, gerçek PostgreSQL/Docker dahil `bun test` (**286 pass, 0 fail, 1103 expect / 43 dosya**), `bun run build:plugin` ve `npm pack --dry-run` geçti. Dry-run 26 dosya / 617117 byte; temiz artifact kurulumu ve nihai manifest geçişi hâlâ açık. Mevcut npm JSON çıktısı isim anahtarlı nesnedir; eski array varsayımı kanıt okuyucusunda düzeltildi.

Son tarayıcı kontrolünde iki revision'ın gerçek referans metni yan yana görüldü; web'deki kayıtlı Node script `{value:7.5}` girdisini gerçek Docker sandbox'ta `{doubled:15}` döndürdü (`design/package-browser.png`). Taze kayıtlar için retention sıfır silme bildirdi. Health endpoint'i kimlik istediği için ilk geçici restart yardımcısının anonim ready probe'u yanlış başarısız oldu; yetkili health yanıtı ve `/proc/<pid>/cmdline` ile yalnız sahip olunan yeni servis doğrulandı, yardımcı probe düzeltildi. Servis/model/ürün kabul durumları birbirine karıştırılmadı.

### P03/P04/P10 üyelik ve erişim iptali — ara uygulama

- Migration 009, üyelik devre dışı bayrağı ve çalışma alanı/proje üyelik generation alanları ekliyor. Üye listesi sayfalı; create tekrarında mevcut rol değiştirilmez; update iki generation ile CAS yapar. Sahip üyeliği bu ekrandan devre dışı bırakılamaz/düşürülemez. Projeler ve ayarlar ekranındaki gerçek yönetim formu aynı servise bağlıdır.
- Yetki daraltma, erişimi kalmayan queued/running işleri aynı transaction'da cancelled/permission_revoked yapar ve fence'i artırır. Eski işçi finish/yayın yapamaz. Doğrudan script yürütmesi 500 ms yetki kontrolü, iptal sinyali ve sonuç commit'inde kilitli tekrar kontrolü kullanır.
- SQLite/PostgreSQL üyelik, mevcut oturum iptali, proje rolü tavanı, stale write, reenable ve eski worker fence testleri `docs/evidence/p03-members.log`. Gerçek Docker'da uzun script yetki iptaliyle erken durdu; başarısız execution receipt korunup tekrar çalışmadı (`p06-script-revocation.log`). Canlı OIDC hesabı kabulü değildir.
- Türkçe yönetim/API belgesi `docs/tr/kullanicilar-ve-yetkiler.md`. Uzun bağımlılık kurulumu sırasında cancellation ve bütün P03/P04/P10 kabulü ayrıca tamamlanacak; bu ara işlevler bütün aşamayı bitirmiş sayılmaz.

Üyelik değişikliği sonrası güncel zorunlu sıra: typecheck geçti; `FORGE_TEST_POSTGRES_URL=<owned-db> bun test` **289 pass, 0 fail, 1138 expect / 45 dosya** (`p10-members-full-tests.log`); `bun run build:plugin` geçti (`p10-members-build.log`). Kaynak fingerprint `p10-members-source-fingerprint.json`. Yeni Node servisinde gerçek tarayıcıdan yalnız kabul fixture üyeliği oluşturuldu, çalışma alanı/proje editör rolü kaydedildi ve reload kalıcılığı görüldü; sonra üyelik devre dışı bırakıldı (`design/members-browser.png`). Hiçbir gerçek OIDC hesabı veya kullanıcı istemci ayarı değiştirilmedi. P01–P16 / K01–K30 bütünü hâlâ açık.

### P07 çıktı sınırı ve taşıma düzeltmesi

MCP yanıtı aynı JSON'u hem text content hem structuredContent olarak gönderiyordu. Altı aracın ilan edilmiş outputSchema'sı yok; resmi istemci zinciri text content'i okuyor. Tek metin payload korunup yinelenen structuredContent kaldırılacak. Etki P07/K24: aynı veri iki kez bağlama girmez; makinece okunabilir JSON ve bütün altı araç korunur. Kabul: resmi MCP istemcisi search/load/run zincirini aynı şekilde tamamlar; yanıt structuredContent kopyası içermez; büyük JSON/artifact sayfalaması ve byte sınırı testleri geçer. ChatGPT widget metadata'sı ayrıca kendi ilan edilmiş sözleşmesiyle uygulanacak, bu değişiklik canlı App kabulü sayılmayacak.

### P07/P10 büyük çıktı ve sayfalama — ara uygulama

- Script JSON'u 8 KiB üzerinde ayrı fsync edilmiş artifact'a yazılıyor. Yeni execution kaydı geçici token yerine özel sandbox/artifact konumu saklıyor; yetkili replay/rapor yeni süreli referans çıkarıyor, script tekrar çalışmıyor. Uzun Unicode dosya adlarında da artifact metadata sayfası uygulama JSON zarfını 16 KiB altında tutacak şekilde küçülüyor.
- `forge_report(section="execution")` artifact listesi, `artifact_reference` veya `result_content` ile 24 KiB içerik parçalarını veriyor. Aynı araçlarda kalınıyor; yedinci araç eklenmedi. Eski inline execution sonucu da parçalı okunabiliyor. `forge_load(inventory=true)` ilk dosya özetinin ötesindeki bütün envanteri 40 satırlık sayfalarla veriyor.
- İş listeleri uzun özel sonuç gövdelerini taşımıyor. Tek run ayrıntısı sınırlı; `result_content` ile tam içerik okunuyor. Sonuç hash'ine bağlı cursor, retention sonucu değiştiğinde karışık okuma yerine reddediliyor.
- Gerçek Node Docker fixture'ında 90 paket dosyası, 31 artifact, büyük Türkçe/emoji JSON'unun kayıpsız parçalı okuması, replay ve yanlış proje/imza reddi geçti. Uzun Unicode artifact adları ve eski inline JSON için sınır testi var. Web script sonucu ve iş ayrıntısı aynı parçalı rapor API'sine bağlandı. `docs/tr/mcp-cikti-ve-sayfalama.md` sözleşmeyi açıklıyor. Bu K24'ün 10.000 katalog/yük benchmarkı veya bütün P07/P10 kabulü yerine geçmez.

P07 çıktı değişikliği sonrası güncel sıra: `bun run typecheck` geçti; gerçek PostgreSQL/Docker dahil `bun test` **292 pass, 0 fail, 1211 expect / 46 dosya** (`p07-output-full-tests.log`); `bun run build:plugin` geçti (`p07-output-build.log`). Kaynak `p07-output-source-fingerprint.json` ile bağlıdır. Yeniden başlatılmış Node servisin gerçek web akışında kabul fixture'ı 30.014 byte JSON ve 22 script dosyası üretti: JSON ayrı artifact ile toplam 23 dosya oldu, 10/10/3 sayfalandı; sonuç 24.576 ve 5.438 karakterlik ASCII parçalarıyla tamamlandı. Son sayfa/bölümde devam düğmesi yoktu, UI hata göstermedi (`design/output-pages-browser.png`). Bu bir gerçek sandbox/arayüz sözleşme kontrolüdür; canlı model kalitesi veya 10.000 katalog yük kabulü değildir.

### P06 bağımlılık iptali ve gerçek Python kurulumu — ara uygulama

- Bağımlılık hazırlama artık yürütmenin AbortSignal'ini taşıyor; cache taraması ve yayın öncesi kontrol dahil iptal uygulanıyor. `docker run` oluşturma/başlatma yarışını önlemek için süre sınırlı `create`, ardından iptal edilebilir `start --attach` kullanılıyor. Her çıkışta container kaldırılıyor, staging temizleniyor; temizlik hatası başarı olarak gösterilmiyor.
- Gerçek npm testi hem önceden iptal edilmiş isteği hem soğuk kurulum sırasında iptali denetliyor; scope etiketli kalan container ve staging bulunmadığını kontrol ediyor. Üyelik iptaliyle çalışan sandbox'ın durması testi de geçti (`p06-dependency-cancel.log`).
- Resmî PyPI `packaging/25.0/json` kaydından alınan wheel SHA-256 test fixture'ına sabitlendi. Gerçek pip kurulumu, kurulum izni kapalı cache tekrar kullanımı, ağ kapalı Docker içinde Python import/hesaplama ve değiştirilmiş cache'in reddi geçti (`p06-python-dependencies.log`). Bu üretim bağımlılığı güncellemesi veya canlı model kabulü değildir.
- Kurulum sırasında sert disk kotası, bütün egress sınırları, tüm runtime bileşimleri ve P06'nın diğer kabul maddeleri açık; bu kontroller bütün P06'yı bitirmiş sayılmaz.

Bağımlılık değişiklikleri sonrası zorunlu doğrulama sırası tamamlandı: `bun run typecheck` geçti (`p06-dependency-typecheck.log`), gerçek PostgreSQL/Docker dahil `bun test` **293 pass, 0 fail, 1219 expect / 46 dosya** (`p06-dependency-full-tests.log`), `bun run build:plugin` geçti (`p06-dependency-build.log`). Kaynak fingerprint `p06-dependency-source-fingerprint.json`. Bu kaynak değişikliği için yeni tarayıcı kabulü veya bütün ürün teslimi iddia edilmiyor. Başlangıçtaki yedi takipli dist silmesi korunuyor; commit/push/publish yapılmadı.

### P05 sınırlı yeniden tabanlama — uygulama kararı

Manager, eski taban/current/aday dosyalarını hash doğrulamalı immutable revision'lardan karşılaştıracak. Yalnız bir tarafta değişen dosya veya iki tarafta byte-identical sonuç güvenle birleştirilecek; aynı dosyada farklı sonuç (silme/değiştirme dahil) `rebase_conflict` olacak. En fazla bir yeniden yayın denemesi, yeni tabana bağlı bütün doğrulama/script testleri ve CAS/fence/ACL kapıları korunacak. SPR bu manager yolunu kullanacak; insan düzenlemesinde açık seçenek olacak, varsayılan eski 409 sözleşmesi korunacak. Kabul: iki gerçek DB'de ayrı dosya güncellemeleri korunur, aynı dosya çatışması yayınlanmaz, eski revision değişmez, yeniden test başarısızsa aktif sürüm korunur. Bu dosya düzeyindeki sınırlı yol, modelin semantik sahip/aktivasyon değerlendirmesinin tamamı değildir.

P05 sınırlı yeniden tabanlama kaynakta uygulandı: `PackageStore.publishRebased`, insan editörü `rebase` seçeneği ve SPR finalize ortak yolu kullanıyor. SQLite/PostgreSQL sözleşme testleri 18 beklentiyle geçti (`p05-rebase-contract.log`): bağımsız dosyaları koruma, aynı dosya çatışması, eski revision değişmezliği, eksik referans kapısı, aynı sonuç no-op ve pinned reddi. Türkçe belge güncellendi. Sınırsız retry veya otomatik metin içi çatışma çözümü yok. Restart reconciliation ve semantik sahiplik/aktivasyon değerlendirmesi hâlâ açık.

Yeniden tabanlama sonrası zorunlu sıra: typecheck geçti, gerçek PostgreSQL/Docker dahil **295 pass / 0 fail / 1237 expect / 47 dosya** (`p05-rebase-full-tests.log`), build geçti (`p05-rebase-build.log`). Kaynak `p05-rebase-source-fingerprint.json` ile bağlıdır. Yeni Node servisinde gerçek tarayıcıdan kabul fixture referansı düzenlendi, birleştirme kutusu işaretlendi ve sandbox testli yayın `3d4a54e992` sürümüne geçti (`design/rebase-browser.png`). Bu UI kontrolü tek yazarlı yayın akışıdır; eşzamanlı birleştirme kanıtı iki DB sözleşme testidir. Canlı SPR/model ve tüm P05/P10 kabulü olarak gösterilmez.

Tarayıcı ekran görüntüsünde checkbox'ın varsayılan genişlik stili fark edildi; aynı uygulamanın `.checkbox` sınıfı kullanıldı. Görüntü, bu küçük stil düzeltmesinden önceki gerçek yayın adayını gösterir. Son kaynak fingerprint ve zorunlu kontrol logları stil düzeltmesini içerir; görüntü güncel piksel kabulü olarak genişletilmez.

### P05 yeniden başlatmada kayıtlı revision bütünlüğü

Yerel servis işçiyi başlatmadan önce kayıtlı revision'ları 25 öğelik sayfalarla doğrular: immutable manifest revision hash'i, dosya byte sayısı ve SHA-256. Bozulma/eksiklik sağlık yanıtında `package_integrity: degraded` ve toplam sayıyla görünür; aktif pointer veya kullanıcı dosyası değiştirilmez. Tenant admin için `GET /api/packages/integrity` aynı sayfalı kontrolü kullanır; host yolu veya içerik rapora girmez. Server profilinde otomatik tenant taraması henüz yok; `not_scanned` açıkça döner. Bu, DB'ye bağlanmamış tam revision/staging kurtarma ve onarımın tamamı değildir; P05 kutusu açık kalır.

Bütünlük kontrolü sonrası zorunlu doğrulama sırası geçti: `bun run typecheck`, gerçek PostgreSQL/Docker dahil **296 pass / 0 fail / 1245 expect / 48 dosya** (`p05-integrity-full-tests.log`), `bun run build:plugin` (`p05-integrity-build.log`). Kaynak `p05-integrity-source-fingerprint.json`. Yeni restart regresyonu gerçek Fastify servis yaşam döngüsü ve disk bozulmasıyla çalışır (`p05-integrity-contract.log`); tüm tenant kurtarma/onarım kabulü değildir. `git diff --check` planın mevcut üçüncü satırındaki Markdown hard-break boşluklarını bildiriyor; derleme veya test hatası değildir.

### P15 dağıtım önkoşulu — temiz npm artifact kontrolü

`scripts/package-smoke.mjs` gerçek tarball'ı boş geçici projeye `npm install --omit=dev` ile kurar. Kurulu CLI sürümü, kurulu ESM entry'sinden Node servis/SQLite açılışı, web index'i, resmî MCP istemcisinde tam altı araç, proje oluşturma, gerçek ZIP worker import'u ve import edilen paketin search/load zinciri geçti (`p15-clean-package.json`, `p15-clean-package.log`). Rapor tarball integrity ve dosya listesini içerir. Alt süreç environment'i sınırlandı; server profili/sağlayıcı sırları taşınmaz. Geçici proje/data/cache temizlenir. `npm pack --dry-run` da geçti (`p15-pack-dry-run.json`).

Bu Linux x64 / Node 24.19.0 dağıtım önkoşuludur; P14 veri geçişi, nihai sürüm/manifest/legacy bağımlılık temizliği, macOS/Windows, backup/restore ve canlı istemci/model kabulleri açık. Önceki aşamaların tamamlandığı veya P15'in kapandığı iddia edilmez. Tekrar komutu ve kapsam `docs/tr/temiz-paket-kontrolu.md` içindedir.

Paket kontrolü eklenmesi sonrası zorunlu sıra da geçti: `p15-package-typecheck.log`, gerçek PostgreSQL/Docker dahil **296 pass / 0 fail / 1245 expect / 48 dosya** (`p15-package-tests.log`) ve `p15-package-build.log`. Bu tur üretim kaynaklarını/bağımlılıklarını değiştirmedi; temiz kuruluma ait tarball'ın kendi integrity değeri raporda kayıtlıdır. Kullanıcının başlangıçtaki takipli dist silmeleri korunur; public publish yapılmadı.

### P04 bağımsız süreç ve lease kaybı — gerçek fault injection

Yeni `test/worker-process.test.ts` ayrı Bun sürecinde gerçek SQLite kuyruğundan lease alıyor; hazır olduğunu doğruladıktan sonra yalnız bu child'ı SIGKILL ile sonlandırıyor. Sonra gerçek `node dist/cli.js worker` başlıyor. Lease süresi dolunca aynı skill işi daha yüksek fence ile alındı, yapılandırılmamış model nedeniyle dürüst `failed/model_missing` sonucu yazıldı. Eski worker'ın finish'i reddedildi; aynı idempotency anahtarı yeni iş üretmedi. Aynı production worker ayrıca yeni prompt işinde özgün metni `fallback/model_missing` ile korudu; SIGTERM ile exit 0 kapandı (`p04-worker-process.log`, 11 beklenti).

İlk deney prompt kuyruğundaydı: bu kuyruğun max_attempts=1 politikası gereği lease kaybı yeniden model çağrısı yerine fallback üretti. Skill kurtarma ve normal prompt fallback senaryoları ayrıldı; ürün politikası testi geçirmek için genişletilmedi. İlk fixture dizini oluşturma hatası test kurulumunda düzeltildi. Bu kanıt gerçek process/lease/production-handler davranışıdır; canlı model başarılı yanıtı, PostgreSQL süreç çökmesi veya kapsamlı P13 fault/soak kabulü değildir. Test mevcut derlenmiş CLI artifact'ını çalıştırır; release kontrolünde build sonrası da koşmalıdır.

Fault injection sırasında eski `run_attempts` kaydının açık kalabildiği görüldü. Kuyruk, süresi dolmuş running lease'i tekrar değerlendirirken aynı transaction'da o fence'e ait açık denemeyi `lease_expired` ve bitiş zamanı ile kapatıyor. Yeni fence/deneme ayrı kalıyor; eski denemeye sonradan success yazılmıyor. Process testi iki ek beklentiyle bunu denetliyor. Dağıtım CLI'sını kullanan test için yeni source önce derlendi; ardından zorunlu tam test ve son derleme sırası çalıştırıldı.

Güncel process doğrulama noktası: typecheck geçti; gerçek PostgreSQL/Docker ve bağımsız Node worker dahil **297 pass / 0 fail / 1257 expect / 49 dosya** (`p04-process-full-tests.log`); son build geçti (`p04-process-build.log`). Kaynak `p04-process-source-fingerprint.json`. Kullanıcı değişiklikleri korunur; canlı model kalitesi ve PostgreSQL process-crash testi hâlâ ayrıca doğrulanmalıdır.

### P04/P10 PostgreSQL süreç kurtarma ve deneme geçmişi

Aynı SIGKILL/lease devralma testi PostgreSQL için ayrı oluşturulan geçici veritabanına genişletildi. Gerçek server-profile Node worker, pg-boss ve outbox üzerinden işi aldı; fence/expired attempt/idempotency/fallback/graceful shutdown kontrolleri geçti (`p04-postgres-process.log`). Test sonu yalnız oluşturulan DB kaldırılır. OIDC fixture adresine bağlanılmaz; kimlik/model kabulü değildir.

`JobQueue.attempts` ve yetkili `GET /api/runs/:id/attempts` en fazla 20 denemeyi sayfalar; sahibi ve güncel proje ACL'si kontrol edilir. Web İşler ayrıntısında gerçek başlangıç/bitiş, lease kaybı, sonuç ve yenileme gösterilir. İki DB process testinde geçmişin sırası, bitiş kayıtları, cursor ve başka kullanıcı reddi eklenmiştir. SSE/retry eylemleri ve bütün P10 kabulü açık kalır.

Deneme geçmişi güncel kanıtı: typecheck geçti; **298 pass / 0 fail / 1281 expect / 49 dosya**, PostgreSQL/Docker ve her iki backend için bağımsız süreç dahil (`p10-attempt-full-tests.log`); build geçti (`p10-attempt-build.log`). Kaynak `p10-attempt-source-fingerprint.json`. Yeniden başlatılan gerçek Node servisinin web İşler ayrıntısında mevcut fallback işinin deneme başlangıç/bitişi ve son sayfa düğmelerinin kapalı durumu görüldü (`design/attempt-history-browser.png`). Lease-crash senaryosunun kanıtı process testidir; bu tek denemeli tarayıcı kaydı crash görüntüsü diye gösterilmez.

### P03 ayar/model yazımı ve eşzamanlı yetki iptali

Model profili yazımı önceki kaynakta yetki/taban sürüm okumasını kalıcı yazımdan ayrı yapıyordu. Yeni işlem, üyelik yöneticisiyle aynı tenant satırını kilitler; kilitten sonra güncel yetki ve CAS tabanı okunur. Ayar yazımı da aynı kilitle sıralanır. Secret yalnız bu kontrollerden sonra yazılır. `provider.updated` audit kaydı sadece rol/sürüm içerir; credential, model adı veya endpoint'i içermez.

SQLite/PostgreSQL testinde aynı tabanla iki profil yazımından yalnız biri başarılı; eski sürüm çatışır. PostgreSQL gerçek transaction kilidi altında iki isteğin ilk yetki okuması gözlenir, üyelik iptali commit edilir, bekleyen profil/personal ayar yazımları 403 olur ve ek revision oluşmaz (`p03-write-lock.log`, 21 beklenti). Bu kimlik iptalinin yazım anındaki sınırını doğrular; canlı OIDC veya bütün P03 kabulü değildir. Secret dosyası yazıldıktan sonra olası DB commit arızasında referanssız şifreli dosya temizliği hâlâ genel GC kapsamında ele alınmalıdır.

Ayar/model kilidi sonrası zorunlu sıra geçti: typecheck (`p03-write-lock-typecheck.log`), gerçek PostgreSQL/Docker/süreç kontrolleri dahil **300 pass / 0 fail / 1303 expect / 50 dosya** (`p03-write-lock-full-tests.log`), build (`p03-write-lock-build.log`). Kaynak `p03-write-lock-source-fingerprint.json`. Bu değişiklik için yeni web görsel kabulü iddia edilmiyor; sunucu uygulama/transaction sözleşmesi gerçek iki DB ile doğrulandı.

### P05 tam dosya envanteri ve sınırlı dizin taraması

Kayıtlı manifest dosyaları hash kontrolünden geçse bile sonradan eklenmiş dosyalar normal `forge_load`/reconciliation yolunda önceki kodda görülmüyordu. Ortak `packageInventory` artık directory handle ile Linux'ta fd'ye bağlı, streaming `opendir` taraması yapar; dosya/link/platform yol kapılarını ve 256 dosya, 1280 toplam dizin/dosya girdisi, 12 derinlik sınırlarını uygular. Yönlendirilmiş üst dizinler reddedilir. Dosya içerikleri ayrı güvenli okuma/hash yolunda kalır.

Paket normal/parçalı okuması ve kayıtlı revision bütünlük taraması gerçek envanteri manifestle karşılaştırır. Yayın da script testleri sonrası envanteri yeniden karşılaştırır; ekstra dosya `candidate_changed` ile durur. Gerçek disk testinde sonradan eklenen dosya seçili SKILL.md okumasında bile `revision_corrupt` oldu; tarama bozulma bildirdi. 1281 boş dizin ve symlink üst dizin reddi geçti (`p05-inventory-contract.log`). Bu runtime izolasyonu, tam GC/recovery veya P05 bütünü yerine geçmez.

Envanter değişikliği sonrası zorunlu sıra geçti: typecheck (`p05-inventory-typecheck.log`), gerçek PostgreSQL/Docker/süreçler dahil **301 pass / 0 fail / 1307 expect / 51 dosya** (`p05-inventory-full-tests.log`), build (`p05-inventory-build.log`). Kaynak `p05-inventory-source-fingerprint.json`. Sonradan eklenmiş dosyanın okunmaması ve boş dizin sınırı yeni gerçek filesystem testleridir; yayın sonrası tüm kurtarma maddeleri tamamlanmış sayılmaz.

### P07/P13 katalog benchmarkı — gerçek çalışma profili

Yeni tekrarlanabilir ölçüm, 10.000 deterministik fixture paketini gerçek yayın/fsync/DB yoluyla oluşturur; ardından derlenmiş Node servisinde resmî HTTP MCP istemcisi kullanır. 10 paket / 10.000 paket discovery application byte karşılaştırması, sabit altı araç, beş öğelik ilk sayfa, cursor tekrar kontrolü ve gerçek load ölçülür. Karma sıcak yük: tek istemciden 300 örtüşen istek, hedef 100 istek/s, yarı search/yarı aynı paket load. Bölüm 16'daki p95 <=250 ms hedefi korunur; tamamlanma hızı ve ham örnekler raporlanır. Bu profil 10/100/1000 ayrı istemci, PostgreSQL yükü veya canlı model kalite deneyi değildir. OS cache düşürülmez; ilk istek cold cache diye etiketlenmez. JSON/CSV/Markdown, dataset hash ve host bilgisiyle üretilir.

### 10.000 katalogda başlangıç hatası — zorunlu teknik düzeltme

İlk gerçek koşu 10.000 paketi 143 saniyede yayımladı; Node servisinin bütün katalog taramasını onReady içinde beklemesi `FST_ERR_HOOK_TIMEOUT` üretti. Ham başarısız kanıt `p07-catalog-startup-failure.json`. Hedef veya dataset küçültülmeyecek. Tarama takip edilen, kapanışta iptal edilebilen arka plan işine taşınacak; health checking/verified/degraded ayrımını koruyacak; worker tarama sonrası başlayacak ve kapanış scan/worker ile yarışmayacak. Kabul: 10.000 paketli servis hook timeout olmadan dinlemeye başlar, doğrulama ilerlemesi gözlenir, scan tamamlanır; bozuk paket ve temiz kapanış regresyonları geçer; aynı katalog benchmarkı yeniden çalışır.

### 10.000 katalog ölçümü — tamamlanan koşu

Aynı dataset ile ikinci koşu tamamlandı: 10.000 tam paket 136.253 ms'de yayımlandı. Node HTTP dinleme 9,9 ms; arka plan bütünlük taraması 10.633 ms ve **10.000 checked / 0 issue / verified**. Böylece ilk koşudaki onReady timeout'u tekrar oluşmadı. SQLite 3.53.4, Node 24.19.0, Linux x64; Ryzen 7 5700G / 16 logical CPU / 46.169.206.784 byte host RAM, disk medyası ölçülmedi. Referans 8 vCPU/16 GiB makineyle aynı ortam iddiası yok.

Discovery application JSON'u 10 pakette **2235 byte**, 10.000 pakette **2240 byte**, her ikisinde ilk sayfa **5 öğe**; araç sayısı **6**. 300 istek, hedef 100 istek/s, tek resmî MCP istemcisiyle yarı search/yarı aynı-package load: gerçek tamamlanma **98,88 istek/s**, hata **0**; p95 search **22,47 ms**, p95 load **145,76 ms** (250 ms hedefi altında). P99 search 26,09 ms / load 153,22 ms. Bunlar kısa sıcak koşu ölçümleridir; sürdürülebilir 100 istek/s, 1000 istemci veya sağlayıcı kapasitesi vaadi değildir.

`p07-catalog-benchmark.json/.csv/.md` ham örnekler, dataset hash, gerçek runtime bundle/lock hash ve sınırları içerir; `p07-catalog-startup-failure.json` ilk başarısız koşuyu korur. Komut `bun scripts/catalog-benchmark.ts 10000`; Türkçe kullanım `docs/tr/katalog-benchmarki.md`. P12 canlı görev kalite kolları, PostgreSQL katalog yükü, 1/10/100/1000 ayrı istemci, handoff ve 30 dakika soak hâlâ açık; P07/P13 bütünü işaretlenmedi.

Katalog/açılış düzeltmesi sonrası zorunlu sıra geçti: typecheck, gerçek PostgreSQL/Docker/süreçler dahil **301 pass / 0 fail / 1307 expect / 51 dosya** (`p07-catalog-full-tests.log`), build (`p07-catalog-build.log`). Ölçülen `dist/index.js` SHA-256 son build ile birebir eşleşti. Kaynak `p07-catalog-source-fingerprint.json`. Yeni paket temiz npm kurulumu, Node/SQLite açılışı, web index, ZIP worker ve MCP search/load zinciri de yeniden geçti (`p07-catalog-clean-package.json`). Büyük katalog taraması devam ederken health checking döner; arka plan taraması bu durum bitmeden başarılı kabul edilmez.

### P13 ayrı MCP istemci matrisi — ölçüm profili

Aynı 10.000 tam paket dataset'iyle `--matrix` modu eklendi. 1/10/100/1000 ayrı resmî MCP istemcisi, her biri en az bir tool çağrısı yapacak şekilde 100 istek/s toplam karma search/load hedefini kullanır. Profillerde en az 300, 1000 istemcide 1000 istek vardır. Aynı yetkili kullanıcı/proje ve aynı load paketine yoğunlaşır; tenant/user ölçeği gibi gösterilmez. Boşta kontrol istemcisi ayrıca raporlanır. Bağlantı süresi, RSS, hata ve latency ham örnekleri tutulur. p95<=250 ms hedefi aşılırsa rapor korunur, komut sıfır olmayan kodla çıkar. Sonuçlar önceki tek istemci raporunun üzerine yazılmaz.

### P13 1/10/100/1000 ayrı istemci — tamamlanan kısa ölçüm

Aynı dataset hash'li 10.000 tam paket yeniden oluşturuldu. Gerçek Node/SQLite/HTTP MCP matrisi: 1 istemcide 300 istek, 10 istemcide 300, 100 istemcide 300, 1000 istemcide 1000 istek; her katılımcı en az bir çağrı yaptı. Büyük profillerde bir boşta kontrol istemcisi ayrıca sayıldı. Hata her profilde **0**. Tamamlanma hızları sırasıyla **99,77 / 99,95 / 100,00 / 99,97 istek/s**.

Search/load p95 (ms): **1: 19,08 / 59,80; 10: 16,85 / 35,43; 100: 11,32 / 14,16; 1000: 10,46 / 11,17**. Hepsi 250 ms hedefinin altında. 1000 istemci bağlantı oluşturma 3026 ms; yük sonu süreç RSS **472.915.968 byte**. Profiller ardışık/sıcak koştu; JIT/cache etkisi ayrıştırılmadı ve daha çok istemcinin sistemi hızlandırdığı iddia edilmez. 1000 ayrı kullanıcı/tenant, uzun soak, PostgreSQL katalog yükü veya canlı sağlayıcı kapasitesi kabulü değildir.

Kanıt `p13-client-matrix.json/.csv/.md` ve `p13-client-matrix.log`; tam runtime/dataset hash ve ham gecikmeler raporda. Önceki tek istemci raporu korunur. P13 kapsamındaki diğer yük/kurtarma maddeleri hâlâ açık.

İstemci matrisi sonrası zorunlu typecheck, gerçek PostgreSQL/Docker/süreçler dahil **301 pass / 0 fail / 1307 expect / 51 dosya** (`p13-matrix-tests.log`) ve build (`p13-matrix-build.log`) geçti. Ölçülen bundle SHA-256 son build ile eşleşti. Bu tur üretim kaynakları değişmedi; benchmark scripti genişletildi ve gerçek 1903 tool ölçüm örneği üretildi. Başlangıçtaki kullanıcı değişiklikleri korunur.

### P13 30 dakika katalog soak hazırlığı

Harness'a `--soak=<dakika>` eklendi. 30×en az 60 saniye, dakikada 6000 karma search/load, toplam 180000 istek hedeflenir; her pencere tam latency quantile, hata, süre, RSS/heap örneği tutar. Ham örnekler dakika sonunda bırakılır; ölçüm tamponu sınırlıdır. Sabit dist/lock kopyasıyla runtime snapshot alınır; sonraki source build çalışan koşuyu değiştirmez. node_modules değişikliği koşu sırasında yapılmayacak. Host paylaşıldığından diğer işler gecikmeyi etkileyebilir. Dakikalık progress dosyası running durumunu açık tutar; final ölçüm olmadan soak kabulü yok. Önce 10 paket/1 dakika harness kontrolü, ardından hedef 10.000 paket/30 dakika koşusu yapılacak.

Soak harness kontrolü: 10 paket / 1 dakika, **6000 istek / 0 hata**, gerçek pencere 60001 ms; search/load p95 10,06 / 10,89 ms (`p13-soak-smoke.json`, `.log`). Bu yalnız harness kontrolüdür. Zorunlu typecheck, gerçek PostgreSQL/Docker/süreçler dahil **301 pass / 0 fail / 1307 expect / 51 dosya** (`p13-soak-tests.log`) ve build (`p13-soak-build.log`) geçti. Bu kontroller asıl koşunun veri hazırlama safhasında çalıştı; seed süresi bu nedenle izole yayın benchmarkı sayılmaz.

Asıl `10000 / --soak=30` koşusu başlatıldı; `p13-catalog-soak.log` ve tamamlanan her dakika `p13-catalog-soak.progress.json` üzerinden izlenecek. Veri hazırlığı ve running ara raporu, 30 dakika tamamlandı kabulü değildir. Nihai JSON üretilmeden sonuç verilmez; process handle korunur ve gözlem timeout'u yeni süreç başlatma gerekçesi yapılmaz.

### P14 salt okunur keşif ve dry-run manifest

`migration-scan --project ... [--legacy-home ...] [--scan-limit ...] [--output ...]` kaynak CLI'ya eklendi. Daemon/config/token oluşturmadan eski project/home skill ve `.skill-power` alanlarını tarar. Paket/files SHA-256, kaynak kimliği, duplicate/case collision, malformed JSON/JSONL sayısı ve açık mapping gereği raporlanır. Prompt/learn metni çıktıya eklenmez. Kişisel learn/rewrites/session-flags ortak kapsama terfi etmez. Output yalnız yeni dosyaya 0600 yazılır; canonical kaynak köküne yazma reddedilir.

İlk gerçek keşif 2048 girdi sınırına takıldı ve truncated olarak korundu (`p14-local-discovery.json`); eski proje transactions dizininde 2951 öğe bulundu. Sınır 1–100000 arası yapılandırılabilir hale getirildi, default4096; taranmayan kökler not_scanned_limit olarak ayrılır. `--scan-limit 10000` ile gerçek ikinci keşif **3065 öğe / 6104682 byte / truncated=false**, **37 ready / 3028 review_required** döndürdü (`p14-local-discovery-complete.json`). Tam metadata manifest kullanıcıya ait geçici özel dizinde tutulur; repository kanıtı yalnız özet/checksum/path içerir. Ready, format doğrulamasıdır; içe aktarım veya script davranış testi kabulü değildir.

Fixture testleri kaynak bytes değişmezliği, özel metnin rapora girmemesi, duplicate, malformed satır, limit durumu ve gerçek Node CLI'nın servis verisi oluşturmamasını/kaynak köküne çıktı yazmamasını denetler (`p14-discovery-contract.log`). Henüz hiçbir gerçek eski öğe aktarılmadı veya silinmedi. İdempotent aktarım/rollback, sahip eşlemesi, learning/flags dönüşümü ve eski runtime kaldırılması açık; P14 kutusu işaretlenmedi. Türkçe komut belgesi `docs/tr/eski-veri-kesfi.md`.

30 dakika katalog soak koşusu bu sırada aynı sabit runtime üzerinde devam ediyor. 17. dakikada 0 istek hatası; bazı dakika load p95 değerleri 250 ms'yi aştı. Hedef başarısızlığı korunur. Paralel doğrulama işlerinin başlangıç/bitişi `p14-validation-overlap.json` ile kaydedildi; paylaşımlı host etkisi saklanmaz.

Keşif değişiklikleri sonrası zorunlu sıra geçti: typecheck (`p14-discovery-typecheck.log`), gerçek PostgreSQL/Docker/süreçler dahil **303 pass / 0 fail / 1323 expect / 52 dosya** (`p14-discovery-full-tests.log`), build (`p14-discovery-build.log`). Kaynak `p14-discovery-source-fingerprint.json`. Soak 20. dakikada halen 0 hata fakat paralel tam test penceresinde belirgin gecikme artışı var (load p95 6726 ms); izole kapasite sonucu değildir ve hedefin geçtiği söylenmez. Uzun koşu halen çalışıyor, final sonucu bekleniyor.

### P13 tamamlanan 30 dakika ölçümü ve açık hedef sapması

`p13-catalog-soak.json/.csv/.md`: 10.000 paket üzerinde gerçek Node/SQLite/HTTP MCP ile 30 dakika, 180.000 istek, 0 istek hatası; süre 1804982.52 ms. `engineering_target_met=false`, komut exit=1: bazı dakikalarda load p95 250 ms üstünde (20. dakikada 6726.28 ms). Testlerle paylaşılan host etkisi `p14-validation-overlap.json` içinde kayıtlıdır; bu etki hedefi geçmiş saymak için kullanılmaz. RSS ilk/son pencereler ve heap ölçümleri ham raporda korunur; sızıntısızlık veya üretim kapasitesi kabulü yapılmadı. Ayrıştırılmış performans tanısı ve düzeltme/yeniden ölçüm açık; P13 kapanmadı.

### P14 atomik paket aktarımı ve receipt geri alma sözleşmesi

Kaynak checksum yeniden doğrulanır; yalnız yeni hedef oluşturulur. Immutable revision yayını, kaynak/kimlik eşlemesi, açık managed/protected/pinned değerleri ve aktarım receipt aynı DB transaction'ında yazılır. Aynı işlem tekrarında receipt döner; mevcut hedefin üzerine örtük yazılmaz. Geri alma kaynak dosyayı/revision'ı silmez, aktarılan hedefi arşivler. Bu özel işlem yalnız aynı kullanıcının kendi receipt'ine ve hedefin değişmemiş generation/revision/flags durumuna uygulanır; kaynakta korunan bayraklar da bu ilk aktarımın parçası olarak geri alınabilir. Sonraki kullanıcı değişikliği, değerler eski haline getirilse bile generation farkıyla geri almayı engeller. Etki P14/K25/K26: genel paket koruma politikasına yeni düzenleme yetkisi eklenmez; yalnız değişmemiş aktarım işlemi geri alınır. Kabul testleri kaynak bytes korunması, checksum reddi, idempotent tekrar, iki DB'de flags korunması, sonraki değişikliği koruma ve receipt sayısını denetler.

`p14-import-contract.log`: SQLite ve PostgreSQL 2 test / 24 assertion geçti; typecheck geçti. Bu servis katmanıdır; CLI aktarım komutu, tam öğe raporu, özel learning/rewrites/flags dönüşümü ve gerçek kullanıcı verisi aktarımı henüz tamamlanmadı. P14 kabulü ilan edilmedi.

Aktarım checkpoint genel doğrulaması: `bun run typecheck` başarılı; PostgreSQL açık `bun test` **305 pass / 0 fail / 1347 assertion / 53 dosya**, 35.14 saniye (`p14-import-full-tests.log`). Ön test derlemesi ve son `bun run build:plugin` geçti. `npm pack --dry-run` ve gerçek tarball'ın temiz dizine production bağımlılıklarıyla kurulması, Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load smoke kontrolü geçti (`p14-import-pack.json`, `p14-import-clean-package.json`). Kaynak fingerprint `p14-import-source-fingerprint.json`. Bu kontroller aktarım CLI'sinin veya canlı model/istemci kabullerinin tamamlandığı anlamına gelmez.

### P14 yerel aktarım komutları ve öğe bazlı rapor

`migration-import --manifest <json> --mapping <json>` ve `migration-rollback --receipt <id>` kaynak CLI'ya bağlandı. Eşleme, manifest checksum'una, seçilmiş source_id'lere, mevcut project_ref'e ve açık managed/protected/pinned değerlerine bağlıdır; `owner: local-owner` yerel cihaz sahibini seçer. Home paketleri yalnız personal kalır; source_id/kök/path ve kapsam tekrar doğrulanır. Manifest/eşleme girişleri bounded ve symlink reddeden okuma kullanır. Her seçilen öğe ayrı recorded/failed sonucu üretir; kısmi hatada exit=1, diğer öğeler devam eder. Değişmiş manifest bütün işlemi, değişmiş kaynak ilgili öğeyi reddeder. Server profilinde yerel sahip taklidi reddedilir; server kimlikli aktarım ve state dönüşümü açık kalır. Scriptli paketler mevcut effective settings ile gerçek Docker validation yolunu kullanır.

Gerçek Node CLI fixture kabulü `p14-batch-contract.log`: kişisel paket + geçersiz kaynak birlikte işlenir, kısmi başarısızlık doğru exit kodunu verir, tekrar aynı receipt'i döndürür, personal sahip/kapsam DB'de doğrulanır, receipt geri alınır, kaynak metni korunur ve yanlış manifest eşlemesi reddedilir. Typecheck, **306 test / 0 hata / 1359 assertion / 54 dosya**, son source build geçti (`p14-batch-full-tests.log`, `p14-batch-build.log`). Kaynak fingerprint `p14-batch-source-fingerprint.json`; Türkçe gerçek komut/eşleme/rapor/geri alma belgesi `docs/tr/eski-veri-kesfi.md` güncellendi. Gerçek kullanıcı verisi bu checkpoint'te taşınmadı; P14 tamamlanma iddiası yoktur.

Aynı checkpoint'in `npm pack --dry-run` ve temiz tarball production kurulumu/Node HTTP/web/altı MCP/ZIP worker import/search/load doğrulaması geçti (`p14-batch-pack.json`, `p14-batch-clean-package.json`). Özel öğrenme geçişi için kaynak incelemesi: legacy `LearningEntry.text` varsayılan 5000 karakter, yeni `LearningStore.save` 1000 karakter ve `retrieve` 500 karakter sınırı kullanıyor. Doğrudan truncate ederek aktarmak kayıpsız kabulü sağlamaz; özgün özel kayıt saklama ile etkin/model bağlamı ayrımı uygulanmadan bu veriler taşınmayacak. Bu açık iş P08/P14 bağımlılığının parçasıdır.

### P08/P10 öğrenme düzenleme, etkinlik ve sürüm geçmişi

011 migration mevcut öğrenme kayıtlarını revision=1 ile geçmişe alır. Yeni kayıt atomik ilk sürüm oluşturur; dedup artık oluşturulmamış UUID yerine mevcut kaydın id/revision değerini döndürür. Ders güncelleme tenant yazma kilidi, yeniden ACL kontrolü, revision CAS, içerik sanitizasyonu ve aynı kapsam duplicate kontrolü kullanır. Devre dışı ders retrieval'dan çıkar; içerik/trigger/disabled değişiklikleri en fazla 20 sürüm tutulur. Ana ders silinmesi veya mevcut retention akışı geçmişi FK cascade ile siler. Webde Düzenle/Etkinleştir/Devre dışı bırak/Geçmiş vardır; eski revision ile gelen form sessizce üzerine yazmaz.

`p08-learning-history-contract.log`: SQLite/PostgreSQL iki test / 26 assertion; sabit dedup id, stale CAS reddi, disable retrieval, başka proje/kullanıcıdan geçmiş reddi, secret reddi, 20 sürüm sınırı ve cascade silme geçti. Typecheck, **308 test / 0 hata / 1385 assertion / 55 dosya**, son build geçti (`p08-learning-history-full-tests.log`, `p08-learning-history-build.log`). Kendi fixture servisi 2459251 PID ile yeniden başlatıldı; gerçek tarayıcıda ders kaydı, devre dışı bırakma, metin düzenleme ve üç sürüm geçmişi görüldü (`docs/evidence/design/learning-history-browser.png`). Türkçe açıklama `docs/tr/ogrenme-gecmisi.md` (P22'de kaldırıldı; tarihçe notu korunur). Bu P08'in canlı model/kalite kabulü veya P14'ün eski learn verisi aktarımı değildir; o işler açık.

Aynı öğrenme checkpoint'inin `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load smoke kontrolü geçti (`p08-learning-history-pack.json`, `p08-learning-history-clean-package.json`). Yeni öğrenme eylemlerinin gerçek HTTP kanıtı ayrıca yukarıdaki tarayıcı akışıdır; paket smoke kontrolü model kalitesi kabulü değildir.

### P08/P14 kayıpsız learn geçişi teknik kararı

Legacy öğrenme kayıtları 5000 karaktere kadar olabilir; mevcut 1000 karakterlik etkin kayıt sınırı kayıpsız geçişi engelliyor. Etkin kayıt/UI düzenleme sınırı 5000'e yükseltilecek; retrieval hâlâ en fazla üç kayıttan 500'er karakter alacak. Özgün learn dosyası checksum ile özel sahip/proje aktarım kaydında byte olarak korunacak; kullanılabilir dersler personal kapsamına atomik aktarılacak. Malformed, sır/yol içeren, sınırı aşan veya kapasite nedeniyle etkinleştirilemeyen kayıtlar raporlanacak; sessiz truncate yapılmayacak. Geri alma yalnız aktarımın oluşturduğu, sonradan değişmemiş dersleri kaldıracak; mevcut duplicate dersleri koruyacak. Etki P08/P14/K25/K26; kabul: 5000'e kadar uzun metin aynen okunur, model bağlamı sınırlı kalır, kaynak byte export roundtrip eşit, tekrar çoğaltmaz, başka kullanıcı okuyamaz, malformed raporu başarılı aktarım olarak gösterilmez.

### P14 learn kayıpsız aktarım uygulaması

012 `learning_imports` migration, özgün byte'ların base64'ünü, checksum/byte sayısını, sahip/proje kimliğini ve öğe raporunu özel DB kaydında tutar. Source dosya başına 16 MiB ve tenant toplamında 128 MiB sınırı vardır. Aynı transaction içinde yalnız kullanılabilir dersler personal kapsama alınır; önceki duplicate dersler değiştirilmez. Metadata raporları özgün özel metni içermez. Hatalı UTF-8/başlık, sanitizasyon/secret/path veya kapasite engelleri review_required olarak kalır; özgün dosya yine eksiksiz export edilebilir. Ana manifest/eşleme yoluna `learning: {enabled: boolean}` seçimi eklendi; sonuç eksikse exit=1. `migration-learning-export` sahip ACL/checksum sonrası özgün byte'ları stdout'a verir; `migration-learning-rollback` yalnız aktarımın yeni oluşturduğu ve değişmemiş dersleri kaldırır, arşiv ve eski duplicate'ler korunur.

`p14-learning-contract.log`: SQLite/PostgreSQL iki test, 36 assertion; >1000 karakter metin aynen saklama, retrieval <=500, private kapsam/kimlik, tekrar, kaynak checksum reddi, secret kaydının etkinleştirilmemesi, değiştirilmiş dersi koruma, malformed byte roundtrip ve geri alma geçti. `p14-learning-cli.log`: gerçek Node CLI manifest/mapping/import/export/rollback zinciri, CRLF dahil byte eşitliği geçti. İlk tam suite'te PostgreSQL fixture önceki kişisel dersle çakıştı (ürün doğru duplicate döndürdü); fixture içeriği koşuya özgü hale getirildi. İlk başarısız log `p14-learning-full-tests.log` korunur; son tekrar sonucu ayrı kaydedilir. Rewrites/flags/server import ve gerçek kullanıcı verisi geçişi hâlâ açık; P14 kapanmadı.

Son doğrulama: typecheck ve son build geçti; **311 pass / 0 fail / 1426 assertion / 56 dosya**, 40.65 saniye (`p14-learning-full-tests-recheck.log`). `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load geçti (`p14-learning-pack.json`, `p14-learning-clean-package.json`). Kaynak fingerprint `p14-learning-source-fingerprint.json`. Bu sonuçlar gerçek kullanıcı verilerinin taşındığı veya model kalitesinin ölçüldüğü iddiası değildir.

### P14/P10 eski rewrite geçmişinin kayıpsız aktarımı

013 migration, özel rewrite arşivleri, ayrı görünür eski kayıtlar ve aktarım-kayıt referanslarını oluşturur. Source checksum, özgün base64 byte'lar ve satır raporu kayıtlarla aynı transaction'da yazılır. `rewrites: true` açık seçimi `migration-import` yolundadır; hatalı satırlar review_required/exit=1, özel metinler metadata raporuna girmez. Eski kayıtlar yeni runs/usage/model kalite kanıtı olarak üretilmez. Applied true/false/absent ayrı korunur; aynı kayıt başka aktarımdan da referanslıysa tek aktarım rollback'i onu silmez. `migration-rewrites-export` checksum doğrulayıp özgün byte'ları verir; rollback arşiv/kaynak dosyayı korur.

Özel HTTP liste/detail API ve Prompt Editor içinde 20 kayıt sayfalama, 400 karakter önizleme, kaynak durum etiketi ve tam metin görüntüleme eklendi. `p14-rewrites-contract.log`: SQLite/PostgreSQL iki test / 36 assertion; 23 kayıt, bounded cursor/no overlap, özel erişim, bilinmeyen applied, malformed raporu, replay, byte roundtrip ve paylaşılan referanslı rollback geçti. Gerçek Node CLI ile kendi tarayıcı fixture servisine iki sentetik kayıt aktarılıp export byte eşitliği doğrulandı (`p14-rewrites-browser-cli.json`). Gerçek yeniden başlatılmış serviste iki applied durumu ve tam metin açma görüldü; sütun hizası görsel kontrolden sonra düzeltildi, tekrar derlenip yeniden başlatıldı (`docs/evidence/design/imported-rewrites-browser.png`, son fixture PID2523844).

Genel kontrol **313 pass / 0 fail / 1462 assertion / 57 dosya**, 41.91 saniye (`p14-rewrites-full-tests.log`). Bundan sonraki yalnız JSX sütun sarmalayıcı/CSS hizalama değişikliği typecheck/build ve taze gerçek tarayıcıyla doğrulandı. Son kaynak fingerprint `p14-rewrites-source-fingerprint.json`. Türkçe komutlar/sınırlar `docs/tr/eski-veri-kesfi.md`. Eski flags/server kimlikli aktarım, gerçek kullanıcı veri geçişi ve P14 nihai runtime kaldırılması açık; P14 kapanmadı.

Son rewrite checkpoint'inin `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load kontrolü geçti (`p14-rewrites-pack.json`, `p14-rewrites-clean-package.json`). Paket kontrolü gerçek eski kullanıcı verisinin aktarımı ya da canlı model kabulü olarak gösterilmez.

### P03/P08/P09/P14 oturum bayrakları bağımlılığı

Kaynak `live.ts:readSessionFlags` bayrakların sessionID bazında olduğunu doğruluyor; yeni `forge_prepare` yalnız proje ve metin aldığı için bunları proje/personal ayarlarına çevirmek kapsamı genişletirdi. Önce opsiyonel kaynak client/session kimliği, sahip/proje/istemci/oturum bazında revision'lı promptEnabled/autoApply tercihleri ve kabul anında immutable effective snapshot bağlantısı eklenecek. Codex/Claude hook mevcut session_id değerini taşıyacak; kimlik yetkisi yine transporttan çözülecek. Etki P03/P08/P09/P14; kabul: aynı kullanıcıda iki oturum birbirini etkilemez, başka kullanıcı/proje tercihi okuyamaz, stale update409, kabul edilmiş iş sonraki değişimden etkilenmez, eski source'suz çağrılar çalışır. Legacy JSON bayrak aktarımı bu temel tamamlandıktan sonra açık session eşlemesiyle yapılacak.

### P03/P08/P09 oturum tercihi ve değişmez kabul bağlantısı

014 migration, tenant/user/project/client-session hash kapsamlı revision'lı tercihleri saklar. Yalnız promptEnabled/autoApply değerleri yazılır; boş values üst kapsam değerlerine dönüşü sağlar. PUT yazıları tenant kilidi + yeniden ACL + revision CAS ile, GET okumaları sahip/proje yetkisiyle çalışır. Kullanıcı başına 10000 kayıt sınırı vardır. `forge_prepare.source` opsiyoneldir; mevcut çağrılar korunur. Kaynak idempotency girdisine dâhil edilir; kuyruk etkin session değerlerini ve sessionPreferenceRevision'ı immutable config_json'a kaydeder. Codex/Claude hook session_id varsa source bilgisini gerçek HTTP isteğine ekler.

`p03-session-contract.log`: SQLite/PostgreSQL iki test / 30 assertion; proje/istemci/oturum ve kullanıcı izolasyonu, stale CAS, izin verilmeyen değer reddi, source'suz uyumluluk, farklı kaynakta idempotency çakışması ve kabul edilmiş snapshot'ın değişmezliği geçti. `p09-hook-session.log`: gerçek localhost HTTP alıcısına çağrılan kaynak hook fonksiyonları iki istemcinin session kimliğini taşıdı; native Codex/Claude olayının canlı çalıştığı iddia edilmez. `p03-session-http.log`: gerçek servis HTTP PUT/GET → forge_prepare → kalıcı kuyruk/production handler zinciri, editörü kapalı oturumda özgün metinle unchanged döndürdü. Türkçe sözleşme `docs/tr/oturum-tercihleri.md` (P22'de kaldırıldı; tarihçe notu korunur). Bu temel eski session-flags dosyasının aktarımı değildir; açık eski-yeni session eşleme dönüşümü devam eden P14 işidir.

Son doğrulama: typecheck, **317 pass / 0 fail / 1497 assertion / 60 dosya**, 43.14 saniye ve son build geçti (`p03-session-full-tests.log`, `p03-session-build.log`). Kaynak fingerprint `p03-session-source-fingerprint.json`. `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load geçti (`p03-session-pack.json`, `p03-session-clean-package.json`). Session HTTP testi Fastify injection ile gerçek route/auth/queue/handler yaşam döngüsünü, hook testi gerçek TCP HTTP taşımasını denetler; canlı native istemci/model kabulü olarak birleştirilmez.

### P14 session-flags dönüşümü

015 migration ve `sessions` açık eşlemesi eski sessionID → hedef client/session bağlantısını aynı sahip/proje kapsamıyla kurar. Legacy enabled/autoAccept, yeni promptEnabled/autoApply olur; eksik alanlar için kaynak varsayılanları mapping'de açık verilir. Malformed kayıt eski güvenli autoAccept=false davranışıyla uygulanır ve review_required olarak raporlanır; malformed belge veya olmayan session hedefi değiştirmez. Seçilmemiş kaynak oturum sayısı unselected olarak görünür. Kaynak bytes/checksum ve önceki değerler/uygulanan revision'lar tek transaction'da arşivlenir. Session preference yazma servisi aynı transaction içinde tekrar kullanılabilir hale getirildi; CAS affected-row kontrolü eklendi. Rollback önceki açık değerleri yeni revision ile geri yazar; bir hedef sonradan değişmişse bütün geri alma durur, revision ABA oluşmaz. Kaynak/arşiv korunur. `migration-flags-export` ve `migration-flags-rollback` gerçek CLI komutlarıdır.

`p14-flags-contract.log`: SQLite/PostgreSQL flags + session sözleşmeleri, 4 test / 66 assertion; açık eşleme, kaynak byte eşitliği, güvenli malformed davranışı, replay, özel erişim, unselected sayısı, stale hedef, monotonic rollback ve bütün transaction'ın değişmiş hedefte geri alınmaması geçti. `p14-flags-cli.log`: gerçek Node CLI üç geçiş türü zinciri, session flag import/export/rollback ve DB'de hedef değerler dahil 3 test / 24 assertion geçti. Typecheck, **320 pass / 0 fail / 1540 assertion / 61 dosya**, 45.38 saniye ve son build geçti (`p14-flags-full-tests.log`, `p14-flags-build.log`). Türkçe mapping/sınır/rollback sözleşmesi `docs/tr/eski-veri-kesfi.md` içinde güncellendi. Gerçek kullanıcı verisi aktarımı ve server kimlikli aktarım, diğer legacy state türleri ve P14 nihai runtime temizliği açık; P14 kapanmadı.

Son flags checkpoint kaynak fingerprint'i `p14-flags-source-fingerprint.json`. `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load kontrolü geçti (`p14-flags-pack.json`, `p14-flags-clean-package.json`). Kullanıcıya ait yedi eski dist silinmesi korunuyor; commit/push/public yayın yapılmadı.

### P14 kimlikli sunucu byte aktarımı

`POST /api/migrations/import`, package/learning/rewrites/flags için bounded canonical base64 byte'ları kabul eder. Transport kimliği kullanıcıyı belirler; strict body user_id/host path kabul etmez. Proje write ACL decode/ZIP açılımından önce tekrar denetlenir. Package scope/flags açık, özel belgeler kişisel kalır. PackageStore receipt/yayın yolu local directory ve bounded ZIP için ortak importSnapshot'a çıkarıldı; local idempotency kısa devresi korunur. Paket açılımı worker, script doğrulaması hedef effective Docker politikası üzerinden çalışır. Kimlikli rollback ve belge original download endpoint'leri aynı servisleri kullanır. Yerel owner token server profile'da kimlik vermez; cookie yazılarında CSRF devam eder.

`p14-transfer-contract.log`: SQLite/PostgreSQL yerel importer + server-profile HTTP fixture testleri, 4 test / 68 assertion. Dört türde import/export/rollback, package replay, canonical base64 reddi, forged user_id reddi, eksik CSRF ve local owner-token reddi, başka yetkili tenant owner'ın özel original/rollback'e erişememesi geçti. Server-profile kimliği testte doğrudan oluşturulmuş geçerli session fixture'ıdır; canlı harici OIDC akışı değildir. Fastify injection gerçek route/auth/DB/worker yaşam döngüsünü denetler; ayrı uzak ağ/istemci kabulü yapılmış sayılmaz.

İlk tam suite `p14-transfer-full-tests.log` bakım PostgreSQL fixture'ının paylaşılan kişisel kapsamdaki eski test kayıtlarını sayması nedeniyle başarısız oldu. Bakım testi ayrı tenant/user ile izole edildi; ürün rapor kapsamı daraltılmadı. `p14-transfer-maintenance-recheck.log` iki backend'de 2 test / 48 assertion geçti. Son suite ayrı logda saklanır. Türkçe HTTP sözleşmesi `docs/tr/sunucu-veri-aktarimi.md`; uzak manifest yükleyen CLI ve gerçek kullanıcı veri geçişi, kalan legacy state/runtime temizliği açık.

Son transfer doğrulaması: typecheck, **322 pass / 0 fail / 1584 assertion / 62 dosya**, 47.46 saniye ve son build geçti (`p14-transfer-full-tests-recheck.log`, `p14-transfer-build.log`). Fingerprint `p14-transfer-source-fingerprint.json`; `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load geçti (`p14-transfer-pack.json`, `p14-transfer-clean-package.json`). P14 veya genel ürün tamamlandı olarak işaretlenmedi.

### P14 uzak manifest yükleme CLI

`migration-upload`, localConfig/daemon/veri dizini oluşturulmadan mevcut keşif/eşleme doğrulamasını çalıştırır; owner=authenticated-user, --server-url/--tenant-id ve SKILL_FORGE_REMOTE_TOKEN gerektirir. Yerel ve uzak yol aynı source_id/kök/scope/collision/seçim kontrolünü paylaşır. Belgeler ve paket dosya checksum'u gönderimden önce doğrulanır; paket klasik ZIP, belgeler özgün byte olarak kimlikli HTTP endpoint'ine gider. HTTPS veya loopback HTTP origin, redirects:error, 180 saniye istek sınırı, 2 MiB bounded yanıt ve receipt/record şeması uygulanır. Token ve rastgele remote yanıt alanları rapora taşınmaz. Local owner eşlemesi uzak kimlik diye yorumlanmaz.

`p14-upload-contract.log`: gerçek Node CLI/TCP HTTP üzerinden dört tür upload, aynı seçimde dört replay, client veri dizininin oluşmaması, kaynak korunması, checksum değişmiş öğenin gönderim öncesi reddi ve token'ın stdout/stderr'de bulunmaması geçti. Ayrı gerçek HTTP redirect testi ikinci sunucuya istek/token taşınmadığını doğruladı. Yerel migration CLI regresyonlarıyla toplam 5 test / 41 assertion. Hedef gerçek yerel servis bearer fixture'ıdır; harici canlı OIDC sağlayıcı kabulü değildir. Türkçe komut/kimlik/rapor sözleşmesi `docs/tr/sunucu-veri-aktarimi.md`.

Uzak upload son doğrulaması: typecheck, **324 pass / 0 fail / 1601 assertion / 63 dosya**, 51.98 saniye ve son build geçti (`p14-upload-full-tests.log`, `p14-upload-build.log`). `npm pack --dry-run` ve gerçek tarball temiz production kurulumu üzerinden Node CLI/HTTP/web/altı MCP aracı/ZIP worker import/search/load geçti (`p14-upload-pack.json`, `p14-upload-clean-package.json`).

### Çalışma ağacı değişimi ve izole devam — 2026-09-05

Çalışma sırasında ana dizinin dışarıdan commit edilip başka dala geçirildiği gözlendi. Reflog: 19:21:03 +0300 `8ba0f6214ccb9d5713cb61ff9bc3c51ca39c14f5` (Refactor skill forge implementation), 19:21:04 main → codex/spr-skill-authoring-policy-v2. Kod, plan ve upload test/paket kanıtlarının bu commit'te korunduğu doğrulandı; veri kaybı yok. Ana dizinin yeni dalı değiştirilmeden aynı commit'ten `/home/ugur/Projects/opencode2-skill-forge-mcp`, `codex/skill-forge-mcp-delivery` worktree'si oluşturuldu. Devam eden hedefin etkin checkout'u budur. Bun frozen lock kurulumu manifest/lock değiştirmedi; kaynak fingerprint fdf4765cfa4aa6aaabdcdf6d8392ab5a13ca986163fda31610f611ad583a3176 önceki kanıtla eşit. Yeni worktree typecheck/build ve Node better-sqlite3 bağlantısı ayrıca kontrol edildi (`worktree-continuation-typecheck.log`, `worktree-continuation-build.log`). Bu dal değişimi görev tamamlanması değildir; kalan P01–P16/K01–K30 işleri açık.

### P14 üretim bağımlılık sınırı

Kaynak incelemesi yeni index/CLI/archive worker girişlerinin OpenCode wrapper'ına ulaşmadığını, yalnız eski editor-session/persist karakterizasyonunun `@opencode-ai/client/service` kullandığını gösterdi. Kullanılmayan `@opencode-ai/ai` ve `@opencode-ai/plugin` doğrudan bağımlılıkları kaldırılıyor; client sabit sürümü yalnız devDependencies altında tutuluyor. Eski tehdit testleri ve byte-identical çekirdek fixture korunuyor. Kabul: typecheck, tüm SQLite/PostgreSQL testleri, kaynak build, npm dry-run ve temiz production tarball kurulumunda tüm iç içe node_modules ağaçlarında sıfır @opencode-ai paketi; aynı kurulumda Node HTTP/web/altı MCP/ZIP import/search/load çalışmalı. Bu adım eski kaynakların test alanına nihai taşınması, gerçek kullanıcı verisi aktarımı veya P14 tamamlanması değildir.

Üretim bağımlılık temizliği doğrulandı: typecheck, **324 pass / 0 fail / 1600 assertion / 63 dosya / 52.45 saniye**, son source build ve npm dry-run geçti (`p14-runtime-typecheck.log`, `p14-runtime-tests.log`, `p14-runtime-build.log`, `p14-runtime-pack.json`). Gerçek tarball'ın temiz `npm install --omit=dev` kurulumunda **production_opencode_packages: []** ve Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p14-runtime-clean-package.json`). Kaynak fingerprint `p14-runtime-source-fingerprint.json`; komut ve bağımlılık ağacı denetimi `docs/tr/temiz-paket-kontrolu.md` içinde. Sürüm yükseltilmedi, public yayın yapılmadı; eski kaynak/README/paket kapsamının nihai temizliği ve diğer P14 kabulleri açık.

### P14 eski host kaynaklarının test alanına ayrılması

Üretim kaynağındaki son legacy bağ, dört yeni modülün context-snapshot içinden sanitizasyonu import etmesiydi. Davranışı değiştirmeden bounded secret redaction `src/prompt/sanitize.ts` içine çıkarılıyor; eski context testleri de aynı üretim fonksiyonunu kullanacak. Wrapper, core options/runtime/handoff ve eski prompt-editor host kodu `test/legacy-runtime/` altına taşınıyor; test importları güncelleniyor ve bu alan typecheck kapsamında kalıyor. Korunmuş `test/fixtures/legacy` manifestli dosyalar değişmeyecek. Kabul: src'de OpenCode/legacy-runtime importu olmaması, eski tehdit testlerinin tümü, SQLite/PostgreSQL suite, build ve temiz tarball smoke. Bu kaynak sınırı değişikliği eski veri geçişi veya canlı model eşdeğerliği kabulünü tek başına kapatmaz.

Kaynak ayrımı tamamlandı: yeni servis yalnız `src/prompt/sanitize.ts` kullanıyor; wrapper/core host modülleri ve eski prompt-editor host kodu `test/legacy-runtime/` altında. Typecheck kapsamı korunuyor; test senaryoları silinmedi. Typecheck, **324 pass / 0 fail / 1601 assertion / 63 dosya / 49.07 saniye**, son build ve npm dry-run geçti (`p14-source-boundary-typecheck.log`, `p14-source-boundary-tests.log`, `p14-source-boundary-build.log`, `p14-source-boundary-pack.json`). Beş manifestli fixture hash'i aynı (`p14-source-boundary-fixtures.json`). Temiz tarball production kurulumunda sıfır OpenCode bağımlılığı ve Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p14-source-boundary-clean-package.json`). Kaynak fingerprint `p14-source-boundary-fingerprint.json`. Root README ve paketlenen eski agent JSONC tanımları sonraki P14 temizliği olarak açık; canlı model/istemci ve gerçek veri kabulü sağlandı denmiyor.

### P14/P15 dağıtım belgeleri ve eski build temizliği

Root README mevcut kaynak CLI/servis mimarisiyle Türkçe yenilendi; yayımlanmamış paket ile eski npm sürümü, fixture/native/model/OS kabulleri ayrı belirtiliyor. Package files eski OpenCode agent JSONC tanımlarını çıkartıp `docs/tr` rehberlerini dahil ediyor. Eski Bash wrapper build'i korunmuş dist çekirdeği isteyen geçersiz yolu bırakıp Node source build'e yönlenen compatibility girişine dönüştürüldü. Paket adı/sürümü değiştirilmedi. Kabul: README komutlarını mevcut CLI ile karşılaştırma; typecheck/test/build; npm dry-run dosya listesinde legacy agent/test kaynağı olmaması, Türkçe rehberlerin bulunması; temiz tarball çalıştırma.

Belge/paket temizliği doğrulandı: typecheck, **308 pass / 0 fail / 1356 assertion / 63 dosya / 43.39 saniye**, source build, yeni compatibility shell girişinin gerçek çağrısı ve npm dry-run geçti (`p14-docs-typecheck.log`, `p14-docs-tests.log`, `p14-docs-build.log`, `p14-docs-compat-build.log`, `p14-docs-pack.json`). Bu tur PostgreSQL bağlantı değişkeni verilmedi; iki DB'li son kapsamlı kanıt önceki source-boundary checkpoint'indedir. CLI help/version gerçek Node ile alındı. README'nin 14 yerel bağlantısı tarball'da mevcut; 12 Türkçe rehber paketleniyor, eski agent JSONC yok. Temiz production tarball smoke yeni distribution_boundary denetimi ve sıfır OpenCode bağımlılığı ile Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p14-docs-clean-package.json`). Parmak izi `p14-docs-fingerprint.json`. Root agent tanımları yalnız mevcut legacy karakterizasyon testleri için depoda tutulur; dağıtımda değildir. P14 gerçek veri geçişi ve P15'in diğer işletim/canlı kabul işleri açık.

### P14 paylaşılan öğrenme aktarımı geri alma koruması

Kaynak incelemesi bir veri kaybı yolu gösterdi: A aktarımının oluşturduğu ders B aktarımında duplicate olarak kullanılırken A rollback yalnız revision kontrolüyle dersi silebiliyor. Receipt'ler aynı personal kapsamındaki farklı projelerde olabilir. Geri alma öncesi aynı tenant/sahibin diğer applied receipt'lerindeki referanslar bounded sayfalama ile denetlenecek; bağımlı aktarım varken `migration_target_referenced` 409 ile bütün işlem duracak. Önce bağımlı duplicate aktarımı geri alıp ardından oluşturan aktarımı geri almak desteklenecek. Kaynak/arşiv korunacak, başka kullanıcı/proje ayrıntıları hata yanıtına konmayacak. Etki P14/K25: geri alınabilirlik bağımlılık sırasını izler ve diğer aktarımın kullanılabilir verisini silmez. Kabul: SQLite/PostgreSQL farklı projelerde duplicate, ilk rollback'in hiçbir hedefi/receipt'i değiştirmemesi, bağımlı rollback sonrası asıl rollback ve özgün byte eşitliği.

Öğrenme referans koruması: SQLite/PostgreSQL dört odaklı test / 54 assertion geçti (`p14-learning-references-contract.log`). Typecheck ve son build geçti; tüm suite **326 pass / 0 fail / 1619 assertion / 63 dosya / 50.07 saniye** (`p14-learning-references-tests.log`). Farklı projede aynı personal derse duplicate referansı korunur; ilk geri alma receipt/derse dokunmaz, bağımlı geri alma dersi silmez, ardından asıl geri alma çalışır ve iki özgün kaynak arşivi aynı kalır. Türkçe geri alma sırası `docs/tr/eski-veri-kesfi.md` içinde güncellendi. Gerçek eski kullanıcı kayıtları bu testlerde kullanılmadı.

Aynı checkpoint'in npm dry-run ve temiz production tarball kontrolü de geçti (`p14-learning-references-pack.json`, `p14-learning-references-clean-package.json`): dağıtım sınırı, sıfır OpenCode üretim bağımlılığı, Node HTTP/web/altı MCP/ZIP worker import/search/load. Kaynak fingerprint `p14-learning-references-fingerprint.json`. Genel P14/P15/P16 ve canlı kabul işleri açık kalır.

### P08/P03 öğrenme silme yetkisinin atomikliği

`LearningStore.remove` yetki okuması ile DELETE'i ayrı yapıyordu; proje üyeliği arada kaldırılırsa silme eski yetkiyle gerçekleşebilirdi. Save/update ve MemberService ile aynı tenant yazma kilidi altında transaction içinde yeniden yetkilendirme ve silme uygulanıyor. Kabul: PostgreSQL gerçek kilit bekleme kanıtı sırasında proje erişiminin kaldırılması, bekleyen silmenin 403 dönmesi ve ders/geçmişin korunması; SQLite iptal edilmiş erişimin reddi; yeniden erişim sonrası silme ve history cascade. Bu P03/P08 ACL sözleşmesinin düzeltmesidir, yeni yetki vermez.

İlk PostgreSQL gözlem testi aynı transaction içindeki pg_stat_activity görünümü yeni bağlantıyı görmediği için başarısız oldu (`p08-delete-lock-contract.log`, `p08-delete-lock-contract-recheck.log`); ilk genel suite de bu gözlem hatasını içerdi (`p08-delete-lock-tests.log`: 327 pass / 1 fail). Gözlem ayrı bağlantıdan yapıldığında gerçek `pg_blocking_pids` bekleme kanıtı elde edildi: **2 pass / 0 fail / 13 assertion** (`p08-delete-lock-contract-final.log`). Üretim silme transaction'ı değiştirilmedi; testin gözlem bağlantısı düzeltildi. SQLite iptal sonrası ret; PostgreSQL kilit bekleyişi sırasında erişim kaldırma, 403, ders/geçmiş koruma ve erişim geri verildiğinde cascade silme doğrulandı.

İkinci genel koşuda yeni silme testleri geçti; farklı eski `members.test.ts` testi 50'yi aşan ortak PostgreSQL fixture üyeleri içinde yalnız ilk sayfaya baktığından başarısız oldu (`p08-delete-lock-tests-recheck.log`). Test mevcut cursor sayfalamasını izleyerek kendi oluşturduğu üyeyi bulacak şekilde düzeltildi; ürünün liste limiti artırılmadı ve gerçek kullanıcı verisine dokunulmadı. Son genel tekrar ayrı kanıt dosyasındadır.

Son tekrar tamamlandı: typecheck, **328 pass / 0 fail / 1632 assertion / 64 dosya / 49.46 saniye**, source build ve npm dry-run geçti (`p08-delete-lock-typecheck.log`, `p08-delete-lock-tests-final.log`, `p08-delete-lock-build.log`, `p08-delete-lock-pack.json`). Temiz production tarball'da dağıtım sınırı, OpenCode bağımlılığı yokluğu, Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p08-delete-lock-clean-package.json`); kaynak fingerprint `p08-delete-lock-fingerprint.json`. Öğrenme silme davranışı Türkçe rehbere işlendi. Bu ACL düzeltmesi genel hedefin kalan canlı model/istemci/işletim/benchmark kabullerini kapatmaz.

### P15 yerel stop komutu

Yerel daemon otomatik başlatılabiliyor ancak CLI stop eksikti. Yerel owner Bearer kimliği gerektiren, cookie/ortak server profiline kapalı shutdown endpoint ve CLI stop ekleniyor. PID üzerinden sinyal gönderilmez; servis kendi Fastify/worker/storage kapanışını yapar. CLI kimlikli health/stop yanıtını doğrular, bildirilen sürecin çıkışını bekler; bağlantı timeout'unu stopped saymaz. Kabul: gerçek Node serve süreci, yanlış token reddi, stop sonrası süreç çıkışı/port kapanışı, ikinci stop idempotent, yeniden başlatma ve mevcut SQLite verisinin korunması. Server profili için işletim sistemi/container lifecycle kullanılmaya devam eder.

İlk stop fixture yanlışlıkla Bun test sürecinin `process.execPath` değerini kullanarak Bun CLI çalıştırdı; ikinci stop'un bağlantı hata biçimi Node'dan farklı olduğu için başarısız oldu (`p15-stop-contract.log`). Test dağıtım hedefi olan gerçek `node` komutunu kullanacak şekilde düzeltildi; Node durdurma/yeniden başlatma geçti (`p15-stop-contract-recheck.log`). Bu Bun üretim desteği iddiası değildir; paket engine Node 24'tür.

Cookie kabul testi ilk gövdesiz pairing isteğine JSON content-type eklediği için genel koşu başarısız oldu (`p15-stop-tests.log`, `p15-stop-cookie-contract.log`). Test isteği CLI'nın gerçek gövdesiz pairing biçimine düzeltildi; gerçek Node serve üzerinde **1 test / 10 assertion** geçti (`p15-stop-cookie-contract-recheck.log`): yanlış token401, geçerli cookie+CSRF403, owner stop/süreç çıkışı/port kapanışı, ikinci stop ve veriyi koruyan restart. Üretim endpoint yetkisi bu düzeltmede genişletilmedi.

Stop son doğrulaması: typecheck, **329 pass / 0 fail / 1642 assertion / 65 dosya / 53.06 saniye** (SQLite/PostgreSQL dahil), source build ve npm dry-run geçti (`p15-stop-typecheck.log`, `p15-stop-tests-final.log`, `p15-stop-build.log`, `p15-stop-pack.json`). Temiz production tarball kontrolü mevcut Node HTTP/web/altı MCP/ZIP worker import/search/load ve dağıtım sınırını geçti (`p15-stop-clean-package.json`). Stop/restart kabulü yukarıdaki ayrı gerçek Node CLI süreci testidir; temiz paket smoke'unun stop çalıştırdığı iddia edilmez. Kaynak fingerprint `p15-stop-fingerprint.json`. README stop kullanımını açıklıyor. Linux kabulü macOS/Windows, ortak sunucu veya canlı model kapanış kabulü değildir; P15 kalan kapsam açık.

### P15 CI kaynak kapıları

Depoda workflow yoktu. Lint sabit legacy bundle'ı tarıyor, format ise byte-identical fixture ve geçmiş kanıt dosyalarını değiştirmek istiyordu. Bu değişmez artifact'lar ile append-only plan format kapsamından açıkça çıkarılacak; üretim/test/web/script kaynakları kontrol kapsamında kalacak. Bilinçli path control-character reddi ve cleanup başarısızlığının önceliği yalnız ilgili satırda gerekçelendirilecek; kullanılmayan type importu kaldırılacak. Linux tam SQLite/PostgreSQL/Docker suite ve Linux/macOS/Windows temiz package/CLI kontrol matrisleri eklenecek. Action sürümleri resmi GitHub release API'den doğrulanıp commit SHA'larına sabitlenecek. Yerel kontroller workflow'un GitHub veya diğer OS'lerde çalıştığı sayılmayacak.

CI workflow `.github/workflows/verify.yml` eklendi; iki job grubu (Linux tam sözleşmeler ve üç OS artifact matrisi), read-only izinler, sabit action SHA'ları (`p15-ci-actions.json`). YAML parser ile açıldı; uzak job çalıştırılmadı. Windows npm.cmd shell bağımlılığını önlemek için temiz paket scripti Windows'ta Node dağıtımındaki npm-cli.js'yi Node ile çağırır; bu dalın gerçek Windows kabulü matris çalışmasına bağlıdır. Lint/format/typecheck geçti (`p15-ci-lint.log`, `p15-ci-format-recheck.log`, `p15-ci-typecheck.log`); ilk format koşusunda jobs-contract dosyası ikinci biçimlendirme gerektirdi. Beş korunmuş fixture hash'i aynı kaldı. Türkçe kapsam/tekrar komutları `docs/tr/surekli-dogrulama.md` içindedir.

CI yerel doğrulaması tamamlandı: **329 pass / 0 fail / 1642 assertion / 65 dosya / 53.76 saniye**, son source build, npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p15-ci-tests.log`, `p15-ci-build.log`, `p15-ci-pack.json`, `p15-ci-clean-package.json`). Kaynak fingerprint `p15-ci-fingerprint.json`; workflow SHA ve `remote_execution: not_run` kaydı `p15-ci-workflow.json`. Workflow henüz GitHub'a gönderilip çalıştırılmadı; macOS/Windows ve uzak job kabulleri açık. Ücretli/live testler ve diğer P15/P16 teslim ölçütleri tamamlandı olarak işaretlenmedi.

### P15 container readiness sınırı

Ortak sunucunun mevcut /health ve /ready endpoint'leri kullanıcı kimliği ister; container'a kullanıcı/owner credential koymak doğru olmaz. Ayrı minimal `/health/live` ve `/health/ready` endpoint'leri yalnız durum döndürecek; readiness startup/worker hazırlığı ve DB bağlantısını denetleyecek, ayrıntılı eski endpoint'ler kimlikli kalacak. Host/Origin doğrulaması korunacak. Container non-root, özel veri volume'u ve kaynak build kullanacak; host Docker socket varsayılan bağlanmayacak. Kabul: kimliksiz minimal durum, kimlikli ayrıntıların korunması, gerçek container build/start/health, stop ve volume yeniden kullanım testi. Ortak server/TLS/OIDC canlı kabulü ayrıca doğrulanacak.

Container temel teslimi: Dockerfile kaynak build + ayrı production/native dependency aşaması + non-root son imaj; Compose PostgreSQL/özel volume/read-only/tmpfs/cap-drop ve host-loopback yayını; Caddy host reverse proxy örneği; Türkçe server işletim rehberi eklendi. İlk native build Python/C++ araçları eksikliğiyle durdu (`p15-container-build.log`); bu araçlar yalnız dependency stage'e eklenince build geçti (`p15-container-build-recheck.log`, `p15-container-build-final.log`). Node base digest'in gerçek sürümü 24.20.0; Bun builder 1.3.14 digest'e sabitlendi.

Gerçek son container smoke (`p15-container-smoke-final.json`) Linux/local profilde UID1000, read-only root, Docker health healthy, SIGTERM çıkışı, aynı volume ile proje verisinin korunması ve OpenCode production dependency yokluğunu doğruladı. Kendi container/volume'u temizlendi. Compose `config --quiet` sentetik değerlerle geçti; **gerçek server/TLS/OIDC çalıştırılmadı**. Varsayılan Compose script execution worker dağıtımı henüz tamamlanmadı; Docker socket/host fallback eklenmedi. Bu açık sınırlar `docs/tr/container-sunucu.md` içinde. Docker tanımları/health/smoke/workflow hash'leri `p15-container-definition.json`.

Minimal public live/readiness probe'ları yalnız durum döndürür; ayrıntılı health/ready kimlikli kalır, Host/Origin kontrolü korunur. Odaklı servis testleri 5 pass / 20 assertion (`p15-container-probes.log`). Lint/format/typecheck ve tam SQLite/PostgreSQL/Docker suite **330 pass / 0 fail / 1648 assertion / 65 dosya / 54.66 saniye** geçti (`p15-container-tests.log`). Linux CI'ya container build/smoke eklendi; uzak CI henüz çalıştırılmadı.

Son source build, npm dry-run ve temiz production npm tarball kontrolü de geçti (`p15-container-source-build.log`, `p15-container-pack.json`, `p15-container-clean-package.json`): Node HTTP/web/altı MCP/ZIP worker import/search/load, dağıtım sınırı ve OpenCode bağımlılığı yokluğu. Kaynak fingerprint `p15-container-fingerprint.json`. Genel P15/P16 ve önceki aşamaların kalan kabul ölçütleri açık; tüm ürün tamamlandı iddiası yoktur.

### P03/P15 gerçek OIDC/TLS sağlayıcı kabulü

Yerel, geçici Keycloak 26.7.3 + Caddy 2.11.4 + ayrı PostgreSQL DB ile gerçek authorization-code/PKCE, signed session ve bearer testi eklendi (`scripts/oidc-smoke.mjs`). Test sertifikası yalnız test Node sürecinin extra CA alanına verilir; sistem trust store değişmez, TLS doğrulaması kapatılmaz. İlk realm fixture profile scope'u eksik olduğu için callback authorization error verdi; scope eklenince gerçek login/session geçti. Bearer tokenında sub yokluğu görüldü (`p03-live-oidc-bearer.json`); Keycloak'ın resmi SubMapper kaynağına uygun basic scope eklendi. Uygulamanın bu kimlik doğrulama hatalarını generic500 vermesi de düzeltildi: bilinen OIDC yanıt/JWT claim/signature hataları401, gerçek ağ/altyapı hataları ayrı kalır. Kabul: gerçek login, CSRF/proje yazma, geçerli bearer, bozuk imza401, yabancı tenant403; test sırları/tokenları rapora yazılmaz.

Gerçek son OIDC kabulü geçti (`p03-live-oidc-acceptance.json`): TLS verification açık; gerçek Keycloak form/authorization code/PKCE; Secure/HttpOnly cookie; CSRF reddi ve yetkili proje yazma; access_denied401; gerçek JWKS imzası/audience/scope/sub ile bearer; bozuk imza401 ve yabancı tenant403. Kullanılan Node server profili gerçek PostgreSQL DB'sine bağlıydı. Kendi container/DB/sertifika dosyaları temizlendi; sistem trust store değiştirilmedi. Fixture realm yapılandırma hataları ve ilk500 yanıtları ayrı başarısız raporlarda korundu (`p03-live-oidc.json`, `p03-live-oidc-recheck.json`, `p03-live-oidc-profile.json`, `p03-live-oidc-bearer.json`). JWT sub kontrolü kaldırılmadı; sağlayıcı basic scope'una resmi mapper eklendi.

Lint/format/typecheck, **330 pass / 0 fail / 1648 assertion / 65 dosya / 53.92 saniye**, son build, npm dry-run ve temiz production tarball kontrolü geçti (`p03-live-oidc-tests.log`, `p03-live-oidc-build.log`, `p03-live-oidc-pack.json`, `p03-live-oidc-clean-package.json`). Kaynak fingerprint `p03-live-oidc-fingerprint.json`; özel test/script/workflow ve imaj digest'leri `p03-live-oidc-definition.json`. Linux CI'ya gerçek OIDC testi ve sunucu rapor artifact'ları eklendi, uzakta çalıştırılmadı. Türkçe rehber `docs/tr/oidc-kabul.md`. Bu protokol kabulü native tarayıcı/üç istemci, dış internet, bütün Compose dağıtımı veya tüm P03/P15 kabulü değildir; kalan hedefler açık.

### P03/P07 gerçek bearer ile resmi MCP istemcisi

Gerçek Keycloak/Caddy/TLS kabul sürücüsü, JWT ile HTTP paket import ve resmi MCP Client/StreamableHTTPClientTransport bağlantısına genişletiliyor. Token yalnız geçici child environment üzerinden taşınır; log/rapora yazılmaz. Kabul: altı araç tam liste, imported immutable paketin search/load zinciri, kayıtlı olmayan proje reddi ve önceki OIDC/CSRF/imza/tenant kabullerinin korunması. Native Codex/Claude/ChatGPT kabulü bununla kapatılmaz.

Gerçek OIDC + resmi MCP uçtan uca kabul geçti (`p07-oidc-mcp.json`): Keycloak JWT ile HTTP ZIP import, Caddy/TLS üzerinden resmi v2 MCP client initialization, altı araç tam liste, immutable revision search/load ve kayıtlı olmayan proje reddi. Önceki PKCE/session/CSRF/bozuk imza/yabancı tenant kabulleri aynı koşuda geçti. Script SHA `p07-oidc-mcp-script.json`; önceki tek başına HTTP bearer kabulünden ayrı gerçek MCP kanıtıdır. Üç native ürün istemcisinin kabulü değildir.

Lint/format/typecheck, **330 pass / 0 fail / 1648 assertion / 65 dosya / 53.77 saniye**, source build, npm dry-run ve temiz production tarball kontrolü geçti (`p07-oidc-mcp-tests.log`, `p07-oidc-mcp-build.log`, `p07-oidc-mcp-pack.json`, `p07-oidc-mcp-clean-package.json`). Kaynak fingerprint `p07-oidc-mcp-fingerprint.json`; Türkçe OIDC rehberi güncellendi. Gerçek model kalitesi, native istemciler, Compose execution worker, backup/restore ve diğer açık kabul maddeleri korunuyor.

### P15 SQLite snapshot uygulama kararı

Çevrim içi SQLite backup API ile tutarlı DB snapshot alınacak; snapshot'ın referans verdiği immutable revision dosyaları ve şifreli provider sırları doğrulanarak özel yedek dizinine taşınacak. Bu ilk işletim dilimi PostgreSQL backup veya K30 bütünü değildir. Restore mevcut dizini ezmeyecek, ürün sürümü ve dosya hash envanterini doğrulayacak, eski auth oturumlarını iptal edecek. Kabul: gerçek Node CLI ile snapshot/restore, paket ve sır bütünlüğü, bozulmuş/eksik dosyada fail-closed, mevcut hedefi koruma. PostgreSQL, yedek retention/silinmiş kullanıcı politikası ve migration upgrade/rollback kabulleri açık kalır.

SQLite backup/restore ilk dilimi uygulandı: CLI komutları `localConfig` veri oluşturma yan etkisinden önce çalışır; Node native online snapshot, FK/integrity kontrolü, DB referanslı revision/artifact envanteri ve provider geçmişindeki sırların çözülme doğrulaması var. Kurulum kurtarma kayıtları/policy dahil; cache/staging/log hariç. Fresh private hedef, hash manifest, aynı ürün sürümü kontrolü, eski auth oturumlarının iptali ve yeni owner token uygulanır. Eksik/bozuk dosya başarısızlıkla hedef temizler; mevcut hedef korunur. PostgreSQL env ile SQLite komutu açık hata verir.

Gerçek Node CLI kabul testi açık DB bağlantısı üstünden backup, restore sonrası paket/sır okuma, oturum iptali, mevcut hedef ve bozuk/eksik dosya reddini geçti (`p15-backup-contract.log`, 12 assertion). Lint/format/typecheck ve SQLite/PostgreSQL içeren tam küme **331 pass / 0 fail / 1660 assertion / 66 dosya / 56.40 saniye** geçti (`p15-backup-tests.log`). Türkçe kapsam ve retention sınırları `docs/tr/yedekleme.md` içinde. PostgreSQL backup/restore, otomatik yedek silme/tombstone aktarımı, migration upgrade/downgrade, OS kabulü ve K30 bütünü açık kalıyor.

Bu checkpoint'in son build, npm dry-run ve temiz production tarball kurulumu da geçti (`p15-backup-build.log`, `p15-backup-pack.json`, `p15-backup-clean-package.json`): Node HTTP/web, altı MCP aracı, gerçek ZIP worker import/search/load, dağıtım sınırı ve sıfır OpenCode üretim bağımlılığı. Backup gerçek Node CLI testi ayrı kanıttır; temiz tarball smoke içinde restore çalıştığı iddia edilmez. Kaynak fingerprint `p15-backup-fingerprint.json`. Genel hedef aktif ve tamamlanmamıştır.

### P15 PostgreSQL snapshot kararı

PostgreSQL export edilmiş repeatable-read snapshot, `pg_dump --snapshot` ve aynı transaction'dan revision/secret/artifact referans okuması ile eşleştirilecek. Restore yalnız açıkça adlandırılmış yeni DB ve yeni veri dizini oluşturacak; mevcut DB'yi temizleme/üzerine yazma yok. `pg_restore --single-transaction --no-owner --no-acl` ardından referans doğrulaması ve oturum iptali uygulanacak. Hata yalnız bu çağrının oluşturduğu DB/dizini geri alacak. Kabul gerçek PostgreSQL dump/restore, secret/paket okuma ve dolu hedef reddi. Host pg_dump 16, test sunucusu 17 olduğundan test uygun 17 araçlarını kullanacak; eski aracın uyumsuzluğunu başarı saymayacak.

PostgreSQL backup/restore uygulandı. `SKILL_FORGE_POSTGRES_URL` modu seçer; restore `--database-name` ile yalnız yeni DB oluşturur. Kaynak snapshot repeatable-read/read-only transaction ile export edilir; DB referans okuması ve gerçek `pg_dump --snapshot` aynı snapshot'ı paylaşır. Revision/artifact dosyaları ve geçmiş provider sırları ortak doğrulama katmanından geçer. Restore outer hash envanterini, ardından DB revision hash'lerini ve secret çözülmesini denetler; eski oturumları iptal eder. Hata yalnız bu çağrıda oluşturulan yeni DB/dizini temizler. DB sahibini/ACL'yi taşımama, güvenilir dump kaynağı, tool sürümü ve libpq URL seçenekleri Türkçe rehberde açıklanır.

İlk kabul denemesi bağlantı URL'sinin yalnız PGDATABASE env'den libpq tarafından URI olarak genişletilmediğini gösterdi (`p15-postgres-backup-contract.log`, `...-recheck.log`). Host/port/user/password/database ayrı env alanlarına ayrıldı; argv/log'a sır yazılmaz. Gerçek Node CLI + PostgreSQL 17 araçlarıyla iki DB backend kabulü geçti (`p15-postgres-backup-contract-final.log`). Genişletilmiş test dış envanter hash'i güncellenmiş bozuk revision'ı da DB hash'inden reddetti ve oluşturulan hedef DB'nin silindiğini doğruladı.

Lint/format/typecheck ve **332 pass / 0 fail / 1675 assertion / 67 dosya / 67.23 saniye** geçti (`p15-postgres-backup-tests.log`). Test PostgreSQL tool adapter'ı yalnız kendi geçici dizinini mount eden sabit `postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` imajını kullanır; üretim komutu native pg_dump/pg_restore veya açık operator executable yolunu kullanır. Gerçek native host pg_dump 16 test sunucusu 17'ye uyumsuz olduğundan 17 araçlarıyla doğrulama yapıldı. Otomatik retention/tombstone, migration upgrade/downgrade, tam Compose işletimi ve K30 bütünü açık kalır.

Son source build, npm dry-run ve temiz production tarball kontrolü geçti (`p15-postgres-backup-build.log`, `p15-postgres-backup-pack.json`, `p15-postgres-backup-clean-package.json`): Node HTTP/web/altı MCP/gerçek ZIP worker import/search/load, dağıtım sınırı ve OpenCode üretim bağımlılığı yokluğu. Backup/restore gerçek Node CLI testleri ayrı kanıttır. Kaynak fingerprint `p15-postgres-backup-fingerprint.json`. PostgreSQL belgeleri: https://www.postgresql.org/docs/17/app-pgdump.html ve https://www.postgresql.org/docs/17/app-pgrestore.html. Genel hedef aktif; tüm P01–P16 kabulleri tamamlandı denmez.

### P11 kalıcı silme önkoşulu — bakım/yetki sıralaması

Kalıcı silme incelemesinde MaintenanceService.apply'ın yalnız membership satırını, MemberService revocation'ın ise tenant satırını kilitlediği görüldü. Kontrol ile arşiv/restore mutation arasına yetki iptali girebiliyor. Önce bakımın item transaction'ı ortak tenant kilidine taşınacak; SQLite/PostgreSQL'de iptal sonrasında yazı/audit/receipt oluşmaması ve yeniden yetkilendirme sonrası işlem/tekrar güvenliği doğrulanacak. Kalıcı delete için gereken aktif okuyucu/revision pin/reference katmanı henüz yok; bu önkoşul düzeltmesi P11 delete tamamlandı olarak işaretlenmez.

Bakım/yetki yarışı düzeltildi. Yeni test eski kodda iki PostgreSQL eyleminde ortak kilitte bekleme koşulunu sağlayamadı (`p11-maintenance-lock-before.log`: 2 pass/2 fail). Tenant kilidi düzeltmesinden sonra SQLite/PostgreSQL archive/restore, yetki iptali sonrası paket/audit/receipt değişmezliği, yeniden yetkilendirme ve başarılı receipt replay geçti; mevcut bakım sözleşmesiyle **6 pass/84 assertion** (`p11-maintenance-lock-after.log`).

Son lint/format/typecheck, **336 pass / 0 fail / 1711 assertion / 68 dosya / 68.93 saniye**, build, npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/ZIP worker import/search/load kontrolü geçti (`p11-maintenance-lock-tests.log`, `p11-maintenance-lock-build.log`, `p11-maintenance-lock-pack.json`, `p11-maintenance-lock-clean-package.json`). Parmak izi `p11-maintenance-lock-fingerprint.json`. Türkçe bakım rehberine transaction/yetki/tekrar davranışı eklendi. Kalıcı silme için script execution'ın files() sonrası kullandığı paket yolu ve SPR'nin seçilmiş taban revision'ı halen kalıcı pin/okuyucu referansı gerektiriyor; fiziksel delete henüz açılmadı. Genel P11/K23 ve tam hedef açık.

### P05/P11 execution revision bağı

Script execution kabul transaction'ında execution ID ile tam tenant/skill/revision FK bağı oluşturulacak; terminal sonucun kalıcı kaydıyla aynı transaction'da bırakılacak. Kabul ve kapanış ortak tenant kilidini kullanacak. Çökmüş/sonucu bilinmeyen execution'ın bağı süre tahminiyle silinmeyecek. Eski execution kayıtlarında skill/revision alanı olmadığından geriye dönük ilişki uydurulmayacak; kalıcı silme kapısı eski belirsiz işleri ayrıca engellemek zorunda. Kabul: gerçek Docker işi sürerken FK revision silmeyi reddeder; tamamlanma/hata ve replay sonunda bağ yaşam döngüsü SQLite/PostgreSQL'de doğrulanır. SPR/diğer okuyucu bağları ve fiziksel GC bundan sonra gelir; delete tamamlandı denmez.

Execution revision referansı uygulandı: `016_execution_pins` migration'ı `execution_revision_pins` tablosunu execution ve tam tenant/skill/revision FK'leriyle oluşturuyor. Kabul ve terminal kayıt transaction'ları ortak tenant kilidini kullanıyor. Yeni işin kaydı ve pin'i atomik; terminal sonuç/observation ve pin bırakma atomik. Belirsiz iş replay'i yeni pin/iş oluşturmaz. Eski execution kayıtlarına tahmini backfill yapılmaz.

Gerçek Docker kabulü SQLite/PostgreSQL'de geçti (`p11-execution-pins-contract.log`, 2 test/20 assertion): iş sürerken pin görüldü, yalnız active pointer korumasının kaldırıldığı rollback transaction'ında revision DELETE FK tarafından reddedildi, running replay ikinci iş başlatmadı, tamamlanma/hata sonrası pin kalktı. Bu test process SIGKILL sonrası kurtarmayı doğrulamıyor; terminal kayıt yapılamayan iş için pin bırakma yolu bulunmadığı kaynak davranışıdır. SPR ve genel dosya okuyucu pin'leri, eski belirsiz işlerin silme engeli ve fiziksel GC açık.

Lint/format/typecheck ve **338 pass / 0 fail / 1730 assertion / 69 dosya / 78.78 saniye** geçti (`p11-execution-pins-tests.log`). Türkçe bakım rehberi yaşam döngüsünü ve sınırları açıklıyor. Genel hedef, P05/P11/K23 ve tüm kalan kabuller açık kalır.

Son source build, npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/ZIP worker import/search/load kontrolü de geçti (`p11-execution-pins-build.log`, `p11-execution-pins-pack.json`, `p11-execution-pins-clean-package.json`). Yeni migration temiz kurulumda da çalıştı; pin'in gerçek Docker yaşam döngüsü yukarıdaki ayrı integration testidir. Kaynak fingerprint `p11-execution-pins-fingerprint.json`.

### P05/P11 SPR taban revision bağı

SPR select öncesi aktif lease/fence ve güncel yetkiyle tenant/run/fence/skill/revision FK bağı alınacak. Bağ, handler kapanışında çalışan tool action'ları bittikten sonra yalnız aynı fence için bırakılacak. Cancel/lease expiry tek başına fiziksel okuyucunun durduğunu kanıtlamadığı için bağı otomatik silmeyecek; eski worker kendi fence'ini bırakabilir, yeni worker'ınkini bırakamaz. Çökmüş worker referanslarının kontrollü GC'si açık kalır. Kabul: iki DB'de select FK koruması, stale select reddi, yeniden claim sonrası iki ayrı fence ve eski dispose'un yenisini koruması.

SPR pin uygulaması `017_run_pins` migration'ı ile geldi. Select, dosyaları okumadan önce tenant kilidi altında aktif lease/fence ve güncel yetkiyi doğrulayıp referansı kaydeder. Bir iş tek seçilmiş taban taşır. `EvolutionStaging.dispose()` yeni tool çağrılarını kapatır, devam eden action promise'lerini bekler ve yalnız aynı tenant/run/fence kaydını siler. Production handler bütün çıkışlarda finally ile bunu çağırır; cancel/lease expiry kendiliğinden okuyucu referansı düşürmez. Model tool/permission listesi değişmedi; normatif SPR sözleşmesindeki okuyucu değişmezliği uygulanıyor.

İki DB'deki sözleşme ve mevcut staging/runner testleri geçti (`p11-run-pins-contract.log`, 6 test/35 assertion). Genişletilmiş okuyucu testi kontrollü gate ile gerçek store.files okumasını bekletti; dispose erken bitmedi ve pin tutuldu. Reclaim ile iki fence referansı oluştu; eski dispose yenisini korudu; stale select reddedildi; cancel pin'i kaldırmadı, açık handler disposal kaldırdı (`p11-run-pins-reader-contract.log`, 2 test/22 assertion). Gerçek model/provider çağrısı veya process SIGKILL kabulü bu fixture'dan çıkarılmaz. Genel okuyucu/backup pin'leri ve çökmüş worker GC doğrulaması açık kalır.

Tam küme **340 pass / 0 fail / 1753 assertion / 70 dosya / 74.95 saniye** geçti (`p11-run-pins-tests.log`). İlk lint'in yalnız Promise.allSettled için gereksiz spread uyarısı düzeltildi (`p11-run-pins-lint.log`, `p11-run-pins-lint-final.log`); son kaynakta staging/runner/iki DB pin testleri yeniden **6 pass/39 assertion** ve typecheck geçti (`p11-run-pins-final-contract.log`, `p11-run-pins-final-typecheck.log`). Format, son source build, npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/ZIP worker import/search/load kontrolü geçti (`p11-run-pins-build.log`, `p11-run-pins-pack.json`, `p11-run-pins-clean-package.json`). Kaynak fingerprint `p11-run-pins-fingerprint.json`. Genel P05/P11/K23, okuyucu/backup GC ve tam hedef açık kalır.

### P05/P11 genel revision okuru

Paket dosya yükleme ve bütünlük taramasında tenant kilidi altında güncel ACL + revision varlığı kontrol edilip kısa ömürlü FK okur kaydı alınacak. DB kilidi dosya I/O boyunca tutulmayacak; FK pin fiziksel silme önkoşulunu koruyacak. Callback başarı/hata finally'sinde yalnız kendi okur kimliği bırakılacak. Sabit süreli lease expiration kullanılmayacak; process çökmesi sonrası kontrollü artık okur temizliği açık kalır. Kabul iki DB'de okuma sırasında revision delete reddi, paralel okur bağımsızlığı ve bozuk dosyada referans bırakılması. Execution/SPR uzun ömürlü pin'leri bu kısa okumadan sonra paket yolunu kullanan işleri korumaya devam eder.

Genel okur koruması `018_revision_readers` migration'ı ve PackageStore.withRevision callback'iyle uygulandı. Tenant kilidi altında ACL/revision kontrolü ve FK kaydı yapılır; I/O kilit dışında devam eder; success/error finally kendi reader ID'sini bırakır. files ve reconcile bu yolu kullanır. Reconcile sırasında yeniden doğrulanan yetki iptali yanlışlıkla corruption olarak yutulmaz. Script/SPR uzun referansları ayrı korunur; snapshot backup ve crash-orphan GC hâlâ açık.

İlk hedefli kümede PostgreSQL fixture katalog ilk sayfasına sığmadığı için reconcile assertion'ı başarısız oldu (`p11-readers-contract.log`, 9 pass/1 fail); test paketin cursor'uyla sınırlandırıldı. Son iki DB okur sözleşmesi **2 pass/24 assertion** (`p11-readers-contract-recheck.log`): iki paralel okuyucu, active-pointer korumasından bağımsız FK deletion reddi, gerçek byte okuma, bağımsız bırakma ve bozuk dosyada temiz referanslar. Tam lint/format/typecheck ve **342 pass / 0 fail / 1777 assertion / 71 dosya / 75.70 saniye** geçti (`p11-readers-tests.log`). Son source build geçti (`p11-readers-build.log`). Kısa 10.000 paket katalog performans kontrolü başlatıldı; sonuç gelmeden gecikme kabulü yapılmıyor.

10.000 paketlik gerçek Node katalog kontrolü ilk kaynakta başarısız oldu (`p11-readers-catalog.json`): başlangıç HTTP 17.45 ms açıldı fakat bütünlük taraması 120.031 saniyede yalnız 8.550 revision bitirdi; istek örneklerine geçilemedi. Bu bir performans regresyonudur, başarı değildir. Neden: reconcile'ın her paket için ayrı durable reader insert/delete transaction'ları. 120 saniye sınırı değiştirilmedi. Reconcile mevcut 25 öğelik sayfasının reader kayıtlarını tek transaction'da alıp sayfa I/O sonunda toplu bırakacak şekilde düzeltildi; her revision FK ile korunur, tenant kilidi I/O'da tutulmaz. Yeniden typecheck ve iki DB okur/paket testleri **6 pass/62 assertion** geçti (`p11-readers-batch-contract.log`), source build sonrası 10.000 paket tekrar ölçümü sürüyor.

İkinci katalog koşusunda tarama tamamlandı fakat warm forge_load p95 **340.57 ms** ile 250 ms hedefini aşarak yine başarısız oldu (`p11-readers-catalog-recheck.json`; search p95 32.57 ms). Aynı kullanıcı/tenant/revision için eşzamanlı okurlar artık yalnız koruma kaydını refcount ile paylaşır; snapshot/pin yalnız son callback bitince silinir. İçerik cache'i yoktur: her callback gerçek byte/hash kontrolünü yapar; her çağrı ACL'yi yeniden okur. Farklı kullanıcılar aynı pool anahtarını paylaşmaz. Hedef değiştirilmedi; üçüncü aynı katalog koşusu sürüyor.

Üçüncü aynı 10.000 paket koşusu mühendislik hedefini geçti (`p11-readers-catalog-shared.json`): bütünlük taraması **15.618 saniye / 10.000 checked / 0 issue**; 300 karma gerçek resmî MCP çağrısı, 100 istek/s hedefi, gerçekleşen 98.51 istek/s; search p95 **24.82 ms**, load p95 **186.18 ms**, `engineering_target_met: true`. Önceki iki başarısız ölçüm korunuyor. Bu tek kullanıcı/proje ve tek istemciden örtüşen aynı-paket load ölçümüdür; çok kullanıcılı PostgreSQL veya 30 dakika soak kabulü değildir. Okur koruması ve 250 ms hedefi korunarak regresyon giderildi.

Son kaynakta paylaşılan reader kaydı açıkken proje yetkisi iptal edilen yeni çağrının 403 aldığı ve mevcut okuyucunun pin'ini kaldırmadığı iki DB testine eklendi. Final lint/format/typecheck ve **342 pass / 0 fail / 1783 assertion / 71 dosya / 75.82 saniye** geçti (`p11-readers-final-tests.log`). Son Türkçe belge, kayıt paylaşımı, per-call ACL, gerçek dosya okuma ve sayfa pin batching davranışına güncellendi. Backup snapshot pin'leri, crash-orphan cleanup ve fiziksel delete hâlâ açık; P11/K23 bütünü tamamlanmış değildir.

Final source build, npm dry-run ve temiz production tarball kontrolü geçti (`p11-readers-final-build.log`, `p11-readers-pack.json`, `p11-readers-clean-package.json`): yeni migration ile Node HTTP/web/altı MCP/gerçek ZIP worker import/search/load; dağıtım sınırı ve OpenCode üretim bağımlılığı yokluğu. Kaynak fingerprint `p11-readers-fingerprint.json`. Katalog mühendislik hedefi kısa koşuda geçti; önceki başarısız uzun soak'ın yerine konulmaz. Genel hedef aktiftir.

### P05/P15 backup revision okuru

Snapshot'ın revision listesi için kaynak DB'de FK reader kayıtları alınacak; snapshot alındıktan sonra eklenecekleri için backup kendi koruma kayıtlarını içine taşımayacak. SQLite kaynakta kısa write transaction, PostgreSQL ayrı bağlantıda sıralı tenant kilitleri + batch insert kullanacak. Referans alınmadan revision silinmişse backup başarısız olacak; snapshot kapsamı küçültülmeyecek. Dosya kopyası/hash denetimi tamamlandıktan sonra yalnız bu çağrının ID'leri bırakılacak. Restore yeni DB/dizine yapıldığı için snapshot'taki eski genel okur kayıtları hedefte temizlenecek; kaynak okurlarına dokunulmayacak. Execution/SPR ve çökmüş worker GC ayrı kalır.

Backup revision okur koruması uygulandı. SQLite kaynak bağlantısında foreign_keys açık, native write transaction ile snapshot listesinin reader ID'leri ekleniyor; PostgreSQL ayrı bağlantıda sıralı tenant kilitleri ve 250'lik parametrik batch insert kullanıyor. Snapshot bu kayıtlar eklenmeden önce alındığından backup kendi reader kayıtlarını taşımaz. Copy/hash doğrulaması sonunda ya da hatada yalnız kendi ID'leri bırakılır. Yeni restore hedefindeki genel reader kayıtları temizlenir; kaynak reader/execution/SPR kayıtları korunur. Revision listesi ve manifest toplam dosya sayısı sınırlandırılır.

Gerçek Node CLI iki DB backup/restore testi **2 pass / 35 assertion** geçti (`p15-backup-readers-contract.log`). PostgreSQL 17 dump aracı kontrollü gate'de gerçekten beklerken kaynak pin görüldü; başka reader geçici kaldırılıp active pointer guard'ı rollback transaction'ında kaldırıldığında revision DELETE backup FK'sinden reddedildi. Başarı ve eksik dosya hatasında ilgisiz reader korundu; restore hedefinde snapshot'taki eski reader kayıtları temizlendi. SQLite testinde aktif dosya kopyasını ayrıca bekleten gate yok; native backup/restore ve kayıt temizliği doğrulandı. Process çökmesi/GC kabulü henüz değildir.

Lint/format/typecheck ve **342 pass / 0 fail / 1791 assertion / 71 dosya / 75.17 saniye** geçti (`p15-backup-readers-tests.log`). Son SQLite LIMIT düzeltmesi ardından source yeniden typecheck/build edildi ve gerçek Node iki DB backup/restore sözleşmesi **2 pass/35 assertion** tekrar geçti (`p15-backup-readers-final-contract.log`). npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/ZIP worker import/search/load geçti (`p15-backup-readers-pack.json`, `p15-backup-readers-clean-package.json`). Parmak izi `p15-backup-readers-fingerprint.json`. Türkçe rehber kaynak metadata yazma yetkisini, yeni restore hedefindeki reader temizliğini ve açık crash-GC sınırını açıklıyor. Kalıcı delete, artık referans yönetimi, K23/K30 bütünü ve genel hedef açık kalır.

### P11 kalıcı silme ve dayanıklı cleanup kararı

Arşivlenmiş, managed ve korunmayan paket için referans etki kontrolü uygulanacak. Revision okuyucu/execution/SPR pin'leri, migration/gözlem/override referansları ve revision'ı bilinmeyen çalışan işler silmeyi engelleyecek. Metadata silme, tombstone, item receipt ve dosya GC kuyruğu tek transaction'da yazılacak. Dosyalar DB commit'ten sonra, tekrar güvenli sınırlı cleanup adımıyla silinecek; yarıda kalma `pending_cleanup`, tüm dosyalar gidince `completed` dönecek. Restore kalıcı silinen kimliği geri getirmez.

Dosya silmede Linux descriptor-relative parent traversal kullanılacak; symlink ancestor yarışıyla kök dışına çıkılmayacak. Node'un diğer platformlarda eşdeğer dirfd API'si olmadığı için Linux dışındaki fiziksel delete bu dilimde metadata silmeden açık hata verecek. macOS/Windows eşdeğer güvenli adapter ve kabulü açık kalır; ürün kapsamı/OS hedefi küçültülmez. Kabul: iki DB'de gerçek dosya silme, pin/referans/protection blokları, stale/ACL/replay ve pending cleanup'ın yeniden denenmesi; kök dışı dosya korunması.

Linux kalıcı silme altyapısı uygulandı: tenant kilidi altında arşiv/protection/revision/referans kontrolü; atomik metadata+tombstone+receipt+GC; descriptor-relative fiziksel silme; gerçek kök dışı symlink ve kimliği başka pakete yönlendirme engelleri. Tam kontrol **344 pass / 0 fail / 1827 assertion / 72 dosya / 75.28 saniye** (`p11-deletion-tests.log`), lint/format/typecheck/build, npm dry-run ve temiz tarball Node HTTP/web/altı MCP/ZIP worker kabulü geçti (`p11-deletion-clean-package.json`). Bu parmak izi web silme kontrollerinden önceki backend dilimidir (`p11-deletion-fingerprint.json`).

Dayanıklı devam akışı için ek API uygulanıyor: özgün kullanıcı/istek body gerektirmeden scope-bound tombstone ve pending GC üzerinden sınırlı sayfalama; yetkili başka yönetici temizliği sürdürebilir. Bu işlem yeni metadata silme kararı vermez. Kabul: başka yöneticiyle keşif/devam, yabancı tenant reddi, sayfa yenilemesiyle geri kazanım ve gerçek web silme önizlemesi/sonucu. İki DB servis sözleşmesi **2 pass / 44 assertion** geçti (`p11-deletion-recovery-contract.log`); web/rendered ve final paket henüz bu ek kaynakta doğrulanmadı.

Dayanıklı keşif/devam ve web silme akışı uygulandı. `GET /api/maintenance/deletions` scope-bound 50 kayıt/next sayfalaması, `POST /api/maintenance/deletions/resume` mevcut tombstone üzerinden yeniden yetkilendirilen cleanup sağlar. Başka admin orijinal isteği bilmeden tamamlayabilir; kişisel/proje kapsamları korunur. Web, tek etki özeti/sürüm sayısı ve ayrı uygula eylemi; sunucudan yenilenen pending liste ve sürdürme sunar. Proje değişiminde bakım bileşeni yeniden kurulur; eski seçimler taşınmaz.

Gerçek Node servis kaynak build'den yeniden başlatıldı. Playwright Chromium ile yerel eşleme girişi → iki gerçek arşiv paketi → kalıcı etki önizlemesi → biri tamamlanan/biri symlink nedeniyle bekleyen silme → sayfa yenilemesi → kayıt tekrar görünür → test symlink'i düzeltilir → sürdür → dosyalar yok ve kök dışı sentinel korunur akışı geçti (`p11-deletion-recovery-browser.json`). İlk betik giriş öncesi beklenen `/api/me` 401 console kaydını yanlışlıkla başarısız saydı; yalnız bu URL/status beklenen sınıfına alındı ve yeni paketlerle bütün akış tekrar geçti. Beklenmeyen console/page error yok. 1440×1000 masaüstü önizlemesi ve 390×844 mobil sonuç görüntüleri incelendi; bu mobil boyutta görüntü kontrolüdür, bütün mobil etkileşim kabulü değildir. Browser plugin mevcut olmadığından kurulu Playwright kullanıldı; kullanıcı tarayıcıları değiştirilmedi.

Final lint/format/typecheck, **344 pass / 0 fail / 1835 assertion / 72 dosya / 75.58 saniye**, source build, npm dry-run ve temiz production tarball HTTP/web/altı MCP/gerçek ZIP worker import/search/load geçti (`p11-deletion-recovery-tests.log`, `p11-deletion-recovery-build.log`, `p11-deletion-recovery-pack.json`, `p11-deletion-recovery-clean-package.json`). Kaynak parmak izi `p11-deletion-recovery-fingerprint.json`. Türkçe bakım rehberi keşif/devam, admin devralma ve OS/backup sınırlarına güncellendi. Gerçek SIGKILL sırasında dosya GC kesintisi, crash-orphan referans GC, macOS/Windows güvenli delete adapter, benchmark/dependency bütünlüğü, K23 bütünü ve genel P01–P16 hedefi açık kalır; yeşil testler genel teslim tamamlandı anlamına gelmez.

### P11 gerçek dosya temizliği sırasında SIGKILL

`test/deletion-crash.test.ts` gerçek derlenmiş Node HTTP servisini özel geçici dizinde başlatır; gerçek bir arşiv paketine 8.000 artık dosya ekler. Bu dosyalar yayın manifestini genişletmez; recursive GC'nin sahipsiz dosyaları da temizlemesini sınar. Üretim koduna fault hook/gecikme eklenmez. Dizin sayısı azalıp sıfır olmadan owned servis PID'sine SIGKILL gönderilir ve gerçek signal exit beklenir. Metadata yok, GC pending ve dosyalar hâlâ var olduğu doğrulanır. Aynı DB/dizinle yeni Node servis başlar; HTTP pending keşfi/devam dosyaları kaldırır, özgün operation replay completed döner, maintenance.delete audit sayısı bir kalır. SQLite Linux gerçek test **1 pass / 11 assertion / 2.70 saniye**, typecheck geçti (`p11-deletion-crash-contract.log`, `p11-deletion-crash-typecheck.log`). Bu genel okuyucu/SPR process-orphan GC veya PostgreSQL SIGKILL kanıtı değildir.

P13 uzun ölçüm yeniden koşulacak: önceki başarısız 30 dakika soak korunur; hedef 100 istek/s, her dakika search/load p95 <=250 ms değişmez. Güncel paylaşılan reader koruması ve gerçek dosya doğrulamasıyla 10.000 paket yeniden seed edilir, sonra 30 dakika ölçülür. Bu koşu sırasında ajan başka tam test/build/benchmark başlatmayacak; kullanıcının diğer uygulamaları kapatılmayacak. Tek kullanıcı/proje/SQLite kapsamı korunarak raporlanır; PostgreSQL çok kullanıcı ve sağlayıcı kapasitesi kabulüne çevrilmez.

SIGKILL testinin eklendiği son kaynakta lint/format/typecheck ve **345 pass / 0 fail / 1846 assertion / 73 dosya / 77.49 saniye** geçti (`p11-deletion-crash-tests.log`). Source build, npm dry-run ve temiz tarball Node HTTP/web/altı MCP/ZIP worker kontrolü geçti (`p11-deletion-crash-build.log`, `p11-deletion-crash-pack.json`, `p11-deletion-crash-clean-package.json`). Parmak izi `p11-deletion-crash-fingerprint.json`. Genel hedef aktiftir.

Çalışan `p13-catalog-soak-readers` koşusunun ikinci dakikasında load p95 **265.99 ms** ile hedef aşıldı; koşu kalan pencereler/bellek eğilimi için devam ediyor, başarılı sayılmayacak. Sonraki koşuların teşhisi için sınırlı per-window event-loop gecikmesi/utilization, CPU user/system, GC count/duration/max ve ham process.resourceUsage sayaç farkları eklendi. Bu sayaçlar nedensellik veya fsync sayısı iddiası değildir; korelasyon sağlar. Bellekte per-request/GC geçmişi biriktirilmez, pencere sonunda sayaç/histogram sıfırlanır. Probe ve teşhis modülü sonraki seed başlangıcında runtime dizinine kopyalanarak dondurulur ve SHA256 rapora yazılır. Çalışan koşu eski yüklenmiş harness ile devam eder; yeni teşhis ölçümü henüz yapılmadı. Ağır doğrulama uzun koşu sonrasına bırakıldı; iki MJS `node --check` geçti.

Uzun koşuda 3. dakika load p95 **2160.91 ms**, 4. dakika **1486.52 ms**; request hatası sıfır fakat performans hedefi başarısız. Salt okunur host anlık görüntüsünde eşzamanlı cargo/rustc/rust-lld süreçleri, I/O pressure ve benchmark process I/O sayaçları kaydedildi (`p13-catalog-soak-readers-host.json`). Kaynak/başlatan bilinmiyor; başka süreç durdurulmadı. Bu gözlem nedensellik kanıtı veya sonuçları dışlama gerekçesi değildir. Koşu kalan pencereleri toplamak için devam ediyor.

P13 ölçüm incelemesinde önceki harness'in hataları toplamda saydığı fakat latency örneklerine eklemediği bulundu. Yeni ölçüm helper'ı transport/tool/JSON hataları dahil her denemeyi finally'de kaydeder; sonucu success/error olarak ayırır. Soak ayrıca planlanan gönderimden gerçek çağrıya gecikmeyi ve planlanan gönderimden tamamlanmaya toplam süreyi raporlar; gecikmiş scheduler görünmez kalmaz. Eski koşunun şu ana kadarki hata sayısı sıfırdır, bu eksik mevcut yüksek gecikmeleri geçersiz kılmaz. Helper frozen runtime'a kopyalanır, SHA256 raporlanır. Transport/tool/malformed ve başarılı çağrı davranışı için sözleşme testleri eklendi; uzun koşu sonrası çalıştırılacak. Çalışan koşunun ölçüm yöntemi geriye dönük değiştirilmedi.

Yeni teşhis kodu incelemesinde soak'a ait runtime.sample çağrısının istemci matrisi dalına da eklendiği görüldü; matrix dalından çıkarıldı. Ölçüm yardımcılarına özel kısa test (başka servis veya katalog yükü yok) **3 pass / 34 assertion / 179 ms** geçti (`p13-diagnostics-contract.log`): transport/MCP/JSON hataları kayıt dışında kalmaz, başarılı yanıt korunur, gerçek Node GC gözlemlenir, pencere reset'i ve observer kapanışı doğrulanır. Bu kısa test uzun koşunun yaklaşık 10. dakikası çevresinde çalıştırıldı; tam test/build/ikinci benchmark başlatılmadı. Türkçe katalog rehberi kod hash'leri, latency paydası, scheduler gecikmesi, GC ve resourceUsage sınırlarına güncellendi. Frozen harness ve soak entegrasyon koşusu henüz doğrulanmadı.

Frozen harness kurulumunda hata yolları incelendi: CLI argüman kontrolü artık geçici dizin yaratılmadan yapılır; runtime kopyalama/DB bootstrap dahil kurulum adımları finally kapsamına alındı. Önceki kodda bu adımlardaki hata sahipsiz benchmark dizini bırakabiliyordu. Bu değişiklik çalışan eski koşuyu etkilemez. Sonraki sınırlı gerçek harness doğrulamasına setup failure cleanup kontrolü dahil edilecek.

Başlangıç hatası temizliği ayrı child-process testiyle doğrulandı: geçersiz katalog boyutu ve eksik runtime kaynak dosyası sonrasında owned `forge-catalog-benchmark-*` dizini kalmıyor. İlk test Bun'ın kendi `bun` cache dizinini de benchmark artığı saydığı için başarısızdı (`p13-diagnostics-setup-contract.log`); kontrol yalnız scriptin sahip olduğu dizinlere bağlandı. Tekrar **1 pass / 6 assertion / 332 ms** geçti (`p13-diagnostics-setup-recheck.log`). Bu kısa kurulum testi uzun koşunun yaklaşık 26. dakikasında yapıldı; ikinci katalog/server veya tam build/test başlatılmadı.

`p13-catalog-soak-readers` tamamlandı; owned session 89174 exit **1** ile terminal oldu. Nihai JSON: **30 pencere / 1.802.183,70 ms / 180.000 istek / 0 hata**, 10.000 paket bütünlük taraması verified/0 issue. `engineering_target_met: false`; load p95 2–9, 19, 28, 29. dakikalarda 250 ms üstünde. En kötü search p95 **148.60 ms**, load p95 **2160.91 ms**. RSS ilk **444.727.296**, son/en yüksek **507.002.880 byte**; sınırsız bellek büyümesi olmadığına dair genel kabul iddiası yapılmaz. Başarısız pencereler dışlanmadı; JSON/CSV/Markdown/log korunuyor. Bu koşu eski yüklenmiş harness ile tamamlandı; yeni GC/event-loop teşhis alanları bu raporda yoktur. Performans kabulü açık. Sonraki işlem yeni frozen harness'in küçük gerçek katalog + matrix + bir dakika teşhis entegrasyon kontrolüdür; 30 dakika kabulüne sayılmaz.

Yeni frozen harness gerçek Node HTTP/resmî MCP entegrasyonunda 10 paket, 1/10/100/1000 istemci matrisi ve 1 dakika soak ile çalıştı (`p13-diagnostics-integration.json`). Üç helper hash'i, her çağrı outcome'u, scheduler ve runtime/GC alanları yazıldı; matrix undefined sampler hatası yok. İstek hatası sıfır. Bir dakika search/load p95 **13.24/26.59 ms**, GC 96 olay/toplam292.14ms/max13.62ms, event loop max107.35ms; scheduler max100.32ms. Buna rağmen başlangıçtaki warm etiketli 300 istek penceresinde load p95 **551.04 ms**, dolayısıyla bütün komut **exit1 / engineering_target_met:false**. İşlevsel entegrasyon gerçekleşti; performans kabulü geçti denmez. Kod şu an yalnız ilk tekil çağrıdan sonra kısa yük ölçüyor; Bölüm16.3'teki açık ısınma aşamasının ayrıca uygulanması gerekir. Başlangıç/cold etkisi rapordan çıkarılmayacak; hedef düşürülmeyecek. Bu küçük entegrasyon 10.000 paket veya 30 dakika kabulü değildir.

Teşhis/kayıt/frozen-copy/setup-cleanup değişikliklerinden sonra lint/format/typecheck, **349 pass / 0 fail / 1885 assertion / 76 dosya / 79.85 saniye** geçti (`p13-diagnostics-tests.log`). Source build, npm dry-run ve temiz production tarball Node HTTP/web/altı MCP/gerçek ZIP worker kontrolü geçti (`p13-diagnostics-build.log`, `p13-diagnostics-pack.json`, `p13-diagnostics-clean-package.json`); kaynak parmak izi `p13-diagnostics-fingerprint.json`. Bu yeşil kontroller başarısız soak performans sonucunu kapatmaz. Owned uzun benchmark süreci ve geçici 10.000 paket dizini terminal sonrası temizlendi; ikinci küçük entegrasyon da terminaldir. Açık ısınma/teşhisli uzun koşu ve P01–P16/K01–K30 genel kabulü sürer.

### P13 açık ısınma aşaması

Bölüm16.3 gereği ölçümden önce sabit **500 istek / 100 istek-s (planlanan 5 saniye)** ısınma aşaması uygulanacak; sonuç görülerek uzatılıp kısaltılmayacak. İlk discovery/load örnekleri ve bütün ısınma örnekleri JSON/CSV'de korunur. Isınma hataları genel başarısızlık hesabına girer; gecikmesi ayrı raporlanır. Sonraki 300 istek warm ölçümü ve 30 soak penceresinin 250 ms hedefi değişmez. GC/event-loop ölçümü ısınma ve warm kısa pencereye de eklenir; bağlantı hazırlığı ayrı kaydedilir. Bu değişiklik önceki başarısız raporları yeniden sınıflandırmaz. Kabul: 500 ısınma örneği/ayrı phase, gerçek sonuç ve hata sayımı, sampler lifecycle, küçük entegrasyonda matrix/soak yolları ve ardından mevcut katalog hedefi.

Isınmalı küçük gerçek entegrasyon tamamlandı (`p13-warmup-integration.json`): 500 ayrı warmup örneği, 4 istemci profili ve 1 soak penceresi doğrulandı; request hatası sıfır. Performans hâlâ başarısız: warm search/load p95 **599.81/1681.92 ms**, bir dakika load p95 **309.00 ms**. Warm pencerede GC max12.35ms, event-loop max84.54ms olduğundan GC tek başına 1.68s sapmayı açıklamıyor. SDK 2.0.0 yerel kaynağı incelendi: her stateless request'te 6 registerTool çağrısı aynı Zod şemalarını yeniden JSON Schema'ya dönüştürüyor. Default AJV ise lazy olduğundan sırf constructor'da AJV compile iddiası doğru değil. Kimlik/server/transport paylaşmadan yalnız sabit schema dönüşümünü önceden üretme değerlendirilecek; canlı Zod doğrulaması ve request kimliği korunacak. Kabul: SDK araç ilanı eşitliği, schema/default/invalid girdi davranışı, farklı kullanıcı izolasyonu ve constructor mikro ölçümü; gerçek katalog ölçümü ayrıca.

Statik MCP şema yayını önceden hazırlanıyor (`src/mcp/published-schemas.ts`). Yalnız SDK'nin draft-2020-12/default-options JSON dönüşümü cache edilir; her alıcıya structuredClone verilir. Diğer target/library options Zod converter'a gider; canlı `~standard.validate` aynı fonksiyondur. Request başına server/transport/identity ayrı kalır. Altı şemanın ilan eşitliği, dönen JSON'u değiştirme izolasyonu, alternatif target, Zod defaults/strict invalid input ve mevcut gerçek MCP sözleşmesi **4 pass / 63 assertion** ile geçti (`p13-schema-contract.log`); typecheck geçti. Node24.19.0 constructor-only mikro ölçümü üç 1000-server örneğinde önce401.99/356.92/372.84ms, sonra81.46/80.58/78.98ms (`p13-schema-construction-before.json`, `p13-schema-construction-after.json`). Tool çalıştırması olmayan bu mikro ölçüm uçtan uca performans kabulü değildir. Yeni gerçek katalog ölçümü ve tüm kaynak kapıları sıradadır.

Isınma ve statik şema yayını sonrasında lint/format/typecheck ve **351 pass / 0 fail / 1925 assertion / 77 dosya / 83.62 saniye** geçti (`p13-schema-tests.log`). Source build, npm dry-run ve temiz tarball Node HTTP/web/altı MCP/gerçek ZIP worker geçti (`p13-schema-build.log`, `p13-schema-pack.json`, `p13-schema-clean-package.json`), kaynak parmak izi `p13-schema-fingerprint.json`. Mikro iyileştirme katalog kabulü yerine sayılmadı. Yeni frozen kaynakta 10.000 paket + sabit500 ısınma + 1 dakika teşhis ölçümü başlatılıyor; bu kısa koşu 30 dakika soak kabulü değildir.

### P05/P13 paket kökünü okuma boyunca sabitleme

Kaynak incelemesinde secureRead ve packageInventory'nin absolute ancestor'ları lstat ile kontrol edip ardından kökü path üzerinden açtığı görüldü. Son kökte O_NOFOLLOW, üst dizinin iki adım arasında symlink ile değiştirilmesini tek başına engellemez. Linux'ta '/' başlangıcından her adım descriptor-relative açılacak; inventory ve seçilmiş dosyalar aynı açık kök üzerinden okunacak. Canlı ACL/revision reader/hash/envanter kapıları korunur; içerik cache edilmez. Bu güvenlik düzeltmesi aynı load içindeki yinelenen root traversal'ı da kaldırır. Linux dışı mevcut yolun güvenlik/OS kabulü ayrı açık kalır; eşdeğer dirfd güvencesi iddia edilmez. Kabul: kök alındıktan sonra ancestor rename/symlink değişiminde eski yetkili inode'dan okuma, kök dışı sentinel'e erişmeme; symlink/hardlink/special/size/depth/hash bozulma regresyonları; callback dışına kaçan işlemleri kapatmadan önce bekleme ve kapanmış okuyucunun reddi. Mevcut 10.000 paket ölçümü önceki frozen runtime'a bağlıdır; yeni kaynak kabulü sayılmayacak.

Önceki frozen kaynakla `p13-schema-catalog` terminal exit1 oldu: 10.000 paket, 500 ısınma, 1 dakika6000istek/0hata; warm load p95 **903.15ms**, dakika load p95 **1473.36ms**, GC max14.96ms/event-loop max148.37ms/ELU0.999. Şema constructor iyileşmesi tek başına katalog hedefini sağlamadı. Log bitiş zamanı20:26:09UTC, yeni root-anchor format/test başlangıcı20:26:53UTC; bu scoped testler koşunun bitişinden sonra çalıştı. Başarısız rapor korunuyor.

Root-anchor değişikliği uygulandı: forward dirfd root açma; aynı açık kökte inventory/read; sıradaki descriptor açıldığında gereksiz parent descriptor kapatılır. Reader kapanışında escaped/in-flight işlemler beklenir; sonradan kullanım reader_closed döner. Callback failure da pending okumaları bırakıp descriptor kapatmadan önce bekler. Live revision pin, ACL, hash, inventory ve boyut/link sınırlamaları korunur. Linux gerçek ancestor rename/symlink testi ve mevcut iki DB paket/reader/archive/delete sözleşmeleri son kaynakta doğrulandı; ayrıntı `p05-root-anchor-final-contract.log`. macOS/Windows dirfd eşdeğeri açık; yeni kaynak için full test/build/package ve rendered/performans kabulü ayrıca gerekir.

İlk root-anchor tam kümesinde **351 pass/1 fail** vardı (`p05-root-anchor-tests.log`): redirect engelleniyordu fakat inventory'nin eski unsafe_path hata kodu genel unsafe_or_missing_file'a dönüşmüştü. Linux root open ENOTDIR/ELOOP durumları eski unsafe_path sözleşmesine döndürüldü; yeni yarış testi de bu mevcut sözleşmeye bağlandı. Hata kodu/sınır kontrolü **2 pass/15 assertion** geçti (`p05-root-anchor-error-contract.log`). Son typecheck/lint/format, **352 pass / 0 fail / 1938 assertion / 78 dosya / 78.02 saniye**, source build, npm dry-run ve temiz tarball Node HTTP/web/altı MCP/ZIP worker geçti (`p05-root-anchor-final-tests.log`, `p05-root-anchor-final-build.log`, `p05-root-anchor-final-pack.json`, `p05-root-anchor-final-clean-package.json`). Parmak izi `p05-root-anchor-final-fingerprint.json`. Bu güvenlik düzeltmesinin son kaynakta katalog performansı henüz ölçülmedi; önceki başarısız şema-katalog raporu aynen durur. Genel hedef ve platform/performance kabulü açık.

### P13 gerçek Node CPU teşhisi

Root-anchor son kaynağında 10.000 gerçek paket, sabit500 ısınma ve1 dakika katalog koşusu Node `--cpu-prof` ile çalıştırılacak. İlk geçici-PATH wrapper komutu otomatik denetimde rm-f tarzı cleanup nedeniyle process başlamadan reddedildi; hiçbir benchmark başlamadı. Wrapper yaklaşımı kaldırıldı. Bunun yerine scriptin `--cpu-profile` seçeneği yalnız child Node'a doğrudan spawn argümanları verir; genel PATH veya diğer süreçler değiştirilmez. Profiler 1000µs örnekleme kullanır; rapor `cpu_profile.acceptance:false` ve artifact yolunu taşır. Profiler maliyeti nedeniyle bu koşu performans kabulü değildir. Amaç gerçek çağrı yığınlarını incelemektir; test/build eşzamanlı çalıştırılmayacak.

CPU profilli gerçek koşu terminal exit1 ile tamamlandı (`p13-root-anchor-profile.json`, `.cpuprofile`, `.log`). 10.000 paket scan21.697ms/verified/0issue, 500 ısınma ve1 dakika6000istek/0hata; warm load p95 **537.78ms**, profil altındaki dakika load p95 **5046.31ms**. Profiler maliyeti/koşulları nedeniyle bu değer kabul ölçümü değildir. Node lifecycle profilinde SQLite executeQuery yaklaşık62.246ms ağırlıklı örnek aralığıyla baskındır; dosya open/close ve GC çok daha az görünür. İncelenen kurulu Kysely driver'da stmt.run satırı7028, stmt.all satırı666 position tick taşır; function entry3786 tick belirsizdir. `p13-root-anchor-profile-analysis.json` ham profil SHA ve yorum sınırlarını içerir. Bunlar tam CPU muhasebesi veya sorgu bazında kesin maliyet değildir; öncelikli inceleme eşzamanlı kalıcı yazma yoludur. FULL dayanıklılığı düşürülmeyecek. Profiler seçeneği ve setup-cleanup/ölçüm yardımcılarının kapsamlı küçük sözleşmesi `p13-cpu-profile-contract.log` ile doğrulandı; production kaynak değişmediğinden önceki352-test/build/package kanıtı tekrar genel geçer performans kanıtına çevrilmedi. Genel hedef açık.

### P13 sorgu bazında SQLite teşhisi

Native profil sonrasında benchmark'a `--sql-profile` eklendi. Yalnız owned SQLite bağlantısındaki senkron sorgu süresi ölçülür; SQL/parametreler raporlanmaz, 256 imza + taşma grubu sınırı vardır. Sabit tablo izin listesi ve işlem türüyle maliyet ayrıştırılır. Üretim dayanıklılığı değiştirilmedi. Gerçek Node SQLite üzerinde constraint/rollback/sonuç koruma, pencere sıfırlama, imza sınırı ve metot restorasyonu doğrulandı; diğer benchmark yardımcılarıyla **5 pass / 0 fail / 54 assertion** (`p13-sql-contract.log`). 10.000 gerçek paket, 500 ısınma ve1 dakika teşhis koşusu `p13-sql-catalog` adıyla başlatıldı; sonuç henüz kabul kanıtı değildir, `sql_profile.acceptance:false`.

`p13-sql-catalog` terminal exit1: 10.000 paket, bir dakika6000çağrı/0hata; gerçek süre78.270ms, search/load p95 **17.176/17.982ms**. Gözlem insert'leri senkron46.301ms tüketti (3000+3000çağrı); revision reader yazmaları bu pencerenin baskın maliyeti değil. Teşhis maliyeti nedeniyle kabul değildir; hata ve kuyruk gecikmeleri korunuyor.

Uygulama düzeltmesi: gözlem kaydı yazmaları en fazla10ms toplama gecikmesi/32çağrı transaction grubu ile birleştirilecek, toplam bekleyen çağrı128ile sınırlanacak. FULL kalıcılığı ve commit-sonrası yanıt korunur. Her çağrı savepoint ile ayrılır; constraint hatası komşu geçerli gözlemi kaybettirmez. Mevcut transaction içindeki observe doğrudan çalışmaya devam eder. Load boyunca revision referansı gözlem commit'ine kadar tutulur. Kabul testleri: iki gerçek DB'de kalıcı bütünlük, tekil hatanın izolasyonu, transaction rollback, idempotency ve kapasite sınırı; sonrasında profiler olmadan gerçek katalog ve30dakika hedefi yeniden ölçülür. Hedef küçültülmez.

Gruplu gözlem yazması uygulandı. Gerçek SQLite/PostgreSQL'de geçersiz revision FK hatası yalnız kendi çağrısını reddediyor; komşu kayıtlar commit oluyor, aynı correlation çoğalmıyor, üst transaction rollback korunuyor.129çağrılık senkron admission'da128kabul/1capacity hatası ve sonrasında toparlanma doğrulandı. Reader/MCP sözleşmeleriyle **6 pass / 0 fail / 71 assertion** (`p13-group-commit-contract.log`). Load artık outer withRevision altında gözlem commit'ini bekler; alt files okuyucusu aynı canlı korumayı paylaşır. Typecheck/lint/format geçti; tam test/derlenmiş ürün/paket kontrolü sürüyor. Profiler kapalı performans kabulü henüz yok.

Gruplu yazma son kaynak kapıları: typecheck/lint/format, **355 pass / 0 fail / 1969 assertion / 80 dosya / 90.70s**, source build, npm dry-run ve temiz artifact kurulumunda gerçek Node HTTP/web/altı MCP/ZIP worker başarılı (`p13-group-commit-tests.log`, `p13-group-commit-build.log`, `p13-group-commit-pack.json`, `p13-group-commit-clean-package.json`). Kaynak parmak izi `p13-group-commit-fingerprint.json`. Profiler ve SQL instrumentation kapalı `p13-group-commit-catalog` 10.000 paket/1dakika karşılaştırması başlatıldı. Bu kapılar genel hedefin veya30dakika performans kabulünün tamamlandığı anlamına gelmez.

Profiler kapalı `p13-group-commit-catalog` terminal exit1: warm search/load p95 **33.87/47.18ms**, dakika **112.03/1234.27ms**,6000istek/0hata/60.054ms. Grup commit doğruluk kapıları geçti fakat sürekli load hedefi halen başarısız. Yeni veri seti hazırlığı137s, önceki268s olduğundan farkın tamamı kod değişikliğine atfedilmez.

Sonraki daraltılmış değişiklik: aynı immutable revision'ın örtüşen okumaları paket kök descriptor'ını paylaşabilir. Şu an her istek aynı absolute yolu O_NOFOLLOW ile bileşen bileşen yeniden açıp kapatıyor. Yalnız canlı okuyucu ömründe kök descriptor paylaşılacak; dosya içeriği veya ACL sonucu cache edilmeyecek, her istekte inventory/hash gerçek dosyadan kontrol edilmeye devam edecek. Son okuyucu root'u kapatır; sonraki okuma kökü yeniden doğrular. Kabul: örtüşen okuyucu aynı root inode'u kullanır, parent rename/symlink yarışında dışarı kaçmaz, bir okuyucunun hatası diğerini kapatmaz, son kapatma ve yeniden açma doğrulanır; mevcut ACL/revision/deletion kontrolleri ve gerçek katalog tekrar ölçülür.

Canlı directory okuyucu paylaşımı uygulandı. Linux gerçek ancestor rename/symlink senaryosunda örtüşen iki çağrı aynı root reader kullanıyor; ikinci callback hatası birinciyi kapatmıyor, değiştirilen gerçek byte okunuyor (içerik cache yok), son okuyucu sonrası closed reddi ve yeni çağrıda unsafe_path doğrulaması çalışıyor. Yol eski haline getirildikten sonra yeniden açılabiliyor. Root-anchor ve iki DB reader/package/deletion sözleşmeleriyle **10 pass / 0 fail / 133 assertion** (`p13-shared-directory-contract.log`); typecheck geçti. Tam build/test/package kapıları sürüyor, performans etkisi henüz ölçülmedi.

İlk paylaşılan directory tam kümesi **355pass/1fail**: PostgreSQL execution-pin gerçek sandbox testi30s timeout (`p13-shared-directory-tests.log`). Bu noktada set-e gate paket adımına geçmedi. Aynı kaynakta ilgili SQLite/PostgreSQL testleri ayrı çalıştırılınca **2pass/20assertion/8.82s** geçti (`p13-shared-directory-execution-recheck.log`). Timeout nedeni kesinleşmiş değildir; süre eşiği yükseltilmedi ve başarısız kanıt silinmedi. Tam küme tekrar çalıştırılıyor.

## 2026-09-06 kullanıcı yönlendirmesi: küçük ölçekli ilk yayın

Kullanıcı gereksiz çoklu test ve büyük kullanıcı ölçeği çalışmalarını durdurup çalışan ürünü yayımlama talimatı verdi. Aktif tekrarlı tam test process'i SIGTERM ile durduruldu (exit143; `p13-shared-directory-tests-final.log` tamamlanmış test sonucu değildir). Yeni soak/ölçek/kalite kampanyası başlatılmayacak. İlk yayın kabulü: mevcut fonksiyonel kanıtlar + son paket için tek temiz kurulum/Node HTTP/web/altı MCP/ZIP worker kontrolü. npm beta ve GitHub ilk bağımsız sürüm hazırlanır; mevcut latest korunur.

P01–P16/K01–K30 içindeki tamamlanmayan ileri ölçek, sağlayıcı, native istemci ve platform kabul maddeleri açık kalır ve bu yayına başarı olarak yazılmaz. Bu, kullanıcının güncel yayın önceliğine göre release kapısının daraltılmasıdır; eski başarısız test/benchmark kayıtları korunur. Son directory paylaşımı typecheck, seçili10test ve ilk tam kümede355başarılıtest ile kontrol edildi; tek PostgreSQL sandbox timeout'u ayrı iki-DB testinde8.82s'de geçti, kök neden doğrulanmadı. Yayın artifact smoke sonucu ayrıca eklenecek.

Kullanıcı yayın kanalını açıkça **npm1.0.0 + GitHub / latest yeni ürüne geçer** olarak seçti. Önceki beta önerisi uygulanmayacak; kararlı1.0.0 yayımlanacak. Fonksiyonel son kodun geçici beta numaralı temiz tarball kontrolü geçti (`release-beta-clean-package.json`: healthy/web/altıMCP/ZIPworker/search_load). Bundan sonra yalnız sürüm sabiti/paket sürümü ve yayın metni1.0.0 olarak değiştirildi; yeniden tam test yok. Yayın paketinin sürümü/içeriği ve registry sonucu doğrulanacak.

1.0.0 yayın artifact'i oluşturuldu: `vaur94-opencode2-skill-forge-1.0.0.tgz`,694.689byte. Paket sınırı (dist/Türkçe belgeler/manifest/README/lisans/SPR rehberi) ve CLI1.0.0 doğrulandı (`release-pack.json`, `release-pack-dry-run.json`, `release-build.log`, `release-fingerprint.json`). npm pack JSON'unun nesne biçimi ilk küçük rapor okuyucusunda dizi varsayımı hatası verdi; okuyucu mevcut scriptteki gibi iki biçimi destekleyecek şekilde çağrıldı ve artifact kontrolü geçti. Ürün hatası veya tekrar test kampanyası değildir. Kullanıcının tekrar testleri durdurma talimatına uygun olarak release commit'i `[skip ci]` kullanır; uzak CI çalıştı iddiası yoktur.

### 1.0.0 yayın tamamlandı

Kullanıcının son talimatıyla belirlenen ilk yayın hedefi tamamlandı. Kaynak commit **a840b07**, uzak main ve codex/skill-forge-mcp-delivery dalına gönderildi; **v1.0.0** etiketi oluşturuldu. npm `@vaur94/opencode2-skill-forge@1.0.0` public/latest olarak yüklendi. Registry ilk kısa beklemede eski sürümü gösterdi; işlem tamamlanınca **latest=1.0.0** ve SHA-512 integrity'nin yayımlanan artifact ile birebir eşleştiği doğrulandı (`release-npm-publish.log`, `release-verification.json`). Tekrar publish yapılmadı.

GitHub kararlı sürümü: https://github.com/ugur-murat-alt/opencode-skill-forge/releases/tag/v1.0.0 — draft=false/prerelease=false;694.689byte tarball ve SHA256SUMS indirilebilir (`release-github.json`). Uzak CI/ileri ölçek testleri tekrar tetiklenmedi. P01–P16'nın açık ileri kabul maddeleri tamamlandı diye işaretlenmedi; sürüm notlarında kullanım sınırları korunuyor. Yeni test kampanyası veya özellik çalışması bu yayın görevinin parçası olarak sürdürülmeyecek.

### P24 uçtan uca denetim ve V2 teslimi (2026-09-08)

G01–G14 uygulama karşılığı kaynak taramasıyla doğrulandı (handoff, revision, runner, kuyruk, sağlayıcı,
telemetri, kurulum, benchmark scriptleri, bakım, artifact, veri dizini, prompt zinciri, bağlar, eşleme/OIDC).
Kod tabanında TODO/FIXME/stub yok. Son ağaçta tam kapılar koşuldu: typecheck, `bun test`
(354 pass / 1 skip / 10 fail / 365 test / 83 dosya; 10 fail yalnızca çevresel gerçek-Docker
sandbox testleri, P22 probu + `p26-review-round2-p19p20.json` gates notuyla kanıtlı), build,
pack (40 dosya), prettier + oxlint temiz, web kabul 28/28 (`role-restore` adımı dahil).
Önceki başarısız soak/katalog kayıtları ve açık P02–P16 maddeleri korunur;
tamamlandı diye işaretlenmedi. Teslim notu `docs/evidence/p24-delivery.md` (P24 anındaki anlık
görüntüdür; güncel kapılar `p26`/`p27` + `p23-web-acceptance.json`'dadur). Uzak CI ve commit
kullanıcı kararına bırakıldı.

### P22 Prompt Editor çıkarma — uygulama kaydı (2026-09-08)

TDD sırası izlendi: önce `test/prompt-removal-boundary.test.ts` yazıldı (kırmızı: 2 fail), kaldırma tamamlanınca yeşile döndü (2 pass). `src/prompt/` kaldırıldı; `sanitize.ts` sır-redaksiyon güvencesi korunarak `src/telemetry/sanitize.ts` altına `sanitizeUntrustedText` adıyla taşındı (legacy karakterizasyon eski adla alias üzerinden çalışır). `forge_prepare` (şema+invoke+HTTP+hook), `prompt_edit` iş türü, `provider role=prompt`, `/api/prompts/*`, `/api/settings/session`, prompt ayar alanları (kayıtlı satırlar `storedSettingsSchema` ile toleranslı okunur) ve migration learning/rewrites/flags kapsamı kaldırıldı. Hook'lar handoff-odaklı yeniden yazıldı; smoke scriptleri beş araç sözleşmesine güncellendi. 8 saf prompt test dosyası silindi, migration/hook/mcp-tools/policy/worker/telemetry testleri paket-odaklı düzeltildi; `test/legacy-runtime` karakterizasyonu korunur. Kapılar: typecheck temiz, build temiz, pack 39 dosya, `bun test` 315 pass / 1 skip / 10 fail (326 test) — 10 fail yalnızca gerçek-Docker sandbox testleri, ortam nedeni kanıtlıdır (PrivateTmp `/tmp` perdesi + `umask 0077`/mkdtemp izinleri; yürütücü `umask 022` probunda başarılı). Kanıt `docs/evidence/p22-prompt-removal.json` (aynı sayılar). Eski `runs` prompt satırları retention ile yaşlanır; prompt tabloları bu adımda düşürülmedi.

Bağımsız incelemede (3 general ajan) bulunan ek eksikler kapatıldı: `020_prompt_drain` migration takılı prompt işlerini `cancelled/prompt_removed` yapar ve `queue.accept` bilinmeyen türü `invalid_kind` ile reddeder; SPR el kitabı/hook talimatları/README/package.json beş araca güncellendi; smoke hata mesajları `five-tool` oldu; eşleme hatası `invalid_mapping` koduna bağlandı; sınır testi `docs/tr`+README+el kitabı+`package.json` kapsar; sanitizer doğrudan birim testle korunur. Eski learning/rewrites/flags receipt'lerinin rollback/`original` yolu kapandı (fail-closed; veri silinmedi). `role='prompt'` yetim satırlar okunmaz, kasadaki sırlarına dokunulmaz; temizlik notu buradadır.

### P17 organizasyon, davet ve devir — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `test/organization.test.ts` (6 test) + `test/github-auth.test.ts` (2 test) önce yazıldı, eksik modüllerde kırmızı verdi, sonra yeşillendi. Roller `founder/admin/writer/reader/auditor` oldu (`owner→founder`, `editor→writer`, `viewer→reader`; migration 022 mevcut satırları yetki yükseltmeden taşır; `local-owner` cihaz kimliği aynı kaldı). `021_invitations`, `023 tenant_lifecycle + transfer_offers` migration'ları eklendi. Davet tek kullanımlık/süreli/iptal edilebilir (50 bekleyen + saatlik 20 kota, kabulde rol yeniden doğrulama); devir iki adımlı atomik takas (eski kurucu yöneticiye iner); silme ad-eşleşme + 24 saat bekleme + dondurma (`tenant_frozen`) + FK-sıralı basamaklı silme; devre dışı bırakma oturumları aynı işlemde iptal eder (401). OIDC mevcut `issuer|sub` kapısıyla, GitHub `github|<id>` adaptörüyle (`/auth/github/*`, fixture-sunuculu test) davet-kapılı çalışır. Uçlar: `/api/tenants`, `/api/organizations`, `/api/invitations/*`, `/api/organization/transfer/*`, `/api/organization/deletion/*`. Web Members etiketleri güncellendi (tam tasarım P23'te). Kapılar: typecheck temiz, build temiz, pack 39 dosya, `bun test` 323 pass / 10 fail (yalnızca çevresel Docker). Kanıt `docs/evidence/p17-organization.json`. Bilinen sınırlar: `users`/`auth_sessions` kullanıcı düzeyinde korunur; disk blobları paylaşılabildiği için silinmez; pg-boss kuyruk temizliği kapsam dışıdır.

### P18 rol-araç matrisi — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `test/role-matrix.test.ts` (5 test) önce yazıldı, eksik modülde kırmızı verdi, sonra yeşillendi. `024_role_registry` migration'ı eklendi; `src/domain/roles.ts` matris + kademe, `src/application/roles.ts` çözümleme servisi (`list/create/remove`, `assertGrantable`, `allowedTool`) taşır. `authorize` özel rolleri tabana indirger, bilinmeyen/silinmiş rolü fail-closed reddeder. `ForgeService.invoke` rol reddini `tool_denied` (rol+araç açıklamalı) ile verir; `createMcpServer` artık async ve kimlik başına liste filtreler. Üye/davet kabulü özel rol adlarını doğrular; yetki yükseltme kuralı (`grant_denied`) üye ve davet yollarında zorlanır. Uçlar: `GET/POST /api/roles`, `DELETE /api/roles/:name`. Proje rolleri yerleşik writer/reader kalır; web özel-rol UI P23 işidir. Kapılar: typecheck temiz, build temiz, pack 39 dosya, `bun test` 338 pass / 0 fail / 339 test. Kanıt `docs/evidence/p18-role-matrix.json`.

### P19 ortam, kapsam ve bağ modeli — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `test/environments.test.ts` (5 test) önce yazıldı, eksik modüllerde kırmızı verdi, sonra yeşillendi. `025_environments` (ortam tablosu + `projects.environment_id` + kiracı başına default ortam ve backfill) ve `026_binding_identity` (`local_name` + `fs_fingerprint`) migration'ları eklendi. `EnvironmentService` (list/create/remove/resolveProject + idempotent `ensureDefaultEnvironment`), `BindingService` (kanonik yol + dev:ino parmak izi, taşınmış dizinde `stale`), `PackageStore.setScope` (CAS + çift-yetki + ad çakışması + denetim; pinler korunur) yazıldı. Skill/ayar/MCP-arama kapsamına `environment` eklendi; yazma kuralı `scopeWritePermission` ile merkezileşti; arama varsayılan kümesi proje ortamını katar. Uçlar: `/api/environments*`, `/api/bindings/*`, `PUT /api/skills/:id/scope`. P17 silme basamağına `environments` eklendi (P17 testi yakaladı). Kişisel/proje kapsamları ve göç yolları değişmedi. Kapılar: typecheck temiz, build temiz, pack 40 dosya, `bun test` 343 pass / 0 fail / 344 test. Kanıt `docs/evidence/p19-environments.json`. Web ortam seçici P23 işidir.

### P20 skorlu arama — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `test/search-scoring.test.ts` (4 test: saf skor birimi + sıralama/açıklama/eşik/sayfa/tekilleme + ayar sınırları + duvar kaçağı) önce yazıldı, eksik modülde kırmızı verdi, sonra yeşillendi. `src/skills/scoring.ts` saf skor motoru (isim katmanı açıklamayı yener, kapsam + ≤0.1 kullanım dürtmesi, 3-ondalık deterministik) eklendi. `PackageStore.search` LIKE ön-filtre (100 aday) + tenant-içi 30-gün kullanım + skor + `searchMinScore` + sıralama + ad-tekilleme (`other_scopes`) + `skor:id` cursor uygular; limit = min(girdi, ayar). Ayarlara `searchMinScore` (max-birleşim: sıkı eşik korunur) ve `searchMaxResults` eklendi. MCP yönergesine ilk-N yükleme cümlesi eklendi. Cursor opaklık sözleşmesi ve staging ajan akışı korunur. Kapılar: typecheck temiz, build temiz, pack 40 dosya, `bun test` 347 pass / 0 fail / 348 test. Kanıt `docs/evidence/p20-search-scoring.json`.

### P21 ajan prompt zinciri — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `test/agent-prompts.test.ts` (4 test: çözüm önceliği, monoton sürüm + CAS + geri alma, içerik doğrulama + admin kapısı, kiracı izolasyonu) önce yazıldı, eksik modülde kırmızı verdi, sonra yeşillendi. `027_agent_prompts` migration'ı eklendi. `AgentPromptService` (active/history/update/rollback) + `resolvePrompt` (environment → org → paket dosyası; bilinmeyen projede zarif düşüş) yazıldı; sürümler monoton artar, geri alma yeni sürüm ekler, taban çakışması `revision_conflict` verir. İçerik kapısı: boşluk-dışı, ≤32768 karakter, karar çapaları; yazma yönetici ister, denetim kaydı tutulur. `productionHandler` çalıştırma başına ortambağımlı prompt çözer; eski dosya yardımcısı kaldırıldı. Uçlar: `GET/PUT /api/agent-prompts`, `POST /api/agent-prompts/rollback`. Kapılar: typecheck temiz, build temiz, pack 41 dosya, `bun test` 351 pass / 0 fail / 352 test. Kanıt `docs/evidence/p21-agent-prompts.json`.

### P23 web yenileme — uygulama kaydı (2026-09-08)

TDD sırası izlendi: `scripts/web-acceptance.mjs` (Playwright, gerçek derlenmiş servis + gerçek Chromium) önce yazıldı, olmayan ekranlarda kırmızı verdi, sonra yeşillendi: 28/28 kontrol (giriş, 12 sayfa, org kur/seç/rozet, skorlu arama görünümü, rol oluştur/sil/geri-yükle, davet oluştur/iptal, prompt düzenle/çift-marker geri al, yetkisiz giriş, sıfır sayfa hatası). `playwright-core@1.63.0` sabitlendi. Yeni ekranlar: Organizasyonlar (kur/seç/devir teklifi+kabul/silme iste+onay+vazgeç), Roller (liste/oluştur/sil + matris görünümü), Davetler (oluştur/anahtar/iptal), Ajan promptları (kapsam seçici, CAS düzenleme, geçmiş + geri alma). Kabuk: org/ortam seçici + kapsam rozeti (`OrgScope`), projesiz açılan yönetim sayfaları; Library skor sütunu + gerekçe + kapsam filtresi. Tasarım standardı: token değişkenleri + compact yoğunluk; `prettier`/`oxlint` temiz. Yeni uçlar: `POST /api/tenants/switch`, `GET /api/organization/transfer/offers`, `GET /api/organization/deletion/status`, `POST /api/projects` artık `environment_id` kabul eder. Kanıt `docs/evidence/p23-web-acceptance.json` + `docs/evidence/design/p23-*.png` (12 ekran).

### Runtime harness — gerçeklik bağı (2026-09-09)

Birim testleri + derleme "çalışır" demez; bu yüzden `scripts/runtime-harness.mjs`
gerçek derlenmiş artifact'ı (`dist/cli.js serve`) açar, gerçek MCP SDK istemcisiyle
5 aracı yoklar ve gömülü worker + GERÇEK Pi runner üzerinden uçtan uca skill_evolve
koşar: senaryolu loopback OpenAI-uyumlu sahte model (sıfır ücret) inventory → select →
patch → validate → finalize(create) adımlarını oynar, doğan skill aranır + okunur.
18/18 yeşil (3 koşu). Kanıt `docs/evidence/p28-runtime-harness.json`. Harness yolunda
bulunan tek gerçek davranış: allowlist yalnız operatör `policy.json` ile genişler
(workspace katmanı daraltır) — tasarım kararı, `provider_endpoint_denied` ile
fail-closed kanıtlandı. Kapsam dışı kalan gerçeklik: Docker gerektiren script
çalıştırma (bu makinede fail-closed zarf döndürür), ücretli sağlayıcılar, PostgreSQL
yolu, soak/performans (P02–P16 açık maddeleri).

### 2. tur bağımsız inceleme bulgu kapatmaları (2026-09-08)

6 kapsam (P22, P17, P18+P21, P19+P20, P23, tutarlılık) ikinci kez tarandı; çıkan blocker/majorların
tamamı kapatıldı. P19+P20 kanıtı `docs/evidence/p26-review-round2-p19p20.json`: 028 kirli-veri
dedup/orphan iyileştirmesi, ortam skill edit/rollback eşlemesi (`scopeForSkill` + projesiz fallback),
`withRevision` ikinci-faz TOCTOU kapatma, arama/duvar kilit testleri. P23 kanıtı
`docs/evidence/p27-review-round2-p23.json`: `list()` silinmiş özel rolleri döndürür (restore ulaşılır),
kabulde `role-restore` + çift-marker `prompt-rollback` gerçek assertion'ları (28/28), ölü CSS/Empty/token
küçükleri. Tutarlılık: plan başlığı + P24 kaydı güncel sayılara çekildi, `p24-delivery.md` anlık-görüntü
notu eklendi, ölü doc referansları işaretlendi, kabul detayları zenginleştirildi
(kalan boş detaylar sayfa-yükleme adımlarıdır; bilinçli kabul).

### 1. tur bağımsız inceleme bulgu kapatmaları (2026-09-08)

6 bağımsız ajan (P22, P17, P18+P21, P19+P20, P23, tutarlılık) taradı; çıkan blocker/majorların tamamı
kapatıldı, kanıt `docs/evidence/p25-review-round1.json`. Öne çıkanlar: davet/transfer atomik claim
korumaları, cascade + dondurma semantiği (istekte iptal, claim/outbox atlama), public uç throttle,
prompt dosya adı + rollback kapısı + PK yarışı eşlemesi, ortam yarışı/backfill/okuma yalıtımı,
binding damgası, skor rötuşları, web senkronizasyon + kabul doublajları, sınır testi genişlemesi.
Ertelenenler belgelendi (pg-boss temizliği, yetim oturum GC, özel-rol web UI).

## 23. V2: Organizasyon > Ortam yönetimi (2026-09-08 yönlendirmesi)

Kullanıcı, firmadan tek kişiye herkesin tüm projelerini yürütebildiği, organizasyonlar arası keskin duvarlı sisteme karar verdi. Org kurma herkese açık, org'a giriş yalnız davetle. Default roller founder/admin/writer/reader/auditor; founder alınamaz (yalnız rıza ile devir, halefsiz ayrılışta org kilitli), diğer default roller üyesizse silinebilir. Skill'ler ortama kayıt olur (environment veya project + yerel ad + yol parmak izi); dışarıda skill bilgisi saklanmaz. Arama skorlu ve yapılandırılabilir (`maxResults`/`minScore` + `why-matched`); adet üst sınırı gibi sabit kapı yok. Default ajan promptu sürümlüdür (org default → env override) + golden test. Prompt Editor ve `forge_prepare` tamamen kalkar (stub yok); dış sözleşme 6→5 araca iner. Web compact/modern/az çizgili yenilenir.

Her pakette TDD kapısı: önce başarısız sözleşme testi (kırmızı) → uygulama (yeşil) → `docs/evidence/` kanıtı → tam küme. Yeşil olmayan paket kapanmaz.

### P17 — Kimlik, üyelik ve davet
- [x] OAuth (GitHub/Google) kayıt; kullanıcı ↔ N org; tek kullanımlık süreli davet, kabulde rol yeniden doğrulama, kabul öncesi iptal.
- [x] Kurucu devir protokolü (teklif + kabul + pencere), halef designate, org silme (yazılı onay + bekleme + tombstone).
- [x] Üye çıkarma = token/session/lease anında iptal; davet kotası + hız sınırı; append-only org denetim kaydı.
- [x] Testler: davet tekrarı/süresi, devirsiz kurucu silme reddi, çıkarma sonrası erişim yokluğu.

### P18 — Rol ve araç matrisi
- [x] Özel roller (izin seti, deny-first); founder dışı default rol silme (üyeli rolde önce reassign zorunlu); yükseltme yasağı (sahip olunmayan izin verilemez).
- [x] Rol→MCP aracı + argüman kısıtı; kontrol `ForgeService.invoke`, HTTP route'ları ve MCP liste filtrelemede; sızıntısız ret açıklaması.
- [x] Başlangıç: reader=search/load/report, writer=+stage/run, admin=+finalize/yönetim, auditor=salt-okunur rapor, founder=tümü+org.
- [x] Testler: yetkisiz finalize/run reddi, admin'in founder'a dokunamaması, matris dışı aracın listede görünmemesi.

### P19 — Org/ortam/project-binding modeli
- [x] `environments` tablosu; `projects.environment_id`; skill/ayar `scope_key`'e `environment:` şeması; binding ortam bilinçli `project_ref` çözümleme.
- [x] Mevcut personal/project verisi idempotent + checksum'lı taşınır; yol değişince binding yeniden doğrulama; ortamlar arası `promote` açık işlem + yeniden doğrulama (kodda `setScope` + CAS/çift-yetki/denetim).
- [x] Testler: tenant-kaçış (orglar arası arama/listeleme imkânsızlığı), kapsam taşıma, stale binding reddi.

### P20 — Skorlu skill arama
- [x] Hibrit skor (terim kapsama + alan ağırlığı + kullanım sinyali), `minScore`/`maxResults` org/ortam ayarından, `why-matched`, cursor sayfalama; aynı kimlik tekilleştirme + kapsam notu (gölgeleme yok).
- [x] Server instructions: çok eşleşmede yalnız ilk N yüklenir; tümünü yükleme davranış testi.
- [x] Testler: eşik altı elenme, adet yapılandırması, açıklanabilirlik, sayfalama determinizmi.

### P21 — Sürümlü ajan promptu
- [x] `agent_prompts` (org default + env override, sürümlü); runner `skill_evolve` sistem promptunu buradan alır; değişiklik diff + golden-task + rollback.
- [x] Testler: override önceliği, eski sürüme dönüş, golden görev regresyonu.

### P22 — Prompt Editor çıkarma
- [x] Kaldırma envanteri: `src/prompt/` tamamı, `forge_prepare` (schemas/server/`forge.ts:295-333`), handler/queue/worker prompt dalları, `Run.kind` daraltma, `provider_profiles role='prompt'` durdurma, `/api/prompts/*` + learning CRUD + `/api/tools/forge_prepare`, ayar prompt alanları, web prompt ekranları, hook'ların handoff-odaklı yeniden yazımı, prompt testleri, `prompts/prompt-edit.md`, P08.
- [x] P14 learning/rewrites/flags göç kapsamı düşer (yalnız skill/paket); prompt `runs` satırları retention ile yaşlanır, backfill yok; prompt tabloları bu adımda düşürülmez (yazım durur).
- [x] Kabul: `forge_prepare|prompt_edit|LearningStore|prompt/` için kaynak taraması sıfır sonuç; tam küme yeşil (çevresel Docker hariç).

### P23 — Web yenileme
- [x] Org/Ortam seçici + kapsam rozeti; skorlu skill arama; rol/davet/denetim ekranları; prompt ekranları kalkar; tasarım tokenları + yoğunluk standardı; her ekranda boş/hata/yetkisiz durumu.
- [x] Kabul: Playwright senaryoları (login, arama→yükleme, davet→kabul, yetkisiz deneme, stale edit) + gerçek ekran görüntüleri; mock veriyle ekran kapatılmaz.

### P24 — Uçtan uca V2 denetimi
- [x] G-hedeflerine org/duvar satırları; K-senaryoları (duvar ihlali denemesi, davet yarışı, eşik davranışı, devir/silme akışı).
- [x] Açık P01–P16 maddeleri V2 notuyla korunur; tamamlanmayan kabul başarı yazılmaz.
