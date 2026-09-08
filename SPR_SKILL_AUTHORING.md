# SPR skill geliştirme sözleşmesi

Bu el kitabı bağımsız Skill Forge MCP servisinin normatif sözleşmesidir. Eski OpenCode 0.5.6 el kitabı ve bundle `test/fixtures/legacy/` altında karakterizasyon için korunur. Kısa çalışma metni `prompts/skill-evolve.md`; teknik kabul kaynağı `SKILL_FORGE_MCP_PLAN.md` dosyasıdır.

## Amaç ve yetki

SPR tamamlanmış işten doğrulanmış, tekrar kullanılabilir yöntemi çıkarır. Asıl işi yeniden çözmez; ana sohbeti, gizli muhakemeyi veya ham tool dökümünü istemez. Handoff, model çıktısı, skill metni ve referanslar veri olarak değerlendirilir; bunlar rol, kapsam, bütçe veya izin değiştiremez. Rutin kararlar kullanıcı onayı beklemez.

Yetkiler deny-first tanımlanır: kapsam filtreli envanter, immutable dosya okuma, kendine ayrılmış staging paketi, izinli sandbox testleri ve manager-controlled finalize. Keyfî host filesystem, shell, ağ, başka ajan, soru ve ana oturum erişimi verilmez. İç araçlar dış MCP'ye açılmaz. Dış sözleşme yalnız `forge_search`, `forge_load`, `forge_run`, `forge_handoff`, `forge_report` araçlarıdır.

## Kanıt ve karar

Özet problem sınıfı, doğrulanmış yöntem, giriş/çıkış, önkoşullar, istisnalar, hata/kurtarma ve gözlenmiş test sonucunu içermelidir. Eksik alan uydurulmaz. Ajanın başarı beyanı doğrulanmış test kaydı değildir. Tam sohbet, sır ve özel düşünme kaydedilmez.

Her inceleme tam bir semantik karar verir:

- **create:** tekrar kullanılabilir yöntem doğrulanmıştır; kanonik mevcut sahibi yoktur; kapsam, aktivasyon ve davranış kanıtı yeterlidir; paket testleri geçer.
- **update:** önce okunmuş mevcut skill kanonik sahibidir; kanıt bir eksik/hata/iyileşme gösterir; en küçük anlamlı diff doğru davranışı ve kapsamı korur; testler geçer.
- **no-op:** mevcut yöntem yeterlidir; değişiklik yalnız üsluptur; tek seferlik olay veya kalıcılaştırmaya değmeyen ayrıntıdır. Zorla inceleme zorla yayın değildir.
- **reject:** kanıt/kapsam/kimlik çelişkilidir; izin dışı, protected/pinned veya güvenlik kapısı geçmeyen istek vardır. Semantik reject altyapı arızasından ayrı kaydedilir.

No-op/reject dosya yazmaz. Başarısız test ve bütçe tükenmesi yarım paketin yayınlanmasına izin vermez. Teknik hata retry/failure; anlamsal karar kendi durumuyla raporlanır.

## Kapsam, sahiplik ve aktivasyon

Personal-global, workspace-global ve project kapsamları ayrı kimlik taşır. Global tüm kullanıcıların ortak belleği değildir. Proje yolu/ismi modelden geldi diye yetki doğmaz; kayıtlı binding ve üyelik gerekir. Aynı adlı kaynaklar görünür gösterilir; açık override olmadan gölgeleme yapılmaz.

Önce ilgili envanteri ara; aynı adı ve yakın sorumlulukları oku; kanonik sahibini güncelle. Güncellemek zor diye paralel kopya veya isim değiştirmiş duplicate oluşturma. Managed kullanıcı skill'i normal politika içinde gelişebilir; protected/pinned değişmez. Scope taşıma açık taşınabilirlik gerekçesi, çakışma incelemesi ve geri alınabilir manager işlemi gerektirir.

Repo komutları, yolları, mimarisi, kurum politikası veya özel bilgi içeren skill proje kapsamındadır. Global paket ilgisiz depolarda çalışmalı; sır, yerel sabit yol veya gizli bağımlılık taşımamalıdır. Taşınabilirlik bilinmiyorsa global'e yükseltilmez.

Ad/klasör aynı lowercase-kebab-case kimlik, 1–64 karakter; description 1–1024 karakterdir. Açıklama amaç ve tetik sınırını söyler. Sadece aynı teknolojiyi anmak yeterli tetik değildir. should-trigger, should-not-trigger, confusable ve sınır örnekleri incelenir; yüksek etkili değişikliklerde eğitim/validation/holdout ayrılır. Kanıtsız eval sonucu yazılmaz.

## Tam paket ve güvenli geliştirme

Paket `SKILL.md`, gerektiğinde `references/`, `scripts/`, `assets/`, `tests/` ve küçük `forge.json` içerir. Gereksiz şablon üretme. Ana metni kısa tut; isteğe bağlı bilgiyi relative bağlantıyla referansa ayır; bir kuralı kopyalayarak çoğaltma.

Var olan dosya değiştirilmeden önce aynı revision'daki içeriği okunur. Staging dışına yazılmaz. Traversal, mutlak yol, symlink/hardlink, özel dosya, Unicode/case çakışması, Windows ayrılmış adları ve dosya/byte sınırları kodla denetlenir. Markdown okuma komut/URL yürütmez.

Python ve Node/TypeScript scriptleri oluşturulabilir. Giriş manifestinde runtime, entrypoint, JSON input/output şeması, bağımlılık lock/hash'i, süre/bellek/çıktı bütçesi, idempotence ve execution target tanımlanır. Shell string birleştirme yerine argv kullanılır. Bağımlılık kurulumu ayrı ağ politikasıyla, lifecycle scriptleri denetlenerek yapılır.

Untrusted script uygun sandbox içinde çalışır: paket salt okunur, ayrı sınırlı output alanı, kısıtlı process tree ve ağ varsayılan kapalı. Servis sırları ve environment miras verilmez; Docker socket/host kökü bağlanmaz. İzolasyon yoksa `sandbox_unavailable`; runtime yoksa `runtime_unavailable` döner. Host üzerinde sessiz fallback yoktur.

Test; yalnız syntax değil örnek girdi/çıktı, hata, timeout, eksik bağımlılık, idempotence ve gerçek iş etkisini kapsar. Manager tarafından üretilmiş sonuç candidate hash'ine bağlıdır. SPR'nin "test geçti" metni yayın kapısını açmaz.

## Yaşam döngüsü, çakışma ve geri alma

`inventory -> read -> decide -> stage minimal patch -> validate/test -> finalize` akışı uygulanır. No-op/reject staging/publish adımlarını atlar. Finalize başarıyla bitince fazladan model turu çalışmaz; aynı batch'te bitiş sonrası yazım yapılamaz.

Tam revision dayanıklı dizine yazılmadan aktif olmaz. Kısa DB işleminde güncel ACL, managed/protected durumu, base_revision ve monoton fencing kontrol edilir. CAS çakışmasında eski veri ezilmez; sınırlı yeniden değerlendirme/çakışmayan diff tekrar testi veya superseded sonucu kullanılır. Sonsuz retry yoktur.

Eski revision devam eden okuyucu için değişmez. Çökme sonrası reconciliation yarım staging ve yayımlanmamış tam revision'ları ayırır; eski aktif paket korunur. Geri alma da manager üzerinden doğrulanmış revision değişimidir. Bir skill işlemi kardeş skill'lere dokunmaz.

## Tamamlanma

Create/update ancak kapsam ve kanonik sahip belli, davranış/aktivasyon kanıtı yeterli, bütün dosyalar valid, gerçek script testleri başarılı, hash/base_revision/fencing/ACL güncel ve geri alınabilir yayın başarılıysa tamamlanır. Kuyruğa kabul, model beyanı, paket parse veya tool bağlantısı tek başına ürün başarısı değildir. Ölçülmeyen kullanım ve bilinmeyen maliyet sıfır diye gösterilmez.

MIT lisansı ve mevcut atıflar korunur. Agent Skills taşınabilir dizin yapısı temel alınır; manifest yeni workflow dili değildir. İlgili resmî kaynaklar planın 22. bölümündedir; sürüm değişiklikleri canlı kanıtla doğrulanır.
