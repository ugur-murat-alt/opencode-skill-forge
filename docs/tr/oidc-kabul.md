# Gerçek OIDC ve TLS kabulü

`scripts/oidc-smoke.mjs` yerel Linux üzerinde gerçek Keycloak 26.7.3, Caddy 2.11.4 ve ayrı PostgreSQL test veritabanıyla sunucu profilini çalıştırır. Keycloak ve Caddy imajları doğrulanmış digest'lere sabittir. Bu bir sahte token/issuer testi değildir; Keycloak kullanıcı giriş formu, authorization code ve gerçek imzalı JWT kullanılır.

```sh
bun run build
# CREATE DATABASE yetkili, yalnız test için ayrılmış PostgreSQL bağlantısını ortamda tanımlayın.
node scripts/oidc-smoke.mjs
```

`FORGE_TEST_POSTGRES_URL` zorunludur. Test kendi rastgele isimli DB'sini oluşturup kaldırır. Docker ve OpenSSL gerekir. Yalnız kendi container'larını, geçici kullanıcı/realm dosyalarını, sertifikayı ve Node sürecini yönetir. Test parolaları rastgele üretilir; gerçek kullanıcı hesabına veya sağlayıcı ayarına dokunmaz.

Geçici sertifika yalnız test Node sürecine `NODE_EXTRA_CA_CERTS` ile verilir; HTTP sürücüsü de aynı sertifikayı açıkça doğrular. Sistem güven deposu değiştirilmez ve TLS doğrulaması kapatılmaz. Dinleyiciler host loopback üzerindedir. Test realm dosyası özel 0700 üst dizinde tutulur; bind mount içinde Keycloak UID'sinin okuyabilmesi için dosya okunabilirdir. Test sonunda kaynaklar temizlenir; temizleme başarısızlığı raporu başarısız yapar.

Doğrulanan sözleşmeler:

- HTTPS discovery ve gerçek authorization-code/PKCE girişi.
- Secure/HttpOnly uygulama oturumu ve doğru tenant kimliği.
- CSRF'siz yazmanın reddi; CSRF ile proje oluşturma.
- OIDC access_denied yanıtının 401 olması.
- Sağlayıcının imzaladığı access token'da issuer, audience, süre, subject ve forge scope doğrulaması.
- Bozuk imzanın 401, yabancı tenant'ın 403 ile reddi.
- Aynı gerçek bearer token ile HTTP ZIP paket import; resmi MCP istemcisinde altı araç listesi, immutable revision search/load ve kayıtlı olmayan proje reddi.

Rapor token veya parola içermez; yalnız sonuçları ve claim adlarını içerir. Varsayılan yol `docs/evidence/p03-live-oidc.json`; farklı rapor yolu ilk argümandır. İlk başarısız denemeler ayrı dosyalarda tutulur.

## Keycloak yapılandırma ayrıntıları

İstemcide standart authorization-code akışı ve S256 PKCE açık olmalıdır. Redirect URI uygulamanın HTTPS public origin'i altındaki `/auth/callback` adresidir. Uygulama üyesi `issuer|sub` ile bootstrap edilir; sırf IdP hesabı bulunması tenant üyeliği vermez.

Keycloak realm'i özel scope listesiyle oluşturuluyorsa `profile` scope'u ve access token'a `sub` ekleyen `basic` scope'u korunmalıdır. Testte ilk özel realm access token'a sub eklemedi ve uygulama doğru biçimde token'ı kabul etmedi. [Keycloak 26.7.3 SubMapper](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/protocol/oidc/mappers/SubMapper.java) bunun için `oidc-sub-mapper` sağlar. `forge` scope'undaki audience mapper, uygulamanın public origin'ini access token'ın aud alanına ekler. Uygulama güvenlik kontrollerini sağlayıcıya uydurmak için gevşetmez.

Sağlayıcı reddi veya geçersiz token kimlik hatası olarak 401 döner; eksik forge scope/yetkisiz tenant 403'tür. Ağ ve sağlayıcı altyapı hataları geçerli kimlikmiş gibi kabul edilmez ve bu kimlik hatalarıyla aynı sınıfa zorlanmaz.

Bu kabul gerçek HTTP/TLS protokol sürücüsüyle yapılır. Native tarayıcı kullanıcı deneyimi, Codex/Claude/ChatGPT oturumu, dış internetten erişim, tüm Compose servislerinin birlikte dağıtımı veya üretim hesabı kabulü değildir. Bu ayrı kabul maddeleri açık kalır.
