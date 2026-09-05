# Katalog ve bağlam ölçümü

```sh
bun run build:plugin
bun scripts/catalog-benchmark.ts 10000
```

Komut geçici SQLite veri dizinine 10.000 deterministik test paketini gerçek `PackageStore.publish` yoluyla yazar. Her paket gerçek revision, dosya, hash ve DB kaydı içerir. Veri DB'ye sahte metadata satırları eklenerek oluşturulmaz. 10 paket noktasında varsayılan discovery yanıtı ölçülür; 10.000 paket noktasında gerçek Node dağıtımı, startup bütünlük taraması ve resmî HTTP MCP istemcisi çalıştırılır.

Ölçüm altı araç sözleşmesini, ilk beş öğelik discovery yanıtını, sonraki sayfada tekrar olmamasını ve gerçek paket okumasını denetler. Ardından tek MCP istemcisiyle 300 örtüşen istek, hedef 100 istek/s olacak şekilde zamanlanır; yarısı metadata search, yarısı aynı paketin load işlemidir. Gerçek tamamlanma hızı, hata sayısı, p50/p95/p99 ve yanıt byte miktarı raporlanır. İlk mühendislik hedefi search/load p95 <= 250 ms'dir; ölçüm sonucu bu hedefi geçmezse başarılıymış gibi gösterilmez.

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
