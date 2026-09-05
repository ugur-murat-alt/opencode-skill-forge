# Kilitli script bağımlılıkları

`forge.json` içindeki `dependencies`, runtime (`node` veya `python`), paket içindeki lockfile yolu ve lockfile'ın SHA-256 değerini içerir. Kurulum yönetici politikasında izinli olmalıdır. Önbellek çalışma kapsamı, lock hash'i, sabitlenmiş sandbox image'i ve işlemci mimarisine göre ayrılır. Kullanımdan önce dosya hash'leri doğrulanır; bozulmuş önbellek çalıştırılmaz.

Node için `package-lock.json` sürüm 3 kullanılır. Paketler resmî npm registry adresine ve integrity hash'ine sabitlenmelidir. Kurulum `npm ci --ignore-scripts` ile yapılır; paket lifecycle script'leri çalıştırılmaz.

Python için her gereksinim exact sürüm ve SHA-256 hash içermelidir. Örnek:

```text
packaging==25.0 --hash=sha256:29572ef2b1f17581046b3a2227d5c611fb25ec70ca1ba8554b24b0e69331a484
```

Bu örnek [resmî PyPI 25.0 kaydındaki](https://pypi.org/pypi/packaging/25.0/json) wheel'e sabitlenmiştir; en güncel sürüm iddiası değildir. Pip yalnız binary wheel kabul eder, transitif bağımlılıkları kendiliğinden çözmez. Gereken her transitif paket lock dosyasında ayrıca sürüm/hash ile belirtilmelidir. Kaynaktan build yapılmaz.

İş iptal edildiğinde bağımlılık hazırlama da iptal edilir. Container oluşturma sınırlı süre içinde tamamlanır, ardından iptal kontrol edilir; çalışan kurulum durdurulur ve geçici staging temizlenir. Temizlik doğrulanamazsa `dependency_cleanup_failed` döner. Başarılı cache kurulumu sonradan ağ/kurulum izni kapalıyken tekrar kullanılabilir; script'in ağ politikası kurulum izninden ayrıdır.

Gerçek Docker kabul testleri `test/dependencies.test.ts` içindedir. Kurulum sırasında sert disk kotası ve bütün P06 güvenlik/kapsam kabulü henüz tamamlanmamıştır; mevcut dosya sayısı ve kurulum süre sınırları bu kabulün yerine geçmez.
