# Sunucuya veri aktarımı

`POST /api/migrations/import` istemcinin gönderdiği byte'ları işler. Hedef kullanıcı bağlantının kimliğinden çözülür; gövdede user_id veya host dosya yolu kabul edilmez. Proje için yazma yetkisi gerekir. Sunucu profilinde OIDC bearer veya doğrulanmış web oturumu kullanılır; yerel owner token sunucu kimliği yerine geçmez. Cookie ile yazarken `x-forge-csrf` başlığı gerekir.

Öğrenme dosyası örnek gövdesi:

```json
{
  "kind": "learning",
  "project_ref": "yetkili-proje-kimligi",
  "source_id": "kesif-manifestindeki-64-karakterlik-kaynak-kimligi",
  "checksum": "ozgun-dosyanin-sha256-degeri",
  "content_base64": "ozgun-dosya-bytelarinin-base64-degeri",
  "enabled": false
}
```

Desteklenen türler:

| kind     | Ek alanlar                                                    | Gönderilen içerik                                |
| -------- | ------------------------------------------------------------- | ------------------------------------------------ |
| package  | scope: personal veya project; flags: managed/protected/pinned | Tek klasik skill kökü içeren ZIP, en fazla 5 MiB |
| learning | enabled: boolean                                              | Özgün learn.md, en fazla 16 MiB                  |
| rewrites | Ek eşleme alanı yok                                           | Özgün rewrites.jsonl, en fazla 16 MiB            |
| flags    | sessions: eski-yeni oturum eşlemeleri                         | Özgün session-flags.json, en fazla 16 MiB        |

Özel belge türleri kullanıcıya özeldir. Paket scope ve üç bayrak açık verilmelidir. `source_id` keşif kaynağının metadata kimliğidir, dosya okuma yetkisi değildir. Belge checksum'u özgün byte SHA-256 değeridir. Paket checksum'u ZIP hash'i değil, keşif manifestindeki sıralı `{path,bytes,sha256}` dosya dizisinin JSON SHA-256 değeridir; böylece farklı ZIP sıkıştırması aynı paket içeriğini temsil eder.

Base64 canonical ve boyut sınırlarıyla doğrulanır. ZIP açılımı bounded worker içinde, script doğrulaması hedef projenin etkin Docker politikasıyla yapılır. Sunucuda host shell fallback yoktur. Kaynak kökleri istemci makinesinde okunur; sunucu hiçbir `source_root`/path alanını uzaktan açmaz.

Başarılı yanıt receipt_id ve ilgili kayıt raporunu döndürür. Belge raporunda `review_required > 0` varsa HTTP işlemi kaynağı korumuş olabilir, fakat bütün öğeler kullanılabilir duruma gelmemiştir; istemci bunu tam başarı saymamalıdır. Aynı kimlik/proje/kaynak/checksum/eşleme tekrarında receipt döner.

- `POST /api/migrations/{kind}/{receipt_id}/rollback` aynı kullanıcının aktarımını kendi değişim/başka referans korumalarıyla geri alır.
- `GET /api/migrations/{learning|rewrites|flags}/{receipt_id}/original` checksum doğrulanmış özgün byte'ları attachment olarak döndürür.
- Paketler mevcut `/api/skills/{skill_id}/export` yolundan revision belirtilerek dışa aktarılır.

Belge ve oturum eşleme ayrıntıları `eski-veri-kesfi.md` içindedir. Yerel `migration-import` komutu yerel veri dizinine yazar; uzak taşıma aşağıdaki ayrı `migration-upload` komutudur. Bu HTTP sözleşmesi canlı bir harici OIDC sağlayıcısının kurulmuş olduğunu tek başına kanıtlamaz.

Uzak manifest yükleme komutu

`migration-upload` mevcut read-only keşif manifestini ve seçim eşlemesini kullanır. Uzak eşlemede owner değeri `authenticated-user` olmalıdır; hedef kullanıcı bearer token'ın kimliğidir. Diğer package/learning/rewrites/sessions seçim alanları yerel aktarım belgesiyle aynıdır.

```sh
node dist/cli.js migration-upload --server-url https://forge.example.com --tenant-id hedef-tenant --manifest /guvenli/manifest.json --mapping /guvenli/uzak-esleme.json
```

Bearer token, `SKILL_FORGE_REMOTE_TOKEN` ortam değişkeninde mevcut olmalıdır. Token CLI argümanına, manifest veya rapora yazılmaz. Yalnız HTTPS origin kabul edilir; test/yerel servis için localhost/127.0.0.1/::1 HTTP kullanılabilir. URL kullanıcı/parola, path, query veya fragment içeremez. HTTP yönlendirmeleri izlenmez.

Komut yerel daemon/veri dizini oluşturmaz. Yalnız seçilen kaynakları bounded ve symlink reddeden okuyucuyla açar, checksum'u **göndermeden önce** doğrular. Paketler klasik ZIP olarak, belgeler özgün byte'larla gönderilir. Sunucu da içeriği tekrar doğrular. Yanıt en fazla 2 MiB ve beklenen receipt/rapor şemasıyla sınırlıdır; sunucunun rastgele ek yanıt alanları CLI çıktısına taşınmaz.

Aynı komut bağlantı kesilmesi veya yanıtın kaybolması sonrasında tekrar çalıştırılabilir. Her öğenin receipt/replayed/state ve inceleme gerektiren kayıt bilgisi raporlanır; kısmi hata veya review_required varsa exit=1 döner. Seçilmemiş kaynaklar aktarılmaz; source_truncated keşfin eksikliğini ayrıca gösterir. Başarılı seçimin sonucu bütün eski verinin taşındığı anlamına gelmez.
