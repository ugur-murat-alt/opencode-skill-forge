# ADR: M04 hafıza çalışma alanı (web) — ekran haritası, veri akışı ve güvenli önizleme

- **Durum:** Proposed (öneri). **Uygulanmadı**; bu belge yalnız faz 1 keşif ve
  plan çıktısıdır, hiçbir üretim kodu bu kararla yazılmış sayılmaz.
- **Karar tarihi:** 2026-09-11.
- **Kapsam:** issue #37 (M04, üst plan #33). Önkoşullar #34 (M01), #35 (M02),
  #36 (M03). Taslak/çatışma davranışı #31'de kapanan desenlerden türetilir.
- **İnceleme tabanı:** `1bda764c97c810d8c24ca4472492b4abb5d9dbed`
  (`memory/m04-ui` worktree). Aşağıdaki tüm dosya/satır referansları bu
  tabandadır.
- **Varsayım işareti:** İşlem/alan adları henüz #36'da kesinleşmediği için
  "koordinatör taslağı" olarak işaretlenmiştir; kesin şema #36 ile gelir. Bu
  ADR'de üretim kodu veya varsayımsal API'ye bağlanan geçici kod yazılmaz.

## 1. Bağlam ve sınırlar

- M04 hedefi: hafızayı yalnız ajan API'si değil, insanın anlayıp
  düzenleyebildiği bir ikinci beyin yüzeyine dönüştürmek. Obsidian
  çalıştırılmaz/gömülmez; Markdown, bağlantı ve graph yaklaşımı yerli yüzeyde
  kullanılır (issue #37, #33 §7).
- M04 tek başına çalışmaz: not/kimlik/ACL sözleşmesi #34, dayanıklı kayıt ve
  revision #35, arama + türetilmiş graph indeksi + `memory_*` HTTP/MCP yüzeyi
  #36'dan gelir. Bu ADR yalnız web adaptör katmanını ve onun tükettiği
  sözleşmeyi planlar.
- Mevcut web kabuğu yeniden kullanılır: hash tabanlı yönlendirme
  (`web/src/main.tsx`, `web/src/screens.ts`), ortak kaynak/kontroller
  (`web/src/ui.tsx`), API istemcisi ve tenant bağlama (`web/src/api.ts`), i18n
  (`web/src/i18n/parts/*`), tema (`web/src/style.css` değişkenleri). Yeni genel
  tasarım framework'ü, router, state kütüphanesi veya graph framework'ü
  kurulmaz (issue #37 "Yeni genel tasarım framework'ü kurma").
- Mevcut durum kanıtı: `src/` içinde hafıza modülü ve `web/src/` içinde hafıza
  sayfası yoktur; `memory_*` araçları da yayınlanmamıştır. Bu ADR "mevcutmuş
  gibi" hiçbir entegrasyon varsaymaz.

## 2. Ekran ve rota haritası

Tek yeni üst rota: `#memory` (`screens.ts` kaydı). Alt görünümler aynı sayfa
içinde sorgu/sekme durumudur; hash'i şişirmemek için yalnız seçili not ve
görünüm adı derin bağlantı olarak taşınır:

| Görünüm             | Derin bağlantı örneği                   | İçerik                                                                                       |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Çalışma alanı       | `#memory`                               | Alan seçici + not/görev listesi (ilk yük). Kayıt listesi ilk ekrandır; büyük graph çizilmez. |
| Not detayı          | `#memory?note=<note_id>&rev=<revision>` | Editör/önizleme + kaynak paneli + backlink/graph + sürüm geçmişi.                            |
| Görevler            | `#memory?view=tasks`                    | Canonical görev kayıtları; durum değişimi kaynak nota gider.                                 |
| Bu Hafta            | `#memory?view=week`                     | Sunucunun ürettiği haftalık görünüm; türetilmiş, ayrı ana veri değil.                        |
| Öneriler/çatışmalar | `#memory?view=review`                   | Aday/öneri kutusu ve çatışma kutusu; onay kuyruğu rutini değil, gerçek karar noktaları.      |
| Sağlık              | `#memory?view=health`                   | İndeks ilerlemesi, teslim durumu, başarısız iş açıklaması.                                   |

Masaüstü yerleşimi üç bölge: **liste** (sol), **editör/önizleme** (orta),
**kaynak + ilişki paneli** (sağ). Dar ekranda (`max-width: 760px`, mevcut kırılım
ile uyumlu) kontrollü tek panel akışı: liste → not → kaynak sırasıyla tam ekran
paneller, geri dönüş düğmesi ve odak yönetimi. Aynı anda iki panel yan yana
zorlanmaz; yatay kaydırma oluşturulmaz.

Kabuk entegrasyonu:

- `web/src/screens.ts`: `{ id: "memory", titleKey: "nav.memory", Icon: Brain,
needsProject: false }`. Kişisel/ortak alanlar proje olmadan da açılabilir;
  proje seçiliyse proje alanı da listelenir.
- `web/src/main.tsx`: `pages` kaydına `memory: <Memory tenant={...}
project={project} />` eklenir. `main` elemanındaki
  `key={`${page}:${project}:${tenant}`}` remount'u taslakları silmemelidir; bu
  yüzden taslak durumu modül deposunda tutulur (§7).
- Sayfa başlığı ve boş/hata/yükleniyor durumları mevcut `useResource` +
  `ErrorNotice` + `Empty` ile verilir.

## 3. Bileşen ve dosya planı

Yeni web modülü tek sahipli klasörde toplanır; sayfa bileşeni mevcut düz
yerleşimi korur:

| Dosya                              | Sorumluluk                                                                                       | Yeniden kullanım                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `web/src/Memory.tsx`               | Rota kabı: alan seçimi, görünüm sekmeleri, seçili not, panel yerleşimi, URL/hash senkronu.       | `useResource`, `ErrorNotice`, `Empty`, `Refresh`, `date`.      |
| `web/src/memory/api.ts`            | `memory_*` HTTP sözleşmesinin ince istemcisi; istek gövdesine `expected_revision`, kapsam taşır. | `api`, `ApiError`, `errorCode`, `walkPages`, `cursorOrderFor`. |
| `web/src/memory/drafts.ts`         | Kapsam anahtarı, modül deposu, `sessionStorage`, dirty/unpublished/pending hesapları.            | #31 deseninin genelleştirilmişi (`PackageDetail.tsx`).         |
| `web/src/memory/markdown.tsx`      | Güvenli Markdown önizleme: sınırlı alt küme → React elemanı; ham HTML yok.                       | React; `dangerouslySetInnerHTML` kullanılmaz.                  |
| `web/src/memory/NoteList.tsx`      | Kayıt listesi/kartlar, arama, tür/durum filtreleri, keyset "daha fazla".                         | `useResource`, `walkPages`.                                    |
| `web/src/memory/NoteEditor.tsx`    | Editör, önizleme, dirty göstergesi, kaydet/pin/arşiv, sürüm seçimi.                              | `drafts.ts`, `markdown.tsx`.                                   |
| `web/src/memory/SourcePanel.tsx`   | Kaynak referansı, ilgili bölüm, kayıt/kanıt zamanı, revision, beyan/öneri/doğrulanmış/stale.     | `date`, `Status`.                                              |
| `web/src/memory/GraphView.tsx`     | Bounded altgraf SVG + klavyeyle gezilebilir ilişki listesi; filtreler; "daha fazla".             | `drafts.ts` (link düzenleme), `ui.tsx`.                        |
| `web/src/memory/TaskBoard.tsx`     | Görev listesi/engeller; durum değişimi canonical notu günceller.                                 | `Status`, `date`.                                              |
| `web/src/memory/WeekView.tsx`      | Sunucu üretimi Bu Hafta; satır düzenleme kaynak nota yönlendirir.                                | `date`.                                                        |
| `web/src/memory/ConflictPanel.tsx` | 409 çatışmada iki sürüm, fark, yeniden tabanlama/yükleme yolu.                                   | Yeni odak yönetimli dialog (aşağıda).                          |
| `web/src/memory/ReviewView.tsx`    | Öneri/aday kutusu ve çatışma listesi; onaylanmış gibi sunulmaz.                                  | `Status`.                                                      |
| `web/src/memory/HealthView.tsx`    | İndeks gecikmesi, teslim/indeks ilerlemesi, başarısız iş açıklaması.                             | `Status`, `date`.                                              |

Mevcut dosyalarda genişletme noktaları:

| Mevcut dosya                                         | Değişiklik                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `web/src/screens.ts`                                 | `memory` ekran kaydı; `projectFreeScreens` otomatik türetilir.                                                                       |
| `web/src/main.tsx`                                   | `Memory` importu + `pages` kaydı; draft koruması için `key` davranışı test edilir, değiştirilmez.                                    |
| `web/src/ui.tsx`                                     | İki küçük ortak ekleme: odak tuzaklı `ConfirmDialog` (native `window.confirm` yerine; #37 klavye/dialog kabulü) ve gerekirse `Tabs`. |
| `web/src/api.ts`                                     | `cursorOrderFor` içine hafıza listesi yönü eklenir; başka sözleşme değişikliği yok.                                                  |
| `web/src/i18n/tr.ts` / `en.ts`                       | `parts/memory` kaydı, `nav.memory`, `status` ve `errors` grubu eklemeleri.                                                           |
| `web/src/i18n/parts/memory.ts`                       | Yeni çift dil dosyası (tr + en aynı dosyada ihracat, mevcut `parts/*` deseni).                                                       |
| `web/src/style.css`                                  | Yalnız değişken tabanlı yeni sınıflar ve dar ekran kuralları; çıplak renk yasak (mevcut i18n/CSS sınır testi).                       |
| `src/http/server.ts`                                 | `memory_*` uygulama işlemlerine bağlanan HTTP rotaları **M03 sahipliğinde** eklenir; web yalnız bunları tüketir.                     |
| `src/domain/tool-contracts.ts`, `src/mcp/schemas.ts` | `memory_*` MCP şemaları **M03 sahipliğinde**; UI bu yüzeyi doğrudan çağırmaz, aynı uygulama işlemlerini HTTP'den kullanır.           |
| `scripts/web-acceptance.mjs`                         | §10.2 senaryo listesi, ölçüm yardımcıları ve hata enjeksiyonu hedefi.                                                                |
| `docs/tr/hafiza-calima-alani.md`                     | M04 kapanışında kısa kullanıcı rehberi; kaynak sahipliği #34–#35 belgelerine bağlanır (bu fazda yazılmaz).                           |

Katman kuralı: tip/sözleşme dış tipleri web'e kopyalanmaz; `web/src/memory/api.ts`
yalnız M03'ün yayınladığı alanların tipini yeniden tanımlar veya paylaşılan
domain tiplerini tüketir. `web` katmanından `src/` içine import
eklenmez (mevcut mimari sınır testi, `docs/adr/module-boundaries.md`).

## 4. Veri akışı

Kimlik ve kapsam:

1. `main.tsx` `/api/me` yükler; görünür tenant `setActiveTenant` ile bağlanır ve
   `api.ts` her isteğe `x-forge-tenant` ekler. Kimlik hiçbir zaman istek
   gövdesinden çözülmez (#33 §4; #36 §3).
2. Hafıza alanları (kişisel/proje/ortak) ayrı `memory_space_id` taşır; UI alan
   seçimini açık gönderir. Çok alanlı arama yalnız kullanıcının seçtiği
   kapsamlarla yapılır; örtük birleştirme yok.
3. Her istek `expected_revision` (yazma) veya `revision` (okuma) taşır; UI
   gösterdiği revision'ı ekranda ayrıca yazar.

Okuma akışı:

1. İlk yükte `GET /api/memory/notes?space_id=…&limit=…` (koordinatör taslağı;
   kesin yol #36) → kart listesi. Sayfa boyu sabittir; tüm vault indirilmez.
2. Seçili not: `memory_read` karşılığı okuma → gövde + metadata + kaynaklar +
   ilişkiler + revision. **Read-before-change**: editör ancak okuma
   tamamlandıktan ve `base_revision` bilindikten sonra yazılabilir hale gelir.
3. Arama/`memory_recall` kartları: `note_id`, `revision`, tür, kısa içerik,
   eşleşme gerekçesi, kaynak referansı (koordinatör taslağı). Kart, tam not
   yerine geçmez; tıklama `memory_read`e gider.
4. Geçmiş: salt okunur revision görüntüleme; geçmiş bir revision'ı düzenlemek
   yeni revision üretir, eskisini değiştirmez (immutable revision, #33 §4).

Yazma akışı:

1. Editör metni `drafts.ts` kapsam anahtarıyla yerel taslak olur; kaydetme
   açık kullanıcı eylemidir.
2. Kaydetme isteği gönderilen anın **snapshot**'ını taşır (`expected_revision`
   - snapshot gövde); yanıt gelene kadar yeni yazı taslakta ayrı korunur (#31
     deseni).
3. Sunucu kalıcı kabul (receipt) sonrası yeni revision döner; UI önce
   "committed", indeks gecikirse "indexed bekliyor" durumunu ayrı gösterir.
   "Kuyruğa alındı" mesajı "kaydedildi" anlamına gelmez (#37).
4. 409 çatışmada sessiz overwrite yok: `ConflictPanel` kullanıcının iki
   sürümü gördüğü farkı ve yeniden tabanlama yolunu sunar (§7).
5. İlişki düzenleme (`memory_link`): canonical sahip kaynak notun sürümlü
   ilişkisidir; graph DB'sine ayrı yazım yoktur. Manuel/çıkarılmış/kaynak
   bağlantısı ayrımı UI'da etiketlenir.
6. Görev durumu (`task_status`) ve pin/arşiv işlemleri aynı `memory_update`
   yolundan geçer; türetilmiş günlük/haftalık görünümler ayrı kayıt üretmez.

Önbellek ve gecikme:

- Liste ve arama cursor'lıdır; `useResource`/`walkPages` sınırlı ilerler,
  `incomplete` durumu gizlenmez (#29 deseni).
- Yanıt nesli (generation) ref'i her alan/not/revision değişiminde artırılır;
  gecikmiş yanıt yeni bağlama yazılmaz (#22/#31 deseni).
- İndeks gecikmesi ayrı bir durumdur; stale kart doğrulanmış güncel bilgi gibi
  gösterilmez (#36 §1). UI, okuduğu notun revision'ını indeks revision'ından
  ayırır.

## 5. Bounded graph yaklaşımı

Graph dekorasyon değildir; hangi bilginin neden ve hangi kaynaktan geldiğini
gösteren gezinme aracıdır (#37 "Graph dekorasyon değildir"). İki eş yüzey
birlikte teslim edilir:

1. **Erişilebilir liste (canonical alternatif):** seçili notun ilişkileri;
   hedef adı (yetki varsa), ilişki türü, yön, kaynak (manuel/çıkarılmış/kaynak
   linki), gerekçe. Klavyeyle tam gezilir; graph'ın yerine geçer.
2. **Bounded altgraf (SVG):** yalnız seçili not çevresi. Varsayılan `depth=1`,
   koordinatör taslağı üst sınır **200 node / 500 edge**; gerçek veri ve cihaz
   ölçümüyle sabitlenir (#37). Aşımda "daha fazla" ve filtreleme verilir.

Sunucu tarafı (M03 sözleşmesi, UI gereksinimi):

- İstek `depth`, `limit` ve filtreleri taşır; sunucu sert üst sınır uygular.
- Yanıt `truncated` bilgisi döner; UI bunu "daha fazla" olarak gösterir.
  Yetkisiz komşuların adı/sayısı hiçbir alanda dönmez; silinmiş/erişilemeyen
  hedef nötr yer tutucuyla gösterilir, komşu sayısı sızdırılmaz.
- Düğüm/kenar kimlikleri #34 sözleşmesinden, veri #36 indeksinden gelir.
- Her kenar `origin` (`manual` | `extracted` | `source_link`) ve canonical
  yön bilgisi taşır; otomatik ilişki onaylanmış karar gibi sunulmaz.

İstemci tarafı:

- Çizim yalnız tek yanıttaki bounded kümeyle yapılır; istemci birleştirerek
  sınırsız büyüyen bir graph biriktirmez. "Daha fazla" yeni bounded istek
  açar; sonuç önceki kümeyle üst sınırı aşmadan birleştirilir.
- Yerleşim **deterministik** olur: seçili not merkezde, komşular ilişki türü ve
  `(kind, note_id)` sırasına göre sabit halkalara yerleştirilir; rastgele
  kuvvet simülasyonu yoktur. Aynı veri + aynı seçim aynı geometriyi verir
  (yeniden derleme/gezinme kararlılığı).
- Düğüm boyutu tek başına anlam taşımaz; tür/durum metin etiketi ve desenle
  (şekil/çizgi) ayrılır; bilgi yalnız renkle anlatılmaz (#37).
- Zoom/pan durumu not başına korunur; "geri" gezinme yığını ile komşudan
  dönüş kararlıdır. Düğüm seçimi odağı değiştirir ve kaynak paneli seçili nota
  bağlanır.
- Klavye: SVG düğümleri odaklanabilir (`tabindex=0`, `role=button`, Enter ile
  aç); ok tuşları halka/komşu sırasında gezer; liste yüzeyi her zaman aynı
  hedeflere klavye erişimi verir.
- Filtreler: tür, ilişki türü, kaynak (manuel/çıkarılmış) ve yaşam döngüsü.
  Filtre değişimi ya istemci içinde bounded kümede ya da yeni bounded sunucu
  isteğiyle uygulanır; hangisinin olduğu kullanıcıya belirsiz bırakılmaz
  ("bu görünümde filtrelendi" / "yeniden sorgulandı").

Ölçüm yaklaşımı (kabul testine girecek, §10.3): ilk yükte graph isteği
**yok**; ilk not seçiminde **tek** bounded istek; DOM'da node ≤ 200, edge ≤ 500;
istek sayısı, render süresi (seçim→paint) ve kullanılabilirse JS heap raporlanır.
10.000 kayıt fixture'ında liste bounded yüklenir; "tümünü yükle" yolu yoktur.

## 6. Güvenli Markdown önizleme

Temel karar: **ham HTML yüzeye çıkmaz.** Önizleme `dangerouslySetInnerHTML`
kullanmaz; sınırlı bir Markdown alt kümesi ayrıştırılıp **React elemanı** olarak
render edilir. Böylece XSS "temizleme" katmanına bağımlı değil, yapı gereği
mümkün olmaz.

Desteklenen alt küme (ilk sürüm): başlıklar, paragraf, sıralı/sırasız liste,
görev listesi (salt okunur kutu; işaretleme ayrı kayıt akışı), blok alıntı,
yatay çizgi, çitli/girintili kod bloğu (kaçışlı metin, yürütme yok), satır içi
kod, kalın/italik, bağlantı. Kapsam dışı: tablo, dipnot, gömülü HTML, SVG,
form, media.

Güvenlik sınırları:

- **Ham HTML:** etiket olarak yorumlanmaz; metin olarak kaçışlanır.
- **URL şeması allowlist:** yalnız `http:`, `https:`, `mailto:`; `javascript:`,
  `data:`, `vbscript:`, `file:` ve şema gizleme denemeleri reddedilir. Harici
  bağlantı yalnız kullanıcı tıklamasıyla, `rel="noopener noreferrer nofollow"`
  ve `target="_blank"` ile açılır; otomatik gezinme/ağ isteği yoktur.
- **Uzak kaynak:** görsel/iframe/embed **hiç yüklenmez**. Görsel sözdizimi
  varsa yalnız alt metin/bağlantı olarak gösterilir; "notu açmak ağ isteğiyle
  özel metin/kimlik sızdıramaz" (#37). Eklenti/gömleme desteği kapsam dışıdır.
- **Wikilink / göreli bağlantı:** yalnız yetkili hedefe uygulama içi gezinme
  üretir; hedef yetkisizse inert metin olur, varlığı hakkında bilgi sızdırmaz.
- **Kod bloğu:** yalnız görüntülenir; çalıştırma, kopyalama dışında eylem yok.
  Çok uzun içerik satır/blok sınırıyla kısaltılır ve kısaltma açıkça yazılır.
- **Kaynak metni güvenilmeyen veridir:** kaynak paneli alıntıyı düz metin
  olarak, "kaynak alıntı — güvenilmeyen içerik" etiketiyle gösterir; sistem
  talimatı gibi biçimlendirilmez, Markdown olarak yorumlanmaz.
- **Sunucu tarafı ek katman (öneri, M03/HTTP sahipliğinde):** statik yanıtlara
  `Content-Security-Policy` (`default-src 'self'; img-src 'self'; frame-src
'none'; frame-ancestors 'none'`) eklenmesi değerlendirilir. UI güvenliği
  buna bağlı kurulmaz; derinlemesine savunma olarak not edilir.
- **Bounded render:** blok ve toplam karakter üst sınırı; aşımda "devamını
  sınırlı oku" bağlantısı. Render sırasında ağ isteği tetiklenmez.

Ayrıştırıcı seçimi: bağımlılıksız, test edilebilir küçük ayrıştırıcı önerilir
(`web/src/memory/markdown.tsx`, saf fonksiyon → React düğümü). Ürün tam
CommonMark isterse alternatif `marked` + `DOMPurify` çiftidir; bu durumda tam
sürüm sabitlenir, allowlist ve testler aynı kalır. Karar ve bağımlılık onayı
uygulama fazına bırakılmıştır (bkz. §12).

## 7. Taslak, dirty ve çatışma davranışı

#31'de kanıtlanan desenler hafıza editörüne genelleştirilir:

- **Kapsam anahtarı:** `tenant \u0000 memory_space_id \u0000 note_id`; taslak
  kaydı ayrıca `base_revision` taşır. Bir tenant/alanın taslağı başka
  tenant/alanda asla açılmaz veya uygulanmaz (`PackageDetail.tsx`
  `draftScopeKey` deseni).
- **Depolama:** modül `Map` (unmount sağkalımı) + `sessionStorage` (sekme
  yenilemesi); boyut sınırı aşılırsa kalıcı kopya yazılmaz, taslak bellekte
  kalır ve kullanıcıya açıkça söylenir. Sunucuya taslak gönderilmez.
- **Dirty hesabı:** tüm açık olmayan notlar dahil: `drafts` içindeki her kayıt
  `bases` ve varsa staged/queued adayla karşılaştırılır
  (`unpublishedWork`/`draftDirty`/`unstagedDraftCount` deseni). Bekleyen link
  değişiklikleri de dirty sayılır. Yalnız aktif sekmenin değil, **tüm kapsamın**
  yayımlanmamış işi kapatma/discard kararında görünür.
- **Stage ≠ commit:** aday/öneri (queued) ile kalıcı commit ve indeks ayrı
  durumlardır. Aday varken "Kapat" gerçek kayıp uyarısı verir; "kuyruğa
  alındı" mesajı kaydedildi sayılmaz. Kalıcı commit sonrası doğru revision
  sunulur; indeks gecikmesi taslağı silmez.
- **Geçişler:** hash, alan, tenant, proje, not seçimi, sürüm seçimi, tarayıcı
  yenilemesi ve gecikmiş yanıtlar taslağı korur; onay yalnız **gerçek kayıp**
  öncesinde istenir (ör. açık "Vazgeç" veya rollback). Rutin her işleme onay
  eklenmez.
- **Gönderim anı kilidi:** kaydetme sürerken yeni düzenleme ya kilitlenir ya
  gönderilen snapshot'tan ayrı korunur; gönderilen gövde her zaman kullanıcının
  o an gördüğü metindir (sabit snapshot). Yanıt nesli eskimişse UI'a yazılmaz.
- **Çok notlu dirty:** kullanıcı A notunda kirliyken B notuna geçebilir; her
  not kendi taslağını taşır. Kaydetme sıralı ve not başına sonuçludur; kısmi
  başarı atomik gibi gösterilmez.
- **409 çatışma:** sunucu güncel revision'ı ve çatışma gövdesini döner. Panel
  "benim sürümüm / sunucudaki sürüm / ortak taban" farkını gösterir; yollar:
  (a) sunucu sürümünü yükle (yerel taslak bilinçli bırakılır), (b) kendi
  metnimi yeni revision üzerine yeniden tabanla (yeniden dene), (c) taslağı
  koru ve sonra karar ver. Sessiz overwrite ve otomatik birleştirme yoktur.
- **İki sekme / ters yanıt:** her sekme kendi taslağını taşır; geç yanıt
  generation ile atılır; ikinci sekmenin kaydı 409 üretir ve çatışma paneline
  düşer. Yanlış alana yazım, isteklerin alan/tenant'ı açık taşıması ve
  generation kontrolüyle engellenir.
- **Türetilmiş görünümler:** görev/Bu Hafta satırı düzenlendiğinde kaynak
  nota yönlendirilir; türetilmiş görünüm ayrı ana veri olmaz. Oturum bitişi
  görevi "done" yapmaz (§#33 §4).
- **Salt okunur kaynak farkı:** kaynak panelindeki dış dosya ile servis
  tarafından yönetilen not kopyası görsel ve metinsel olarak ayrılır; harici
  dosya sessizce yeniden yazılmaz (#33 §2).

## 8. i18n anahtar planı

Mevcut yapı korunur: `web/src/i18n/parts/memory.ts` içinde `memoryTr` +
`memoryEn`; `tr.ts` ve `en.ts` kaydı; `KeyPath` türetildiği için anahtar hatası
derleme zamanında yakalanır.

| Grup                        | Örnek anahtarlar                                                                 | Notlar                                                               |
| --------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `nav.memory`                | "Hafıza" / "Memory"                                                              | Ekran kaydı başlığı.                                                 |
| `memory.title/subtitle`     | Çalışma alanı başlığı                                                            | Kabuk başlığı.                                                       |
| `memory.spaces.*`           | alan seçici, kişisel/proje/ortak etiketleri                                      | Yetkili alan listesi sunucudan.                                      |
| `memory.list.*`             | arama, tür/durum filtreleri, boş liste, "daha fazla", eşleşme gerekçesi          | Kart alanları #36.                                                   |
| `memory.editor.*`           | kaydet, geri al, dirty, kilitli, snapshot notu, revizyon seçimi                  | #31 üslubu.                                                          |
| `memory.preview.*`          | önizleme, kısaltma, "harici bağlantı", engellenen içerik                         | Güvenli önizleme.                                                    |
| `memory.source.*`           | kaynak alıntı, zaman, revision, beyan/öneri/doğrulanmış/stale, salt okunur dosya | Güvenilmeyen içerik etiketi zorunlu.                                 |
| `memory.graph.*`            | ilişki listesi, filtre, yön, gerekçe, "daha fazla", erişilemeyen hedef           | Liste alternatifi + SVG.                                             |
| `memory.tasks.*`            | planned/doing/blocked/done/cancelled, engeller                                   | `status` sözlüğüyle hizalı.                                          |
| `memory.week.*`             | Bu Hafta, hafta başlangıcı, kaynak nota git                                      | Sunucu üretimi.                                                      |
| `memory.review.*`           | öneri, aday, çatışma, kabul et, reddet, yeniden tabanla                          | Onay kuyruğu rutini değil.                                           |
| `memory.states.*`           | staged/queued/committed/indexed/index_lag                                        | "Kuyruğa alındı" ≠ "kaydedildi".                                     |
| `memory.health.*`           | indeks ilerlemesi, başarısız iş, son teslim                                      | Kısa açıklama zorunlu.                                               |
| `memory.states.lifecycle.*` | active/superseded/archived                                                       | `status` sözlüğüne eklenir.                                          |
| `errors.memory_*`           | #36'da kesinleşecek hata kodları                                                 | `web-i18n-boundary` testi tr/en ve `{param}` eşliğini zorunlu kılar. |

Kurallar: UI bileşenlerinde sabit Türkçe metin olmaz (mevcut test);
`status`/`errors` sözlükleri sunucu kodlarıyla eşlenir; tarih/saat mevcut
`date()` ile aktif dile göre biçimlenir; hafta hesabı istemcide yeniden
yapılmaz, sunucunun `week_start` değeri gösterilir.

## 9. Erişilebilirlik ve responsive

- **Klavye:** skip link mevcut; liste → editör → kaynak paneli sırası anlamlı;
  graph düğümleri odaklanabilir ve ilişki listesi her hedefe klavye erişimi
  verir; dialog'lar odak tuzağı, Escape ve odağı tetikleyiciye geri verme
  davranışı taşır (native `window.confirm` yerine `ConfirmDialog`).
- **Görünür odak:** mevcut `:focus-visible` kuralı tüm yeni kontrolleri kapsar.
- **Ekran okuyucu:** kaydetme/commit/indeks durumu `aria-live` ile duyurulur;
  graph düğüm etiketleri tür/durum metnini taşır; durum yalnız renkle
  anlatılmaz; `aria-current` seçili not/sekme için kullanılır.
- **320–1440 px:** 320/375 tek panel, 768 iki bölge, 1440 üç bölge; yatay
  kaydırma yok; mevcut `@media (max-width: 760px)` kırılımıyla uyumlu.
- **%200 zoom/metin ölçeği:** kök yazı boyutu %200 iken taşma/kırpılma olmaz;
  geometri assertion'ı tarayıcı senaryosuna girer (§10.2/§10.3).
- **TR/EN:** tüm metin sözlükten; dil değişimi mevcut `LangToggle` ile.
- **Açık/koyu tema:** yalnız CSS değişkenleri; çıplak renk yok (mevcut CSS
  sınır testi); grafik desenleri iki temada da okunur.
- **Boş/hata/yükleniyor:** her görünüm üç durumu da tanımlar; hata kodu
  sözlükten çevrilir.

## 10. Test planı

### 10.1 Birim testleri (bun test)

| Dosya                                              | Kapsam                                                                                                                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/web-memory-draft.test.ts`                    | Kapsam anahtarı tenant/alan/not ayrımı; çok notlu dirty; staged/queued ≠ draft; `base_revision` bayatlığı; sessionStorage sınırı; 409 durum makinesi (saf fonksiyonlar); kayıp-onay politikası.            |
| `test/web-memory-markdown.test.ts`                 | Ham HTML/olay özniteliği/`javascript:`/`data:` linki/uzak görsel/iframe girdilerinin React ağacında etkisizleştiği; URL allowlist; kod bloğu kaçışı; blok/karakter sınırı; ağ isteği üretmeme (saf çıktı). |
| `test/web-memory-api.test.ts`                      | Enjekte edilen fetch ile: `expected_revision` gövdede, alan kapsamı istekte, 409'un hata koduna eşlenmesi, gecikmiş yanıtın generation ile atılması.                                                       |
| `test/tenant-switch-coordination.test.ts` (mevcut) | Hafıza istekleri de geçiş beklerken mutasyon reddine ve açık tenant başlığına uyar; kapsam genişletmesi gerekirse burada kanıtlanır.                                                                       |
| `test/web-i18n-boundary.test.ts` (mevcut)          | Yeni `memory` anahtarları, `errors.memory_*` ve `{param}` eşliği otomatik denetlenir.                                                                                                                      |

### 10.2 Gerçek tarayıcı senaryoları (`scripts/web-acceptance.mjs`)

Mevcut sözleşme korunur: doğrusal `safe(ad, fn)` + `check(ad, ok, ayrıntı)`;
`--report` tek JSON; `--verify` artefakt/stdout eşliği; `--inject-failure
<senaryo> --fail-fast` ve `--expect-failure` hata kapısı. Yeni senaryolar bu
listenin **tamamı** olacak şekilde şimdiden adlandırılır:

| #   | Senaryo (`check` adı)               | Doğrulama                                                                                                                                                                  |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `memory-route-first-paint`          | `#memory` açılır; başlık görünür; ilk yükte graph isteği **yok**; liste ilk ekrandır.                                                                                      |
| 2   | `memory-space-select`               | Kişisel + proje + ortak alan listelenir; alan değişimi liste/sorguyu değiştirir; yetkisiz alan görünmez.                                                                   |
| 3   | `memory-create-edit-save-reopen`    | Gerçek serviste oluştur → düzenle → kaydet → yeniden aç; yeni revision görünür; içerik aynen döner.                                                                        |
| 4   | `memory-history-view`               | Sürüm geçmişi; eski revision salt okunur; düzenleme yeni revision üretir, eskisini bozmaz.                                                                                 |
| 5   | `memory-source-panel`               | Kaynak referansı, ilgili bölüm, kayıt/kanıt zamanı, revision; beyan/öneri/doğrulanmış/stale etiketleri ayrı; kaynak metni sistem talimatı gibi sunulmaz.                   |
| 6   | `memory-backlink-graph-navigate`    | Kaynak paneli → backlink listesi → graph'ta komşuya git → geri dön; düğüm seçimi, odak, zoom/pan ve geri davranışı kararlı.                                                |
| 7   | `memory-graph-filters`              | Tür/ilişki türü/kaynak filtreleri düğüm kümesini değiştirir; çıkarılmış ilişki "öneri/otomatik" etiketiyle gösterilir, onaylanmış karar gibi sunulmaz.                     |
| 8   | `memory-graph-bounded-10k`          | 10.000 kayıt fixture'ı; liste bounded yüklenir (sınırlı istek); graph node ≤ 200, edge ≤ 500; aşımda "daha fazla"; ölçümler §10.3'te.                                      |
| 9   | `memory-draft-multi-note`           | İki not kirli; birini kaydet; diğerinin taslağı durur; geçişte ikisi de korunur; pending göstergesi ikisini sayar.                                                         |
| 10  | `memory-draft-transitions`          | Hash geçişi, alan/tenant/proje/not geçişi, tarayıcı yenilemesi ve gecikmiş yanıtlar sonrası son kullanıcı metni korunur.                                                   |
| 11  | `memory-slow-save`                  | Yavaş kayıt sürerken gönderilen snapshot değişmez; yeni yazı ayrı korunur; yanıt sonrası doğru revision gelir.                                                             |
| 12  | `memory-conflict-409`               | İki sekme zıt sırada kaydeder; 409 paneli iki sürümü ve farkı gösterir; yeniden tabanlama yolu çalışır; sessiz overwrite yok.                                              |
| 13  | `memory-queued-vs-committed`        | staged/queued/committed/indexed ayrı görünür; "kuyruğa alındı" mesajı kaydedildi sunmaz; indeks gecikmesi taslağı silmez.                                                  |
| 14  | `memory-task-canonical`             | Görev durumu değişimi canonical kayda gider; oturum bitişi görevi done yapmaz; engel görünür.                                                                              |
| 15  | `memory-week-consistency`           | Bu Hafta ve graph aynı canonical revision'lara dayanır; satır düzenleme kaynak nota yönlendirir; yeniden derlemede tarih kaymaz.                                           |
| 16  | `memory-review-box`                 | Öneri/aday ve çatışma kutusu; aday onaylanmış gibi sunulmaz; kabul/reddet sonucu ayrı durumdur.                                                                            |
| 17  | `memory-health-view`                | Sistem sağlığı, teslim/indeks ilerlemesi, başarısız iş açıklaması görünür.                                                                                                 |
| 18  | `memory-xss-negative`               | Zararlı Markdown (script, onerror, iframe, `javascript:` link, uzak görsel) açılır; script çalışmaz; **hiçbir ağ isteği** üretilmez; engellenen içerik açıkça işaretlenir. |
| 19  | `memory-authz-neighbor-negative`    | Yetkisiz komşu/diğer tenant notu graph ve sonuç yanıtında ad/sayı sızdırmaz; 403/404 ayrımı kullanıcıya bilgi vermez.                                                      |
| 20  | `memory-a11y-keyboard`              | Klavye-only akış: liste → not → kaynak → graph listesi; dialog odak tuzağı/geri dönüş; Enter/Escape davranışları.                                                          |
| 21  | `memory-responsive-geometry`        | 320/375/768/1440 px: yatay taşma yok, paneller erişilebilir, geometri assertion'ı (mevcut `header-<width>` deseni).                                                        |
| 22  | `memory-zoom-200`                   | %200 metin ölçeğinde taşma/kırpılma yok; kontrol ve metinler erişilebilir.                                                                                                 |
| 23  | `memory-locale-theme`               | TR/EN ve açık/koyu tema; tüm durumlar okunur; renk-dışı durum kodlaması doğrulanır.                                                                                        |
| 24  | `memory-states-empty-error-loading` | Boş liste, hata ve yükleniyor durumları gerçek tarayıcıda görünür.                                                                                                         |
| 25  | `memory-a11y-list-alternative`      | İlişki listesi graph olmadan da tüm gezinmeyi verir; aynı hedeflere klavye erişimi.                                                                                        |

Mevcut `pages` döngüsüne `["memory", "Hafıza"]` eklenir (sayfa başlığı ve
ekran görüntüsü `page-memory`). Senaryolar numara sırasıyla aynı oturumda
koşar; 10k fixture yalnız 8. senaryo öncesi kurulur ve sonra temizlenir.

### 10.3 Ölçüm ve CI kapısı

- **İstek sayımı:** `page.on("request")` ile `/api/memory/**` filtrelenir;
  ilk paint'te graph isteği 0, not başına bounded okuma ≤ sabit; liste
  "daha fazla" istekleri cursor sayısıyla raporlanır.
- **Render süresi:** seçim `performance.mark` → `requestAnimationFrame` sonrası
  `performance.measure`; değer `check` ayrıntısına kısa yazılır.
- **Bellek:** Chromium'da `performance.memory.usedJSHeapSize` varsa raporlanır;
  yoksa `null` ve "ölçülemedi" notu — uydurma değer yazılmaz.
- **Fixture:** 10.000 kayıt, test sunucusuna bounded toplu tohumlama ile
  kurulur (yol #36'da netleşecek; §12). Süre ölçülür ve raporda ayrıca belirtilir.
- **Rapor:** sonuçlar `skill-forge.web-acceptance.v1` içinde `check`
  satırlarıdır; ölçüm özeti 300 karakter sınırına sığacak kısa ayrıntı olarak
  yazılır. Şema genişletmesi gerekirse geriye uyumlu opsiyonel alan olarak
  eklenir ve `--verify` parity kontrolü korunur.
- **Hata kapısı:** CI'daki mevcut "intentional UI fault" adımı, ikinci bir
  koşuda `--inject-failure memory-conflict-409 --fail-fast` ile hafıza
  senaryosunu da kırar; `--verify --expect-failure` failure_shots ve kırmızı
  rapor kanıtını doğrular. Böylece #37'nin "kasıtlı regresyon kapıyı gerçekten
  kırar" maddesi yeni yüzeye bağlanır (CI süresi bütçesi izlenir).

## 11. #37 kabul maddeleri → senaryo eşlemesi

| #37 kabul maddesi                                                                                        | Eşlenen senaryolar / testler                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gerçek servis üzerinden oluştur → düzenle → kaydet → yeniden aç → geçmiş → kaynak/backlink/graph zinciri | `memory-create-edit-save-reopen`, `memory-history-view`, `memory-source-panel`, `memory-backlink-graph-navigate`; birim: `web-memory-api`.                           |
| İki alan/iki sekme ve ters sıralı yanıtlarda yanlış alana yazım veya eski kaynak gösterimi olmaz         | `memory-draft-transitions`, `memory-conflict-409`, `memory-space-select`; birim: generation testleri.                                                                |
| Kirli birden fazla not, staged aday, yavaş kayıt, conflict ve refresh sonrası metin korunur              | `memory-draft-multi-note`, `memory-slow-save`, `memory-conflict-409`, `memory-draft-transitions`; birim: `web-memory-draft`.                                         |
| Task durumları ile oturum bitişi ayrı; Bu Hafta ve graph aynı canonical revision'lara dayanır            | `memory-task-canonical`, `memory-week-consistency`.                                                                                                                  |
| 10.000 kayıt fixture'ında liste/graph bounded; istek sayısı, render süresi, bellek raporlanır            | `memory-graph-bounded-10k`, `memory-route-first-paint`; ölçüm §10.3.                                                                                                 |
| 320/375/768/1440 px, %200 zoom, TR/EN, açık/koyu; klavye, dialog, boş/hata/yükleniyor                    | `memory-responsive-geometry`, `memory-zoom-200`, `memory-locale-theme`, `memory-a11y-keyboard`, `memory-states-empty-error-loading`, `memory-a11y-list-alternative`. |
| XSS/tehlikeli link/uzak kaynak ve yetkisiz graph komşusu negatif testleri                                | `memory-xss-negative`, `memory-authz-neighbor-negative`; birim: `web-memory-markdown`.                                                                               |
| Ekran görüntüsüne ek davranış/geometri assertion'ları CI'a bağlanır; kasıtlı regresyon kapıyı kırar      | §10.3 istek/render/geometri assertion'ları + `--inject-failure memory-conflict-409` ikinci hata kapısı.                                                              |

## 12. Açık sorular / sözleşme boşlukları

#36'da netleşmesi gereken, UI'ın doğrudan bağımlı olduğu alanlar:

1. **Not alanları (koordinatör taslağı):** `format_version`, `note_id`,
   `memory_space_id`, `kind`, `title`, `summary`, `lifecycle`, `pinned`,
   `task_status`, `verification`, `sources`, `edges`. Alanların tipleri,
   zorunlulukları ve eksik alan davranışı (kısmi kart) sabitlenmeli.
2. **İşlem yüzeyi (koordinatör taslağı):** `memory_context`, `memory_recall`,
   `memory_read`, `memory_update`, `memory_link`, `memory_checkpoint`.
   HTTP karşılıkları, metotlar, yol şeması, sayfalama/cursor biçimi ve
   MCP/HTTP eşdeğerliği.
3. **Kart alanları:** `note_id`, `revision`, tür, kısa içerik, eşleşme
   gerekçesi, kaynak. "Eşleşme gerekçesi" yapısı (metin mi, etiket listesi
   mi?) ve kaynak alanının ACL güvenli gösterimi.
4. **Revision/commit sözleşmesi:** `expected_revision` alan adı, 409 gövdesi
   (benim/sunucu/taban sürümleri), yeniden tabanlama işleminin adı ve bayrağı;
   sürüm geçmişi uç noktası ve sayfalaması; immutable revision okuma.
5. **Durum modeli:** `staged`/`queued`/`committed`/`indexed`/`index_lag`
   adları; UI indeks tamamlanmasını nasıl öğrenir (poll ucu mu, iş durumu mu)?
6. **Yaşam döngüsü ve görev:** `lifecycle` değerleri (active/superseded/
   archived), `task_status` değerleri, oturum/günlük kaydının görevle ilişkisi.
7. **Doğrulama ayrımı:** `verification` değerleri (kullanıcı beyanı / öneri /
   doğrulanmış / stale) ve bunları kimin yazabildiği; UI etiketleme kuralları.
8. **Kaynak şeması:** kaynak referansı alanları (tür, yol/id, bölüm, checksum,
   gözlem/kanıt zamanı), alıntı gösterim sınırı ve salt okunur dış dosya ile
   yönetilen kopya ayrımının API'da nasıl işaretlendiği.
9. **Graph sözleşmesi:** altgraf yanıt şeması; `depth`/`limit` varsayılanları;
   `truncated` ve yetkili toplam davranışı; silinmiş/erişilemeyen hedefin
   nötr gösterimi; `origin` enum'ı; `CONTRADICTS`/`DEPENDS_ON` kullanımı;
   düğüm/kenar kimliklerinin #34 ile birebir uyumu.
10. **Bounded graph sabitleri:** 200 node/500 edge geçici; hangi ölçümle
    (hangi cihaz, hangi fixture) sabitlenecek ve aşımda "daha fazla"nın
    sözleşmesi (filtreli yeni istek mi, cursor mı?).
11. **Öneri/aday kutusu:** aday listeleme/kabul/reddet uçları M02'de mi
    M03'te mi; UI hangi durumları gösterecek; M06 otomasyonu gelmeden hangi
    aday türleri oluşur?
12. **Sağlık uç noktası:** indeks ilerlemesi, başarısız iş ve teslim
    gecikmesi alanlarının şeması; boş/başarısız durumlar.
13. **Hafta tanımı:** saat dilimi ve `week_start` sunucu hesabı; istemci
    yalnız gösterir.
14. **Arama sıralaması/gezinme:** cursor yönü (artan/azalan), "daha fazla" ve
    `incomplete` durumunun kart listesindeki karşılığı.
15. **Test tohumlaması:** 10.000 kayıt fixture'ının kabul betiği için bounded
    tohumlama yolu (toplu oluşturma ucu veya CLI import); ölçüm gürültüsünü
    azaltmak için sabit veri üreteci.
16. **Markdown renderer kararı:** bağımlılıksız alt küme ayrıştırıcısı mı,
    `marked`+`DOMPurify` mı; desteklenen alt kümenin ürün onayı ve görev
    listesi kutularının etkileşimli olup olmayacağı.
17. **Ek güvenlik katmanı:** statik yanıtlara CSP başlığı eklenmesi (HTTP
    sahipliğinde) ve `img-src` politikasının yerel eklentilerle ilişkisi.
18. **Derin bağlantı biçimi:** `note_id` ve `revision`ın URL'de taşınması;
    paylaşılabilir link kapsamı ve yetki kontrolü.
19. **Boş alan davranışı:** kişisel alan yoksa/proje alanı yoksa ilk ekran;
    alan otomatik oluşturma M01 kararı.
20. **i18n hata kodları:** `memory_*` hata kodlarının `ForgeError` kodu olarak
    yazılması; `web-i18n-boundary` testinin otomatik kapsaması için zorunlu.

## 13. Riskler, büyüklük ve sıralama (özet)

- **Önkoşul riski (yüksek):** #36 sözleşmesi bu ADR yazılırken yok; varsayılan
  alan/yol adları değişebilir. Azaltma: yalnız ADR; UI ince adaptörle
  (`web/src/memory/api.ts`) sonradan bağlanır, sözleşme değişikliği tek
  dosyada toplanır.
- **Kapsam riski (yüksek):** M04 yedi yüzeyi (liste, editör, kaynak, graph,
  görev, hafta, inceleme/sağlık) tek issue'da taşıyor. Öneri: dikey dilimler
  ve gerekirse alt issue'lara bölme (çalışma alanı çekirdeği → graph →
  görev/hafta → inceleme/sağlık).
- **Markdown güvenliği (orta):** bağımlılıksız ayrıştırıcı kenar durumları ve
  DoS riski; bounded girdi + property/fuzz testleri; alternatif vetted
  kütüphane. Ham HTML yolu hiçbir senaryoda açılmaz.
- **Graph performansı/kararlılığı (orta):** 200 düğümde yerleşim ve erişilebilir
  liste; deterministik düzen ve 10k ölçümü erken koşulur.
- **İndeks gecikmesi/yanlış tazelik (orta):** stale kartın güncel sanılması;
  UI revision + durum etiketiyle ayırır, test senaryosu vardır.
- **Taslak depolama sınırı (düşük-orta):** büyük gövdelerde kalıcı kopya
  yazılamaz; kullanıcıya açık bildirim, veri kaybı yok.
- **Kabul süresi (orta):** 10k fixture ve yeni senaryolar CI 25 dk bütçesini
  zorlayabilir; fixture kurulumu ölçülür, gerekirse ayrı iş olarak bölünür.
- **Bağımlılık onayı (düşük):** yeni kütüphane gerekirse sürüm sabitleme ve
  lisans kontrolü ayrı karar gerektirir.

Tahmini büyüklük: **L (büyük)** — web tarafında ~10 yeni dosya, ~1500–2500
satır kod + test; M03 sözleşmesi olgunlaşmadan üretim kodu yazılmaz.

M01–M04 dikey teslim sırası (kabul için): M01 sözleşme/ACL → M02 kalıcı kayıt
ve revision → M03 arama/bağlam/graph + `memory_*` HTTP/MCP → M04 web yüzeyi.
M04 içi uygulama sırası: (1) rota + i18n + liste/okuma + kaynak paneli
(salt okunur), (2) editör + taslak/dirty + çatışma + sürüm geçmişi,
(3) backlink + bounded graph, (4) görev/Bu Hafta + öneri/sağlık, (5)
erişilebilirlik/responsive + 10k ölçüm + CI hata kapısı + kullanıcı rehberi.
Her adım kendi birim ve tarayıcı senaryolarını o adımda ekler; testler M08'e
bırakılmaz.
