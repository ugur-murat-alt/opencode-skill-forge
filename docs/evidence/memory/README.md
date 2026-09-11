# Memory evidence şablonları

Bu dizin **yalnız şema ve placeholder** taşır. Gerçek koşum raporları buraya
commit edilmez; temiz bir artifact kökünde (örnek:
`/tmp/opencode/memory-evidence/<tarih>-<issue>-<kısa-ad>/`) tutulur ve raporda
yolu ile SHA-256'sı belirtilir.

## Dosyalar

| Dosya                 | Amaç                                                        |
| --------------------- | ----------------------------------------------------------- |
| `report.schema.json`  | Üretilen raporun JSON şeması (#41 ortak kanıt sözleşmesi).   |
| `example.report.json` | Alan doldurma örneği; `status: "placeholder"`, gerçek değil. |

## Rapor üretme kuralları

- Rapor geçerli JSON olmalı ve `report.schema.json` ile doğrulanmalıdır.
- Zorunlu alanlar: `reportId`, `reportType`, `status`, `requirement`,
  `entryPath`, `command`, `fixture`, `commit`, `ci`, `environment`,
  `startedAt`/`finishedAt` (UTC), `results`, `limitations`, `artifacts`.
- `status` yalnız `passed` / `partial` / `failed` olabilir. Koşulmayan kontrol
  `skipped` veya `not-run` olarak işaretlenir; asla `passed` yazılmaz.
- `limitations` alanı çalıştırılmamış kontrolleri ve kalan riski açıkça
  listeler.
- Aynı gereksinimin eski raporu yeni koşumun yerine yüklenmez; yeni koşum yeni
  `reportId`, yeni `commit` ve yeni artifact üretir.
- Sır, API anahtarı, gerçek kullanıcı transcript'i veya kişisel veri rapora
  girmez.
- Görsel artifact yalnız destekleyicidir; davranış assertion'ının yerine
  geçmez.
- Kasıtlı regresyon kanıtı için kırmızı koşum logu ayrı artifact olarak
  saklanır ve raporda `failed` satırıyla eşlenir.

## Adlandırma

`<UTC-tarih>-<issue>-<tür>-<kısa-ad>.json`, örnek:
`2026-09-12-41-benchmark-acceptance-sqlite.json`. Log dosyaları aynı kökte
`.log`, ek veriler `.csv` uzantısıyla durur.
