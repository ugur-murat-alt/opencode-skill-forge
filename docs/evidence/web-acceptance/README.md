# Web kabul kanıt sözleşmesi (issue #30)

CI'daki `web-acceptance` işi tek bir artifact kökü üretir:

```
artifacts/web-acceptance/
  report.json           # bu çalıştırmanın tek geçerli JSON raporu
  stdout.log            # stdout'a yazılan aynı JSON (log/artifact eşleşmesi)
  stderr.log            # redakte edilmiş debug logları
  shots/                # bütün ekran ve failure görüntüleri
  failure/
    report.json         # kasıtlı UI hatasının kırmızı kanıtı
    stdout.log
    stderr.log
    shots/              # failure görüntüsü
```

## Akış

1. `node scripts/web-acceptance.mjs --report <report.json> --shots <shots>`
   - Çalıştırma başında eski `report.json` ve `shots/` **silinir**; böylece
     önceki bir başarı yeni bir hatayı maskeleyemez.
   - Sonuç her çıkış yolunda (başarı, senaryo hatası, ölümcül boot hatası)
     `report.json`'a yazılır.
   - stdout yalnız rapor JSON'unu taşır; debug logları stderr'e gider.
2. `node scripts/web-acceptance.mjs --verify --report <report.json> --stdout <stdout.log>`
   - Artifact JSON'unu parse eder; `commit_sha`, `run_id`, `job` ile HEAD/run
     kimliğini doğrular.
   - Log JSON'u ile artifact JSON'unun `passed/failed/total` sayılarını ve
     senaryo kimliklerini karşılaştırır.
   - Eski ya da eksik rapor bu adımı kırmızı yapar.
3. Kasıtlı hata kapısı: `--inject-failure login --fail-fast` ile koşulan
   betik sıfırdan farklı çıkmalıdır; `--verify --expect-failure` raporun
   `failed >= 1` olduğunu ve failure görüntüsünün artifact'ta durduğunu
   doğrular.

## Rapor alanları

- `schema`: `skill-forge.web-acceptance.v1`
- `commit_sha`, `run_id`, `run_attempt`, `job`, `repository`
- `started_at` / `finished_at` (UTC ISO-8601), `duration_ms`
- `versions`: uygulama, Node, Playwright, Chromium sürümleri
- `port`, `headed`, `shots_root`
- `total`, `passed`, `failed`, `results[]` (`name`, `ok`, `detail`, `shot`)
- `failure_shots[]`

## Redaksiyon

`scripts/web-acceptance.mjs` içindeki `redact()` pairing kodlarını, davet
tokenlarını, `Bearer` değerlerini ve JWT'leri sonuç/log metinlerinden
temizler. `report.json` ve `stdout.log` yalnız `[redacted]` yer tutucusunu
taşır; testler bunu `test/web-draft-report.test.ts` içinde doğrular.

## İzlenen dosya politikası

`docs/evidence/p29-web-acceptance.json` kaldırılmıştır: sabit bir başarı
raporunun artifact'a yeniden konulması eski sonucun yeni çalıştırma gibi
görünmesine yol açıyordu. Kanıt artık yalnız CI çalıştırmasının kendi
artifact kökünde üretilir.
