# Hafıza dosya düzeni ve kaynak kökleri (M02)

Bu belge M02'de teslim edilen vault düzenini, kaynak türlerini ve çatışma
davranışını anlatır. Format sözleşmesi `docs/tr/hafiza-format.md`, sahiplik ve
kurtarma kararları `docs/adr/memory-ownership.md` içindedir.

## Vault düzeni

Vault kökü `<dataDir>/memory/` altındadır. Yollar ID/hash tabanlı kanoniktir:

```
memory/
  .writer.lock                     # tek yazıcı kilidi (writer id + pid + host + heartbeat)
  .tmp/                            # atomik yazım geçici dosyaları (sahiplik/liveness ile GC)
  .quarantine/                     # yalnız metadata: hash + sınırlı özet + neden (ham içerik yok)
  spaces/<spaceId>/
    notes/<noteId>.md              # yönetilen çalışma kopyası (kanonik kimlik yolu)
    revisions/<noteId>/<revision>-<fileHash>.md   # immutable kabul edilmiş sürümler
```

- Okunabilir klasörler (`decisions/`, `tasks/`, `notes/`, `sessions/`, …)
  yalnız **sunumdur**: API `display_path` üretir, ama yazma her zaman kanonik
  ID yoluna gider. Bir dosyayı klasörler arasında taşımak `note_id`'yi
  değiştirmez; klasör adı kimlik veya yetki değildir.
- Revision dosya adı içerik hash'ini taşır. Aynı revision için yarışan iki
  yazar farklı dosya adları üretir; kaybeden kazananın dosyasını silemez.
- `memory/` dışına çıkan yollar (`..`, mutlak yol, `\`) reddedilir.

## Kaynak kökleri

| Mod         | Anlamı                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------- |
| `read_only` | Kullanıcının eklediği kök; izlenir, **asla** sessizce değiştirilmez/yazılmaz.            |
| `managed`   | Servisin yönetilen çalışma kopyası; write-back yalnız beklenen disk hash'i değişmediyse. |

- Tarama cursor/checkpoint'lidir ve tur başına sınırlıdır (varsayılan 200
  yol); "ilk N'e dönme" veya "tüm dizini okuyup dilimleme" yoktur. Aynı yol
  bir sonraki turda kaldığı yerden devam eder.
- Symlink, kök dışı yol, boyut sınırı aşımı ve yarım yazım (okuma sırasında
  değişen dosya) sessizce yutulmaz: atlanır/karantinaya alınır ve sayaçlarda
  raporlanır.
- Yarım yazım sonraki taramada yeniden denenir; kaynak dosyanın kendisi
  redaksiyon adına değiştirilmez.

## Değişiklik adayları ve çatışmalar

Her gözlenen fark `memory_change_candidates` satırı olur:

- `candidate`: yeni ya da incelenmeyi bekleyen değişiklik.
- `conflict`: dış dosya ile kabul edilmiş not eşzamanlı değişmiş; son-yazan
  kazanmaz, iki taraf da korunur.
- `applied` / `rejected` / `quarantined`: açık işlem/inceleme sonucu.

Örnekler:

1. **Dış editör + UI yarışı.** UI bir revision commit ederken kullanıcı
   çalışma kopyasını değiştirdiyse yeni sürüm commit edilir, diske yazılan
   dış metin **korunur** ve `working_copy_changed` nedenli `conflict` adayı
   görünür olur.
2. **Aynı note_id, iki dosya.** Kopyalanmış aynı ID çatışması yeni not diye
   yutulmaz; aday olarak işaretlenir.
3. **Kaynak silindi.** Not silinmez; `source_state=missing` olur. Notu
   kaldırmak için açık arşiv/restore işlemi gerekir; yeniden tarama veya eski
   spool tombstone'u diriltemez.
4. **Rename.** `note_id` frontmatter'da taşındığı için başlık/dosya adı
   değişse de aynı notun sürümleri devam eder.

## HTTP yüzeyi

- `GET /api/memory/spaces`, `GET /api/memory/notes`, `GET /api/memory/notes/:id`,
  `GET /api/memory/events` salt okunurdur; hiçbir run/olay üretmez.
- `POST /api/memory/ingest` açık mutasyondur: alan `write` ACL'i + tenant
  `run` izni + audit (`memory.ingest.accepted`). Aynı `source_event_key` +
  aynı içerik duplicate döner; farklı içerik 409'dur.
- Kaynak kaydı/tarama, çatışma listesi ve arşiv/restore uçları M02'nin Faz B
  adımında eklenir.
