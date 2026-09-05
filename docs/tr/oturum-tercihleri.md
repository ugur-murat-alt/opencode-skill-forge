# Oturuma özgü Prompt Editor tercihleri

Oturum tercihi, transporttan çözülen kullanıcıya ve açık proje/istemci/oturum üçlüsüne bağlıdır. İstemcinin `source` alanı kimlik veya proje yetkisi vermez. Bir Codex oturumunun tercihi, aynı isimli Claude oturumunu veya başka projeyi değiştirmez.

`forge_prepare` isteğine isteğe bağlı kaynak eklenebilir:

```json
{"project_ref":"proje-kimligi","original":"Özgün istek","idempotency_key":"istek-kimligi","source":{"client":"codex","session":"istemci-oturum-kimligi"},"wait_ms":10000}
```

Mevcut source'suz çağrılar proje/kişisel ayarları kullanmayı sürdürür. Codex ve Claude yerel hook'ları `session_id` varsa bu bilgiyi taşır. Kaynak, idempotency girdisinin parçasıdır; aynı anahtarla farklı oturum göndermek çakışma üretir.

Yetkili HTTP API:

- `GET /api/settings/session?project_ref=...&client=...&session=...` güncel revision ve açık değerleri döndürür. Kayıt yoksa revision=0 ve values={} gelir.
- `PUT /api/settings/session` aşağıdaki gövdeyi kabul eder. Cookie oturumunda mevcut CSRF başlığı da gereklidir.

```json
{"project_ref":"proje-kimligi","source":{"client":"codex","session":"istemci-oturum-kimligi"},"base_revision":0,"values":{"promptEnabled":false,"autoApply":false}}
```

Yalnız `promptEnabled` ve `autoApply` oturum düzeyinde yazılabilir. Boş values, o oturumun özel değerlerini kaldırarak üst kapsamların geçerli değerlerine dönmeyi sağlar; revision artar. Stale revision 409 ile reddedilir. Kullanıcı başına en fazla 10.000 tercih saklanır.

Kuyruk kabulü bu tercihleri effective ayarlara uygular ve revision ile birlikte immutable config snapshot'a yazar. Daha sonra değişen tercihler yalnız yeni kabul edilen işleri etkiler. Eski `session-flags.json` kayıtlarını bütün projeye taşımak bu API'nin amacı değildir; eski-yeni oturum eşlemesi yapan `migration-import` sessions seçimi `eski-veri-kesfi.md` belgesinde açıklanmıştır. Bu API native istemcinin oturum sonu veya mesaj gönderme olayının çalıştığına tek başına kanıt değildir.
