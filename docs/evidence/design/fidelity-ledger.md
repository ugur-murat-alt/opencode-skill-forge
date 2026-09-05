# Görsel karşılaştırma — ara kontrol

5 Eylül 2026 tarihinde `dashboard-concept.png` (1504 × 1046) ve yeniden başlatılmış gerçek servisin `dashboard-current.png` (1264 × 1143, tam sayfa) görüntüleri birlikte özgün boyutta incelendi. Bu kayıt bütün P10 görsel/erişilebilirlik kabulü değildir; viewport genişlikleri farklıdır.

| Alan | Gerçek arayüz gözlemi | Durum |
|---|---|---|
| Sol gezinme | Yaklaşık 244 px beyaz panel, ince sağ sınır, tek satır ikon/metin | Referans yapısı korunuyor |
| Üst çubuk | 64 px, sağda çalışma alanı; ek gerçek proje seçici ve çıkış eylemi | Ürün işlevine uygun fark |
| Etkin sayfa | Sol teal çizgi, soluk teal arka plan, aynı renk metin/ikon | Referansla uyumlu |
| Tipografi | Paketlenmiş Inter, koyu başlık, gri açıklama; ürün markası monospace | Hiyerarşi korunuyor |
| Ölçüm şeridi | Dört eşit bölüm, ince bölücüler; gerçek veri 0 iş / 1 paket / yapılandırılmadı / bilinmiyor | Sahte ölçüm yok |
| Orta paneller | Solda geniş iş tablosu, sağda istemciler; aynı üst hizası | Referans yerleşimi korunuyor |
| Olay alanı | Tam genişlik, gerçek audit satırları ve tarihler | Referanstaki boş durum yerine gerçek veri |
| Eksik yüzey | Referansta 10, uygulamada 9 gezinme öğesi; benchmark henüz yok | Açık P10/P12 işi |
| İçerik yüksekliği | Gerçek olaylar nedeniyle tam sayfa daha uzun; yatay taşma görünmedi | Dar ekran/klavye kapsamlı kabulü açık |

`package-browser.png` gerçek referans revision karşılaştırması ve Docker script sonucu (`7.5 → 15`) içerir. `maintenance-browser.png` gerçek archive/restore işlem sonucudur; sonraki saklama paneli eklenmeden alınmıştır. Görsellerdeki paket açıkça kabul deneyi fixture'ıdır; canlı model kalitesi veya gerçek kullanım iddiası değildir.
