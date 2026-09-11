# Hafıza MCP araçları (M03 referansı)

Bu belge #36 ile sabitlenen altı odaklı hafıza aracını, cursor/bütçe
sözleşmesini ve read-before-change akışını özetler. Kimlik/tenant/proje
payload'dan **alınmaz**; oturum kimliği taşıma katmanından çözülür. Araçlar
yalnız `memoryEnabled` etkinken katalogda görünür; her çağrı alan ACL'ini
yeniden doğrular. HTTP ve MCP aynı uygulama işlemlerini çağırır.

## Araçlar

### `memory_context`

Görev/oturum başlangıcı veya delta bağlamı. Aynı yetkili snapshot'tan aktif
görevler, engeller, son kararlar, pinler ve kaynaklı devam adımı derlenir.
Her kart `note_id + revision + kind + snippet + match_reason + sources`
taşır; bütçe `bytes/2.5 **tahmini**` ile hesaplanır (gerçek tokenizer yok,
karakter token sayılmaz) ve zarf/pin/kaynaklar bütçeye dahildir. Varsayılan
1024 token; `max_tokens` ile 128–8192 arası ayarlanır; en fazla 8 kart.
Sığmayan kritik öğe `truncated` + `continuation_note` ile bildirilir.

```json
{
  "space_id": "…",
  "goal": "M03 kapanışı",
  "session_key": "s-1",
  "generation": 3,
  "branch": "memory/m01-core",
  "worktree": "agent-mem-core",
  "known_revisions": [{ "note_id": "n-1", "revision": 2 }]
}
```

Yanıt `envelope.package_hash`, `offered[]` ve `sections` içerir. `offered`
yalnız **sunulan** sürümlerdir; teslim, istemcinin `known_revisions` ile
beyanıdır. Aynı sürümler tekrar sunulmaz; compaction/resume'da istemci
`known_revisions` göndermezse başlangıç paketi yeniden gelir. Eski metin
fiziksel olarak silinmiş sayılmaz; düzeltme yeni revision olarak sunulur.

### `memory_recall`

Yetkili kapsamlarda kısa kart araması. **Global aday keşfi** (ilk N ID
değil) → bounded lexical skor → sınırlı typed graf genişlemesi. TR/EN
normalizasyonu (`İÇİN ≡ icin`, `IŞIK ≡ isik ≡ ışık`), tam başlık eşleşmesi
ve pin ağırlığı uygulanır. Yenilenmemiş indeks isabeti güncel head ile
karşılaştırılır; stale sonuçlar döndürülmez, `index.stale` ve
`index.pending_events` raporlanır. Cursor sorgu+kapsama bağlıdır; başka
sorguda `invalid_cursor` (400) döner.

```json
{ "query": "kabul kapısı", "space_id": "…", "limit": 8, "graph_depth": 1 }
```

### `memory_read`

Açık ID/revision okuma + sınırlı komşular (`neighbors`, en fazla 10).
Varsayılan güncel head'dir; içerik immutable revision dosyasından birebir
okunur. Yetkisiz/silinmiş hedefler graf çıktısından tamamen çıkarılır.

```json
{ "space_id": "…", "note_id": "n-1", "revision": 2, "neighbors": 3 }
```

### `memory_update`

Tipli create/patch/archive/supersede/pin. Patch `expected_revision` CAS'ı
ister; çakışma `memory_revision_conflict` (409) döner. Yanıt kalıcı commit
receipt'ini taşır. Toplu purge bu araçta yoktur; ayrı yetkili yönetim
akışıdır. Kısmi başarı atomik gibi sunulmaz.

```json
{
  "space_id": "…",
  "note_id": "n-1",
  "expected_revision": 2,
  "title": "Yeni başlık",
  "pinned": true
}
```

### `memory_link`

Kaynak notun sürümlü metadata'sında tek tipli ilişki ekler/kaldırır
(`remove: true`). İki uç aynı yetkili alanda olmalıdır; düzenleme kaynak
notun `expected_revision` CAS'ına tabidir. Bağımsız ikinci graf yazıcısı
yoktur; ters bağlantılar türetilir.

```json
{
  "space_id": "…",
  "note_id": "n-1",
  "relation": "SUPPORTS",
  "target_note_id": "n-2",
  "expected_revision": 3
}
```

### `memory_checkpoint`

Oturumun hedef/ilerleme/engel/sonraki-adım durumunu task notu olarak
kaydeder. **Otomatik `done` yoktur**; görev durumu yalnız açık `status`
veya engel varlığına göre `doing`/`blocked` olur. Mevcut checkpoint
güncellemesi `expected_revision` ister.

```json
{
  "space_id": "…",
  "goal": "Faz B kapanışı",
  "progress": "testler yeşil",
  "blocker": "benchmark",
  "next_step": "ölçüm raporu"
}
```

## HTTP karşılıkları

- Salt okunur: `GET /api/memory/recall`, `/graph`, `/context`, `/notes/:id`,
  `/events`, `/spaces`, `/sources`, `/conflicts`.
- Açık mutasyonlar: `POST /api/memory/update|link|checkpoint|ingest|sources|
sources/:id/scan|notes/:id/archive|notes/:id/restore|index/rebuild`
  (ACL + uygulama katmanında audit).

## Read-before-change akışı

1. `memory_read` ile güncel `revision` alınır.
2. Düzenleme `expected_revision` ile gönderilir.
3. Çakışmada (409) yeniden okunur; kaybeden yazar kazananın revizyonunu
   ezmez.
4. `memory_recall`/`memory_context` yalnız kabul edilmiş revision'ları
   gösterir; indeks gecikmesi `index.pending_events` ile görünürdür.

## Kaynaklar ve güven

Kaynak metin güvenilmeyen veridir; biçimsel zarf tek başına prompt
injection koruması sayılmaz. Araç şema token maliyeti ölçülür ve katalog
hafıza kapalıyken genişlemez.
