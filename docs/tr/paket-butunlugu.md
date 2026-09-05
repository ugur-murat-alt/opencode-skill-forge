# Paket bütünlüğü ve yeniden başlatma

Yerel servis HTTP dinlemeye başladıktan sonra veritabanında kayıtlı paket sürümlerini arka planda kontrol eder; işçi tarama sonrasında başlar. Tarama devam ederken `/health` yanıtı `checking` durumunu ve kontrol edilen revision sayısını gösterir. Böylece büyük katalog açılışı HTTP başlangıç hook süresine bağlı kalmaz. Kapanışta tarama sonraki sayfa sınırında durdurulur ve DB kapanmadan önce beklenir. Manifest revision hash'i ile dosyaların byte sayısı ve SHA-256 değerleri karşılaştırılır. Eksik veya değişmiş dosya bulunduğunda `/health` yanıtının `status` alanı `degraded`, `package_integrity.status` alanı `degraded` olur. Tarama hatası `failed` olarak raporlanır. Bu alanlar kimlik doğrulaması gerektirir.

Kontrol mevcut aktif sürümü değiştirmez; bozuk dosyayı silmez, başka sürümü otomatik etkinleştirmez. Böylece veri kaybı başarılı onarım gibi gösterilmez. Dosya okuma ve yürütmenin kendi hash kapıları ayrıca geçerlidir. Bilinen sağlam yedek veya revision kullanılarak yapılacak kurtarma ayrıca doğrulanmalıdır.

Tenant yöneticisi `GET /api/packages/integrity` ile 25 revision'lık sayfalar okuyabilir. Devam için yanıttaki `next.skill_id` ve `next.revision`, sırasıyla `after_skill` ve `after_revision` query alanlarına verilir. Yanıt sorunlu skill/revision kimliklerini içerir; paket içeriği ve host yolu içermez. Bu canlı taramadır; eşzamanlı yeni yayınlar nedeniyle tek transaction snapshot'ı değildir.

Server profilinde otomatik tüm tenant taraması henüz uygulanmadı; sağlık alanı `not_scanned` döner. Yönetici kendi tenant'ını endpoint üzerinden tarayabilir. DB'ye kaydedilmemiş staging/tam revision kurtarma, otomatik onarım ve tam backup/restore kabulü bu kontrolün kapsamında tamamlanmış değildir.

## Tam envanter kontrolü

Normal paket okuması ve kayıtlı revision taraması artık diskteki bütün dosya adlarını manifestle karşılaştırır. Manifest dışında sonradan eklenen dosya, yalnız tek kayıtlı dosya okunuyor olsa bile reddedilir. Yayın kapısı da script testleri sonrasında envanteri yeniden karşılaştırır.

Tarama en fazla 256 dosya, toplam 1280 dizin/dosya girdisi ve 12 dizin derinliği kabul eder. Böylece çok sayıda boş dizin dosya sayısı sınırını dolaşamaz. Link, özel dosya, yönlendirilmiş üst dizin ve platformda geçersiz adlar reddedilir. Dosya içerikleri mevcut hash ve boyut kontrolleriyle okunur. DB'ye bağlanmamış staging kurtarma ve backup/restore hâlâ ayrı kabul gerektirir.
