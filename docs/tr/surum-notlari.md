# 1.0.0 — İlk bağımsız Skill Forge MCP sürümü

> P22 notu (1.0.0 sonrası, henüz yayımlanmadı): istemci metin hazırlama alt sistemi (hazırlama aracı, Prompt Editor ekranları ve öğrenme kayıtları) üründen kaldırıldı; dış MCP sözleşmesi beş araca indi. Aşağıdaki 1.0.0 açıklaması yayımlanmış sürümü anlatır.

OpenCode'a bağımlı eklenti mimarisinden Node.js üzerinde çalışan bağımsız HTTP/MCP servisine geçildi. Bu kırıcı mimari değişiklik nedeniyle ana sürüm 1'e yükseltildi; dağıtım `latest` kanalındadır. Eski OpenCode eklentisini kullananlar bağımsız servise geçmeden önce `0.5.6` sürümünü açıkça sabitlemelidir.

## Bu sürümde

- Altı MCP aracı, kimlikli web yönetimi ve yerel CLI; proje/kişisel/workspace kapsamları ve ortak yetki kontrolleri.
- SQLite yerel profil, PostgreSQL sunucu profili; kalıcı iş kabulü, işçi kurtarma, lease/fencing ve sabit sürüm referansları.
- Tam skill paketleri, immutable revision, gerçek dosya/hash denetimleri; Docker içinde şemalı script çalıştırma ve doğrulama.
- Bağımsız Prompt Editor ve skill evolution ayarları; editör hatasında özgün isteği koruyan davranış.
- Sağlayıcı ayarları, öğrenme geçmişi, veri import/export, arşivleme/geri alma, referans korumalı silme ve yarıda kalan silmeyi sürdürme.
- SQLite/PostgreSQL yedekleme ve yeni veri dizinine geri yükleme; Türkçe kurulum ve işletim rehberleri.
- Codex/Claude kurulum yardımcıları ve HTTP MCP bağlantısı; gerçek istemci kabulü aşağıdaki sınırlarla değerlendirilmelidir.

## Doğrulama ve kullanım sınırları

Linux x64 / Node.js 24 üzerinde kaynak derlemesi ve gerçek paket kurulumu doğrulanır. Önceki tam fonksiyonel küme 355 test geçti; son paket kökü paylaşımı değişikliğinin 10 odaklı testi geçti. Son tam kümede 355 test geçti, PostgreSQL gerçek sandbox testi bir kez 30 saniyede zaman aşımına uğradı; ayrı tekrarında iki veritabanı testi geçti. Süre eşiği yükseltilmedi. Kullanıcı isteğiyle ikinci tam tekrar ve ileri ölçek çalışmaları durduruldu.

100 istek/s sürekli katalog yükünde 250 ms p95 hedefi henüz sağlanmadı. Bu sürüm 1000 kullanıcı kapasitesi veya üretim SLA'sı vaat etmez. Model kalite karşılaştırmaları, dört sağlayıcının canlı tool-call/cancel/usage kabulü, gerçek ChatGPT App ve tüm native istemci senaryoları, macOS/Windows uçtan uca kabulü açık kalır. Kimlikli HTTP MCP/fixture kanıtları bu platformların canlı kabulü yerine sayılmaz.

Mevcut kullanıcı verisi otomatik taşınmaz veya silinmez. Eski veriler için belgelenmiş import akışını kullanın. Yedek geri yükleme yeni hedef ister; otomatik retention ve sürümler arası downgrade kabulü henüz tamamlanmamıştır.

## Başlangıç

```sh
npm install -g @vaur94/opencode2-skill-forge@latest
skill-forge login
```

Node.js 24 gerekir. Script özellikleri için Docker gerekir; host shell fallback yoktur. Giriş sonrasında proje oluşturun, model profilini ayarlayın ve istemci kurulum sayfasını kullanın. Ayrıntılar depo README'sinde ve Türkçe rehberlerdedir.
