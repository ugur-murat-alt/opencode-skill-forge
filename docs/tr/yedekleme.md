# SQLite ve PostgreSQL yedekleme

Yerel profil için Node CLI tutarlı SQLite snapshot alır. Servis açık kalabilir; DB snapshot'ından sonra eklenen işlemler bu yedeğe dahil değildir.

```sh
skill-forge backup --data-dir /veri/skill-forge --output /yedek/forge-2026-09-05
skill-forge restore --data-dir /yedek/forge-2026-09-05 --output /veri/forge-kurtarma
skill-forge serve --data-dir /veri/forge-kurtarma
```

Hedefin üst dizini mevcut, hedefin kendisi yeni olmalıdır. Kaynağın içine yedek oluşturulmaz. Var olan hedef asla üzerine yazılarak restore edilmez. Hata halinde yalnız komutun oluşturduğu eksik hedef temizlenir. Symlink ve hardlink dosyalar reddedilir.

Yedek, `local.sqlite` snapshot'ı, DB'nin başvurduğu bütün paket revision dosyaları, provider geçmişindeki referans verilen şifreli sırlar ve master key, tamamlanmış execution artifact'ları, istemci kurulum kurtarma kayıtları ve varsa `policy.json` içerir. Bağımlılık cache'leri, staging, sandbox paket kopyaları ve daemon logları dahil değildir. Kurulum kayıtları dış projelerdeki istemci dosyalarının anlık yedeği değildir; bu proje dosyalarını ayrıca koruyun.

`backup.json` tamamlanma envanteridir; her dosyanın SHA-256 değeri ve byte sayısı bulunur. SQLite integrity/FK, revision içerik hash'leri ve sırların çözülmesi denetlenir. Eksik artifact veya paket varsa komut başarısız olur. Varsayılan üst sınırlar: DB 1 GiB, tek diğer dosya 128 MiB, veri toplamı 10 GiB, 100.000 dosya. Daha büyük veri için başarı iddiası yerine hata verilir.

Restore aynı ürün sürümünü gerektirir, envanteri ve DB referanslarını yeniden doğrular. Eski web/device/pairing oturumları iptal edilir ve yeni owner-token üretilir. İstemcileri yeni servis adresi/kimliği ile tekrar bağlayın. OIDC kimlikleri ve kullanıcı/proje kayıtları korunur; dış OIDC sağlayıcısının yapılandırması yedeğe dahil değildir.

Yedek özel dizin (0700) ve dosyalar (0600) kullanır. Master key de bulunduğu için yedeğe erişen kişi provider sırlarını çözebilir. Depolama ortamını şifreleyin; bu format kendi başına şifreli arşiv veya imzalı dış kaynak formatı değildir. Windows'ta POSIX mode yerine hedef disk ACL'sini işletim ortamınızda uygulayın.

Silinen kullanıcı veya secret eski yedekte kalabilir. Eski yedeği restore etmek bu veriyi tekrar getirir. Operatör, belirlediği saklama süresinde eski yedekleri ve uzak kopyalarını silmeli; restore sonrası sonradan yapılan kullanıcı/secret silmelerini tekrar uygulamalıdır. Otomatik retention ve silme tombstone aktarımı henüz uygulanmadı. Sürümler arası migration downgrade henüz desteklenmiyor; bu CLI ile doğrulandığı iddia edilmez. P15/K30 bu nedenle açık kalır.

## PostgreSQL sunucu profili

`SKILL_FORGE_POSTGRES_URL` ayarlandığında aynı CLI PostgreSQL modunda çalışır. `backup` için kaynak DB bağlantısı, `restore` için yeni DB oluşturma yetkisi olan bakım bağlantısı kullanılır. URL'yi terminal geçmişine veya belgeye yazmak yerine mevcut secret yönetiminizden ortam değişkenine verin.

```sh
skill-forge backup --data-dir /veri/forge --output /yedek/forge-pg
skill-forge restore --data-dir /yedek/forge-pg --output /veri/forge-kurtarma --database-name forge_recovered
```

Restore var olan veritabanını reddeder. Başarılı sonuçtaki yeni DB adını servis bağlantınızda kullanın. Komut mevcut servisin bağlantısını değiştirmez. Dump bütün uygulama DB'sini kapsar; küme rolleri/tablespace ve dış OIDC yapılandırması ayrı işletim verileridir. Geri yüklenen nesneler restore kullanıcısına ait olur, eski nesne ACL'leri taşınmaz; servis rolünün DB erişimini işletim politikanıza göre verin.

Hostta sunucuyla uyumlu `pg_dump` ve `pg_restore` bulunmalıdır. Farklı sürüm yolu için `SKILL_FORGE_PG_DUMP` ve `SKILL_FORGE_PG_RESTORE` tam executable yolu verilebilir; shell komut metni verilmez. On dakikalık araç süresi sınırı vardır. Araç hatası/uyarısı başarı sayılmaz. URL bağlantı bilgileri argv yerine libpq ortam değişkenleriyle aktarılır. Desteklenen URL seçenekleri: sslmode, sslrootcert, sslcert, sslkey, channel_binding, application_name; bilinmeyen seçenek reddedilir.

DB referansları ile `pg_dump --snapshot` aynı export edilmiş repeatable-read snapshot kullanır. PostgreSQL restore tek transaction ile çalışır; sonrasında paket hash'leri ve şifreli sırlar doğrulanır. Başarısız restore yalnız bu çağrının oluşturduğu DB ve veri dizinini temizler. Kaynak yedek korunur. Yalnız kendi güvenilir yedeklerinizi restore edin: PostgreSQL dump restore işlemi SQL nesnelerini oluşturur, dış kaynaktan gelen arşiv salt veri formatı değildir.

Gerçek PostgreSQL 17 testinde dump/restore, paket ve sır okuma, oturum iptali, mevcut DB reddi, bozuk envanter ve DB revision uyuşmazlığı sonrası yeni DB'nin temizlenmesi denetlenir. Bu test bütün Compose dağıtımı veya sürümler arası downgrade kabulü değildir.

Teknik sözleşme için PostgreSQL'in [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) ve [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) belgeleri kullanıldı.

## Backup sırasında revision koruması

Backup, snapshot revision listesini kaynak DB'deki geçici FK okur kayıtlarıyla korur. Bu nedenle kaynak bağlantısı yalnız SELECT değil, ilgili koruma kayıtlarını ekleme/silme yetkisine de sahip olmalıdır; PostgreSQL'de tenant kilidi için UPDATE yetkisi de gerekir. İşletim hesabını kullanın. Kaynak paket içeriği değiştirilmez.

Kayıtlar snapshot alındıktan sonra oluşturulur; backup kendi kayıtlarını dump'a eklemez. Copy/hash denetimi sonunda veya hatada yalnız bu çağrının reader ID'leri silinir. Başka okurların kayıtları korunur. Snapshot'tan sonra ancak referans alınmadan önce bir revision silinmişse kapsam küçültülmez, backup başarısız olur.

Restore yeni DB ve yeni veri dizinine yapıldığı için snapshot'taki eski genel okur kayıtları hedefte temizlenir. Kaynak servis üzerindeki okurlar etkilenmez. Execution/SPR pin'leri bu adımla kaldırılmaz. DB/process çökmesi yüzünden kaynakta kalan backup reader kayıtlarının kontrollü temizliği henüz açık bir işletim işidir; süre doldu diye yaşayan okuyucu varsayılarak silinmez.
