# Temiz dağıtım kontrolü

Önce zorunlu kaynak kontrollerini ve derlemeyi çalıştırın:

```sh
bun run typecheck
bun test
bun run build:plugin
npm pack --dry-run
node scripts/package-smoke.mjs
```

Son komut gerçek `npm pack` çıktısını işletim sisteminin geçici dizinindeki boş projeye `npm install --omit=dev` ile kurar. Depodaki kaynaklar üzerinden servis başlatmaz. Kurulu CLI sürümünü manifestle karşılaştırır; kurulu ESM entry'sinden Node servisini, SQLite migration'larını ve resmî MCP istemcisini çalıştırır. Web index dosyasını, tam altı araç sözleşmesini, gerçek ZIP import worker'ını, proje oluşturmayı ve import edilen paketin `forge_search` / `forge_load` zincirini kontrol eder. Test hiçbir model çağrısı yapmaz.

Test verisi, npm cache ve OpenCode test home'u geçicidir; işlemin sonunda temizlenir. Alt süreç ortamı sınırlıdır, server profili veya sağlayıcı sırları aktarılmaz. Rapor `docs/evidence/p15-clean-package.json` dosyasına yazılır; farklı rapor yolu komutun ilk argümanı olabilir. Rapor Node/OS/mimari, gerçek tarball integrity ve dosya listesi ile kontrol sonuçlarını içerir. Hata varsa komut sıfır olmayan kodla çıkar.

Mevcut doğrulama Linux x64 / Node 24 içindir. Bu kontrol macOS/Windows, canlı sağlayıcı kalitesi, kimlikli gerçek istemci oturumları, backup/restore veya bütün P15 kabulünün yerine geçmez. Nihai ürün sürümü ve legacy bağımlılık/paket manifesti geçişi ayrıca tamamlanmalıdır.
