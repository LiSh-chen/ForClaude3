package tw.sleepdiary;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.Settings;
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
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

/** 以 WebView 載入打包在 assets/www 的網頁版。https://appassets.androidplatform.net 為安全來源,
 *  感測器與 localStorage 皆可用;夜間翻面偵測由前景服務 SleepService 在背景執行,螢幕可以關閉。 */
public class MainActivity extends Activity {
    private WebView web;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
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
        web.setWebChromeClient(new WebChromeClient() {   // 沒有它,網頁的 alert/confirm 不會顯示(confirm 直接回傳取消)
            @Override public boolean onJsAlert(WebView v, String url, String message, final JsResult r) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton("好", (d, w) -> r.confirm()).setOnCancelListener(d -> r.confirm()).show();
                return true;
            }
            @Override public boolean onJsConfirm(WebView v, String url, String message, final JsResult r) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton("確定", (d, w) -> r.confirm()).setNegativeButton("取消", (d, w) -> r.cancel())
                    .setOnCancelListener(d -> r.cancel()).show();
                return true;
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
        // ---- 夜間背景偵測(前景服務) ----
        @JavascriptInterface public void startNight(final long tryAt, final String events, final int restSign) {
            SleepStore.begin(MainActivity.this, tryAt, events, restSign);   // 同步寫入狀態,網頁立刻讀得到「進行中」
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
                Intent i = new Intent(MainActivity.this, SleepService.class).setAction("start");
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            });
        }
        @JavascriptInterface public String stopNight() {
            String st = SleepStore.state(MainActivity.this, SleepService.instance != null);
            SleepStore.end(MainActivity.this);
            stopService(new Intent(MainActivity.this, SleepService.class));
            return st;
        }
        @JavascriptInterface public void addEvent(String type, long t) {
            SleepService s = SleepService.instance;
            if (s != null) s.manual(type, t); else SleepStore.append(MainActivity.this, type, t);
        }
        @JavascriptInterface public void setQuiet(boolean q) { SleepStore.setQuiet(MainActivity.this, q); }
        @JavascriptInterface public String getState() { return SleepStore.state(MainActivity.this, SleepService.instance != null); }
        @JavascriptInterface public void batterySettings() {
            runOnUiThread(() -> {
                try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                catch (Exception e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
            });
        }
        private void toast(String s) { runOnUiThread(() -> Toast.makeText(MainActivity.this, s, Toast.LENGTH_LONG).show()); }
    }

    @Override public void onBackPressed() { moveTaskToBack(true); }
}
