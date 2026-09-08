# Katalog ve bağlam ölçümü

```sh
bun run build:plugin
bun scripts/catalog-benchmark.ts 10000
```

Komut geçici SQLite veri dizinine 10.000 deterministik test paketini gerçek `PackageStore.publish` yoluyla yazar. Her paket gerçek revision, dosya, hash ve DB kaydı içerir. Veri DB'ye sahte metadata satırları eklenerek oluşturulmaz. 10 paket noktasında varsayılan discovery yanıtı ölçülür; 10.000 paket noktasında gerçek Node dağıtımı, startup bütünlük taraması ve resmî HTTP MCP istemcisi çalıştırılır.

Ölçüm beş araç sözleşmesini, ilk beş öğelik discovery yanıtını, sonraki sayfada tekrar olmamasını ve gerçek paket okumasını denetler. Önce tek MCP istemcisiyle sabit 500 istek / 100 istek-s ısınma aşaması uygulanır; ardından 300 örtüşen istek, hedef 100 istek/s olacak şekilde zamanlanır; yarısı metadata search, yarısı aynı paketin load işlemidir. Gerçek tamamlanma hızı, hata sayısı, p50/p95/p99 ve yanıt byte miktarı raporlanır. İlk mühendislik hedefi search/load p95 <= 250 ms'dir; ölçüm sonucu bu hedefi geçmezse başarılıymış gibi gösterilmez.

`docs/evidence/p07-catalog-benchmark.json`, `.csv`, `.md` dosyaları ham örnekleri, dataset hash'ini ve ortam bilgisini içerir. Test paketleri ve veri dizini sonunda silinir. Model çağrısı yapılmaz. Kaynak kontrollü scriptlerin kullandığı veri gerçek kullanıcılara ait değildir.

Bu bir sentetik içerikli **gerçek sistem** ölçümüdür. 10/100/1000 ayrı istemci, PostgreSQL yükü, durable handoff latency, 30 dakikalık soak, LLM kalitesi ve maliyeti ayrıca ölçülmelidir. OS cache boşaltılmaz; başlangıç bütünlük taraması dosyaları ısıtır. İlk istek ölçümü “cold cache” diye sunulmaz. CPU/RAM raporu mevcut host içindir; disk türü ölçülmeden SSD kabulü yapılmaz.

## Ayrı istemci matrisi

```sh
bun scripts/catalog-benchmark.ts 10000 docs/evidence/p13-client-matrix.json --matrix
```

Bu seçenek aynı katalogda 1, 10, 100 ve 1000 ayrı resmî MCP istemcisi kullanır. İlk profil 300 istek; diğerleri en az 300 ve en az istemci sayısı kadar istek gönderir. Her istemci en az bir gerçek tool çağrısı yapar. İstekler toplam 100 istek/s hedefiyle sırayla istemcilere dağıtılır. Model çağrısı yoktur; tüm istemciler aynı yetkili kullanıcı/proje üzerinde çalışır. Bir önceki bağlantı/doğrulama için açılmış kontrol istemcisi büyük profillerde boşta kalır ve raporda ayrıca belirtilir.

Her profil bağlantı süresi, gerçek tamamlanma hızı, process RSS, hata sayısı ve search/load p50/p95/p99 değerlerini kaydeder. 250 ms p95 hedefi aşılırsa ölçüm korunur ve komut başarısız kodla çıkar; hedef küçültülmez. Bu kısa bağlantı/katalog matrisi, ayrı kullanıcı/tenant yükü veya 30 dakikalık soak değildir.

## Uzun süreli katalog kontrolü

```sh
bun scripts/catalog-benchmark.ts 10000 docs/evidence/p13-catalog-soak.json --soak=30
```

Soak modu 30 adet en az 60 saniyelik pencere çalıştırır. Her pencerede 100 istek/s hedefiyle 6.000 karma search/load isteği gönderilir; toplam 180.000 istek planlanır. Süre, gönderilen istek, hata, tam pencere p50/p95/p99, RSS ve heap kullanımı raporlanır. Gecikme örnekleri yalnız o dakikanın sınırlı tamponunda tutulur; raporlama kendi başına 30 dakika boyunca sınırsız örnek biriktirmez.

Derlenmiş `dist/` ve lock dosyası, veri oluşturulmadan önce geçici runtime dizinine kopyalanır. Koşu bu sabit dağıtımı kullanır; kaynak ağacında sonraki build aynı çalışan koşuyu değiştirmez. Bağımlılıklar mevcut `node_modules` üzerinden çözülür; koşu sırasında dependency kurulumu/güncellemesi yapılmamalıdır. Host üzerindeki başka işler gecikmeyi etkileyebilir; bu koşu ayrı bir fiziksel makine değildir.

Her dakika `.progress.json` ve log yenilenir. Ara rapordaki `running`, bitmiş kabul değildir. Nihai JSON’daki soak durum ve süre incelenmeden 30 dakika geçti denmez. `--soak=1`, harness doğrulaması içindir ve uzun soak kabulünün yerine geçmez. Katalog soak'ı, model/iş kuyruğu veya çok kiracılı soak olarak sunulmaz.

### Gecikme teşhisi ve ölçüm kapsamı

Yeni koşularda yük sürücüsü ve ölçüm yardımcıları seed başında özel runtime dizinine kopyalanır. JSON içindeki `harness_sha256`, `measurement_sha256` ve `diagnostics_sha256` alanları kullanılan kodu tanımlar. Çalışma sırasında kaynak dosyanın düzenlenmesi bu kopyayı değiştirmez.

Her deneme `success` veya `error` sonucu ve süresiyle kaydedilir; transport, MCP hata sonucu ve bozuk JSON çağrıları gecikme örneklerinden çıkarılmaz. Hata toplamı ayrıca raporlanır. `elapsed_ms` gerçek çağrının başlamasından tamamlanmasına kadar geçen süredir. `scheduler_delay_ms` planlanan gönderimin ne kadar geciktiğini, `scheduled_to_complete_ms` planlanan gönderimden tamamlanmaya toplam süreyi gösterir. Soak penceresi bu iki ek sürenin maksimumunu da raporlar; zamanlayıcı yetişemediğinde yalnız hızlı gönderilmiş çağrılara bakarak kapasite iddiası yapılmaz.

Her dakika olay döngüsü gecikme histogramı, olay döngüsü kullanım oranı, process CPU user/system süreleri, GC sayısı/süresi ve ham `process.resourceUsage` sayaç farkları alınır. Dosya I/O sayaçları byte veya fsync sayısı olarak yorumlanmamalıdır. Bunlar gecikmeyle ilişki aramak içindir; tek başına neden kanıtlamaz. Sayaçlar pencere sonunda sıfırlanır; per-GC geçmiş tutulmaz ve gözlemciler kapanışta bırakılır. GC olaylarının gözlemciye teslimi asenkron olduğundan pencere sınırındaki olay bir sonraki örnekte görülebilir.

Tam ölçüm sırasında aynı host'ta derleme veya başka iş çalışıyorsa bu koşul rapora eklenir. Başarısız pencereler silinmez. Kısa yardımcı sözleşme testi, yeni araçların veri kaydetmesini doğrular; 10.000 paket veya 30 dakika performans kabulü değildir.

### Başlangıç, ısınma ve sürekli yük

İlk discovery ve load örnekleri bütünlük taraması sonrasında alınır; OS cache temizlenmediğinden bunlar cold-cache iddiası taşımaz. Sonra sabit 500 karma çağrı, 100 istek/s hedefiyle gönderilir. Bu ısınmanın planlanan süresi 5 saniyedir; tamamlanması gecikirse gerçek süre raporlanır. Sonuçlara bakarak ısınma süresi değiştirilmez. Isınmanın bütün örnekleri `warmup` phase'iyle JSON/CSV'de kalır; hata oluşursa genel hedef başarısızdır.

250 ms p95 hedefi sonraki 300 çağrılık `warm_100_rps` ölçümüne ve her soak penceresine uygulanır. Isınmanın gecikmesi ayrı gösterilir. `warmup.runtime` ve `load.runtime` aynı Node process'inin ayrı pencereleridir; `soak_preparation_runtime` varsa istemci matrisi/bağlantı hazırlığında biriken ölçümleri saklar. Tek sampler sonunda kapatılır. Isınma eklenmesi geçmiş başarısız koşuları başarılıya dönüştürmez.

### Node CPU profili

```sh
bun scripts/catalog-benchmark.ts 10000 docs/evidence/katalog-cpu.json --soak=1 --cpu-profile
```

Bu seçenek yalnız gerçek child Node sürecine `--cpu-prof` verir; 1.000 mikro saniye örnekleme kullanır. JSON ile aynı dizinde, aynı taban adla `.cpuprofile` oluşur. Raporda profil yolu ve `acceptance: false` kaydedilir. Profil; başlangıç taraması, ısınma ve ölçüm dahil Node sürecinin yaşamını kapsar; dosya örneklerini değerlendirirken bu aşamaları karıştırmayın. CPU profili duvar saati gecikmesinin tamamını veya disk beklemesinin nedenini tek başına açıklamaz. Örnekleme ek maliyet getirebildiği için bu koşu performans kabulü sayılmaz; düzeltmenin kabulü profiler olmadan yeniden ölçülür.

### SQLite sorgu teşhisi

```sh
bun scripts/catalog-benchmark.ts 10000 docs/evidence/katalog-sql.json --soak=1 --sql-profile
```

Bu seçenek yalnız benchmark sunucusunun SQLite bağlantısında senkron `prepare/all/run` süresini toplar. Promise ve bağlantı kuyruğu beklemesi bu süreye dahil değildir. Sorgu metni ve parametreleri rapora yazılmaz; SHA-256 sorgu parmak izi, işlem türü ve sabit izin listesindeki tablo adı kaydedilir. Bilinmeyen tablolar `other` olur. En fazla 256 farklı imza ve tek taşma grubu tutulur. Her pencere çağrı/hata sayısı, toplam ve en uzun senkron süreyi içerir; toplamlar ayrıca saklanır. Helper hash'i `sql_diagnostics_sha256` alanındadır.

Ölçüm ek maliyet getirdiğinden `sql_profile.acceptance: false` yazılır. Bu veri yazma yolunu teşhis etmek içindir; üretimin SQLite kalıcılık ayarlarını değiştirmez. Gerçek Node SQLite sözleşme testi sonuç, constraint hatası, rollback, pencere sıfırlama, imza sınırı ve bağlantı metodunun geri yüklenmesini denetler.

### Gözlem yazmalarının kalıcılığı ve kapasitesi

Arama/yükleme gözlemleri aynı veritabanı bağlantı havuzu için en fazla32çağrılık transaction gruplarına alınır. Grup toplama zamanlayıcısı10ms'dir; bu değer toplam yanıt süresi garantisi değildir. Kuyrukta ve çalışmakta olan toplam128çağrı sınırı aşılırsa `observation_capacity` / HTTP429 döner. Hiçbir başarılı yanıt gözlem commit edilmeden dönmez; SQLite `synchronous=FULL` korunur. Her çağrının ayrı savepoint'i vardır; bir constraint hatası aynı gruptaki geçerli çağrıların kayıtlarını kaybettirmez. Transaction'ın tamamı commit edilemezse tüm grup hata alır. Zaten transaction içinden yapılan gözlemler üst transaction'ın atomikliğini kullanır.

Yükleme sırasında sürüm referansı dosya okuma ve gözlem commit'i boyunca tutulur. Gözlem kaydı yüklenen skill'in başarıyla uygulandığını iddia etmez; yalnız sunucunun gördüğü erişimi kaydeder.
