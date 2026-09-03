# Password Anomaly Detector

Manifest V3 Chrome/Chromium eklentisi, şifre alanındaki tuş vuruşlarından parolayı veya tuş kimliğini saklamadan oturum bazlı davranış verisi toplar.

## Depolama ve gizlilik

- Her şifre alanı oturumu ayrı bir IndexedDB kaydıdır (`password-anomaly-detector` / `sessions`). En yeni 200 kayıt tutulur.
- Her kayıtta tekil `keyHoldDurations` ve `keyTransitionDurations` dizileri, giriş süresi ve silme sayısı bulunur. Ortalama değer veya kullanıcı profili saklanmaz.
- Parola, parola karakterleri, tuş adları/kodları, alan değeri, URL, site adı ya da kullanıcı kimliği toplanmaz.
- Popup'taki **Oturumları dışa aktar** düğmesi, Python eğitim aracına verilebilecek gizlilik-korumalı JSON dosyası indirir. **Yerel verileri sil** tüm IndexedDB oturumlarını temizler.

## Model eğitimi ve tarayıcı çıkarımı

1. Eklentiden oturum JSON'unu dışa aktarın.
2. Eğitim yönergeleri için [`trainer/README.md`](trainer/README.md) dosyasını izleyin.
3. Oluşan modeli `model/isolation_forest.json` olarak yerleştirin.
4. Eklentiyi `chrome://extensions` üzerinden yeniden yükleyin.

`trainer/train.py`, SQLite veritabanından ham oturumları alır, `scikit-learn` Isolation Forest eğitir ve ağaçların eşik/dal/yaprak yapısını JSON'a aktarır. Eklenti bu JSON'u yükler; JavaScript yalnızca aynı özellik şemasını çıkarır ve inference yapar. Eğitimli model yoksa oturumlar yine kaydedilir, ancak skorlanmaz.

## Yerelde yükleme

1. Chrome veya Chromium tabanlı tarayıcıda `chrome://extensions` açın.
2. **Geliştirici modu**nu etkinleştirin.
3. **Paketlenmemiş öğe yükle**yi seçip bu klasörü gösterin.
