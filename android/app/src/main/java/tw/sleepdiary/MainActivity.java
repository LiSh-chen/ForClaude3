package tw.sleepdiary;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import java.io.OutputStream;
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
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    /** 網頁呼叫的原生功能:存檔到「下載」、列印(WebView 本身不支援 a[download] 與 window.print) */
    private class Bridge {
        @JavascriptInterface public boolean saveFile(String name, String mime, String text) {
            try {
                byte[] data = text.getBytes("UTF-8");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream o = getContentResolver().openOutputStream(u)) { o.write(data); }
                    toast("已存到「下載」資料夾:" + name);
                } else { // 舊版 Android:改用分享
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain"); i.putExtra(Intent.EXTRA_SUBJECT, name); i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, name));
                }
                return true;
            } catch (Exception e) { toast("儲存失敗:" + e.getMessage()); return false; }
        }
        @JavascriptInterface public void print() {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                pm.print("睡眠日記", web.createPrintDocumentAdapter("睡眠日記"), new PrintAttributes.Builder().build());
            });
        }
        private void toast(String s) { runOnUiThread(() -> Toast.makeText(MainActivity.this, s, Toast.LENGTH_LONG).show()); }
    }

    @Override public void onBackPressed() { moveTaskToBack(true); }
}
