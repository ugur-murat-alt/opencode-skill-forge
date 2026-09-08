# V2 Teslim Notu (2026-09-08, commitlenmemiş ağaç)

## Kapsam
P22 Prompt Editor çıkarma, P17 organizasyon/davet/devir/silme/GitHub, P18 rol-araç matrisi,
P19 ortam/kapsam/bağ modeli, P20 skorlu arama, P21 ajan prompt zinciri, P23 web yenileme.
P24 bu notla kapanır.

## Kapılar (son ağaç)
- `bun run typecheck`: temiz
- `bun test`: 351 pass / 1 skip / 0 fail / 352 test / 82 dosya (çevresel Docker testleri dahil)
- `bun run build:plugin`: temiz (node + vite)
- `npm pack --dry-run`: 41 dosya
- `bunx prettier --check .`: temiz; `bunx oxlint`: 0 uyarı/hata
- Web kabul (`scripts/web-acceptance.mjs`, gerçek Chromium): 27/27 yeşil; 12 ekran görüntüsü `docs/evidence/design/p23-*.png`

> Not (2. tur): bu bölüm P24 anındaki anlık görüntüdür; güncel kapılar
> `docs/evidence/p26-review-round2-p19p20.json`, `p27-review-round2-p23.json` ve
> `p23-web-acceptance.json`'dadur (354 pass / 10 çevresel Docker fail, web 28/28, pack 40).

## Bilinçli sınırlar
- P02–P16 ileri kabul maddeleri (ölçek/soak, canlı model, native istemci, macOS/Windows, backup retention
  bütünü) bu teslimde kapatılmadı; başarısız soak/katalog kayıtları korunur.
- `users`/`auth_sessions` kullanıcı düzeyinde korunur; paylaşılan disk blobları silinmez;
  pg-boss kuyruk temizliği kapsam dışıdır.
- Kurucu halefsiz ayrılırsa org kilitli kalır (arka kapı yok); karar kullanıcı onaylıdır.
- `test/legacy-runtime` + `test/fixtures/legacy` karakterizasyonu korunur.
- Değişiklikler commitlenmedi; uzak CI çalıştırılmadı.
