# P01 başlangıç kanıtı — 5 Eylül 2026

Aktif checkout `/home/ugur/Projects/opencode2-skill-forge`, branch `main`.
`git fetch --prune origin` + `git merge --ff-only origin/main` sonunda HEAD ve
origin/main `dcbc41e0c15eec0998162be35a204290387f9abc`. Başlangıç `ed4c4b4`.
Uzak commit yalnız planı ekledi. Kullanıcının yedi dist silmesi korundu.

Node 24.19.0 / Bun 1.3.14 / Linux x64. İlk ölçüm tam mevcut ağaçta,
`OC_SKILL_POWER_HOME` geçici dizinle yapıldı:

| Kontrol | Çıkış | Sonuç |
|---|---:|---|
| bun run typecheck | 2 | dist modülü ve kurulu client/service dosyaları eksik |
| bun test | 1 | 119 pass, 12 fail, 9 errors |
| bun run build:plugin | 1 | korunmuş core yok |
| npm pack --dry-run | 0 | yalnız 6 dosya, runtime yok; kullanılabilir paket değil |

Komut/çıktı: `baseline-results.json` ve işaret ettiği loglar.

Aynı Git HEAD `git archive` ile `/tmp/forge-clean-baseline-27xodad0` içine
çıkarıldı; `bun install --frozen-lockfile` çalıştırıldı. Kullanıcı checkout'u
resetlenmedi. Temiz kurulumda typecheck, 242 test / 0 hata, wrapper build ve
13 dosyalı pack dry-run geçti. Kanıt `baseline-clean-results.json` ve logları.
Bu eski ürün karakterizasyonudur, yeni MCP ürünü kabulü değildir.

Yerel dependency kurulumu `bun install --frozen-lockfile --force` ile onarıldı.

## Kaynak kökeni ve extraction

MIT lisansı, Copyright 2026 Ugur Murat Alt. Git'te core ilk `6600665`
commit'inde korunmuş artifact olarak yer alıyor, `2c67e90` içinde command
registration düzeltmesi var. Bundle içindeki üçüncü taraf açıklamaları/atıflar
fixture'da aynen korunuyor. `test/fixtures/legacy/manifest.json` SHA-256 ve
kaynak commit'i içeriyor; test byte bütünlüğünü doğruluyor.

`/home/ugur/Projects/oc-skill-power` aynı remote'un eski 0.2.0 kaynak checkout'u:
`src/store.ts`, `guards.ts`, `state.ts`, `v2/tools.ts`, `review/prompts.ts` var.
Bu kaynak, mevcut 0.5.6 bundle'ının tam ve birebir yeniden üretilebilir kaynağı
olarak doğrulanmadı; otomatik kopyalanmayacak.

Bundle'ın okunmuş kaynak segmentleri `src/skills/candidate/store.ts`,
`transaction.ts`, `skills/guards.ts`, `skills/store.ts`, `skills/v2/tools.ts`
ve `skills/evidence/fs-helper.ts`. Native helper platform/arch ile bulunuyor,
SHA-256 allowlist denetimi ve protocolVersion=1 probe yapıyor. Bu checkout'ta
native helper kaynağı yok; yeni runtime için yeniden kullanım şartı olmayacak.
Linux artifact başka platform kanıtı değildir.

Somut çıkarılacak davranışlar ve eski karakterizasyonlar aşağıdaki tabloda;
yeni kaynak API'lerinde aynı tehditler P05/P06/P14'te sınanacak. Eski core ve
security testleri erken silinmedi; fixture olarak ayrıldı. Yeni kaynakta ilk
saf karar/yayın kapısı `src/domain/evolution-policy.ts` ve
`test/evolution-policy.test.ts` ile uygulanıyor. Henüz gerçek yayın servisi
bağlanmadığından bu test paket yayınlama kabulü değildir.
