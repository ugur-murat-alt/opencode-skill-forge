# Paket düzenleme ve geri alınabilir bakım

Skill kütüphanesi bir paketin kayıtlı sürümlerini ve o sürümün dosyalarını gösterir. Dosya içeriğini okumak, script çalıştırmak ve yeni sürüm yayımlamak ayrı işlemlerdir.

## Dosya düzenleme

1. Etkin projeyi seçin ve Skill kütüphanesinden paketi açın.
2. Sürümü ve dosyayı seçip **Dosyayı oku** düğmesini kullanın. Büyük metnin devamı ayrı yüklenir. Düzenleme için metnin tamamını okuyun.
3. Düzenlemeyi adaya ekleyin. İlişkili referans, script ve `forge.json` değişikliklerini aynı adayda toplayabilirsiniz. Bir aday en fazla 16 dosya değişikliği içerir; toplam paket sınırı 4 MiB ve 256 dosyadır.
4. **Test et ve yayımla** bütün paketi denetler. Script içeren adayın kayıtlı davranış testleri gerçek sandbox içinde çalıştırılır. Test geçmeden veya etkin revision değiştiğinde yayın yapılmaz.

Korunan, sabitlenmiş veya otomatik yönetimi kapalı paketi değiştirmek için ilgili yönetim ayarını önce açıkça değiştirin. Eski sürümleri okumak ve dışa aktarmak mümkündür. Eski sürüme dönmek de aynı yayın ve test kapısından geçer; eski dosyalar yerinde değiştirilmez.

Bir scripti kullanmak için kayıtlı girişini seçin, girdi şemasına uygun JSON girin ve **Sandbox içinde çalıştır** düğmesini kullanın. Çalıştırma host shell'e düşmez. Sonucun ürettiği artifact bağlantıları kimlik ve proje yetkisini yeniden denetler.

## Kullanımın anlamı

Bakım raporu seçili kullanıcı ve projedeki servis gözlemlerini sayar:

| Ölçüm                           | Kanıtladığı                                                               |
| ------------------------------- | ------------------------------------------------------------------------- |
| Aramada görünme                 | Paket servis arama yanıtında yer aldı                                     |
| Yükleme                         | Sabit sürümün dosya içeriği servis üzerinden okundu                       |
| Script çalıştırma               | Kayıtlı giriş başarıyla tamamlandı                                        |
| Script hatası                   | Çalıştırma başarısız sonuçlandı                                           |
| Görevde uygulama / görev sonucu | Bu ölçümler mevcut servis gözleminden çıkarılmaz; bilinmiyor olarak kalır |

Bir kullanıcı dosyayı birden çok parçada okuyabilir; yükleme sayısı tekil görev veya başarı sayısı değildir. Başka kullanıcıların özel gözlemleri ve servis dışında kullanılan/export edilmiş dosyalar bu raporun kapsamı dışındadır. Bu alanlarda kullanım sıfır kabul edilmez. Varsayılan pencere 30 gündür; yeni paketler ilk 7 gün gözlem dönemindedir. “Aramada görünmedi” ve “göründü ama yüklenmedi” ayrı gerekçelerdir; otomatik silme önerisi değildir.

## Arşivle ve geri al

Bakım ekranında paketleri seçip **Arşivlemeyi incele** veya **Geri almayı incele** düğmesini kullanın. Önizleme her paketin uygunluğunu ve etkiyi gösterir. Tek **İşlemi uygula** eylemi bütün seçimi yürütür.

- Arşivleme paketi yeni aramadan çıkarır. Kimliği, bütün revision dosyaları ve mevcut sabit sürüm okuyucuları korunur.
- Sabitlenmiş, korunan ve yönetim dışı paketler arşivlenemez.
- Önizlemeden sonra değişen bir paket için eski izin veya revision kullanılmaz; o öğe çatışma sonucu verir.
- Her başarılı öğe kendi DB işlemiyle ve tekrar anahtarıyla kaydedilir. Bağlantı kesilirse aynı istek tekrar gönderilebilir; tamamlanmış öğe yeniden uygulanmaz.
- Bazı öğeler reddedilirse diğer uygun öğeler tamamlanır. Gerekçeleri okuyun, listeyi yenileyin ve yeni seçimi tekrar inceleyin.
- Geri alma aynı kimlik ve revision'ı yeniden aramaya açar; başka bir paketin üzerine yazmaz.

Bu ekrandaki arşivleme kalıcı dosya silme veya kişisel verinin saklama süresini kısaltma işlemi değildir. Arşivlenmiş paketler yedeklerde ve mevcut revision dizinlerinde kalır.

## Yönetim API'si

Bütün çağrılar mevcut oturum/bearer kimliği ve proje yetkisi ister; tarayıcı mutasyonlarında CSRF başlığı gerekir. Model girdisinden kimlik alınmaz.

- `GET /api/skills/:id/manifest?revision=<sha256>&after=0`: 40 dosyalık envanter sayfası, kayıtlı girişler ve doğrulama kaydı.
- `POST /api/skills/:id/edit`: `base_revision`, `changes: [{path, original_hash, content}]`. Yeni dosyada `original_hash: null`; silmede `content: null`. Hash uyumsuzluğu veya stale revision HTTP 409'dur.
- `GET /api/maintenance?project_ref=<id>&days=30&state=all`: en fazla 50 paket ve `next` devam anahtarı; sonraki çağrıda `after` kullanılır.
- `POST /api/maintenance/preview` ve `/api/maintenance/apply`: aynı `{project_ref, operation_id, action, items:[{skill_id, revision, updated_at}]}` gövdesi. `action` arşivleme için `archive`, geri alma için `restore` değeridir. En fazla 100 benzersiz paket seçilebilir.

Toplu API yanıtının HTTP 200 olması bütün öğelerin başarılı olduğu anlamına gelmez. Her öğenin `status` ve varsa `error` alanını okuyun. Başarılı bir öğenin tekrarı `replayed: true` ile döner; aynı anahtarın farklı girdiyle kullanılması reddedilir.

## Saklama ve destek paketi

Etkin `retentionDays` varsayılanı 30 gündür. Operator ve yönetici politikası üst sınırdır; daha dar kapsam süreyi azaltabilir. Servis her dakika en fazla 25 yetkili kullanıcı/proje grubunu sırayla tarar. Tek grupta en fazla 200 tamamlanmış iş metni, 200 ders, 500 gözlem ve 500 olay temizlenir; büyük birikim birden çok turda işlenir. Bu sınırlar ana iş kuyruğunu tek büyük silme işlemiyle durdurmamak içindir. Çok sayıda kapsamda bir kaydın temizlenmesi politika son anından sonraki tura kalabilir.

Bakım ekranındaki **Süresi dolan özel kayıtları şimdi temizle** eylemi aynı sınırlı işlemi kendi kullanıcı/projeniz için çalıştırır. `may_have_more` varsa yeniden çağrılabilir. Bu işlem içerik açısından geri alınamaz; paket arşivleme ile karıştırılmamalıdır.

Tamamlanmış işte özgün prompt/handoff ve sonuç metni kaldırılır; iş kimliği, durum, input hash, tekrar anahtarı ve mevcut kullanım özeti kalır. Aktif iş metni temizlenmez. Eski prompt hazırlama isteği aynı anahtarla tekrar gelirse silinmiş bir iyileştirme uydurulmaz: `content_expired` gerekçesiyle çağrıdaki özgün metin döner. Maliyet ve idempotency defterleri bu temizlikle silinmez; geçmiş maliyet sıfırlanmaz. Paket revision'ları ve mevcut yedekler korunur. Yedeklerin imhası ayrı işletim sorumluluğudur.

Bakım raporunda `window_complete: false`, servis dışı gözlemin eksikliğini ve saklama politikasının istenen tarih penceresini kısaltabilmesini açıklar. Eski olaylar temizlendiğinde önceki dönem için sıfır kullanım iddiası yapılmaz.

Log ve teşhis ekranındaki **Redakte destek paketini indir**, ürün/Node/OS/DB sürümlerini, etkin limitlerin kaynaklarını, son 100 yetkili işin metadata'sını, izinli olay metadata'sını ve istemci sürüm/son görülme bilgisini JSON olarak indirir. Özgün prompt, dosya içeriği, cihaz dizini, credential veya model ağ adresleri eklenmez. İndirme kimlik doğrulanmış aynı servis üzerinden yapılır; üçüncü kişiye otomatik gönderilmez.

Ek API yolları:

- `GET /api/reports/support?project_ref=<id>`: sınırlandırılmış metadata destek paketi.
- `POST /api/telemetry/retain` ve `{project_ref}`: aynı saklama politikasını kendi kapsamınızda uygular.
- MCP `forge_report` içinde `section: "maintenance"`, `observation_days`, `limit`, `cursor`: web ile aynı bakım hesaplarını verir. Cursor kullanıcı/proje/rapor türüne bağlıdır; iş raporunda tekrar kullanılamaz.

## Eşzamanlı düzenlemeleri birleştirme

Paket düzenleyicisindeki “Çakışmayan dosya değişikliklerini güncel sürümle birleştir” seçeneği varsayılan kapalıdır. Açıldığında servis, okunmuş taban sürümü ile güncel sürümü karşılaştırır. Farklı dosyalardaki değişiklikler korunur; iki yazar aynı dosyada aynı byte sonucunu üretmişse de birleştirilebilir. Aynı dosyada farklı değişiklik varsa `rebase_conflict` döner; servis metin içindeki çakışmayı tahmin ederek çözmez. Silme/değiştirme çatışması da reddedilir.

HTTP edit gövdesinde bu seçenek `rebase: true` alanıdır. `original_hash` hâlâ okunmuş taban dosyasıyla eşleşmelidir. Birleşmiş bütün paket yeniden doğrulanır, kayıtlı script testleri yeniden çalıştırılır. Güncel tabana yalnız bir CAS yayın denemesi yapılır; üçüncü bir yazar değiştirirse tekrar çatışma döner. Koruma, güncel yetki ve worker fencing kontrolleri atlanmaz. SPR finalize aynı manager yolunu kullanır; bu işlem SPR'nin anlamsal sahiplik ve kalite değerlendirmesinin yerine geçmez.

Arşivleme ve restore öğeleri, üyelik/proje yetkisi iptaliyle aynı tenant kilidi altında kontrol edilir ve yazılır. İptal önce tamamlanırsa bekleyen öğe engellenir; paket durumu, başarı receipt'i ve audit kaydı değişmez. Toplu isteğin diğer öğeleri kendi sonuçlarıyla raporlanır. Yetki yeniden verildikten sonra aynı başarısız öğe tekrar denenebilir; daha önce başarılı olmuş öğenin receipt'i tekrar yazmayı önler.

Script çalıştırmaları kabul edildiğinde tam tenant/paket/revision bağı veritabanına kaydedilir. İş sürerken revision silme, yabancı anahtar tarafından engellenir. Terminal sonucun yazılması ve bağın bırakılması aynı transaction'dır; aynı execution tekrar çağrılırsa ikinci iş/bağ oluşturulmaz. Sonucu bilinmeyen veya çökmüş execution'ın bağı süre tahminiyle bırakılmaz. Migration öncesi execution kayıtlarında revision alanı bulunmadığından eski işler için ilişki uydurulmaz. Bu koruma SPR ve diğer dosya okurlarının tamamlandığı veya kalıcı silmenin kullanıma açıldığı anlamına gelmez.

SPR mevcut paketi seçerken taban revision'a `run_id + fence` bağı alır; aktif lease ve güncel yetki yeniden denetlenir. Handler kapanışı devam eden araç işlemlerini bekler, sonra yalnız kendi fence bağını bırakır. Eski worker yeni denemenin bağını silemez. Cancel veya lease expiry, bir dosya okurunun gerçekten durduğunu kanıtlamadığı için bağı kendiliğinden kaldırmaz. Çökmüş worker bağlarının kontrollü toplanması henüz tamamlanmamıştır; genel dosya okuyucu koruması aşağıda açıklanır.

Paket yükleme ve bütünlük taraması, dosyaların okunması boyunca kısa ömürlü revision okur kaydı tutar. Yetki ve revision varlığı kayıt alınırken aynı transaction'da kontrol edilir; dosya I/O boyunca tenant kilidi tutulmaz. Aynı kullanıcı/tenant/revision için eşzamanlı okumalar yalnız koruma kaydını paylaşır; içerik cache edilmez ve her çağrı yetkiyi yeniden kontrol eder. Son okur bitince kayıt bırakılır. Farklı kullanıcılar aynı kaydı paylaşmaz. Bütünlük taraması 25 revision referansını sayfa başına tek transaction ile alır ve sayfa sonunda bırakır. DB bağlantısı/process kaybında kalan kayıtlar otomatik süre tahminiyle silinmez; kontrollü artık kayıt temizliği henüz açıktır. Backup snapshot okurları kaynak DB’de FK kayıtlarıyla korunur; [yedekleme rehberi](yedekleme.md) kaynak/restore davranışını açıklar.

## Kalıcı silme API'si

Linux sunucusunda `POST /api/maintenance/preview` ve `POST /api/maintenance/apply` aynı bakım gövdesinde `action: "delete"` kabul eder. Önce arşivlenmiş paketleri rapordan seçin; aynı `project_ref`, `operation_id` ve `items` gövdesini önizleme ve uygulamada kullanın. Her öğede rapordaki `skill_id`, `revision`, `updated_at` bulunmalıdır. Önizleme silinecek revision sayısını gösterir. Web ekranındaki kalıcı silme ve temizliği sürdürme akışı aşağıda açıklanır.

Kalıcı silme yalnız managed, arşivlenmiş, pinned/protected olmayan paket içindir. Canlı okur, script/SPR referansı, geçiş kaydı, kullanım geçmişi veya override bağı varsa engellenir. Revision bilgisi bulunmayan çalışan işler de korunur. Referansları geçersizleştirerek zorla silme yapılmaz; varsayılan geri alınabilir arşivleme kullanılmaya devam eder.

Metadata silme, tombstone, işlem receipt'i ve dosya temizleme kayıtları tek transaction'dır. Dosya temizliği bunun ardından yapılır. Öğenin `completed` olması revision dosyalarının kaldırıldığını belirtir. `pending_cleanup` dönerse aynı gövdeyi tekrar gönderin; çağrı en fazla 25 revision temizler. Alternatif olarak aşağıdaki keşif/devam API’sini kullanın. Başarılı diğer öğeler tekrar silinmez; engellenen öğeler kendi hata nedenini taşır. Temizlik sırasında bağlantı kapanırsa durable kayıtlar kalır. Bekleyen kayıtlar web ekranından veya keşif API’sinden yeniden bulunabilir.

Linux'ta kökten başlayarak her dizin adımı file descriptor ile sabitlenir; recursive path-only silme kullanılmaz. Yollar tenant, skill ve revision kimliğiyle eşleşmelidir. Yönlendirilmiş revision kökü temizliği engeller; alt dizinlerdeki symlink hedefleri takip edilmez. macOS/Windows eşdeğer güvenli adapter henüz hazır olmadığından bu platformlarda metadata silinmeden `safe_delete_unavailable` döner.

Kalıcı silinen kimlik için restore yoktur. Audit/receipt/tombstone metadata'sı tekrar güvenliği için kalır. Önceki backup'lar ve dışa aktarılmış kopyalar bu işlemle silinmez; kullanıcı/secret erasure ve backup retention ayrı işletim kapsamıdır.

### Bekleyen dosyaları yeniden bulma

Bakım ekranında **Kalıcı silmeyi incele** seçimi, revision sayısını ve geri alınamaz etkisini gösterir. Uygulama ayrı düğmeyle başlatılır. **Bekleyen dosya temizliği** listesi sunucudan yeniden yüklenir; sayfa yenilense veya işlemi başka yönetici devralırsa korunur. **Temizliği sürdür** yalnız önceden silinmesine karar verilmiş paketin kalan dosyalarını temizler. Hata durumunda kayıt listede kalır.

API: `GET /api/maintenance/deletions?project_ref=...&after=...` en fazla 50 kayıt ve `next` döndürür. `POST /api/maintenance/deletions/resume` gövdesi `project_ref` ve `skill_id` içerir. Kişisel kapsam yalnız sahibine, proje kapsamı yetkili projeye bağlıdır; çalışma alanı temizliğini sürdürmek admin yetkisi gerektirir. Özgün operation body veya kullanıcının tarayıcı depolaması gerekmez. Önceki operation receipt yeniden oynatılırsa güncel dosya durumundan sonuç yenilenir.

Linux SQLite üzerinde dosya temizliği devam ederken Node servisinin `SIGKILL` ile kesilmesi de doğrulanır. Yeniden başlatma sonrası Bekleyen dosya temizliği listesini yenileyip **Temizliği sürdür** eylemini kullanın. Metadata kararı tekrar verilmez; kalan dosyalar temizlenir. Servisin çökmesinden kalmış genel okur/SPR referanslarını toplama işi bundan ayrıdır.

Linux paket okumasında mutlak kökün her bileşeni `/` başlangıcından descriptor üzerinden açılır. Envanter ve seçilmiş dosyalar aynı açık kökten okunur; arada üst dizin taşınıp yerine symlink konulması okumayı yeni hedefe yönlendirmez. İçerik cache edilmez; dosya hash'i ve gerçek envanter her yüklemede denetlenir. Okuma tamamlanınca descriptor'lar kapanır; callback'in başlattığı devam eden okumalar kapanıştan önce beklenir. Linux dışındaki yol için aynı dirfd garantisi verilmez; platform kabulü ayrı doğrulanmalıdır.

Aynı paket sürümünü örtüşen biçimde okuyan istekler yalnız açık kök descriptor'ını paylaşır. Her isteğin yetkisi tekrar kontrol edilir; inventory ve dosya hash'i gerçek dosyadan okunur. İçerik cache edilmez. Son okuyucu bitince kök kapanır; sonraki istek kökü yeniden açıp doğrular. Bu yaşam süresi dışındaki descriptor'lar veya yetki sonuçları saklanmaz.
