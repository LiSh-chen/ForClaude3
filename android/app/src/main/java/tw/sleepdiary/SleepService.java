package tw.sleepdiary;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * 夜間背景偵測:前景服務 + 部分喚醒鎖,螢幕關閉也持續讀加速度計,偵測到翻面就寫入 SleepStore。
 * 被系統回收後 START_STICKY 會自動重啟並從 SleepStore 還原狀態。
 */
public class SleepService extends Service implements SensorEventListener {
    static final String CHANNEL = "sleep_night";
    static final int NOTIF_ID = 42;
    static volatile SleepService instance;

    private final FlipLogic logic = new FlipLogic();
    private final Handler main = new Handler(Looper.getMainLooper());
    private SensorManager sm;
    private PowerManager.WakeLock wl;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        // 夜間狀態已由橋接層(MainActivity.Bridge.startNight)同步寫入 SleepStore;被系統重啟(intent == null)時若已結束就停止
        if (!SleepStore.running(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        logic.restSign = SleepStore.restSign(this);
        logic.setState("awake".equals(SleepStore.lastType(this)) ? "awake" : "rest");
        startForegroundCompat();
        if (sm == null) {
            sm = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
            Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (acc != null) sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_NORMAL);
        }
        if (wl == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleepdiary:night");
            wl.acquire(14L * 60 * 60 * 1000);               // 最長 14 小時,避免忘了關
        }
        instance = this;
        return START_STICKY;
    }

    @Override public void onSensorChanged(SensorEvent e) {
        FlipLogic.Event ev = logic.feed(System.currentTimeMillis(), e.values[2]);
        if (logic.restSign != SleepStore.restSign(this)) { SleepStore.setRestSign(this, logic.restSign); updateNotification(); }
        if (ev != null && SleepStore.append(this, ev.type, ev.t)) { if (!SleepStore.quiet(this)) buzz(); updateNotification(); }
    }

    @Override public void onAccuracyChanged(Sensor s, int a) {}

    /** 網頁上的手動「我醒了/我再睡了」:同步偵測狀態,避免之後重複記錄 */
    void manual(final String type, final long t) {
        main.post(new Runnable() { public void run() {
            if (SleepStore.append(SleepService.this, type, t)) {
                logic.setState("awake".equals(type) ? "awake" : "rest");
                updateNotification();
            }
        }});
    }

    @Override public void onDestroy() {
        instance = null;
        if (sm != null) sm.unregisterListener(this);
        if (wl != null && wl.isHeld()) wl.release();
        super.onDestroy();
    }

    private void buzz() {
        try {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null) return;
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE));
            else v.vibrate(40);
        } catch (Exception ignored) {}
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        boolean quiet = SleepStore.quiet(this);
        String text = quiet ? (logic.armed() ? "背景記錄中" : "請把手機放平以就緒")
            : (logic.armed() ? "翻面偵測中" : "請把手機放平以就緒") + " · 已記錄醒來 " + SleepStore.awakeCount(this) + " 次";
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(this, CHANNEL);
        else b = new Notification.Builder(this);
        return b.setContentTitle("睡眠記錄中").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setOngoing(true).setShowWhen(false).setContentIntent(pi)
            .setVisibility(Notification.VISIBILITY_SECRET).build();   // 鎖屏上不顯示內容
    }

    private void startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "睡眠記錄", NotificationManager.IMPORTANCE_LOW);
            ch.setSound(null, null); ch.enableVibration(false);
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, buildNotification());
    }

    private void updateNotification() {
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIF_ID, buildNotification());
    }
}
