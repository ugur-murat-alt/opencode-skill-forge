# Hafıza küratörü (MemoryCurator) — kaynaklı çıkarım ve birleştirme

Durum: **Faz A uygulandı; gerçek/ücretli model ve native kabul testi
yapılmadı.** Bu ortamda testler sahte provider stream'i ile çalışır; canlı
model kalitesi ve TR/EN otomasyon eşiği #41 değerlendirme kümesiyle
ölçülmelidir. Yerel fixture kanıtı, canlı model kanıtı değildir.

İlgili sözleşme: `docs/adr/memory-curator.md`. Kod:
`src/memory/curator/**`, `src/domain/curator.ts`, migration
`037_memory_curator`.

## Ne yapar, ne yapmaz?

- **Yapar:** yetkili kaynaklardan (kayıtlı `memory_sources`) sınırlı okuma,
  kısa kayıt arama, create/update/supersede/link **adayı** hazırlama ve
  politikaya göre dar otomatik yazım.
- **Yapmaz:** şema/ACL/hash/CAS/kuyruk/redaksiyon/link indeksleme gibi
  deterministik işleri modele yaptırmaz; model ana Markdown'a veya SQL'e
  doğrudan yazamaz; host shell, keyfi dosya yolu, izin genişletme, delegasyon
  ve başka ajan üretme araçları yoktur; silme işlemi yoktur.

Tek profil üç görev modunu taşır: `extract` (yeni kayıt), `merge` (mevcut
kaydı `base_revision` ile güncelleme), `conflict` (çelişki/düzeltme
incelemesi; yalnız öneri kalır).

## Bağımsız model bağı

- Model yapılandırması `memory_curator_profiles` tablosunda ayrı tutulur;
  `provider_profiles` rolü (skill/evaluation) kullanılmaz. Anahtar yine mevcut
  `SecretVault` ile şifreli saklanır.
- **Fallback yok:** skill profilinden, ortam değişkeninden veya başka bir
  rolden anahtar devralınmaz; ücretsizden ücretliye sessiz geçiş yoktur.
- Model yoksa/eksikse çalışma `no_op` + `model_not_ready` olur; manuel hafıza
  ve arama etkilenmez. Hazırlık `GET /api/memory/curator/status` ile görünür
  (`model_ready`, `credential`, `mode`).

## Dar iç araçlar

| Araç            | Yetki sınırı                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `source_read`   | Yalnız işin yetkili `source_refs`'i ve kayıtlı köke göreli yol; `..`/mutlak yol/symlink reddi; byte sınırlı |
| `memory_lookup` | Yalnız iş kapsamındaki (space) sınırlı kayıt araması/seçili gövde                                           |
| `propose_patch` | create/update/supersede; beklenen `base_revision`, kaynak atıfları ve gerekçe zorunlu                       |
| `propose_link`  | Aynı space'te doğrulanmış iki uç + ilişki türü + atıf                                                       |
| `finalize`      | `no_op`/`proposed`/`rejected`; sonrasında araç yok. Auto modda düşük riskli sınıf commit edilebilir         |

Atıflar yalnız gerçekten okunan kaynak özetleriyle eşleşirse geçerlidir;
uydurma citation reddedilir. `finalize` sonrası araç çağrısı ve iptal/timeout
sonrası yazım engellenir.

## Politika modları

| Mod        | Anlam                                                  |
| ---------- | ------------------------------------------------------ |
| `off`      | Otomatik çıkarım kapalı; manuel hafıza etkilenmez      |
| `manual`   | Yalnız açık istekle çalışır; adaylar incelemeye düşer  |
| `shadow`   | Kaydeder ama uygulamaz; değerlendirme içindir          |
| `proposal` | Adaylar inceleme kuyruğuna düşer                       |
| `auto`     | Yalnız ölçülmüş düşük riskli sınıflar otomatik yazılır |

Katmanlar modu yalnız daraltabilir (off < manual < shadow < proposal < auto).
Mod geçişleri veri silmez; kapatma skill geliştirmeyi etkilemez
(`memoryEnabled` ve `evolutionEnabled` ayrı bayraklardır).

**Auto-write sınırı:** yalnız `state=proposed`, `risk=low`,
`claim_class=user_declaration`, `operation=create`, `kind=preference` ve
ayarda açıkça izinli (`curatorAutoWriteKinds`) adaylar M02 commit yolundan
yazılır. Belirsiz birleştirme, çelişki, insan metnini değiştirme, link ve
her türlü silme kullanıcı kararına kalır.

## Kalite sınıfları

`classifyCuratorClaim` deterministik olarak ayırır: kullanıcı beyanı
(`declared`), dış doğrulanmış olgu (`verified`), model tahmini (`proposed`),
düzeltme, çelişki, plan ve tamamlanmış iş. "Bitti"/test sayısı tek başına
tamamlanma kanıtı değildir; modelin güven ifadesi yetki değildir; kaynak
değiştiyse eski aday `base_revision_conflict` ile `stale` olur ve daha yeni
insan metnini ezemez.

## Sınırlar ve muhasebe

- `curatorMaxCalls` (1–3), `curatorMaxProposals` (1–8), `curatorMaxSourceBytes`
  ve `maxCostMicros`/`maxTokens` bu işin kabul anlık görüntüsüdür; başka
  projelerin geçmiş harcamasıyla birleşmez.
- Toplam input/output/reasoning/cache token, ücret, çağrı sayısı, tool sonucu
  boyutu ve süre `memory_curator_extractions.usage_json` içinde birlikte
  saklanır; belirsiz sağlayıcı maliyeti `null`'dır (sıfır değil).
- Aynı kaynak + extractor/policy sürümü + mod değişmediyse ikinci istek model
  çağırmaz (`cached`); servis restart'ı bu kaydı bozmaz.
- Öneriler `memory_curator_changes` tablosunda aday olarak durur; uygulanan
  aday `applied_revision` taşır. Adaylar Markdown notu değildir.

## HTTP yüzeyi

- `GET /api/memory/curator/status` — mod, hazırlık, sürümler.
- `PUT /api/memory/curator/profile` — bağımsız model profili (CAS `base_revision`).
- `POST /api/memory/curator/run` — elle kuyruklama (idempotency anahtarı ile).
- `GET /api/memory/curator/proposals?space_id=…` — salt-okunur aday listesi.

## Faz B (henüz yok)

- Aday/çelişki inceleme arayüzü ve `propose_*` onay akışı (M04-B).
- TR/EN değerlendirme kümesinde yanlış otomatik yazım ölçümü ve otomasyon
  kalite eşiği (#41); "confidence yüksek" tek başına auto-write açmaz.
- Canlı model kalitesi, gerçek maliyet ve gecikme ölçümü.
