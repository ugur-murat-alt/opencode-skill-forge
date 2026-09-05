# Container ve ortak sunucu

Dockerfile yeni servisi kaynaktan derler ve non-root `node` kullanıcısıyla çalıştırır. Son imajda üretim bağımlılıkları vardır; Bun, TypeScript ve native derleme araçları build aşamalarında kalır. Node runtime digest'i v24.20.0, Bun builder digest'i 1.3.14 olarak doğrulanmıştır. Yerel kaynak/CI Node 24.19.0 ile de doğrulanır; engine aralığı Node 24'tür.

```sh
docker build -t skill-forge-local:acceptance .
node scripts/container-smoke.mjs
```

Smoke komutu kendi container ve volume'unu oluşturur, salt okunur kök dosya sistemiyle çalıştırır, readiness bekler, proje oluşturur, SIGTERM ile kapatır, yeniden başlatıp aynı projeyi doğrular ve kendi test kaynaklarını kaldırır. Bu test **yerel profil** içindir; HTTP isteği container içinden yapılır. Yerel profil loopback'e bağlı olduğundan port publish ederek dışarı açılması amaçlanmaz.

## Ortak sunucu ayarları

`deploy/server.env.example` dosyasını depo dışındaki özel bir operator dosyasına kopyalayın. Gerçek PostgreSQL parolası için rastgele hex kullanın; URI içinde aynı değer kullanılır. Dosyayı yalnız operator okuyabilmelidir. Public URL ve OIDC issuer HTTPS olmalıdır. OIDC uygulamasında callback adresi `PUBLIC_URL/auth/callback` olarak kayıtlı olmalıdır.

```sh
docker compose --env-file /ozel/forge.env config --quiet
docker compose --env-file /ozel/forge.env up --build -d
```

Compose PostgreSQL volume'unu ve `/data` servis volume'unu ayrı tutar. PostgreSQL dışarı port yayımlamaz. Servis yalnız host `127.0.0.1:38475` adresine yayımlanır; TLS ters vekili bu adrese bağlanır. Servis container'ı root değildir, kök filesystem salt okunurdur ve capability'leri kaldırılmıştır. `/tmp` sınırlı tmpfs'tir.

Host üzerinde Caddy kullanıyorsanız `deploy/Caddyfile` örneğinde `FORGE_HOST` değerini public DNS adına ayarlayın. `FORGE_PUBLIC_URL` aynı HTTPS origin olmalıdır. Host başlığını farklı bir iç ada çevirmeyin; uygulama public origin'i doğrular. Caddy yapılandırması [resmî reverse_proxy sözleşmesini](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) kullanır. DNS/sertifika ve canlı OIDC girişi ayrıca doğrulanmalıdır.

İlk owner üyeliği gerçek issuer/sub eşlemesiyle operator CLI üzerinden hazırlanır:

```sh
docker compose --env-file /ozel/forge.env exec forge node dist/cli.js bootstrap-server \
  --tenant-id EKIP_KIMLIGI --tenant-name "Ekip" \
  --subject 'https://identity.example.com/realms/forge|GERCEK_SUB' \
  --display-name "Operator"
```

Bu komut OIDC hesabı oluşturmaz; var olan issuer/sub kimliğini servis üyeliğine eşler. Kullanıcı daha sonra web arayüzünde OIDC ile giriş yapar. Yerel owner token veya `login` eşleme kodu ortak sunucu kimliği değildir.

## Health ve kapatma

`/health/live` yalnız `{ "status": "live" }` döndürür. `/health/ready` startup/worker hazırlığı ve DB erişimi sağlandığında ready, aksi halde 503 not_ready döndürür. Bu iki minimal probe kimliksizdir; Host/Origin kontrolü devam eder. Ayrıntılı `/health` ve `/ready` kimlik ister. Docker healthcheck kullanıcı credential'ı taşımaz.

```sh
docker compose --env-file /ozel/forge.env ps
docker compose --env-file /ozel/forge.env stop forge
```

Compose kapanış için 30 saniye verir. Kalıcı veri kaldırılmadan yeniden başlatmak için `up -d` kullanılır. Volume'ları silen `down -v` veriyi kaldırır; normal kapatma komutu değildir.

İmaj güncellemesi için yeni kaynaktan `build` ve `up -d` uygulanır; DB migration'ları servis açılışında çalışır. Eski imaja dönmek DB şemasını kendiliğinden geri almaz. SQLite ve PostgreSQL için DB/revision tutarlılığı denetlenen [backup/restore komutları](yedekleme.md) vardır. Sürümler arası migration rollback kabulü henüz tamamlanmadığından eski imaja dönüş doğrulanmış rollback prosedürü olarak sunulmaz.

## Doğrulanmış kapsam ve açık işler

Gerçek Linux imaj build'i, yerel profilde non-root/read-only çalışma, Docker readiness, kontrollü stop ve volume üzerinden restart doğrulandı. Compose şeması kontrol edildi. Ayrı gerçek Node server + PostgreSQL + Keycloak/Caddy TLS protokol kabulü `oidc-kabul.md` rehberinde açıklanır; bütün Compose servislerinin birlikte canlı dağıtımı henüz doğrulanmadı.

Varsayılan imaja Docker socket bağlanmaz ve Docker CLI kurulmaz. Bu nedenle bu Compose tanımı henüz script sandbox yürütme dağıtımını tamamlamaz; script işi host fallback kullanmaz ve sandbox yokluğunu bildirir. Ayrı güvenli execution worker dağıtımı, tam Compose kabulü, container içinden backup araçlarının işletimi ve upgrade/rollback doğrulaması P15 kapsamında açık kalır. Bu sınırlar tam sunucu teslimi olarak gösterilmez.
