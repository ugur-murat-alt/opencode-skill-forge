# Hafıza Markdown formatı v1 (M01)

Bu belge **M01'de teslim edilen** taşınabilir not formatını tanımlar. Uygulama
referansı `src/domain/memory.ts`'tir; DB şeması ve yetki modeli
`docs/adr/memory-ownership.md` içindedir. Graph arayüzü, arama ve model
çıkarımı M02–M06 kapsamındadır.

## Belge yapısı

```markdown
---
format_version: 1
note_id: "not-1"
memory_space_id: "alan-1"
kind: "decision"
title: "Örnek karar"
lifecycle: "active"
pinned: true
verification: "declared"
sources: [{ "id": "agz:42", "kind": "agz" }]
edges: [{ "relation": "SUPPORTS", "target": "not-2" }]
created_at: 1700000000000
---

Gövde metni aynen korunur.
```

- Frontmatter `---` satırları arasındadır ve **JSON uyumlu** değerler taşır:
  metinler tırnaklı, diziler/nesneler JSON. Elle yazımda basit tırnaksız
  metin (`title: Örnek karar`) da okunur; karmaşık YAML desteği yoktur.
- Gövde, kapanış `---` satırından sonraki her şeydir ve aynen korunur.
  Unicode normalizasyonu yapılmaz. `CRLF` yalnız serileştirmede `LF`'e
  çevrilir.

## Frontmatter alanları

| Alan              | Zorunlu | Anlam                                                              |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `format_version`  | evet    | Şu an `1`. Daha yüksek bir sürüm mutasyonsuz reddedilir.           |
| `note_id`         | evet    | Değişmez kimlik; başlık/yol değişse de değişmez.                   |
| `memory_space_id` | evet    | Notun ait olduğu alanın değişmez kimliği.                          |
| `kind`            | evet    | Aşağıdaki türlerden biri.                                          |
| `title`           | evet    | İnsan başlığı; kimlik değildir.                                    |
| `summary`         | hayır   | Kısa özet.                                                         |
| `lifecycle`       | hayır   | `active` (varsayılan), `superseded`, `archived`.                   |
| `pinned`          | hayır   | `true/false`; önem sırası işareti.                                 |
| `task_status`     | hayır   | `planned`, `doing`, `blocked`, `done`, `cancelled`.                |
| `verification`    | hayır   | `declared` (varsayılan), `verified`, `proposed`.                   |
| `stale`           | hayır   | Bayatlık işareti.                                                  |
| `sources`         | hayır   | Kaynak referansları dizisi: `{id, kind?, revision?, hash?, url?}`. |
| `edges`           | hayır   | İlişkiler: `{relation, target}`; `target` hedef `note_id`'dir.     |
| `created_at`      | hayır   | Oluşturulma (epoch ms).                                            |
| `observed_at`     | hayır   | Kaynağın gözlenme zamanı.                                          |
| `valid_from`      | hayır   | Geçerlilik başlangıcı.                                             |
| `valid_until`     | hayır   | Geçerlilik bitişi.                                                 |
| `base_revision`   | hayır   | Bu içeriğin türetildiği önceki kabul edilmiş sürüm.                |
| `revision`        | hayır   | Kabul edilmiş sürüm numarası; hash'e **dahil edilmez**.            |

Bilinmeyen kullanıcı alanları korunur ve yeniden yazılır. Bilinmeyen güvenlik
alanları (`tenant_id`, `acl`, vb.) yalnız veri olarak kalır; yetki vermez.

## Türler ve ilişkiler

- Türler: `decision`, `fact`, `procedure`, `context`, `research`,
  `preference`, `task` (AGZ uyumlu) + `note`, `session`.
- İlişkiler: `SUPPORTS`, `DERIVED_FROM`, `PART_OF`, `ABOUT`, `PRECEDES`,
  `SUPERSEDES` (AGZ uyumlu) + açık semantikli `CONTRADICTS`, `DEPENDS_ON`.
- İlişkinin sahibi kaynak notun sürümlü metadata'sıdır; ters bağlantılar
  türetilir. Otomatik çelişki tespiti mevcut kaydı silmez.
- `SUPERSEDES` zinciri döngüsüz olmak zorundadır; döngü reddedilir.

### Görev durumu ≠ not yaşam döngüsü

`task_status` görevin ilerlemesidir, notun `lifecycle` değeri değildir.
Not `archived` olsa da görev `doing` kalabilir; görev `done` olsa da not
`active` kalır. Görev tamamlanması ayrı bir aktör/kaynak ile izlenir;
oturum/Stop olayı görevi kendiliğinden tamamlamaz.

## Kanonik serileştirme ve hash

- Satır sonları `LF`; bilinen alanlar sabit sırada, bilinmeyenler alfabetik
  yazılır.
- `revision` alanı hariç tüm kanonik kaydın SHA-256'sı alınır; hash kendisini
  içermez, bu yüzden sürüm değişikliği hash'i değiştirmez.
- Aynı içerik her zaman aynı baytları üretir (kararlı yeniden yazım).

## Wikilink ve kimlik

- `[[Başlık]]`, `[[Başlık|etiket]]` ve `[[Başlık#bölüm]]` desteklenir.
- Aynı başlıklı birden çok notta çözüm rastgele yapılmaz: tek aday varsa
  çözülür, aksi hâlde `ambiguous` ve aday `note_id` listesi döner.
- `note_id` başlık/yol değişiminden etkilenmez.

## Sürüm reddi

Desteklenmeyen gelecek `format_version` değeri mutasyonsuz reddedilir
(`status: "unsupported_format"`); kısmi bir kayıt üretilmez.
