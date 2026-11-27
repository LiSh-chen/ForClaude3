package tw.sleepdiary;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** 夜間事件的持久儲存(SharedPreferences)。服務、橋接、網頁共用;所有方法同步,服務被系統重啟也不會遺失。 */
final class SleepStore {
    private static final String PREFS = "sleep_native";
    private SleepStore() {}

    private static SharedPreferences p(Context c) { return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static synchronized void begin(Context c, long tryAt, String events, int restSign) {
        String ev = (events == null || events.isEmpty()) ? "[]" : events;
        p(c).edit().putBoolean("running", true).putLong("tryAt", tryAt).putString("events", ev).putInt("restSign", restSign).commit();
    }

    /** 低干擾模式:不震動、通知不顯示醒來次數(由網頁設定同步過來)。預設開啟。 */
    static synchronized void setQuiet(Context c, boolean q) { p(c).edit().putBoolean("quiet", q).commit(); }
    static synchronized boolean quiet(Context c) { return p(c).getBoolean("quiet", true); }

    static synchronized void end(Context c) { p(c).edit().putBoolean("running", false).commit(); }

    static synchronized boolean running(Context c) { return p(c).getBoolean("running", false); }

    static synchronized int restSign(Context c) { return p(c).getInt("restSign", 0); }

    static synchronized void setRestSign(Context c, int s) { p(c).edit().putInt("restSign", s).commit(); }

    static synchronized String lastType(Context c) {
        try {
            JSONArray a = new JSONArray(p(c).getString("events", "[]"));
            return a.length() == 0 ? "rest" : a.getJSONObject(a.length() - 1).getString("type");
        } catch (JSONException e) { return "rest"; }
    }

    static synchronized int awakeCount(Context c) {
        try {
            JSONArray a = new JSONArray(p(c).getString("events", "[]")); int n = 0;
            for (int i = 0; i < a.length(); i++) if ("awake".equals(a.getJSONObject(i).getString("type"))) n++;
            return n;
        } catch (JSONException e) { return 0; }
    }

    /** 加入事件;與上一個狀態相同則忽略(回傳 false)。 */
    static synchronized boolean append(Context c, String type, long t) {
        try {
            JSONArray a = new JSONArray(p(c).getString("events", "[]"));
            String last = a.length() == 0 ? "rest" : a.getJSONObject(a.length() - 1).getString("type");
            if (last.equals(type)) return false;
            JSONObject o = new JSONObject(); o.put("type", type); o.put("t", t);
            a.put(o);
            p(c).edit().putString("events", a.toString()).commit();
            return true;
        } catch (JSONException e) { return false; }
    }

    /** 給網頁:{"running":bool,"alive":服務是否存活,"armed":bool,"restSign":n,"tryAt":ms,"events":[{"type":"awake","t":ms},...]} */
    static synchronized String state(Context c, boolean alive) {
        try {
            SharedPreferences sp = p(c);
            JSONObject o = new JSONObject();
            o.put("running", sp.getBoolean("running", false));
            o.put("alive", alive);
            o.put("restSign", sp.getInt("restSign", 0));
            o.put("armed", sp.getInt("restSign", 0) != 0);
            o.put("tryAt", sp.getLong("tryAt", 0));
            o.put("events", new JSONArray(sp.getString("events", "[]")));
            return o.toString();
        } catch (JSONException e) { return "{\"running\":false,\"alive\":false,\"armed\":false,\"restSign\":0,\"events\":[]}"; }
    }
}
