# ADR: sınırlı MemoryCurator profili, dar araçlar ve otomasyon politikası

Durum: **Accepted — Faz A uygulandı; canlı model ve native kalite kabulü
yapılmadı.** Tarih: 2026-09-11. İlgili issue: #39 (üst plan #33). Önkoşullar
#35 (M02 commit hattı), #36 (M03-A arama/recall) ve #38 (M05 güvenilir
olaylar) teslim edilmiştir; M03-B bağlam/`memory_update` ve M04-B arayüzü
Faz B'dir.

## Bağlam

M05'e kadar hafıza yalnız manuel ve hook checkpoint'leriyle besleniyordu.
#39 yararlı kayıtları kontrollü üretmek istiyor ama her olayda pahalı bir
ajan zinciri çalıştırmadan. Deterministik işler (ACL, hash/revision, kuyruk,
redaksiyon, indeks) kodda kalır; model yalnız anlam çıkarma/birleştirme
gerektiren adaylarda çalışır.

## Kararlar

1. **Bağımsız model bağı.** `memory_curator_profiles` (037) ayrı bir rol
   tablosudur; `provider_profiles` skill/evaluation rolleri kullanılmaz.
   Anahtar mevcut `SecretVault` ile saklanır. Skill profilinden, başka rolden
   veya ortamdan anahtar devralma ve sessiz ücretli modele geçiş yoktur;
   profilsiz çalışma görünür `model_not_ready` no-op'udur. Gerekçe: dosya
   alanı kısıtı `src/application/providers.ts` rol enum'unu değiştirmeye
   izin vermediği için "eşdeğer açık bağ" olarak yeni tablo seçildi; ayrıca
   bu, iki model politikasının birbirine karışma riskini tamamen kaldırır.
2. **Tek profil, üç görev modu.** `memory_curate` payload'ı
   `task: extract|merge|conflict` taşır; ayrı sonsuz ajanlar yoktur. Model
   yalnız `source_read`, `memory_lookup`, `propose_patch`, `propose_link` ve
   `finalize` araçlarını görür.
3. **Yazı yolu tek.** Araçlar aday üretir (`memory_curator_changes`); Markdown
   veya SQL'e doğrudan yazım yoktur. İzinli otomatik adaylar `finalize`
   sırasında M02 `recordEvent` + `MemoryCommitService.commit` yolundan
   geçer; iptal/timeout/finalize'sız koşu adaylarını `rejected` işaretler.
4. **Politika modları ve sert sınırlar.** `off|manual|shadow|proposal|auto`
   ayarlarda bağımsızdır ve katmanlar yalnız daraltır. Auto-write yalnız
   `risk=low`, `claim_class=user_declaration`, `operation=create`,
   `kind=preference` ve açık `curatorAutoWriteKinds` izniyle mümkündür;
   belirsiz birleştirme, çelişki, insan metnini değiştirme, link ve silme
   kullanıcı kararına kalır. `curatorMaxCalls ≤ 3`, `curatorMaxProposals ≤ 8`
   ve `curatorMaxSourceBytes` şemada sert tavanlıdır.
5. **Sınıflandırma deterministik.** `classifyCuratorClaim` kullanıcı beyanı,
   dış doğrulanmış olgu, model tahmini, düzeltme, çelişki, plan ve
   tamamlanmış işi ayırır; tamamlanma iddiası ve insan metnini değiştirme
   asla auto-write değildir.
6. **Maliyet önbelleği ve muhasebe.** `(tenant, space, extractor, policy,
fingerprint, mod)` değişmediyse model çağrılmaz (`memory_curator_extractions`
   üzerinden `cached`). Kullanım (input/output/reasoning/cache token, ücret,
   çağrı, tool byte, süre) birlikte yazılır; belirsiz ücret `null`'dır.
   Bütçe bu işin kabul anlık görüntüsüyle sınırlıdır (M02/#25 semantiği).
7. **İş türü kaydı.** `memory_curate` `defaultJobKinds` içine statik olarak
   eklendi; `productionJobKinds` birleşimi onu otomatik taşır. Kuyruk/worker
   aynı kabul/claim/audit hattını kullanır. Handler, `productionHandler`
   içinde `memory_curate` dalına yönlenir; `memoryJobHandlers` kaydı
   değişmeden kalır.

## Sonuçlar ve sınırlar

- Model çağrısı yalnız sınırlı bir iş koşusunda olur; hook sıcak yolu ve
  M05 spool bundan etkilenmez.
- `memoryEnabled=false` iken memory işleri kabul edilmez; skill geliştirme
  `evolutionEnabled` ile bağımsız kalır. `memoryCuratorMode=off` manuel
  hafızayı engellemez.
- Adayların kullanıcı onay akışı, çelişki inceleme arayüzü ve TR/EN
  değerlendirme eşiği Faz B'dir; "confidence" tek başına yetki değildir.
- Canlı model kalitesi ve gerçek maliyet ölçülmedi; fixture'daki sahte
  stream yalnız sözleşme kanıtıdır.

## Açık sorular

1. Auto-write izinli sınıf kümesi ölçüm sonrası genişletilecek mi
   (`fact`/`note` için hangi kanıt sınıfı)?
2. Merge modunda tek adaylı otomatik güncelleme yerine kullanıcı onayı ne
   zaman zorunlu olmalı?
3. `memory_curator_extractions` kayıtlarının saklama süresi ve önbellek
   invalidation politikası #41 retention ile nasıl birleşecek?
