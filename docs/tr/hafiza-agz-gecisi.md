# AGZ-Memory'den Markdown Hafızaya Geçiş (M07)

Bu belge, AGZ-Memory verisinin Markdown merkezli yeni hafıza modülüne
kayıpsız, salt okunur ve geri alınabilir aktarımının sözleşmesini tanımlar.
Üst plan issue #33, aktarım issue'su #40'tır. Hedef modül sözleşmeleri
#34–#39 kapsamındadır.

**Önemli:** Bu belge bir teslim kaydı ve sözleşmedir. "Uygulandı" satırları
bu depodaki gerçek dosya ve testlerle doğrulanmıştır; "Planlandı" satırları
henüz kodlanmamıştır. FAZ 1 salt-okunur keşif/envanterdir; FAZ 2 manifest,
stage, apply, doğrulama ve rollback'i #35 commit hattı üzerinden uygular.
Cutover (#38/#39 ve M08) bu belgenin kapsamı dışındadır ve yapılmamıştır.

## 1. Durum tablosu

| Yetenek                                   | Durum             | Kanıt / bağımlılık                                          |
| ----------------------------------------- | ----------------- | ----------------------------------------------------------- |
| Schema 11 fixture üreticisi               | Uygulandı (FAZ 1) | `test/fixtures/agz/buildAgzFixture.ts`                      |
| Salt-okunur envanter ve dry-run raporu    | Uygulandı (FAZ 1) | `src/memory/agz/inventory.ts`, `test/agz-inventory.test.ts` |
| Hash-tuple/2 doğrulaması ve parmak izi    | Uygulandı (FAZ 1) | `src/memory/agz/{hash,schema-v11}.ts`                       |
| WAL/canlı dosya reddi                     | Uygulandı (FAZ 1) | `source_snapshot_not_frozen`                                |
| Manifest şeması ve planı                  | Uygulandı (FAZ 2) | `src/memory/agz/manifest.ts`                                |
| AGZ → M01 belge dönüşümü                  | Uygulandı (FAZ 2) | `src/memory/agz/documents.ts`                               |
| `stage` + bütünlük doğrulaması            | Uygulandı (FAZ 2) | `stageAgzImport`, `readAgzStage`, `agz_stage_integrity`     |
| `apply` + kalıcı receipt + crash resume   | Uygulandı (FAZ 2) | `src/memory/agz/pipeline.ts`, M02 `MemoryCommitService`     |
| `rollback` (yalnız değişmemiş hedeflerde) | Uygulandı (FAZ 2) | `rollbackAgzImport`, M02 tombstone                          |
| Eski/yeni shadow karşılaştırması          | Uygulandı (FAZ 2) | `src/memory/agz/shadow.ts` (SQLite fixture üzerinde)        |
| CLI/HTTP/MCP adaptörü                     | Planlandı (FAZ 3) | Uygulama servisi hazır; dış yüzey ayrı issue                |
| Cutover ve tek otomatik yazım sahibi      | Planlandı (FAZ 3) | #38, #39, #41; bu belge cutover yetkisi vermez              |

FAZ 2 kütüphane API'sidir: `planAgzImport` (dry-run), `stageAgzImport`,
`applyAgzImport`, `compareAgzShadow`, `rollbackAgzImport`. Henüz CLI/HTTP/MCP
komutu yoktur. Canlı kullanıcı verisi, token veya gerçek veritabanı yolu
kullanılmadı; tüm kanıtlar deterministik fixture ve geçici hedef DB/vault
üzerindedir. Üretim verisiyle otomatik rollout, M08 (#41) backup/restore ve
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
4. **Hostile kimlik savunması:** Import edilebilir not kimliği
   `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` kalıbına uymalıdır. `..`, `/`, `\`,
   NUL, mutlak yol veya 64 karakterden uzun kimlik taşıyan not
   `agz_hostile_note_id` (blocking) ile karantinaya alınır; hash'i bile
   taşınmaz. Stage dosya yolu ham kimlikten türetilmez: güvenli kimlik
   okunur kalır (`documents/<noteId>/...`), güvensiz kimlik yalnız
   `documents/x-<sha256[0:32]>/...` dizinine eşlenir. `stageAgzImport`
   şema ve kimlik kapısını **hiçbir dosya yazmadan önce** uygular; hiçbir
   koşulda `documents/` dışında dosya/dizin oluşmaz.

### 5.4 Revision ve hash eşlemesi

- Kaynak revision geçmişi immutable kayıtlardan okunur ve hedef revision
  zincirine sırayla yazılır.
- Kaynak `revision` numarası ile hedef revision numarası farklı olabilir.
  Eski ve yeni değerler açık mapping olarak saklanır:

  | Alan                | Anlam                                                      |
  | ------------------- | ---------------------------------------------------------- |
  | `sourceRevision`    | AGZ `note_revisions.revision`                              |
  | `sourceContentHash` | AGZ `hash-tuple/2` içerik hash'i                           |
  | `targetRevision`    | Hedef revision numarası (plan; gerçek değer receipt'te)    |
  | `documentSha256`    | Stage edilen hedef Markdown'un bayt hash'i                 |
  | `recordHash`        | M01 `memoryRecordHash` (revision alanı hariç)              |
  | hedef `fileHash`    | M02 commit sonrası kabul edilen revision dosyasının hash'i |

- Eski hash **hiçbir zaman** yeni hash'miş gibi yazılmaz: hedef `content_hash`
  M02 tarafından kendi kuralıyla hesaplanır; AGZ hash'i `sources[].hash`,
  `agz_content_hash` ve manifest `sourceContentHash` alanında kaynak izi
  olarak yaşar. Age'a ait hash `content_hash` olarak yazılmaz.
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
- **Supersedes:** `notes.supersedes_id` varsa aynı çift için
  `SUPERSEDES` edge'i kurulur (açık edge yoksa sentezlenir) ve hedefe
  eşlenmiş not UUID'sine çevrilir. Hedef hazır notlar arasında yoksa bağ
  taşınmaz ve `supersedes_missing` uyarısı raporlanır; notun kendisi
  taşınmaya devam eder.
- **Edge'ler:** Altı predicate aynen korunur; `SOURCE → TARGET` yönü
  değişmez, ters bağlantılar hedefte türetilir. Uçlarından biri eksik, farklı
  projede veya karantinada olan edge taşınmaz
  (`edge_cross_project`, `edge_target_unavailable`, `edge_source_quarantined`);
  referans uydurulmaz. Aynı relation + hedef çifti tekilleştirilir; 200 edge
  sınırı aşılırsa fazlası raporlanarak düşürülür.
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

## 6. Manifest şeması (donduruldu, v1)

Manifest, dry-run planından üretilen makine okunur sözleşmedir
(`AGZ_MANIFEST_VERSION = 1`, zod ile katı doğrulama). Kaynak snapshot
kimliğini, açık proje eşlemesini, not/revision/edge planını, sayımları,
dışlananları ve kararı taşır. Not `content`/`summary` metni taşımaz; yalnız
kimlik, hash ve metadata.

Örnek (alan değerleri fixture'dandır; kullanıcı verisi yoktur):

```json
{
  "manifestVersion": 1,
  "kind": "agz-memory-import-manifest",
  "createdAt": 1775000000000,
  "generator": {
    "product": "agz-project-management-mcp",
    "module": "m07-agz-import"
  },
  "source": {
    "productId": "agz-memory",
    "version": "0.5.2",
    "commit": "80096abaaa66dfb13953d011ad234859a75df222",
    "schemaVersion": 11,
    "hashPolicy": "hash-tuple/2",
    "schemaFingerprint": "8d63948dcdfd5404a3e555fe9a194866f4c03cb6825dca503063f4797a57a888",
    "databaseId": "e0000000-0000-4000-8000-000000000001",
    "fileSha256": "835d3252b8ee6d07…",
    "fileSizeBytes": 208896,
    "inventoryDigest": "…",
    "journalMode": "delete",
    "integrityCheck": "ok"
  },
  "mappings": [
    {
      "sourceProjectId": "a0000000-0000-4000-8000-000000000101",
      "sourceName": "Proje Alfa",
      "normalizedName": "proje alfa",
      "target": {
        "tenantId": "local",
        "memorySpaceId": "<hedef-memory-space-uuid>",
        "projectId": null,
        "kind": "personal"
      }
    }
  ],
  "notes": [
    {
      "sourceProjectId": "a0000000-0000-4000-8000-000000000101",
      "sourceNoteId": "b0000000-0000-4000-8000-000000000004",
      "targetNoteId": "b0000000-0000-4000-8000-000000000004",
      "idDecision": "preserved",
      "idDecisionReason": null,
      "title": "Yeni Dağıtım Prosedürü",
      "kind": "procedure",
      "lifecycle": "active",
      "pinned": false,
      "status": "ready",
      "issues": [],
      "revisions": [
        {
          "sourceRevision": 1,
          "sourceContentHash": "…",
          "targetRevision": 1,
          "documentSha256": "…",
          "recordHash": "…",
          "bytes": 742
        }
      ],
      "edges": [
        {
          "relation": "SUPERSEDES",
          "sourceRelation": "SUPERSEDES",
          "targetSourceNoteId": "b0000000-0000-4000-8000-000000000003",
          "targetNoteId": "b0000000-0000-4000-8000-000000000003"
        }
      ],
      "provenanceCount": 1
    }
  ],
  "counts": {
    "projects": 3,
    "notes": 8,
    "readyNotes": 8,
    "quarantinedNotes": 0,
    "revisions": 11,
    "edges": 6,
    "droppedEdges": 0,
    "provenance": 11,
    "pinned": 2
  },
  "exclusions": [
    { "table": "capture_events", "count": 2, "reason": "…replay edilmez…" },
    { "table": "index_outbox", "count": 3, "reason": "…replay edilmez…" },
    { "table": "project_bindings", "count": 1, "reason": "…" },
    { "table": "capture_checkpoints", "count": 1, "reason": "…" },
    { "table": "notes_fts", "count": 8, "reason": "…" }
  ],
  "issues": [],
  "decision": { "status": "ready", "blockingIssues": 0, "warningIssues": 0 }
}
```

- `decision.status`: `ready` (bloklayıcı/uyarı yok), `partial` (karantina
  veya düşürülen edge var; sağlam öğeler uygulanabilir), `blocked` (hiç
  uygulanabilir not yok veya eşlenmemiş proje var; stage/apply reddedilir).
- `notes[].issues` ve üst düzey `issues` karantina gerekçelerini taşır;
  `edge_cross_project`, `edge_source_quarantined`, `edge_target_unavailable`
  gibi düşürülen edge'ler `warning` olarak raporlanır.
- Manifest'te bulunması **yasak** olanlar: not `content`/`summary` metni, ham
  transcript veya `payload_json`, token/parola/anahtar, kullanıcı ev dizini
  veya mutlak kaynak yolu, oturum içeriği. `issues[].detail` metinleri de
  içerik kopyalamaz.

### 6.1 Idempotency anahtarı

Her kaynak revision için anahtar:

```text
agz:<sourceDatabaseId>:<sourceProjectId>:<sourceNoteId>:<sourceRevision>
```

`<snapshot>` olarak kaynak `database_id` kullanılır (dosya kopyaları arasında
sabit kalır); byte düzeyi snapshot kimliği manifestteki `fileSha256`'dır ve
apply öncesi yeniden doğrulanır. Aynı anahtar + aynı içerik hash'i = duplicate
(replay); aynı anahtar + farklı hash = `memory_event_conflict` (409), yani
kaynak sessizce değişmişse hiçbir yeni revision üretilmez.

### 6.2 Stage paketi ve doğrulaması

`stageAgzImport`, `vault/imports/<databaseId>/<fileSha256>/` altına yazar:

```text
manifest.json          # dondurulmuş manifest (içeriksiz)
stage.json             # {manifestDigest, stageDigest, documentCount, bytes}
documents/<noteId>/<sourceRevision>-<documentSha256>.md   # güvenli kimlik
documents/x-<sha256[0:32]>/...                            # güvensiz kimlik kaçışı
receipt.json           # apply/rollback sonrası oluşur (aşağıda)
```

`stageDigest = hashTuple("agz-import-stage", 1, [databaseId, fileSha256, ...])`
ve `manifestDigest = sha256(manifest.json baytları)`'dır. Apply, her doküman
dosyasının hash'ini manifest ile ve `stage.json`'daki digest'leri yeniden
hesaplar; uyuşmazlık `agz_stage_integrity` ile reddedilir ve hedefe hiçbir
şey yazılmaz. Bloklayıcı manifest stage edilemez (`agz_manifest_blocked`).
Stage yazımı ayrıca manifest şemasını ve not kimliği kalıbını doğrular;
uyuşmazlık `agz_hostile_note_id`/`invalid_agz_manifest` ile, yazımdan önce
reddedilir. Kalıcı receipt `manifestDigest` + `stageDigest` + `databaseId`
üçlüsüne bağlıdır; apply ve rollback bu bağı yeniden doğrular, kopuksa
`agz_stage_conflict` (fail-closed) döner.

### 6.3 Operatör kuralları

- **Organizasyon eşlemesi idempotent değildir.** `ensureAgzTargetSpace`
  organizasyon türünde her çağrıda yeni bir alan açar (M01: organizasyon
  adı kimlik değildir). Çağıran eşlemeyi kalıcı saklamalı ve yeniden
  çalıştırmada aynı `mapping`/`memorySpaceId` ile devam etmelidir; aksi
  hâlde aynı kaynak ikinci bir alana aktarılır. Kişisel alan kullanıcı
  başına tek, proje alanı proje başına tektir; organizasyon alanı adı
  serbest etikettir.
- **Snapshot başına tek stage dizini.** Dizin anahtarı
  `imports/<databaseId>/<fileSha256>`'dır. Hedef durumu değişince üretilen
  yeni manifest farklı `manifestDigest` taşır; eski receipt ile
  uzlaşmadığı için apply/rollback `agz_stage_conflict` (fail-closed)
  verir. Operatör çözümü: eski receipt'i arşivleyip stage dizinini
  kaldırmak/yeniden adlandırmak ve yeni planı temiz dizine stage etmek
  ya da yeni bir dondurulmuş snapshot (yeni `fileSha256`) almak. Eski
  receipt asla yeni manifeste işaret ettirilmez; plan sessizce
  ezilmez.

## 7. Apply, receipt ve kısmi hata (uygulandı)

1. **Ön koşullar:** `readAgzStage` manifesti ve dokümanları doğrular; hedef
   tenant aktörün kiracısıyla eşleşmeli; `sourcePath` verilmişse dosya
   SHA-256'sı manifest ile aynı olmalı (`source_changed_during_scan`).
2. **ACL ön kontrolü:** Bütün hedef alanlar (`authorizeSpace` + kapsam türü)
   herhangi bir yazımdan önce yeniden doğrulanır. Yetkisiz hedefte hiçbir
   satır yazılmaz.
3. **Apply:** Her revision için `recordEvent` (idempotency anahtarı) +
   `MemoryCommitService.commit` çağrılır; dosya → DB sırası, tek yazıcı,
   CAS ve kalıcı event receipt'i M02'den gelir. İçerik `migration` güvenilir
   kaynak türüdür: sessiz redaksiyon yapılmaz; güvensiz içerik
   `memory_unsafe_content` ile açık incelemeye gider.
4. **Kalıcı import receipt'i:** `<stageDir>/receipt.json` her revision ve her
   öğe sonrası atomik yazılır. Öğe durumları:
   `pending | applied | duplicate | quarantined | conflict | failed`;
   her revision planlanan hedef revision, hedef `fileHash` ve `recordHash`
   ile izlenir.
5. **Tekrar import:** İkinci aynı stage yeni not/revision/olay üretmez;
   M02 replay yolu duplicate döner ve eksik index işareti tamamlanır.
   Rapor `already_applied` olur (`revisions.applied = 0`). **Rollback
   sonrası** bu garantinin anlamı değişir: tombstoned hedefler için replay
   sessiz "duplicate başarı" üretmez. `commitLocked` tombstone kontrolünü
   committed replay'den **önce** yapar (`memory_note_deleted`, 409) ve
   import hattı bu durumu öğe bazında `conflict` olarak sayar; rapor
   `partial` olur, hiçbir not otomatik diriltilmez (açık restore ayrı
   yoldur).
6. **Crash ve devam:** Dosya sonrası/DB öncesi kesinti M02 orphan-benimseme
   kuralıyla; DB sonrası kesinti replay ile kapanır. Import düzeyinde
   `hooks.afterItem` ile simüle edilen çökmede receipt son committed öğeye
   kadardır; yeniden `applyAgzImport` çağrısı kalan öğeleri tamamlar ve
   çoğaltma üretmez.
7. **Kısmi hata:** Bir öğenin hatası diğerlerini durdurmaz; karantina
   (`quarantined`), çakışma (`conflict`) ve hatalar (`failed`) öğe ve
   revision düzeyinde raporlanır.
8. **Doğrulama:** `compareAgzShadow` kaynak planı ile hedef DB/vault'u
   karşılaştırır; coverage ve `mismatched` listesi kanıttır.

Kullanım (özet):

```ts
const source = await openAgzSource(snapshotPath); // salt okunur
try {
  const plan = await planAgzImport({ source, targetDb, mappings });
  const staged = await stageAgzImport(plan, { vaultRoot });
  const applied = await applyAgzImport({
    service,
    commits,
    identity,
    stageDir: staged.stageDir,
    sourcePath: snapshotPath,
  });
  const shadow = await compareAgzShadow({
    service,
    identity,
    vaultRoot,
    manifest: plan.manifest,
  });
} finally {
  await source.close();
}
```

## 8. Rollback (uygulandı)

- **Receipt bağı:** Rollback, receipt'in `manifestDigest` + `stageDigest` +
  `databaseId` üçlüsünü stage ile karşılaştırır; kopuklukta
  `agz_stage_conflict` ile reddeder ve hiçbir notu geri almaz.
- Rollback yalnız bu receipt'in uyguladığı ve **hâlâ aynı kabul edilmiş
  revision'da duran** hedeflere uygulanır: `current_revision` receipt'teki
  son hedef revision'a eşit, revision `content_hash` receipt `fileHash`'ine
  eşit ve çalışma kopyası değişmemiş olmalı.
- Değişmemiş hedef, açık tombstone ile geri alınır (`archiveNote`:
  `deleted_at` + `lifecycle = archived`). Hard delete yapılmaz; kabul edilen
  sürümler ve receipt denetlenebilir kalır, geri alma açık `restoreNote` ile
  mümkündür.
- Kullanıcı aktarım sonrası hedefi düzenlediyse (yeni revision, değişmiş
  çalışma kopyası veya başka bir tombstone) rollback o kaydı silmez; öğe
  `conflict` olarak raporlanır ve karar kullanıcıya bırakılır.
- Import tarafından oluşturulmayan notlara, edge'lere ve kullanıcı
  düzenlemelerine dokunulmaz.
- İkinci rollback idempotenttir: daha önce geri alınanlar
  `already_rolled_back` olur, yeniden silinmez; süren çatışma `conflict`
  olarak kalır.
- Kaynak AGZ veritabanı ve doğrulanmış yedeği her durumda korunur; rollback
  kaynağı değiştirmez ve kaynak dosya hash'i aynı kalır.

## 9. Cutover (planlandı — yapılmadı)

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

- FAZ 2 henüz CLI/HTTP/MCP yüzeyi sunmaz; API çağrıları uygulama kodundan
  yapılır ve dış adaptör ayrı iş kalemidir.
- Kanıtlar deterministik fixture ve SQLite hedef üzerindedir; gerçek
  kullanıcı verisinin boyutu, canlı AGZ sürümü ve DB konumu doğrulanmadı.
  İlk gerçek dry-run ayrı bir operatör adımıdır ve M08 kapılarına bağlıdır.
- Fixture bazı bilinçli bozukluklar içerir (bozuk referans, hash uyuşmazlığı,
  revision boşluğu); bunlar negatif test içindir, üretim verisi değildir.
- `foreign_key_check` sayısı bütünlük tanısıdır; ayrıntılı karantina kararı
  issue listesindeki semantik kodlarla verilir.
- PostgreSQL hedefi bu fazın kapsamı dışındadır; M02 yolu iki backend'i
  desteklese de M07 testleri SQLite ile koştu.
- Bir SQLite dosyasında şema 11 ama farklı DDL parmak izi varsa aktarım
  reddedilir; bu durumda ayrı sürüme uygun exporter gerekir.
- Rollback tombstone'dur (hard delete değil); kabul edilen revision
  dosyaları ve receipt denetim izi olarak kalır. Kalıcı silme ayrı ve açık
  bir unutma/retention kararıdır (#41).
- Stage/receipt dosyaları vault içindedir; aynı stage üzerinde eşzamanlı iki
  apply denenirse M02 CAS/event idempotency çoğaltmayı engeller, ancak yarış
  raporu `conflict`/`duplicate` olarak görünebilir. Tek operatör akışı
  önerilir.

## 11. Sonraki faz önkoşulları

FAZ 3 (adaptör + cutover hazırlığı) başlamadan önce:

1. En az bir gerçek (dondurulmuş) AGZ yedeği üzerinde dry-run + shadow
   çalıştırılmalı ve kayıp/karantina listesi kullanıcıya raporlanmalı,
2. CLI/HTTP/MCP adaptörü aynı servis çağrılarını kullanmalı; yeni iş mantığı
   `src/memory/agz/` dışına kopyalanmamalı,
3. Hedef `memory_space`/proje oluşturma ve ACL akışı UI/operatör tarafından
   seçilebilir olmalı (ad benzerliğiyle otomatik eşleme yok),
4. M08 (#41) backup/restore, gizlilik/unutma ve işletim kapıları geçmeli,
5. Cutover'da tek otomatik yazım sahibi kararı (#38/#39) açıkça verilmeli;
   iki bağımsız auto-write aynı oturumda açık bırakılmamalı.

Cutover bu belgenin otomatik yetkisi değildir; M07 kodu yazıldı diye
üretim verisiyle rollout yapılmaz.

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
- FAZ 2 dosyaları:
  - `src/memory/agz/manifest.ts` — dondurulmuş manifest şeması, plan, kimlik,
  - `src/memory/agz/documents.ts` — AGZ → M01 Markdown dönüşümü,
  - `src/memory/agz/pipeline.ts` — stage/apply/receipt/rollback,
  - `src/memory/agz/shadow.ts` — eski/yeni karşılaştırma,
  - `test/agz-import-pipeline.test.ts` — FAZ 2 kabul testleri,
  - `test/agz-import-guards.test.ts` — hostile kimlik, rollback replay ve
    receipt bağı regresyonları.
- FAZ 2 doğrulaması: `bun test test/agz-import-pipeline.test.ts` (13 test),
  `bun test test/agz-import-guards.test.ts` (7 test),
  `bun test test/agz-inventory.test.ts` (18 test),
  hafıza + sınır + i18n süiti (148 test), `bun run typecheck`,
  `bun run lint`.

## 13. Terimler

- **Dondurulmuş snapshot:** WAL günlüğü checkpoint edilmiş, yan dosyasız,
  salt okunur açılan SQLite kopyası.
- **Dry-run / plan:** Hiçbir değişiklik yapmadan eşleme, kimlik, hash,
  çakışma ve karantina kararlarını üreten manifest + belge planı.
- **Manifest:** Dry-run'dan üretilen, açık eşleme ve snapshot kimliğini
  taşıyan dondurulmuş makine okunur sözleşme (v1).
- **Stage:** Manifestin ve hedef Markdown belgelerinin hash'lerle vault
  altına yazılmış, doğrulanabilir paketi.
- **Receipt:** Apply/rollback sırasında oluşan hedef ID, revision ve
  durumların kalıcı kaydı (`receipt.json`).
- **Shadow:** Kaynak manifesti ile hedef DB/vault'un salt-okunur içerik/kapsam
  karşılaştırması.
- **Cutover:** Otomatik yazım sahipliğinin eski sistemden yeni sisteme açık
  kararla geçirilmesi (bu fazda yapılmadı).
