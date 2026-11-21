package tw.sleepdiary;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowManager;
import androidx.webkit.WebViewAssetLoader;

/** 以 WebView 載入打包在 assets/www 的網頁版。https://appassets.androidplatform.net 為安全來源,
 *  感測器與 localStorage 皆可用;螢幕在 App 前景時保持開啟(夜間模式純黑)。 */
public class MainActivity extends Activity {
    private WebView web;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this) {
                @Override public WebResourceResponse handle(String path) {
                    return super.handle("www/" + (path.isEmpty() ? "index.html" : path));
                }
            }).build();
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
        });
        setContentView(web);
        web.loadUrl("https://appassets.androidplatform.net/index.html");
    }

    @Override public void onBackPressed() { moveTaskToBack(true); }
}
