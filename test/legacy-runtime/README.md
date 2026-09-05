# Eski OpenCode karakterizasyon kaynakları

Bu alan eski wrapper, core seçenekleri/handoff ve prompt-editor host hook/session/persist uygulamasını yalnız regresyon testleri için korur. Yeni ürünün giriş noktası `src/index.ts`, CLI girişi `src/cli/main.ts` dosyasıdır. Bu alan üretim paketine girmez ve OpenCode kalıcı istemci adaptörü değildir.

Testler `test/prompt-editor/` ve kök `test/*.test.ts` içindedir. Typecheck bu kaynakları kapsamaya devam eder. Byte-identical çekirdek/politika fixture ve hash manifesti ayrı `test/fixtures/legacy/` alanındadır; onları bu kaynak refactor'u için değiştirmeyin.

Sanitizasyon testi yeni ürünün `src/prompt/sanitize.ts` fonksiyonunu kullanır. Böylece geçmiş sır sızıntısı/truncation senaryoları üretimde kullanılan işlevi denetler. Eski host testlerinin geçmesi canlı yeni istemci/model eşdeğerliği kanıtı değildir.
