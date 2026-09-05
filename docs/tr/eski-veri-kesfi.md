# Eski OpenCode verisini salt okunur keşfetme

```sh
node dist/cli.js migration-scan --project /mutlak/proje --output /guvenli/dizin/manifest.json
```

Bu komut daemon başlatmaz, yeni servis veri dizini veya token oluşturmaz. Projenin `.opencode/skills`, `.opencode/.skill-power`; kullanıcının `.config/opencode/skills`, `.opencode/skills` ve ilgili `.skill-power` köklerini okur. `--legacy-home` farklı bir home kaynağı seçebilir. Çıktı dosyası yeni olmalı; mevcut dosyanın üzerine yazılmaz. Çıktı eski veri köklerine yazılamaz, symlink üzerinden yönlendirilmiş çıktı üst dizini de gerçek yoluyla kontrol edilir.

Manifest, kaynak kimliği, relative dosya yolları, byte sayısı, SHA-256, hedef kapsam önerisi, durum ve malformed kayıt sayılarını taşır. Prompt/learn metinleri manifestte gösterilmez. Kaynak bytes değiştirilmez. Home kaynakları personal kalır; prompt-editor learn/rewrites/session-flags ortak çalışma alanına kendiliğinden terfi etmez. Sahip, proje ve alan eşlemesi sonraki içe aktarma adımında açıkça yapılmalıdır.

`ready`, paketin mevcut format doğrulamasından geçtiğini belirtir; script davranış testlerinin veya veri içe aktarımının tamamlandığı anlamına gelmez. `review_required`, hatalı paket, legacy script sözleşmesi, malformed JSON/JSONL veya açık sahip/flags eşlemesi gerektiren veriyi belirtir. `unreadable` ayrı kayıttır. Aynı checksum'lı kaynaklar `duplicate_of` ile bağlanır; otomatik silinmez. Aynı kaynak kökündeki case çakışmaları işaretlenir.

Varsayılan tarama sınırı 4.096 girdidir. `--scan-limit 10000` gibi açık bir üst sınır seçilebilir (1–100.000). Okuma toplam byte ve derinlik sınırlarıyla korunur. `truncated: true` veya `partial_limit/not_scanned_limit`, keşfin eksik olduğunu belirtir; tamamlanmış manifest diye kullanılmamalıdır. Canlı eski servis dosyaları değiştirebilir; bu tek atomik disk snapshot'ı değildir. İçe aktarma öncesinde checksum'lar yeniden doğrulanmalıdır.

Örnek sınır genişletilmiş komut:

```sh
node dist/cli.js migration-scan --project /mutlak/proje --scan-limit 10000 --output /guvenli/dizin/manifest-yeni.json
```

Bu ilk komut keşif/dry-run yapar. Seçilen paketlerin aktarımı aşağıdaki ayrı komutla yapılır. Özel veri türlerinin kapsamları aşağıda açıklanır; nihai legacy runtime kaldırılması ayrı P14 kabul işidir.

Aktarım servisinin ilk sözleşmesi

Paket aktarımı kaynak checksum'u yeniden okur, yeni hedef revision ve aktarım kaydını atomik yazar. Tekrar aynı kaydı döndürür; mevcut paketi otomatik güncellemez. Kapsam, proje, sahip ve üç yönetim bayrağı açık eşlenmelidir. Geri alma yalnız aynı kişinin değişmemiş aktarımını arşivler; özgün kaynak ve immutable revision korunur. Aktarımdan sonra düzenlenmiş veya yönetim bayrağı değiştirilmiş hedef geri alınmaz. Aktarım sırasında taşınan koruma/sabitleme değerleri aynı değişmemiş işlemin geri alınmasını engellemez; genel paket düzenleme korumaları geçerliliğini korur.

Yerel paket aktarımı

Serviste oluşturulmuş hedef projenin kimliğini ve keşif manifestindeki kaynak kimliklerini kullanarak bir eşleme JSON dosyası hazırlayın:

```json
{
  "version": 1,
  "owner": "local-owner",
  "project_ref": "hedef-proje-kimligi",
  "manifest_checksum": "manifestin-64-karakterlik-checksum-degeri",
  "items": [
    {
      "source_id": "paketin-64-karakterlik-source_id-degeri",
      "flags": { "managed": true, "protected": false, "pinned": false }
    }
  ]
}
```

Bayraklar örnektir; kaynağın yönetim/koruma/sabitleme durumunu koruyacak açık değerler girilmelidir. Komut mevcut yerel cihaz sahibini kullanır; kişisel veriyi başka kullanıcıya veya ortak global kapsama taşımaz. `project_ref` mevcut ve yetkili bir proje olmalıdır. Server profilinde bu yerel kimlik komutu reddedilir.

```sh
node dist/cli.js migration-import --data-dir /guvenli/skill-forge --manifest /guvenli/dizin/manifest.json --mapping /guvenli/dizin/esleme.json
```

JSON sonucu her seçilen öğe için `recorded` veya `failed`, hata kodu ve başarılı öğenin `receipt_id` değerini içerir. Bir öğe başarısızsa diğer seçilenler işlenir ve süreç 1 koduyla çıkar; tam başarılı seçimde 0 döner. `source_truncated` keşfin bütünlüğünü ayrı bildirir. Manifestin değişmesi veya yanlış manifest eşlemesi bütün aktarımı durdurur. Kaynakta sonraki içerik değişikliği öğeyi `source_changed` ile reddeder. Scriptler etkin proje sandbox/bağımlılık/ağ politikasına göre gerçek Docker testinden geçmeden yayımlanmaz. Formatı eksik legacy script için sahte `forge.json` üretilmez; hata raporlanır.

Aynı manifest/eşleme tekrar çalıştırıldığında kaydedilmiş işlemler çoğalmaz. Süreç sonuç basmadan kapanırsa aynı komut receipt'leri yeniden döndürür. Kaynak dosyaları silinmez. Geri alma:

```sh
node dist/cli.js migration-rollback --data-dir /guvenli/skill-forge --receipt aktarim-kaydinin-64-karakterlik-kimligi
```

Geri alınmış işlem tekrar aktarım komutunda `rolled_back` olarak görünür; otomatik yeniden etkinleştirilmez. Learn aktarımı aşağıdaki açık eşlemeyle desteklenir. Rewrites ve oturum bayrağı aktarımı aşağıda açıklanır.


Özel learn dosyası aktarımı

Aynı `migration-import` komutunda `learn.md` kaynak öğesi için `flags` yerine şu seçim kullanılır:

```json
{"source_id":"manifestteki-64-karakterlik-kimlik","learning":{"enabled":false}}
```

`enabled` açıkça seçilir. `false` dersleri saklar fakat retrieval'a katmaz; webden etkinleştirilebilir. Proje içindeki eski global learn dosyası dahi sahibinin **kişisel** kapsamına aktarılır. Özgün dosya byte'ları sahip/proje ACL'sine bağlı geçiş arşivinde, checksum ve kayıt raporuyla saklanır. Servis DB yedekleri bu özel metinleri içerir ve özel veri olarak korunmalıdır.

Her tarih başlığı bir kayıttır. En fazla 5.000 karakterlik, sanitizasyon ve sır/yol kontrolünden geçen metin aynen ders olarak saklanır; ilgili sözcükler metindeki sözcüklerden deterministik türetilir. Retrieval en fazla üç ders ve ders başına 500 karakterle sınırlıdır. Aynı içerik varsa mevcut ders korunur, bayrakları değiştirilmez. Hatalı UTF-8/başlık, güvenle kullanılamayan içerik ve etkin ders kapasitesini aşan kayıtlar `review_required` olur; dosya yine eksiksiz saklanır, sonuç kısmi kabul ile exit=1 döner. Arşivlenmiş olması, bütün kayıtların etkinleştirildiği anlamına gelmez.

Özgün dosyayı standart çıktıya byte olarak almak ve aktarımı geri almak:

```sh
node dist/cli.js migration-learning-export --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
node dist/cli.js migration-learning-rollback --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
```

Export checksum'u yeniden doğrular. Geri alma yalnız aktarımın oluşturduğu değişmemiş dersleri kaldırır; önceden var olan duplicate kayıtları ve özgün dosya arşivini korur. Sonradan düzenlenmiş/etkinlik durumu değiştirilmiş ders varsa bütün geri alma transaction'ı durur. Kaynak dosya hiçbir komutta değiştirilmez. Dosya başına 16 MiB, tenant geçiş arşivi için 128 MiB sınırı vardır; kapasite aşımı sessiz silme yapmaz.


Eski rewrite geçmişi

`rewrites.jsonl` kaynak öğesi için seçim şu biçimdedir:

```json
{"source_id":"manifestteki-64-karakterlik-kimlik","rewrites":true}
```

Aynı manifest/eşleme komutu geçerli JSONL kayıtlarını sahibine ve açık hedef projesine bağlı özel geçmişe alır. Bu kayıtlar yeni `runs` oluşturmaz, tüketim veya model kalite kanıtı sayılmaz. Eski `applied` alanı yoksa bilinmiyor olarak korunur; true/false yalnız kaynakta ne kaydedildiğini belirtir. Prompt Editor sayfasında 20 kayıtlık sayfalar, 400 karakterlik önizlemeler ve tam metin açma vardır. Geçmiş kimliğe göre sabit sıralanır; zaman etiketi kaynak zamanını gösterir.

Her kaynak 16 MiB ve 10.000 satır sınırındadır; rewrite arşivi tenant başına 128 MiB ile sınırlıdır. Hatalı satırlar `review_required` ile raporlanır ve komut 1 koduyla çıkar. Kaynak dosyanın tamamı, malformed satırlar ve bilinmeyen ek alanlar dahil byte olarak arşivlenir. Geçerli kayıtların özgün/düzenlenmiş metni kırpılmaz; önizleme tam kaydın yerini almaz. Aynı kayıt birden fazla aktarımda bulunursa referanslar korunur.

```sh
node dist/cli.js migration-rewrites-export --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
node dist/cli.js migration-rewrites-rollback --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
```

Geri alma yalnız seçilen aktarımın referansını kaldırır; başka aktarımın da kullandığı kayıt görünür kalır. Hiçbir etkin aktarım referansı kalmadığında görünür geçmiş kaydı kaldırılır. Özgün arşiv ve kaynak dosya korunur. JSON raporları özel prompt metinlerini içermez; export ve özel geçmiş API'si metin içerir ve sahip/proje yetkisi gerektirir.


Oturum bayrakları aktarımı

`session-flags.json` kaynağı genel proje ayarına çevrilmez. Her eski oturum, aynı sahibin açık hedef proje/istemci/oturumuna eşlenir. Hedef revision'ı `/api/settings/session` üzerinden okuyun; kayıt yoksa 0 kullanılır. Eşleme seçimi:

```json
{
  "source_id":"manifestteki-64-karakterlik-kimlik",
  "sessions":[
    {
      "legacy_session":"eski-oturum-kimligi",
      "target":{"client":"codex","session":"hedef-oturum-kimligi"},
      "base_revision":0,
      "defaults":{"enabled":true,"autoAccept":true}
    }
  ]
}
```

`defaults`, eski kaynak kurulumun eksik alanlarda kullandığı oturum varsayılanlarıdır; açıkça eşlenir. Eski `enabled`, `promptEnabled`; `autoAccept`, `autoApply` olur. Bozuk kayıt eski `readSessionFlags` güvenli davranışına göre otomatik uygulamayı kapatır ve `legacy_safe_fallback_applied` ile review_required raporlanır. Belgenin tamamı bozuksa veya seçilen eski oturum yoksa hedef değiştirilmez. Eski dosyadaki seçilmemiş oturum sayısı `unselected` ile açık gösterilir.

Aynı `migration-import` komutu dosyanın checksum'unu, hedef revision'larını ve sahip/proje yetkisini denetler. Seçimler başına en fazla 1.000 oturum, dosya başına 16 MiB ve bayrak arşivi tenant başına 128 MiB sınırı vardır. Aynı hedef iki kez eşlenemez. Stale hedef review_required olur; diğer geçerli seçimler aynı aktarımda işlenir. Tekrar aynı receipt'i döndürür, ayarları yeniden yazmaz.

```sh
node dist/cli.js migration-flags-export --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
node dist/cli.js migration-flags-rollback --data-dir /guvenli/skill-forge --receipt aktarim-kimligi
```

Export özgün JSON byte'larını checksum denetimiyle verir. Rollback yalnız değişmemiş hedefleri önceki açık değerlere döndürür; revision sayısı artar, eski bir revision yeniden kullanılmaz. Yeni oluşturulmuş tercih geri alınırken boş değerlere dönerek üst kapsamı izler. Bir hedef sonradan değişmişse bütün rollback durur. Kaynak dosya ve özgün özel arşiv korunur. Bu aktarım native istemcide eski bir sohbeti yeniden oluşturmaz.
