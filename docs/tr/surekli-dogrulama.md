# Sürekli doğrulama

`.github/workflows/verify.yml`, push, pull request ve elle başlatma olaylarında çalışacak şekilde tanımlıdır. Workflow yalnız repository okuma izni ister; checkout kimlik bilgilerini çalışma ağacına bırakmaz. Public yayın veya ücretli model çağrısı yapmaz.

Linux işinde sabit Node 24.19.0/Bun 1.3.14, frozen lockfile, sıfır uyarılı lint, format, typecheck, kaynak build, PostgreSQL 17 ve gerçek Docker Node/Python testleri çalışır. Derlenmiş CLI testlerinden önce build yapılır. Testler SQLite ve PostgreSQL yollarını birlikte çalıştırır. Docker runtime image digest'leri uygulamadaki izinli sürümlerle aynıdır.

Ayrı artifact matrisi Ubuntu 24.04, macOS 15 ve Windows 2025 için kaynak build, gerçek Node CLI stop/restart ve temiz npm tarball kurulumunu çalıştırır. Temiz kurulum raporu her platform için artifact olarak saklanır. Bu matris bütün sandbox/script davranışlarının macOS/Windows üzerinde doğrulandığı anlamına gelmez; Docker testleri Linux işindedir. Hiçbir job gerçek sağlayıcı kalitesi, native Codex/Claude oturumu veya ChatGPT App kabulü olarak sunulmaz.

Action sürümleri resmi GitHub release kayıtlarından doğrulanıp commit SHA'larına sabitlenmiştir: checkout v7.0.1, setup-node v7.0.0, setup-bun v2.2.0 ve upload-artifact v7.0.1. Güncellerken ilgili resmi release kaydını ve commit'i yeniden kontrol edin.

Format kontrolü kaynakları, testleri, web'i ve rehberleri kapsar. Byte-identical `test/fixtures/`, yakalanmış `docs/evidence/`, üretilmiş `dist/` ve eklemeli yürütme planı yeniden biçimlendirilmez. Legacy host test kaynakları lint/format kapsamındadır; yalnız korunmuş fixture bundle lint dışındadır.

Yerel karşılık:

```sh
bun install --frozen-lockfile
bun run lint
bun run fmt:check
bun run typecheck
bun run build
bun test
bun run build:plugin
npm pack --dry-run
node scripts/package-smoke.mjs
```

PostgreSQL sözleşmelerini eklemek için `FORGE_TEST_POSTGRES_URL` test veritabanına ayarlanmalıdır. Tam suite Docker gerektirir. Yerel loglar GitHub job'larının çalıştığına kanıt değildir; uzaktaki job URL'si ve artifact raporu ayrıca kaydedilmelidir. Workflow henüz uzakta çalıştırılmadıysa diğer işletim sistemi kabulü açık kalır.
