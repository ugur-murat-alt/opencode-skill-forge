# AGZ-Memory'den Markdown Hafızaya Geçiş (M07)

Bu belge, AGZ-Memory verisinin Markdown merkezli yeni hafıza modülüne
kayıpsız, salt okunur ve geri alınabilir aktarımının sözleşmesini tanımlar.
Üst plan issue #33, aktarım issue'su #40'tır. Hedef modül sözleşmeleri
#34–#39 kapsamındadır.

**Önemli:** Bu belge bir uygulama planı ve kısmi teslim kaydıdır. Aşağıdaki
"Planlandı" satırları henüz kodlanmamıştır. "Uygulandı" satırları bu depodaki
gerçek dosya ve testlerle doğrulanmıştır.

## 1. Durum tablosu

| Yetenek                                | Durum             | Kanıt / bağımlılık                                          |
| -------------------------------------- | ----------------- | ----------------------------------------------------------- |
| Schema 11 fixture üreticisi            | Uygulandı (FAZ 1) | `test/fixtures/agz/buildAgzFixture.ts`                      |
| Salt-okunur envanter ve dry-run raporu | Uygulandı (FAZ 1) | `src/memory/agz/inventory.ts`, `test/agz-inventory.test.ts` |
| Hash-tuple/2 doğrulaması ve parmak izi | Uygulandı (FAZ 1) | `src/memory/agz/{hash,schema-v11}.ts`                       |
| WAL/canlı dosya reddi                  | Uygulandı (FAZ 1) | `source_snapshot_not_frozen`                                |
| Manifest üretimi                       | Planlandı (FAZ 2) | Bu belgedeki şema                                           |
| `stage` / `apply` / receipt            | Planlandı (FAZ 2) | #34 ve #35 kabul yolları birleşmeden yazılmaz               |
| `rollback`                             | Planlandı (FAZ 2) | Bu belgedeki geri alma kuralları                            |
| Eski/yeni shadow recall ölçümü         | Planlandı (FAZ 3) | #36 ve #41                                                  |
| Cutover ve tek otomatik yazım sahibi   | Planlandı (FAZ 3) | #38, #39, #41                                               |

FAZ 1 hiçbir hedef sisteme yazmaz; import/apply/rollback komutları yoktur.
Canlı kullanıcı verisi, token veya gerçek veritabanı yolu bu fazda
kullanılmaz. Üretim verisiyle otomatik rollout, M08 (#41) backup/restore ve
gizlilik kapıları tamamlanmadan yapılmaz.

## 2. Desteklenen kaynak sürümleri

Tek desteklenen kaynak, incelenen sürümdür:

| Alan              | Değer                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Ürün              | AGZ-Memory 0.5.2                                                         |
| Kaynak commit     | `80096abaaa66dfb13953d011ad234859a75df222`                               |
| Şema              | v11 (`schema_state.version = 11`, `agz_meta.schema_version = 11`)        |
| Hash politikası   | `hash-tuple/2`                                                           |
| Şema parmak izi   | `8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888`       |
| `application_id`  | `0x41475a4d`                                                             |
| Not içerik hash'i | `hashTuple("canonical-note", 2, [kind, title, summary, content])`        |
| Edge türleri      | `SUPPORTS`, `DERIVED_FROM`, `PART_OF`, `ABOUT`, `PRECEDES`, `SUPERSEDES` |
| Yaşam döngüsü     | `active`, `superseded`, `archived`                                       |

Reddetme kuralları mutasyonsuzdur: kaynak dosyaya yazılmaz, migration veya
onarım denenmez. Hata kodları:

| Durum                                      | Kod                          | Davranış                                                 |
| ------------------------------------------ | ---------------------------- | -------------------------------------------------------- |
| `schema_state > 11`                        | `unsupported_source_schema`  | Gelecek sürüm; ayrı sürüme uygun export gerekir          |
| `schema_state < 11`                        | `unsupported_source_schema`  | Önce AGZ tarafında doğrulanmış yedekle yükseltme gerekir |
| v11 ama farklı parmak izi                  | `unsupported_source_schema`  | Bilinmeyen v11 varyantı; eşleşen exporter gerekir        |
| Kayıtlı/hesaplanan parmak izi farkı        | `source_identity_mismatch`   | Bozuk veya kurcalanmış dosya                             |
| `integrity_check != ok`                    | `source_integrity_failed`    | Okuma güvenilir değil                                    |
| WAL başlığı veya `-wal`/`-shm` yan dosyası | `source_snapshot_not_frozen` | Canlı dosya; önce dondurulmuş kopya alınmalı             |
| Tarama sırasında dosya değişti             | `source_changed_during_scan` | Dry-run sessizce uygulanamaz                             |

`PRAGMA foreign_key_check` ihlalleri açılışı engellemez; kaynak içi bozuk
referanslar raporda `blocking` issue olarak listelenir.

## 3. Kaynak snapshot kuralları

Aktarım yalnız **dondurulmuş** bir kopya üzerinde çalışır:

1. Kaynak, AGZ'nin kendi doğrulanmış yedeği veya `VACUUM INTO` ile alınmış
   tutarlı bir kopyadır. WAL günlüğü checkpoint edilmiş olmalıdır.
2. Kopya rollback-journal modunda (`journal_mode=delete`, dosya başlığında
   write/read version `1`) ve `-wal` / `-shm` yan dosyaları olmadan alınır.
3. Kopya, envanter boyunca yalnız `readonly` + `PRAGMA query_only=ON` ile
   açılır. Envanter yazma denemez; dosyanın SHA-256'sı açılış öncesi ve
   sonrasında aynı kalır.
4. Envanter, kaynak dosya ve varsa yan dosyaların hash'lerini açılışta
   kaydeder; `close()` öncesi yeniden doğrular. Değişiklik varsa
   `source_changed_during_scan` fırlatılır ve dry-run uygulanamaz.

Canlı AGZ veritabanı doğrudan açılmaz. FAZ 1'de canlı veriye dokunulmadı;
üretim geçişi M08 (#41) backup/restore kabulüne bağlıdır.

## 4. Envanter ve dry-run

Envanter şunları salt okunur olarak çıkarır:

- Proje sayısı ve her projenin adı/normalize adı (eşleme ipucu; otomatik
  eşleme değil),
- Not sayıları: toplam, `active` / `superseded` / `archived`, pinli,
- Not başına `id`, `project_id`, tür, başlık/özet/içerik, `content_hash` ve
  `hash-tuple/2` ile yeniden hesaplanan hash karşılaştırması,
- Revision geçmişi (immutable kayıtlar) ve `current_revision` tutarlılığı,
- Provenance kayıtları (kaynak türü, oturum/mesaj/ordinal, redaksiyon ve
  extractor sürümü, güven),
- Altı tür edge ve sayıları,
- Kaynak kimliği: `database_id`, schema sürümü, hash politikası, parmak izi,
  dosya SHA-256'sı ve boyutu.

Aktarım dışı bırakılanlar raporda `exclusions` olarak sayılır ve **asla
otomatik nota dönüşmez**:

| Tablo                 | Neden                                                      |
| --------------------- | ---------------------------------------------------------- |
| `capture_events`      | Denetim kaydıdır; payload'lar replay edilmez               |
| `index_outbox`        | Türetilmiş indeks kuyruğudur; hedef kendi indeksini kurar  |
| `project_bindings`    | Kaynak binding, hedef kimlik veya token yetkisi vermez     |
| `capture_checkpoints` | Kaynağa özgü uzlaştırma durumudur                          |
| `notes_fts`           | Türetilmiş aramadır; hedefte revision'dan yeniden üretilir |

Dry-run raporu `blocking` ve `warning` issue'lar üretir. Örnek issue kodları:
`edge_missing_endpoint`, `edge_cross_project`, `supersedes_missing`,
`provenance_missing_note`, `revision_missing_provenance`, `revision_gap`,
`note_content_hash_mismatch`, `revision_content_hash_mismatch`,
`note_without_provenance`. En az bir `blocking` issue varsa karar
`blocked` olur; bozuk referanslar uydurularak tamamlanmaz.

### 4.1 Dry-run örneği (fixture verisi, kullanıcı verisi değil)

```json
{
  "kind": "agz-memory-dry-run",
  "reportVersion": 1,
  "dryRun": true,
  "source": {
    "databaseId": "e0000000-0000-4000-8000-000000000001",
    "schemaVersion": 11,
    "hashPolicy": "hash-tuple/2",
    "schemaFingerprint": "8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888",
    "journalMode": "delete",
    "integrityCheck": "ok",
    "foreignKeyViolationCount": 6,
    "file": { "sha256": "b4f44302…074e25", "walPresent": false }
  },
  "counts": {
    "projects": 3,
    "notes": 10,
    "notesActive": 6,
    "notesSuperseded": 1,
    "notesArchived": 3,
    "notesPinned": 2,
    "revisions": 13,
    "provenance": 13,
    "edges": 8,
    "edgesByPredicate": {
      "SUPPORTS": 2,
      "DERIVED_FROM": 1,
      "PART_OF": 1,
      "ABOUT": 2,
      "PRECEDES": 1,
      "SUPERSEDES": 1
    }
  },
  "digest": "fcf9fb7594ef1ea4f64e50bb12fc7967c5f1a72f16473d9db0f1b3fa7ffe1d96",
  "decision": { "status": "blocked", "blockingIssues": 8, "warningIssues": 1 },
  "exclusions": [
    { "table": "capture_events", "count": 2 },
    { "table": "index_outbox", "count": 3 },
    { "table": "project_bindings", "count": 1 },
    { "table": "capture_checkpoints", "count": 1 },
    { "table": "notes_fts", "count": 10 }
  ]
}
```

Tam JSON'da `issues` ve `plan.projects` listeleri de bulunur. Örnek çıktı,
`bun test test/agz-inventory.test.ts` fixture'ından üretilmiştir; gerçek
kullanıcı verisi içermez.

## 5. Kimlik ve kapsam eşlemesi

### 5.1 Kaynak kimliği

Kaynak kimliği `(source_database_id, source_project_id, source_note_id)`
üçlüsüdür. `source_database_id`, `agz_meta.database_id`'dir; kaynak dosya
hash'i ve şema parmak iziyle birlikte manifest'te saklanır. Aynı not UUID'si
farklı bir veritabanında farklı içerik taşıyabilir; bu yüzden yalnız not
UUID'si kimlik sayılmaz.

### 5.2 Proje eşleme tablosu

Eşleme **açıktır** ve operatör tarafından manifest'e yazılır. Ad, klasör
veya normalize ad benzerliği otomatik eşleme değildir; adı değiştirilmiş
projeler kaybolmaz çünkü kimlik UUID'dir.

| Kaynak alan                                          | Hedef alan                                    | Kural                                               |
| ---------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| `agz_meta.database_id`                               | `manifest.source.databaseId`                  | Aynen; hedef kimlik üretmez                         |
| `projects.id`                                        | `manifest.mapping.projects[].sourceProjectId` | Aynen                                               |
| `projects.name`                                      | `manifest.mapping.projects[].sourceName`      | Yalnız ipucu; eşleme girdisi değil                  |
| `projects.id`                                        | `target.tenantId`                             | Operatör seçer                                      |
| `projects.id`                                        | `target.memorySpaceId`                        | Operatör seçer; kişisel/ortak alan bilinçli seçilir |
| `projects.id`                                        | `target.projectId`                            | Operatör seçer; hedefte yoksa açıkça oluşturulur    |
| `notes.id`                                           | Hedef not UUID'si                             | Çakışma yoksa korunur; varsa §5.3                   |
| `notes.current_revision` / `note_revisions.revision` | Hedef revision                                | §5.4 açık mapping                                   |
| `note_edges.predicate`                               | Hedef tipli ilişki                            | Altı tür aynen korunur                              |

Her proje satırı hedef tenant ve memory_space ile birlikte manifest'e
yazılmadan `apply` çalışmaz. Bir kaynak projesi birden çok hedef kapsama
bölünmez; bölünme gerekiyorsa ayrı manifest ve ayrı karar gerekir.

### 5.3 Not kimliği ve çakışma

1. Hedefte çakışma yoksa kaynak not UUID'si **aynen korunur**.
2. Hedefte aynı UUID başka bir kaynağa aitse not kimliği deterministik
   türetilir ve manifest'te `idDecision: "remapped"` olarak raporlanır.
   Türetim, ada değil kaynak kimliğine bağlıdır (planlanan algoritma):

   ```text
   digest = hashTuple("agz-import-note-id", 1,
             [sourceDatabaseId, sourceProjectId, sourceNoteId])
   targetNoteId = ilk 32 hex hanesi, sürüm nibble'ı 8 ve RFC 4122
                  varyant bitleri ayarlanmış 8-4-4-4-12 UUID
   ```

   Aynı üçlü her zaman aynı sonucu verir; ikinci import yeni kayıt
   çoğaltmaz.

3. Aynı başlıklı farklı UUID'li notlar birleştirilmez. Aynı kelimelere
   sahip farklı kararlar LLM ile otomatik birleştirilmez; geçiş model
   çağırmaz.

### 5.4 Revision ve hash eşlemesi

- Kaynak revision geçmişi immutable kayıtlardan okunur ve hedef revision
  zincirine sırayla yazılır.
- Kaynak `revision` numarası ile hedef revision numarası farklı olabilir.
  Bu durumda eski ve yeni değerler açık mapping olarak saklanır:

  | Manifest alanı      | Anlam                                        |
  | ------------------- | -------------------------------------------- |
  | `sourceRevision`    | AGZ `note_revisions.revision`                |
  | `sourceContentHash` | AGZ `hash-tuple/2` içerik hash'i             |
  | `targetRevision`    | Hedef revision numarası                      |
  | `targetContentHash` | Hedefin kendi politikasıyla hesapladığı hash |

- Eski hash **hiçbir zaman** yeni hash'miş gibi yazılmaz. Hedef `content_hash`
  hedef politikasıyla yeniden hesaplanır; kaynak hash yalnız kaynak izi
  alanında yaşar.
- Kaynak hash ile içerik yeniden hesabı uyuşmuyorsa kayıt karantinaya
  alınır (`note_content_hash_mismatch` / `revision_content_hash_mismatch`);
  içerik hash'e "uyarlanmaz", hash içeriğe göre düzeltilmez.

### 5.5 Provenance, pin ve komşu dönüşümleri

- **Provenance:** `source_type`, `capture_event_id` (yalnız kimlik),
  `source_session_id`, `source_message_id`, `source_ordinal`,
  `source_tool_call_id`, `redaction_version`, `extractor_version`,
  `confidence` taşınır. Alan kaynakta yoksa hedefte de boş kalır; tarih,
  güven veya kaynak uydurulmaz.
- **Pin:** `notes.pinned = 1` hedef pin alanına taşınır.
- **Supersedes:** `notes.supersedes_id` hedefe eşlenmiş not UUID'sine
  çevrilir ve aynı çift için `SUPERSEDES` edge'iyle tutarlı olur. Hedef
  bulunamazsa kayıt karantinaya alınır.
- **Edge'ler:** Altı predicate aynen korunur; `SOURCE → TARGET` yönü
  değişmez, ters bağlantılar hedefte türetilir. Uçlarından biri eksik veya
  farklı projede olan edge taşınmaz (`edge_missing_endpoint`,
  `edge_cross_project`); referans uydurulmaz.
- **Kişisel alanlar:** Kişisel memory_space notları ortak alana
  kendiliğinden açılmaz. Hedef tenant/actor ACL'si aktarımda yeniden
  uygulanır; kaynak proje UUID izolasyonu hedef yetkilendirmenin yerine
  geçmez.

### 5.6 Taşınmayanlar

- Kaynak binding'ler, istemci tokenları, sırlar, proje dışı yollar ve
  otomasyon izinleri taşınmaz.
- `capture_events` payload'ları, ham oturum transcript'leri ve eski outbox
  teslimleri yeni not olarak replay edilmez. Gerekli provenance bağı yalnız
  kimlik düzeyinde korunur.
- `notes_fts` içeriği taşınmaz; hedef kendi indeksini kabul edilen
  revision'dan üretir.

## 6. Manifest şeması

Manifest, dry-run çıktısından üretilen (FAZ 2) makine okunur bir sözleşmedir.
Kaynak snapshot kimliğini, açık proje/not eşlemesini, dışlananları ve
kararı taşır. Örnek (alan değerleri fixture'dandır; kullanıcı verisi yoktur):

```json
{
  "manifestVersion": 1,
  "kind": "agz-memory-import-manifest",
  "createdAt": "2026-09-11T00:00:00.000Z",
  "source": {
    "productId": "agz-memory",
    "version": "0.5.2",
    "commit": "80096abaaa66dfb13953d011ad234859a75df222",
    "schemaVersion": 11,
    "hashPolicy": "hash-tuple/2",
    "schemaFingerprint": "8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888",
    "databaseId": "e0000000-0000-4000-8000-000000000001",
    "fileSha256": "b4f443026769adc16e1b0fc538e40b6791aaa689d894f31816f73a9a69074e25",
    "fileSizeBytes": 208896,
    "inventoryDigest": "fcf9fb7594ef1ea4f64e50bb12fc7967c5f1a72f16473d9db0f1b3fa7ffe1d96"
  },
  "target": {
    "tenantId": "<hedef-tenant-uuid>",
    "memorySpaceId": "<hedef-memory-space-uuid>",
    "projectId": "<hedef-proje-uuid>"
  },
  "mapping": {
    "projects": [
      {
        "sourceProjectId": "a0000000-0000-4000-8000-000000000101",
        "sourceName": "Proje Alfa",
        "normalizedName": "proje alfa",
        "targetProjectId": "<hedef-proje-uuid>",
        "decision": "explicit"
      }
    ],
    "notes": [
      {
        "sourceDatabaseId": "e0000000-0000-4000-8000-000000000001",
        "sourceProjectId": "a0000000-0000-4000-8000-000000000101",
        "sourceNoteId": "b0000000-0000-4000-8000-000000000001",
        "targetNoteId": "b0000000-0000-4000-8000-000000000001",
        "idDecision": "preserved",
        "sourceRevision": 1,
        "sourceContentHash": "8c71e6721c1d7031d35046ae0051cfe82dbefbb875b2786ff627a668b7882179",
        "targetRevision": 1
      }
    ]
  },
  "excluded": [
    { "table": "capture_events", "count": 2, "reason": "not-replayed" },
    { "table": "index_outbox", "count": 3, "reason": "not-replayed" },
    {
      "table": "project_bindings",
      "count": 1,
      "reason": "no-target-authority"
    },
    {
      "table": "capture_checkpoints",
      "count": 1,
      "reason": "source-operational"
    },
    { "table": "notes_fts", "count": 10, "reason": "derived" }
  ],
  "issues": [
    {
      "code": "edge_missing_endpoint",
      "severity": "blocking",
      "edgeId": "d0000000-0000-4000-8000-000000000007"
    }
  ],
  "decision": { "status": "blocked", "blockingIssues": 8, "warningIssues": 1 }
}
```

Manifest'te bulunması **yasak** olanlar: not `content`/`summary` metni, ham
transcript veya `payload_json`, token/parola/anahtar, kullanıcı ev dizini
veya mutlak kaynak yolu, oturum içeriği. Manifest yalnız kimlik, hash,
sayım, karar ve gerekçe taşır. `issues[].detail` metinleri de içerik
kopyalamaz.

## 7. Apply, receipt ve kısmi hata (planlandı)

1. **Stage:** Manifest ve kaynak snapshot hash'i doğrulanır; stage paketi
   içerik hash'leriyle birlikte yazılır. Stage hedefe görünmez.
2. **Apply:** Hedef yazma, #35'in aynı yetkili commit yolunu kullanır.
   Idempotency anahtarı
   `(sourceDatabaseId, sourceProjectId, sourceNoteId, sourceRevision)`'dır;
   ikinci aynı import yeni not/edge/revision çoğaltmaz.
3. **Receipt:** Uygulanan her hedef ID ve kabul edilen revision kaydedilir.
   Aynı snapshot ikinci kez uygulanırsa yeni kayıt üretilmez.
4. **Kısmi hata:** Her öğe bağımsız durum taşır:
   `applied | skipped_conflict | quarantined | failed`. Bir öğenin hatası
   diğerlerini durdurmaz; iş sonunda tam durum raporlanır. Çözülemeyen
   çatışmalar karantinada kalır, sessizce atlanmaz.
5. **Doğrulama:** Hedefteki not/revision/edge sayıları ve hash'leri dry-run
   planıyla karşılaştırılır. Kaynak snapshot değişmişse eski dry-run
   uygulanmaz; yeni dry-run gerekir.

## 8. Rollback (planlandı)

- Rollback yalnız bu aktarımın oluşturduğu ve **hâlâ aynı revision'da duran**
  hedeflere uygulanır.
- Kullanıcı aktarım sonrası hedefi düzenlediyse rollback o değişikliği
  silmez; kayıt `conflict` olarak raporlanır ve karar kullanıcıya bırakılır.
- Import tarafından oluşturulmayan notlara, edge'lere ve kullanıcı
  düzenlemelerine dokunulmaz.
- Kaynak AGZ veritabanı ve doğrulanmış yedeği her durumda korunur; rollback
  kaynağı değiştirmez.
- Rollback sonucu receipt'e işlenir; ikinci rollback aynı kayıtları tekrar
  silmez.

## 9. Cutover (planlandı)

- Cutover öncesi eski/yeni karşılaştırma salt okunur shadow ölçümüyle
  yapılır (#36/#41); recall, graph ve doğrudan okuma kapsamı karşılaştırılır.
- Aynı anda yalnız **bir** sistem otomatik yazım sahibidir. Cutover'da hangi
  sistemin otomatik yazdığı açıkça seçilir; aynı oturumda iki bağımsız
  auto-write açık bırakılmaz.
- Eski plugin/MCP ayarları kullanıcı kararı olmadan kaldırılmaz veya
  devre dışı bırakılmaz.
- Yeni sistem kapatılsa bile eski AGZ kaynağı bozulmaz; geçiş geri
  alınabilir kalır.
- Cutover, M08 backup/restore, gizlilik/unutma ve işletim kapıları
  tamamlanmadan yapılmaz.

## 10. Bilinen sınırlar ve riskler

- FAZ 1 yalnız keşif ve salt-okunur altyapıdır; hedefe yazmaz. Bu belgedeki
  manifest/apply/rollback bölümleri sözleşmedir, çalışan kod değildir.
- Gerçek kullanıcı verisinin boyutu, canlı AGZ sürümü ve DB konumu bu fazda
  doğrulanmadı; ilk gerçek dry-run ayrı bir operatör adımıdır.
- Fixture bazı bilinçli bozukluklar içerir (bozuk referans, hash uyuşmazlığı,
  revision boşluğu); bunlar negatif test içindir, üretim verisi değildir.
- `foreign_key_check` sayısı bütünlük tanısıdır; ayrıntılı karantina kararı
  issue listesindeki semantik kodlarla verilir.
- PostgreSQL hedefi bu fazın kapsamı dışındadır.
- Bir SQLite dosyasında şema 11 ama farklı DDL parmak izi varsa aktarım
  reddedilir; bu durumda ayrı sürüme uygun exporter gerekir.

## 11. Sonraki faz önkoşulları

FAZ 2 (manifest + apply + rollback) başlamadan önce:

1. #34 çekirdek alan/kimlik/Markdown sözleşmesi birleşmiş olmalı,
2. #35 tek yazıcı ve dayanıklı kabul yolu kullanılabilir olmalı,
3. Hedef `memory_space`/proje oluşturma ve ACL tekrar kontrolü tanımlı olmalı,
4. Manifest şeması bu belgedeki alanlarla dondurulmalı,
5. Dry-run raporu en az bir gerçek (dondurulmuş) yedek üzerinde
   çalıştırılmalı ve sonuç kullanıcıya raporlanmalıdır.

FAZ 3 (cutover) ayrıca #36–#39 ve #41 kapılarını bekler.

## 12. Kaynak, atıf ve dosyalar

- AGZ-Memory kaynağı MIT lisanslıdır (telif: Uğur Murat Altıntas). Uyarlanan
  parçalar kaynak yorumlarında belirtilir:
  - `src/memory/agz/hash.ts` — `hash-tuple/2` (`src/hash.ts` uyarlaması),
  - `src/memory/agz/schema-v11.ts` — şema kimliği ve parmak izi hesabı,
  - `test/fixtures/agz/schema-v11-ddl.ts` — birebir v11 DDL kopyası.
- FAZ 1 dosyaları:
  - `src/memory/agz/inventory.ts` — salt-okunur envanter/dry-run,
  - `src/memory/agz/sqlite-driver.ts` — Bun/Node SQLite adaptörü,
  - `src/memory/agz/errors.ts` — hata kodları,
  - `test/fixtures/agz/buildAgzFixture.ts` — deterministik fixture üreticisi,
  - `test/agz-inventory.test.ts` — kabul testleri.
- FAZ 1 doğrulaması: `bun test test/agz-inventory.test.ts` (18 test),
  `bun run typecheck`, `bun run lint`.

## 13. Terimler

- **Dondurulmuş snapshot:** WAL günlüğü checkpoint edilmiş, yan dosyasız,
  salt okunur açılan SQLite kopyası.
- **Dry-run:** Hiçbir değişiklik yapmadan eşleme, çakışma ve karantina
  kararlarını gösteren rapor.
- **Manifest:** Dry-run'dan üretilen, açık eşleme ve snapshot kimliğini
  taşıyan makine okunur sözleşme.
- **Receipt:** Apply sırasında oluşan hedef ID ve revision'ların kaydı.
- **Cutover:** Otomatik yazım sahipliğinin eski sistemden yeni sisteme açık
  kararla geçirilmesi.
