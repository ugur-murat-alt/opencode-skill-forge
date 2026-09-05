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

| Ölçüm | Kanıtladığı |
|---|---|
| Aramada görünme | Paket servis arama yanıtında yer aldı |
| Yükleme | Sabit sürümün dosya içeriği servis üzerinden okundu |
| Script çalıştırma | Kayıtlı giriş başarıyla tamamlandı |
| Script hatası | Çalıştırma başarısız sonuçlandı |
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
