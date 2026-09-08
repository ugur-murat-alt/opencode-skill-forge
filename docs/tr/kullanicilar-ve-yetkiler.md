# Kullanıcılar, davetler ve organizasyon yetkileri

**Projeler ve ayarlar** ekranında kurucu veya yönetici, kullanıcıları ve seçili projeye erişimi yönetir. Üyeler 50 kişilik sayfalarda gösterilir. Yazıcı/okuyucu/denetçi bu yönetim API'sini kullanamaz.

| Organizasyon rolü | Erişim                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Kurucu            | Bütün projelere ve yönetim işlemlerine erişir. Kurucu üyeliği bu ekrandan kaldırılamaz veya düşürülemez; devir ayrı akıştır. |
| Yönetici          | Bütün projelere ve yönetim işlemlerine erişir.                                                                               |
| Yazıcı            | Yalnız açık proje üyeliği olan projelere erişir. Proje rolü okuyucu ise yazamaz.                                             |
| Okuyucu           | Yalnız açık proje üyeliği olan projeleri okur. Proje yazıcı rolü çalışma alanı sınırını yükseltmez.                          |
| Denetçi           | Salt okunur; yazma/çalıştırma yapamaz.                                                                                       |
| Devre dışı        | Rolü ne olursa olsun erişemez. Devre dışı bırakmada mevcut oturum ve tokenlar iptal edilir.                                  |

## Kullanıcı tanımlama ve davet

Kurucu/yönetici `POST /api/invitations` ile tek kullanımlık, süreli davet üretir (kurucu rolü davet edilemez). Davet, bekleyen 50 ve saatlik 20 kotasıyla sınırlıdır. Kabul eden hesap belirtilen rolle üye olur; kullanılmış, süresi dolmuş veya iptal edilmiş davet reddedilir. Kabul anındaki rol yeniden doğrulanır; arada değişmiş yetki devralınmaz.

Sunucu profilinde OIDC sağlayıcının tam `issuer|sub` kimliğini (veya GitHub için `github|<id>`) davette subject olarak girin. Bu kayıt bir davet mesajı göndermez, parola üretmez veya harici hesap açmaz. Kullanıcı kendi kimlik sağlayıcısıyla (Google OIDC veya GitHub OAuth) giriş yapar. Yerel profil tek yerel sahip kimliğiyle çalışır; başka subject tanımlamak yerel owner-token'ı ikinci kullanıcı girişine dönüştürmez.

Mevcut subject'i yeniden eklemek mevcut rolünü sessizce değiştirmez. Yeni yazıcı veya okuyucu için seçili projede üyelik tanımlayın. Yönetici rolü seçildiğinde proje erişimi çalışma alanı rolünden gelir.

## Rol → araç matrisi ve özel roller

MCP araç görünürlüğü üyelik rolüne göre filtrelenir; yetkisiz çağrı `tool_denied` ile reddedilir ve hangi rolün hangi araca takıldığı yanıtta açıklanır. Başlangıç matrisi:

| Rol                      | Araçlar                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| Kurucu, Yönetici, Yazıcı | `forge_search`, `forge_load`, `forge_run`, `forge_handoff`, `forge_report` |
| Okuyucu                  | `forge_search`, `forge_load`, `forge_report`                               |
| Denetçi                  | yalnız `forge_report`                                                      |

Kurucu/yönetici `POST /api/roles` ile özel rol tanımlar (`base: reader|writer|admin` + araç alt kümesi); adlar `^[a-z0-9-]{1,64}$`, yerleşik adlar rezerve. `GET /api/roles` etkin tanımları, `DELETE /api/roles/:name` kaldırır, `POST /api/roles/:name/restore` geri yükler: kurucu korunur, üyeli rol önce başka role taşınmadan kalkmaz. Rolü silinmiş/bilinmeyen üyelik fail-closed reddedilir. Kimse kendi yetkisinden üst rol veremez (kurucu devri hariç, o ayrı akıştır). Devre dışı bırakma başka kiracıdaki oturumları da kapatır (güvenli tarafta kalmak için bilinçli tercih).

## Kurucu devri ve organizasyon silme

Devir iki adımlıdır: kurucu alıcı üyeye teklif eder, alıcı kabul eder; roller atomik takas olur (eski kurucu yöneticiye iner). Kendine devir, pasif üyeye devir ve süresi dolmuş teklif reddedilir. Kurucu rolü devredilmeden alınamaz; halefsiz ayrılışta organizasyon kilitli kalır, arka kapı yoktur.

Silme de iki adımlıdır: kurucu organizasyon adını yazarak ister, 24 saat bekleme boyunca yazma işlemleri `tenant_frozen` ile kapanır, süre dolunca ad yeniden doğrulanıp bütün organizasyon verisi silinir. Bekleme içinde vazgeçilebilir. Silme makbuzu yanıtta döner; denetim kaydı organizasyonla birlikte silindiği için makbuz saklanmalıdır.

## Değişiklik ve iptal

Rol, proje üyeliği ve devre dışı durumu **Kaydet** ile birlikte uygulanır. Ekranın okuduğu çalışma alanı ve proje üyelik sürümleri yazma sırasında denetlenir. Başka yönetici değiştirdiyse HTTP 409 gelir; listeyi yenileyip güncel duruma göre karar verin. Eski ekranın üzerine yazma yetkisi yoktur.

Yetki daraltıldığında artık çalıştırma izni olmayan bekleyen/çalışan işler aynı DB işlemi içinde iptal edilir. İşçinin fence değeri geçersizleşir; eski işçi paket yayımlayamaz. Doğrudan çalışan script, yetkiyi 500 ms aralıklarla yeniden kontrol eder; iptal veya yetki kontrolü başarısızlığında sandbox iptal sinyali alır. Script sonucu kaydedilirken üyelik yeniden kilitlenip denetlenir. Yetkisi kaldırılan kullanıcıya başarılı script sonucu teslim edilmez.

İptal edilen iş/çalıştırmanın kimliği ve tekrar kaydı korunur. Erişimi tekrar açmak iptal edilmiş işi kendiliğinden başlatmaz. Aynı script tekrar anahtarı eski başarısız sonucu döndürür; yeni bilinçli çalıştırma yeni anahtar ister. Model sağlayıcının iptal anına kadar oluşan veya raporlamadığı tüketim silinmez.

## API

- `GET /api/members?project_ref=<id>&after=<user_id>`: yetkili yöneticiye en fazla 50 üye ve devam anahtarı.
- `POST /api/members`: `{subject, display_name, role}`; yeni üyelikte `created: true`, mevcut üyelikte `false`.
- `PUT /api/members/:id`: `{project_ref, generation, project_generation, role, disabled, project_role}`. Proje üyeliği yokken `project_generation: null`; kaldırmak için `project_role: null`. Devre dışı bırakma oturumları iptal eder.
- `GET /api/tenants`: oturum sahibinin üye olduğu organizasyonlar ve rolleri.
- `POST /api/organizations`: `{name}`; yeni organizasyon kurar, kurucu yapar.
- `POST /api/invitations`: `{role, ttlMs?}`; `GET /api/invitations` bekleyenler; `POST /api/invitations/:id/revoke` iptal; `POST /api/invitations/accept`: `{token, subject, display_name}` (kimliksiz).
- `POST /api/organization/transfer`, `POST /api/organization/transfer/:id/accept`, `POST /api/organization/deletion/request|confirm|cancel`.

Kurucu erişimi koruması ve eski üyelik sürümü HTTP 409; yetersiz yetki HTTP 403; bulunmayan üye HTTP 404 verir. Modelin veya istemcinin gönderdiği tenant/user iddiası kimlik kaynağı değildir; kimlik mevcut oturumdan çözülür.

## Ayar ve model profili yazımları

Ayar ve model profilini değiştiren işlem, üyelik güncellemesiyle aynı çalışma alanı kilidini kullanır. Güncel yetki ve taban sürümü kilit alındıktan sonra yeniden okunur. Üyelik iptali önce tamamlandıysa bekleyen yazım reddedilir; eski yetki okuması değişikliği kabul ettirmez. Yazım önce tamamlandıysa sonraki iptal ileriye dönük uygulanır.

Aynı model profili tabanından eşzamanlı iki yazım yeni sürümü birlikte oluşturamaz; biri `revision_conflict` alır. `provider.updated` denetim kaydı yalnız rol ve revision içerir. Credential, model içeriği ve sağlayıcı adresi audit kaydına eklenmez.
