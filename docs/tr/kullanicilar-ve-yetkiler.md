# Kullanıcılar ve proje yetkileri

**Projeler ve ayarlar** ekranında çalışma alanı sahibi veya yöneticisi, kullanıcıları ve seçili projeye erişimi yönetir. Üyeler 50 kişilik sayfalarda gösterilir. Görüntüleyici/editör bu yönetim API'sini kullanamaz.

| Çalışma alanı rolü | Erişim                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Sahip              | Bütün projelere ve yönetim işlemlerine erişir. Sahip üyeliği bu ekrandan kaldırılamaz veya düşürülemez. |
| Yönetici           | Bütün projelere ve yönetim işlemlerine erişir.                                                          |
| Editör             | Yalnız açık proje üyeliği olan projelere erişir. Proje rolü görüntüleyici ise yazamaz.                  |
| Görüntüleyici      | Yalnız açık proje üyeliği olan projeleri okur. Proje editör rolü çalışma alanı sınırını yükseltmez.     |
| Devre dışı         | Rolü ne olursa olsun çalışma alanına erişemez. Mevcut oturum ve token aynı yetki kontrolünden geçer.    |

## Kullanıcı tanımlama

Sunucu profilinde OIDC sağlayıcının tam `issuer|sub` kimliğini, görünen adı ve başlangıç rolünü girin. Bu kayıt bir davet mesajı göndermez, parola üretmez veya OIDC hesabı açmaz. Kullanıcı kendi kimlik sağlayıcısıyla giriş yapar. Yerel profil tek yerel sahip kimliğiyle çalışır; başka subject tanımlamak yerel owner-token'ı ikinci kullanıcı girişine dönüştürmez.

Mevcut subject'i yeniden eklemek mevcut rolünü sessizce değiştirmez. Yeni editör veya görüntüleyici için seçili projede üyelik tanımlayın. Yönetici rolü seçildiğinde proje erişimi çalışma alanı rolünden gelir.

## Değişiklik ve iptal

Rol, proje üyeliği ve devre dışı durumu **Kaydet** ile birlikte uygulanır. Ekranın okuduğu çalışma alanı ve proje üyelik sürümleri yazma sırasında denetlenir. Başka yönetici değiştirdiyse HTTP 409 gelir; listeyi yenileyip güncel duruma göre karar verin. Eski ekranın üzerine yazma yetkisi yoktur.

Yetki daraltıldığında artık çalıştırma izni olmayan bekleyen/çalışan işler aynı DB işlemi içinde iptal edilir. İşçinin fence değeri geçersizleşir; eski işçi paket yayımlayamaz. Doğrudan çalışan script, yetkiyi 500 ms aralıklarla yeniden kontrol eder; iptal veya yetki kontrolü başarısızlığında sandbox iptal sinyali alır. Script sonucu kaydedilirken üyelik yeniden kilitlenip denetlenir. Yetkisi kaldırılan kullanıcıya başarılı script sonucu teslim edilmez.

İptal edilen iş/çalıştırmanın kimliği ve tekrar kaydı korunur. Erişimi tekrar açmak iptal edilmiş işi kendiliğinden başlatmaz. Aynı script tekrar anahtarı eski başarısız sonucu döndürür; yeni bilinçli çalıştırma yeni anahtar ister. Model sağlayıcının iptal anına kadar oluşan veya raporlamadığı tüketim silinmez.

## API

- `GET /api/members?project_ref=<id>&after=<user_id>`: yetkili yöneticiye en fazla 50 üye ve devam anahtarı.
- `POST /api/members`: `{subject, display_name, role}`; yeni üyelikte `created: true`, mevcut üyelikte `false`.
- `PUT /api/members/:id`: `{project_ref, generation, project_generation, role, disabled, project_role}`. Proje üyeliği yokken `project_generation: null`; kaldırmak için `project_role: null`.

Sahip erişimi koruması ve eski üyelik sürümü HTTP 409; yetersiz yetki HTTP 403; bulunmayan üye HTTP 404 verir. Modelin veya istemcinin gönderdiği tenant/user iddiası kimlik kaynağı değildir; kimlik mevcut oturumdan çözülür.

## Ayar ve model profili yazımları

Ayar ve model profilini değiştiren işlem, üyelik güncellemesiyle aynı çalışma alanı kilidini kullanır. Güncel yetki ve taban sürümü kilit alındıktan sonra yeniden okunur. Üyelik iptali önce tamamlandıysa bekleyen yazım reddedilir; eski yetki okuması değişikliği kabul ettirmez. Yazım önce tamamlandıysa sonraki iptal ileriye dönük uygulanır.

Aynı model profili tabanından eşzamanlı iki yazım yeni sürümü birlikte oluşturamaz; biri `revision_conflict` alır. `provider.updated` denetim kaydı yalnız rol ve revision içerir. Credential, model içeriği ve sağlayıcı adresi audit kaydına eklenmez.
