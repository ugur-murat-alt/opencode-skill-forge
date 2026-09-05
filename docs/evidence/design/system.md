# Web uygulama tasarım sistemi

Referans `dashboard-concept.png` (1504×1046). Yeni akışlar bu sistemle genişler;
tablo/iş/veri henüz yoksa sayıya dönüştürülmez. Konseptteki boş durumlar gerçek API
aynı sonucu döndürdüğünde gösterilir. Konsept sonuç/ürün kanıtı değildir.

- Beyaz arka plan, #182230 metin, #667085 ikincil metin, #e4e7ec sınır;
  #087f8c vurgu. 232px sidebar, 64px üst bar, 32–56px ana içerik boşluğu.
- System sans 14px/1.5 kontroller, 28px/1.2 başlık, 20px bölüm başlığı.
  Ürün adı monospace; font dosyası veya dekoratif görsel zorunlu değil.
- 8px buton radius, 6px alan radius, 1px sınır; odak halkası görünür.
- Açık özet bandı; ana tablo ve dar bağlantı paneli; altında olay listesi.
  Sidebar menü metinleri plan bölüm 13 ile aynı. Basit 20px outline ikonlar.
- Kütüphane editörü/diff, detay/timeline, kurulum matrisi ve ayar formu aynı
  border, tipografi ve padding ailesini kullanır. Rutin akış modal gerektirmez.
- Giriş akışı işlev gereği ayrı ekran: Skill Forge, 'Çalışma alanına giriş',
  'Eşleme kodu', 'Giriş yap', 'Kurumsal hesapla giriş'. Tek kullanımlık kod,
  gerçek cookie oturumu ve hata mesajı. Public UI secret veya metrik içermez.
- Mobilde sidebar aç/kapat, ana içerik tek sütun; tablolar yerel yatay kayar.
- P03 sadece giriş/proje/ayar API'leri doğrulanır. P10 sonunda on yüzey ve
  gerçek browser screenshot konsept karşılaştırması yapılmadan UI tamamlanmaz.
