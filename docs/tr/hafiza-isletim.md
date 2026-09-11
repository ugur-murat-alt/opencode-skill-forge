# Hafıza işletimi: saklama, unutma, yedek/geri yükleme ve doktor

Bu rehber hafıza modülünün işletim sözleşmesidir. Uygulanan ile planlanan
ayrımı açıktır; ölçüm sonuçları bu belgenin konusu değildir. Giriş noktası:
[`docs/tr/hafiza.md`](hafiza.md). İlgili ADR'ler:
`docs/adr/memory-ownership.md`, `memory-session-hooks.md`, `memory-curator.md`.

## Saklama sınıfları ve pencereler

Pencereler ayarlardan (sistem politikası + daraltıcı katmanlar) yönetilir;
katmanlar yalnız daraltabilir:

| Sınıf                              | Ayar                            | Varsayılan | Not                                                            |
| ---------------------------------- | ------------------------------- | ---------- | -------------------------------------------------------------- |
| Kabul edilmiş not + sürüm geçmişi  | `memoryHistoryRetentionDays`    | 365        | **Otomatik silinmez**; yalnız açık `purge` kaldırır            |
| Yakalama payload'ı (spool)         | `memoryCaptureRetentionDays`    | 30         | Yalnız terminal satırlar; `pending` asla                       |
| Teslim/idempotency (memory_events) | `memoryDeliveryRetentionDays`   | 30         | Yalnız `committed`/`rejected`; `pending` asla                  |
| Tanılama (adaylar, çözüm adayları) | `memoryDiagnosticRetentionDays` | 30         | `applied/rejected/quarantined`; açık `candidate/conflict` asla |
| Yedekler                           | `memoryBackupRetentionDays`     | 30         | Politika penceresi; yedek silme ayrı ve açık işlemdir          |

- **Aktif karar/görev/pin yaşlandı diye silinmez.** Çözülmemiş görev, pinli not
  ve bekleyen olay her pencerede korunur; retention yalnız terminal kayıtları
  budar ve raporu sayaçlarla `memory_retention_runs` tablosuna yazar.
- Payload azaltma ile replay kimliği/tombstone ayrıdır: sürüm satırları,
  hash'ler ve purge kayıtları silinse bile kabul edilmiş sürüm dosyası
  yedeklenene kadar korunur; hiçbir pencere kabul edilmiş Markdown'u silmez.
- Sunucu, mevcut saklama zamanlayıcısına (60 sn) eklenen bounded geçişle
  retention'ı çalıştırır; geçiş başına silme üst sınırı vardır.

## Unut / sil akışı

1. **Arşiv (tombstone):** not `deleted_at` ile silinir, türetilmiş indeks
   satırları (head/term/edge) aynı işlemde geçersizleştirilir; arama, graph ve
   bağlam notu bir daha sunmaz. Replay/eski spool tombstone'u **diriltemez**;
   açık `restore` gerekir.
2. **Purge (kalıcı unutma):** yetkili kullanıcı `purge` çağırır; not satırları,
   sürüm satırları, ilgili olay/aday kayıtları ve kabul edilmiş sürüm dosyaları
   kaldırılır. `memory_purges` purge makbuzu kalır ve **yedekle taşınır**.
   Aynı not kimliğine yapılan yeni commit/replay `memory_note_purged` ile
   reddedilir.
3. **Yedeklerde kopya:** purge'ten önce alınmış yedeklerde not kopyası kalır;
   anında yok olduğu iddia edilmez. Eski yedek geri yüklenirse:

## Yedek / geri yükleme

- Mevcut `backup`/`restore` altyapısı genişletilir; ayrı çerçeve yoktur.
  Snapshot aynı tutarlı sınırda işletim DB'sini **ve** kabul edilmiş Markdown
  sürüm dosyalarını içerir.
- `backup.json` içindeki `memory` bölümü: sayımlar (alan/not/sürüm/dosya/olay/
  purge), DB migration adı, sürüm dosyalarının yol+hash'leri ve purge
  makbuzları. Yalnız `.md` kopyası "tam güvenli restore" değildir; yetki
  kayıtları, tombstone/purge ve işletim DB'si olmadan güvenli kabul edilmez.
- **Boş hedefe restore + doğrulama:** dosya hash'leri doğrulanır, oturumlar
  iptal edilir, ardından türetilmiş arama/graph/bağlam kabul edilmiş
  sürümlerden yeniden kurulur.
- **Uzlaştırma:** manifestte `memory` bölümü yoksa (eski yedek) restore
  `purges_included=false` makbuzu bırakır ve `reconciliation_required=true`
  olur. Bu durumda otomatik senkron/yazım başlamadan önce operatörün purge/
  tombstone kaydını uzlaştırması gerekir; sağlık yüzeyi bunu gösterir.
- PostgreSQL yolu aynı sözleşmeyi kullanır (pg_dump + aynı manifest/reconcile);
  PostgreSQL kabul testleri ilgili ortam değişkeni varsa çalışır.

## Doktor / sağlık

`GET /api/memory/health?space_id=…` içerik döndürmez; additive olarak
`retention` bloğu eklenir: pencere değerleri, purge sayısı, son retention
çalışması ve `restore_reconciliation_required`. Not başlığı, alan adı veya
tenant adı public yanıtta yer almaz; tam içerikli log varsayılan değildir.

## Bilinen sınırlar

- Retention, kabul edilmiş not/sürüm içeriğini **silmez**; yalnız purge
  kaldırır. Bu bilinçli bir veri kaybı önleme tercihidir.
- Purge sonrası eski yedekteki kopya, o yedek geri yüklenip uzlaştırma
  yapılana kadar fiziksel olarak kalabilir.
- Yedek saklama penceresi politika olarak tanımlıdır; otomatik yedek silme
  ayrı ve açık bir işlem gerektirir.
- Obsidian gerekmez: Markdown + dosya ağacı + servis içi indeks yeterlidir.
- Ölçüm/benchmark ve native istemci kabulü ayrı çalışmalardır; bu rehber
  yalnız işletim sözleşmesini anlatır.
