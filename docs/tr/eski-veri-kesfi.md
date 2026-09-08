# Eski OpenCode verisini salt okunur keşfetme

```sh
node dist/cli.js migration-scan --project /mutlak/proje --output /guvenli/dizin/manifest.json
```

Bu komut daemon başlatmaz, yeni servis veri dizini veya token oluşturmaz. Projenin `.opencode/skills`; kullanıcının `.config/opencode/skills` ve `.opencode/skills` köklerini okur. `--legacy-home` farklı bir home kaynağı seçebilir. Çıktı dosyası yeni olmalı; mevcut dosyanın üzerine yazılmaz. Çıktı eski veri köklerine yazılamaz, symlink üzerinden yönlendirilmiş çıktı üst dizini de gerçek yoluyla kontrol edilir.

Manifest, kaynak kimliği, relative dosya yolları, byte sayısı, SHA-256, hedef kapsam önerisi ve durum sayılarını taşır. Kaynak bytes değiştirilmez. Home kaynakları personal kalır. Sahip, proje ve alan eşlemesi sonraki içe aktarma adımında açıkça yapılmalıdır.

`ready`, paketin mevcut format doğrulamasından geçtiğini belirtir; script davranış testlerinin veya veri içe aktarımının tamamlandığı anlamına gelmez. `review_required`, hatalı paket, legacy script sözleşmesi veya açık sahip/flags eşlemesi gerektiren veriyi belirtir. `unreadable` ayrı kayıttır. Aynı checksum'lı kaynaklar `duplicate_of` ile bağlanır; otomatik silinmez. Aynı kaynak kökündeki case çakışmaları işaretlenir.

Varsayılan tarama sınırı 4.096 girdidir. `--scan-limit 10000` gibi açık bir üst sınır seçilebilir (1–100.000). Okuma toplam byte ve derinlik sınırlarıyla korunur. `truncated: true` veya `partial_limit/not_scanned_limit`, keşfin eksik olduğunu belirtir; tamamlanmış manifest diye kullanılmamalıdır. Canlı eski servis dosyaları değiştirebilir; bu tek atomik disk snapshot'ı değildir. İçe aktarma öncesinde checksum'lar yeniden doğrulanmalıdır.

Örnek sınır genişletilmiş komut:

```sh
node dist/cli.js migration-scan --project /mutlak/proje --scan-limit 10000 --output /guvenli/dizin/manifest-yeni.json
```

Bu ilk komut keşif/dry-run yapar. Seçilen paketlerin aktarımı aşağıdaki ayrı komutla yapılır. Nihai legacy runtime kaldırılması ayrı P14 kabul işidir.

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

Geri alınmış işlem tekrar aktarım komutunda `rolled_back` olarak görünür; otomatik yeniden etkinleştirilmez.
