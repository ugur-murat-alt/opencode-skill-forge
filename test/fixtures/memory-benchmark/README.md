# Memory benchmark fixtures

Bu dizin, hafıza modülünün kalite/token ölçümü için **anonim, sentetik** TR/EN
veri kümesini ve ölçüm sözleşmesini taşır. Üretim koduna girmez; yalnız
`test/benchmarks/**` ve bağımsız inceleme koşumları tarafından okunur.

## Dosyalar

| Dosya             | Amaç                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `tuning.json`     | Ayar/geliştirme bölümü. 8 kategori × TR/EN = 16 senaryo.          |
| `acceptance.json` | Kabul (held-out) bölümü. Aynı kategori matrisi, farklı içerik.    |
| `thresholds.json` | Ölçümden önce donmuş eşikler; sürümlü.                           |
| `schema.json`     | Veri kümesi JSON şeması (insan/araç sözleşmesi).                  |
| `synthetic.ts`    | Tohumlu 1.000/10.000+ not üreticisi ve metadata hesabı.           |

## Bölüm disiplini

- `tuning.json` üzerinde serbestçe çalışılır.
- `acceptance.json` **held-out**'tur: ayar, eşik veya prompt bu bölüme bakılarak
  değiştirilemez. Eşik değişikliği `thresholds.json` sürümünü artırır ve
  gerekçesini `notes` alanına yazar.
- İki bölümün senaryo kimlikleri ayrıktır; `dataset-contract.test.ts` bunu
  doğrular.

## Kategoriler (her biri en az TR ve EN örnek içerir)

1. `old_new_decision` — eski karar superseded, yeni karar geçerli.
2. `same_name_different_scope` — aynı başlık, farklı alan; sorgu alanı dışındaki
   kayıt sonuca girmemeli (`forbidden`).
3. `temporal_information` — geçerlilik penceresi dışındaki kayıt güncel
   sayılmamalı (`stale`).
4. `multi_session_continuity` — önceki oturum kararı ve açık sonraki adım
   birlikte hatırlanmalı.
5. `task_blocker_next_step` — görev durumu `blocked`, engel ve planlı sonraki
   adım kaynaklarıyla dönmeli.
6. `irrelevant_query_abstention` — konu dışı sorguda sistem çekimser kalmalı
   (`abstain: true`).
7. `contradiction` — çelişen iki aktif kayıt birlikte sunulmalı, sessizce
   silinmemeli (`mustFlagContradiction`).
8. `memory_poisoning` — kayıt içindeki talimat güvenilmez sayılmalı
   (`quarantine`, `mustNotFollowInstructionFrom`); otomatik yazım adayı olamaz.

## Metadata tanımları

- `noteLength`: her notun `body` karakter sayısı; min/max/mean.
- `sectionLength`: her `sections[].text` karakter sayısı; min/max/mean.
- `edgeDensity`: `edgeCount / (noteCount × (noteCount − 1))` — yönlü çift
  yoğunluğu (self-loop yok).
- `averageOutDegree`: `edgeCount / noteCount`.
- `pinRatio`: `pinCount / noteCount`.
- `languages` ve `categories`: senaryo sayıları (fixture bölümlerinde).

Metadata, `synthetic.ts --update-metadata` ile yeniden üretilir; test onu
yeniden hesaplayıp eşitlik arar. Kadameli değerler yuvarlanmıştır
(`mean` 2, `edgeDensity` 9, oranlar 6 basamak).

## Gizlilik

- Bütün metin şablon havuzlarından üretilmiştir; gerçek kullanıcı notu,
  transcript, sır veya kişisel veri yoktur.
- Dosyalardaki `synthetic: true`, `containsRealUserData: false`,
  `containsSecrets: false` alanları zorunludur ve test edilir.
- Zehirleme örnekleri bilinçli zararlı metin içerir; üretim verisine
  aktarılmaz, yalnız negatif test girdisidir.

## Sentetik üretim

```bash
bun test/fixtures/memory-benchmark/synthetic.ts --update-metadata \
  test/fixtures/memory-benchmark/tuning.json \
  test/fixtures/memory-benchmark/acceptance.json
```

```ts
import { generateSyntheticDataset } from "./synthetic.js";
const corpus = generateSyntheticDataset({ seed: 42, size: 10_000 });
```

Aynı `(seed, size, languages, edgeDensity, pinRatio)` her zaman byte-özdeş
çıktı verir; `test/benchmarks/synthetic.test.ts` bunu SHA-256 ile kilitler.
`needles` alanı, güçlü eşleşen kayıtlarını listenin **son %2**'sine koyar; yalnız
ilk N kaydı tarayan bir keşif bu sorguları kaçırır.

## Eşik politikası

`thresholds.json` ölçüm başlamadan donar (`frozenBeforeMeasurement: true`).
Sonuç görüldükten sonra eşik düşürülemez; değişiklik yeni `version` ve
gerekçe gerektirir. 1024/2048 token, 8 kart ve p95 250/100 ms değerleri
#41'deki başlangıç hedefleridir: **ölçüm veya garanti değildir**.
