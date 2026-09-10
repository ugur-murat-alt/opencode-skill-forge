# ADR: pg-boss + uygulama kuyruğunun ortak sorumluluğu ve liveness

Karar: 2026-09-10 (issue #11; #23 ile teslim zamanlaması ve sahiplik eklendi).
Kısa ama değişkenle bağlantılı kayıt.

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

## Liveness sözleşmesi (issue #11)

pg-boss tekrar bütçesi, claim yolu geçici hata verirken tükenirse iş terminal başarısız
olur; `queued` run + `delivered=1` kalır. Sweep, tanımlı süre içinde kayıp teslimi
yeniden gönderir ve operatöre raporlar. Tanımlı süre içinde ya yürütülür ya da mevcut
`deadline_at` kontrolü `deadline_or_attempt_limit` ile terminalleştirir.

## Teslim zamanlaması ve sahiplik (issue #23)

- **Outbox kendi zamanlamasını taşır.** `delivered_at` son başarılı teslimi,
  `delivery_attempts` sınırlı deneme sayısını, `dispatch_owner`/`dispatch_until` ise
  kaydın o anki tek dispatcher sahipliğini tutar. `runs.available_at` yalnız iş
  yürütme uygunluğu olarak kalır; teslim penceresi için kullanılmaz.
- **Tek başarılı send yeni pencere açar.** `delivered_at + livenessMs` dolmadan sweep
  aynı kaydı yeniden göndermez. Pencere dolduğunda önce taşıma durumu sorgulanır
  (`findJobs(kind, { key: run.id })`): `created`/`retry`/`active` ise pencere yenilenir,
  gönderim yapılmaz; `failed`/`completed`/`cancelled` veya kayıp ise tekilleştirilmiş
  bounded yeniden teslim yapılır. Böylece aktif/bekleyen taşıma işi ile kaybolmuş
  teslim ayrılır ve normal backlog sürekli yeniden teslim üretmez.
- **Tek sahiplik.** Sweep önce `outbox` satırını CAS ile sahiplenir
  (`dispatch_until <= now OR dispatch_owner IS NULL`); aynı anda yalnız bir dispatcher
  işler. Sahiplik süresi dolan satır (çöken dispatcher) başka bir worker tarafından
  devralınır. Aynı worker içindeki sweep çağrıları da serileştirilir.
- **Lease otoritedir.** `running` + süresi geçmiş `lease_until`, yürütücünün öldüğünü
  gösterir; taşıma işi hâlâ `active` görünse bile bounded pencere sonunda yeniden
  teslim edilir. Fencing eski worker'ın yayın yapmasını engeller.
- **Bounded pencere.** Kayıp teslim, pencere başına en fazla bir kez gönderilir;
  `delivery_attempts` gözlemlenebilir üst sınırdır. Donmuş tenant ve terminal işler
  hiç gönderilmez.

## Reddedilen alternatifler

- Yalnız `retryLimit` artırmak: pencereyi büyütür, garantisi yoktur.
- pg-boss'u tamamen atmak: ayrı bir tasarım; özel lease/fencing atomikliklerini
  yeniden kurmayı gerektirir (kabul edilmemiş).
- `runs.available_at` değerini teslim penceresi olarak ilerletmek: iş yürütme
  semantiğini bozar (issue #23'te açıkça reddedildi).
- Pencereyi uzatıp taşıma durumunu sorgulamamak: sağlıklı bekleyen işi periyodik
  yeniden gönderir; pg-boss tekilleştirmesi bazı insertleri engellese de tekrar eden
  çağrı ve yetim logları sürer.

## Gözlemlenebilirlik

Kayıp taşıma nedeniyle yapılan yeniden teslim sayısı stderr'e yazılır
(`Kuyruk uzlaştırması: N queued iş teslim penceresi aştı`); testler
`test/worker-liveness.test.ts` (issue #11) ve `test/queue-redelivery-*`,
`test/queue-scheduling-*` dosyaları (issue #23) bunu doğrular.
