# Özet

<!-- Değişikliğin sonucunu 2-4 net cümleyle açıklayın. -->

## Neden

<!-- Çözülen problemi, kullanıcı ihtiyacını veya teknik zorunluluğu açıklayın. -->

## Değişiklikler

- <!-- Ne değişti, neden değişti ve etkisi nedir? -->

## Commit Yapısı

- `<kısa-sha>`: <!-- Commit'in tek ve incelenebilir amacını Türkçe yazın. -->

## Doğrulama

- [ ] `bun run typecheck`:
- [ ] `bun run lint`:
- [ ] `bunx prettier --check .`:
- [ ] `bun test` (PostgreSQL hücresi için `FORGE_TEST_POSTGRES_URL`):
- [ ] `bun run build:plugin`:
- [ ] `npm pack --dry-run`:
- [ ] Gerçek tarayıcı kabulü (UI değiştiyse): `node scripts/web-acceptance.mjs --report <dosya> --verify ...`

## Riskler ve Geri Alma

- Risk: <!-- Bilinen riski veya "Bilinen ek risk yok" ifadesini yazın. -->
- Geri alma: <!-- Güvenli geri alma ya da ileri düzeltme yolunu yazın. -->

## İlgili Kayıtlar

<!-- Issue, plan, migration veya release bağlantılarını yazın; yoksa neden uygulanmadığını belirtin. -->

## Kalan Engeller

<!-- Varsa tamamlanmayan kapsam ve nedenini yazın; yoksa "Yok" yazın. -->

## Kontrol Listesi

- [ ] Proje PR kuralları ve şablonu uygulandı.
- [ ] Commit'ler mantıklı ve incelenebilir parçalara ayrıldı.
- [ ] İlgisiz dosyalar PR kapsamında değil.
- [ ] Çalıştırılan ve atlanan kontroller doğru raporlandı.
- [ ] PR başlığı ve açıklaması tamamen Türkçe.
- [ ] Gizli bilgi veya credential eklenmedi.
