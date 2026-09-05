# Öğrenme kayıtlarını yönetme

Prompt Editor sayfasındaki dersler yalnız sahibi olan kullanıcı ve yetkili proje/kapsam için görünür. Kişisel dersler kullanıcının yetkili projelerinde seçilebilir; başka kullanıcının dersleri listelenmez.

- **Düzenle** metni ve ilgili sözcükleri değiştirir. Etkin/devre dışı durumu korunur. Başka bir işlem aynı dersi değiştirmişse eski formun kaydı 409 hatasıyla durur; güncel kaydı yükleyip yeniden düzenleyin.
- **Devre dışı bırak** kaydı ve geçmişi korur; dersin sonraki prompt hazırlamalarında seçilmesini engeller. **Etkinleştir** yeniden seçilebilir yapar. Önceden kabul edilmiş bir işin immutable bağlamını değiştirmez.
- **Geçmiş** en son 20 sürümü, metin, ilgili sözcükler ve etkinlik durumuyla gösterir. Daha eski sürümler saklama sınırında kaldırılır.
- **Sil** dersi ve onun sürüm geçmişini kaldırır. Aynı içerik tekrar kaydedildiğinde mevcut kayıt varsa onun kimliği döner; otomatik yeni sürüm veya yeni kopya oluşturulmaz.

Etkin ders metni en fazla 5.000, ilgili sözcükler en fazla 200 karakterdir. Sır ve host yolu içeren dersler reddedilir. Retrieval ilgili en fazla üç dersi seçer ve her birinden en fazla 500 karakter alır. Kaydetme/düzenleme sıradan API değişiklikleri olup gerçek model çağrısı gerektirmez.

Bu sürüm geçmişi yeni etkin öğrenme kayıtları içindir. Eski OpenCode `learn.md` verisi açık kişisel eşlemeyle aktarılabilir; komut ve sınırlamalar `eski-veri-kesfi.md` belgesindedir. Arayüzün varlığı kullanıcının eski verisinin otomatik taşındığı anlamına gelmez.
