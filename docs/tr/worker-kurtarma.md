# Bağımsız worker ve süreç kurtarma

HTTP servisi kendi işçisini başlatır. Ayrı işçi gerektiğinde aynı veri diziniyle çalıştırılabilir:

```sh
node dist/cli.js worker --data-dir /mutlak/skill-forge-verisi
```

Yerel profil SQLite kullanır. Server profilinin PostgreSQL bağlantısı ve kimlik ayarları ayrıca yapılandırılır. Bir worker süreci öldüğünde sahip olduğu lease hemen başka sürece verilmez; süresi dolunca kuyruk tekrar değerlendirir. Her yeni sahip monoton fence alır; eski sahip sonuç/yayın commit edemez.

Skill işleri en fazla üç deneme sınırındadır. Sağlayıcı yapılandırılmamışsa başarısız sonuç kaydedilir; bu model kalite başarısı değildir.

`bun test test/worker-process.test.ts` gerçek ayrı süreç, SIGKILL, süreli lease, production Node worker, fencing, idempotency ve SIGTERM kapanışını kontrol eder. Önce `bun run build:plugin` çalıştırın; test dağıtım CLI'sını kullanır. Geçici veri ve yalnız teste ait süreçler temizlenir. PostgreSQL crash/soak ve canlı model kurtarma ayrı kabul ölçütleridir.

## PostgreSQL süreç deneyi ve deneme geçmişi

`FORGE_TEST_POSTGRES_URL` verilirse aynı test PostgreSQL için ayrı, rastgele isimli bir veritabanı oluşturur. Server profilli gerçek Node worker ve pg-boss bu izole veritabanını kullanır; test sonunda child süreçler kapatılıp yalnız oluşturulan veritabanı kaldırılır. Test bağlantısı veritabanı oluşturma izni gerektirir. Fixture OIDC adreslerine bağlanılmaz; bu kimlik sağlayıcısı kabulü değildir.

İşler ekranında seçilen işin deneme geçmişi, başlangıç/bitiş ve sonuç kayıtlarını gösterir. `lease_expired` eski sahipliğin süre aşımıdır; başarılı sonuç diye çevrilmez. Yenile düğmesi güncel kayıtları okur. API `GET /api/runs/:id/attempts?after=<fence>` üzerinden en fazla 20 kayıt döner; `next` varsa sonraki sayfada `after` olarak kullanılır. İşin kullanıcısı ve güncel proje erişimi her okumada doğrulanır. Model sırrı veya host yolu bu rapora eklenmez. Canlı SSE, ayrıntılı retry eylemleri ve bütün İşler ekranı kabulü ayrıca tamamlanmalıdır.
