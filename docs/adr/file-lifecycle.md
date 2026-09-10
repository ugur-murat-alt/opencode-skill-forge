# ADR: reader lease sınıflandırması ve publish/reclaim sahipliği

Karar: 2026-09-10 (issue #27 ve #28 takip düzeltmesi). Yeni dağıtık sistem
eklenmez; SQLite/PostgreSQL üzerinde küçük, kalıcı koordinasyon kayıtları
kullanılır.

## Bağlam

#12 reader pin'lerine owner/expiry/heartbeat ekledi, ancak "süresi geçmiş =
süreç kesin ölü" varsayımı kanıtsızdı: heartbeat hatası yutuluyor, sweep
seçim ile DELETE arasında yenilenen pin'i siliyordu ve reconcile'ın kendi
pin'leri sahipsiz kalıyordu. #13 referanssız dosya geri kazanımını publish ile
koordine etmeden `reconcile` içine ekledi; mtime yaşı sahiplik kanıtı değildi ve
tarama ilk dizinlerde takılı kalıyordu.

## Reader sözleşmesi (#27)

- **Sınıflandırma:** `revision_readers.kind` = `read` (süreç sahipli,
  heartbeat'li lease), `integrity` (bütünlük taramasının sahipli, kısa ömürlü
  pin'i), `backup` (yedek akışının sahipsiz kaydı).
- **Zaman:** `created_at`/`expires_at` ve sweep karşılaştırmaları DB saatinden
  (`database.now()`); uygulama saati kayması lease'i erkene çekemez.
- **Heartbeat doğrulaması:** `touchReaders` yenileme sonucunu doğrular; hata
  sessizce yutulmaz, etkilenen pin'ler sonuç kabulünden önce tek tek okunur.
- **Sonuç kabulü:** `withRevision` callback'ten önce ve sonra pin'in sahibini,
  süresini ve revision satırının varlığını doğrular. Lease kaybı, I/O
  tamamlanmış olsa bile sonucu reddeder (`reader_closed`).
- **Sweep bariyeri:** aday listesi seçildikten sonra DELETE, `expires_at < now`
  koşulunu yeniden uygular; arada yenilenen pin silinmez. Sahipsiz kayıtlar
  rutin sweep'ten muaftır.
- **Sahipsiz kurtarma:** eski/yetim sahipsiz kayıtlar yalnız açık yönetici
  çağrısıyla (`POST /api/packages/integrity`, `recover_ownerless_before` DB
  zamanı kesimi) kurtarılır; rutin çalışma asla silmez.
- **Fiziksel silme koordinasyonu:** silme transaction'ı revision satırını
  (tombstone) önce kaldırır; okuyucu sonuç kabulünden önce satırın hâlâ var
  olduğunu doğrular.

## Publish/reclaim sözleşmesi (#28)

- **Simetrik claim:** `package_claims` (tenant, kind, key) tekil anahtarıyla
  sahiplik taşır; `revision` claim'i `skill_id/revision`, `staging` claim'i
  staging yoludur. Claim'ler lease süresiyle dolan ve heartbeat ile yenilenen
  kayıtlardır.
- **Barrier:** reclaim, referans kontrolünü claim aldıktan sonra yineler;
  publish ise rename'den önce revision claim'ini alır ve commit öncesi claim'i
  yeniden doğrular. Böylece "referans yok" okuması ile rm arasında yayın
  destination'ı yeniden sahiplenemez; sahiplenilmiş kazanan silinemez.
- **Grace:** claim'siz eski kalıntılar `reclaimGraceMs` (varsayılan 10 dk)
  mtime penceresini bekler; süresi dolmuş claim'i olan crash kalıntısı mtime'ı
  taze olsa da kurtarılır.
- **Uzun staging:** publish, staging claim'ini heartbeat ile yeniler; duraklayan
  süreç lease'i kaybederse staging geri kazanılır ve yayın güvenle başarısız
  olur (DB satırı yazılmaz).
- **Bounded tarama:** `package_scan_state` staging ve paket ağacı için kararlı
  lexicographic imleç taşır; tur başına iş `reclaimBudget` ile sınırlıdır ve
  sonraki turlar kaldığı yerden devam eder. Başarı, atlama (referenced/claim/
  symlink/grace) ve hata ayrı sayılır; FS hatası başarı sayılmaz ve claim
  bırakılarak tekrar denenebilir.
- **Güvenli kaldırma:** geri kazanım, `removeRevision` ilkeleriyle fd çapalı,
  `O_NOFOLLOW`, symlink takip etmeyen ve girdi sınırlı bir yardımcı kullanır.
- **HTTP ayrımı:** `GET /api/packages/integrity` salt rapordur (dosya silmez,
  pin süpürmez). Mutasyon `POST /api/packages/integrity` ile admin ACL ve
  `package.reclaim` denetim kaydı altında yapılır. Servis açılışındaki
  `reconcile` çağrısı yayın öncesi bakım adımıdır; GET değildir.

## Reddedilen alternatifler

- Yalnız timeout/grace büyütmek: yarışı kapatmaz, sahiplik kanıtı değildir.
- Yalnız mtime'a güvenerek değişmez revision dizinini silmek: publish aynı
  destination'ı yeniden kullanabildiği için veri kaybı riski taşır.
- Yeni genel GC framework'ü: bu ölçek için claim + imleç kayıtları yeterlidir.

## Kabul ve kanıt

- `test/reader-lease-lifecycle.test.ts`, `test/reader-lease-two-process.test.ts`,
  `test/reader-lease-crash-recovery.test.ts`, `test/reader-lease-postgres.test.ts`
- `test/file-lifecycle-gc.test.ts`, `test/file-lifecycle-crash.test.ts`,
  `test/file-lifecycle-postgres.test.ts`
- PostgreSQL koşuları `FORGE_TEST_POSTGRES_URL` ile CI'da etkinleşir.
