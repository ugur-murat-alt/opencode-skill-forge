# MCP çıktıları ve sayfalama

Dış araçlar altı adla kalır: `forge_search`, `forge_load`, `forge_run`, `forge_prepare`, `forge_handoff`, `forge_report`. MCP cevabı makinece okunabilir JSON'u tek text content alanında taşır; aynı içerik ikinci bir structuredContent kopyasıyla gönderilmez.

## Paket içeriği

`forge_load` varsayılan olarak sabit revision'ın `SKILL.md` dosyasını okur. `path` ile yalnız gereken alt dosyayı isteyin. Metin UTF-8 sınırları korunarak, binary veri base64 ile aktarılır. Bir parça en fazla 24 KiB kaynak byte'ıdır. `next_cursor` varsa aynı sorguya cursor ekleyerek devam edin.

Dosya envanteri ilk özetin ötesine geçiyorsa aynı araçta `inventory: true` kullanın. Bu mod dosya içeriği taşımadan 40 metadata satırı döndürür; `file_count` toplamı, `next_cursor` sonraki sayfayı belirtir. Paket değişse bile bütün çağrılarda aynı revision kullanılmalıdır.

## Script sonucu

`forge_run` sabit revision ve tek idempotency anahtarıyla çalışır. JSON sonucu 8 KiB'ı aşarsa tam sonuç özel bir JSON artifact'ına yazılır. İlk yanıt `result_truncated`, `result_bytes`, `result_artifact_path` ve artifact metadata'sını verir. Kesilme, scriptin ürettiği verinin kaybolması değildir.

Artifact listesi varsayılan 10, en fazla 20 öğe ister. Uzun dosya adları nedeniyle uygulama JSON zarfının yaklaşık 16 KiB sınırına yaklaşılırsa sayfa daha az öğe dönebilir. Bu bir byte sınırıdır; token ölçümü değildir ve JSON-RPC taşıma kaçışlarının toplam byte'ına verilmiş bir garanti değildir.

Sonraki sayfa için:

```json
{
  "project_ref": "<proje>",
  "section": "execution",
  "execution_id": "<çalıştırma>",
  "cursor": "<next_cursor>"
}
```

Bu gövde `forge_report` aracına verilir. Aynı `limit` değerini koruyun. Bir artifact'ın içeriğini okumak için `artifact_reference` ekleyin; sonuç JSON'unu doğrudan okumak için `result_content: true` kullanın. İkisini aynı çağrıda kullanmayın. İçerik modunda `next_cursor` 24 KiB parçalarını sürdürür.

Web kütüphanesindeki script sonucu aynı sayfalama API'sini kullanır. Artifact sayfası değiştirilebilir, indirme bağlantıları yenilenebilir ve büyük JSON bölümler halinde okunabilir.

Yeni biçimde saklanan execution kaydı geçici indirme token'ı yerine kalıcı, özel artifact konumunu saklar. Yetkili tekrar/rapor çağrısı yeni süreli referans üretir. Aynı script anahtarı scripti tekrar çalıştırmaz. Tam artifact indirmesi de kullanıcı/proje yetkisini yeniden denetler; sunucu dizini model çıktısına konmaz.

## İş raporu

İş listesi özel prompt/sonuç gövdesi yerine durum, zaman, deneme, hata ve küçük kullanım/karar özetini verir. Kullanım alanı bilinmiyorsa `null` kalır. `run_id` ile tek ayrıntıda 8 KiB'a kadar sonuç görülebilir; daha büyük sonuç için `result_content: true` ve aynı run_id ile parçalı okuma kullanılır.

Cursor, okunan sonuç hash'ine de bağlıdır. Sonuç bu sırada saklama politikasıyla temizlenirse eski cursor reddedilir; yeni durum baştan okunmalıdır. Süresi dolmuş veya yanlış kapsamlı cursor'ı başka proje, rapor türü veya dosyada kullanmayın.

Eski geliştirme sürümlerindeki inline execution sonuçları da `result_content: true` ile okunabilir. Küçük görünen özet veya yükleme sayısı, görevin kaliteli tamamlandığı ya da skill'in başarıyla uygulandığı anlamına gelmez.
