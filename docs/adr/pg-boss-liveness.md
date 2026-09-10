# ADR: pg-boss + uygulama kuyruğunun ortak sorumluluğu ve liveness

Karar: 2026-09-10 (issue #11). Kısa ama değişkenle bağlantılı kayıt.

## Bağlam

`ForgeWorker` iki katman kullanıyor: uygulamanın `runs`/`outbox` kayıtları (SQLite ve
PostgreSQL'de ortak) ve PostgreSQL modunda pg-boss'un iş teslimi (`retryLimit: 3`,
`retryBackoff`, `expireInSeconds: 3600`).

## Sorumluluk ayrımı

- **Doğruluk kaynağı:** `runs` satırı. State, attempt, fence, deadline ve sonuç yalnız
  orada yaşar; pg-boss yalnız teslimat aracıdır ve tekrar teslimden sorumludur.
- **Teslim:** kabul transaction'ında `outbox(delivered=0)` yazılır; worker'ın
  `sweepOutbox()` döngüsü bunu pg-boss'a tekil (`singletonKey: run.id`) gönderir.
- **Claim/fencing:** pg-boss handler'ı yalnız `JobQueue.claim`'i çağırır; state
  geçişleri claim/finish/fail CAS'ı ve fence ile korunur. Stale worker yayın yapamaz.

## Liveness sözleşmesi (eklenen kural)

pg-boss tekrar bütçesi, claim yolu geçici hata verirken tükenirse iş terminal başarısız
olur; `queued` run + `delivered=1` kalır. Artık sweep, `available_at <= now - livenessMs`
olan `queued` işleri (varsayılan 60s, worker seçeneği `livenessMs`) yeniden teslim
edilir ve operatöre raporlar. Tanımlı süre içinde ya yürütülür ya da mevcut
`deadline_at` kontrolü `deadline_or_attempt_limit` ile terminalleştirir.

## Reddedilen alternatifler

- Yalnız `retryLimit` artırmak: pencereyi büyütür, garantisi yoktur.
- pg-boss'u tamamen atmak: ayrı bir tasarım; özel lease/fencing atomikliklerini
  yeniden kurmayı gerektirir (kabul edilmemiş).

## Gözlemlenebilirlik

Yetim yeniden teslim sayısı stderr'e yazılır
(`Kuyruk uzlaştırması: N queued iş teslim penceresi aştı`); test
`test/worker-liveness.test.ts` bunu doğrular.
