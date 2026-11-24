package tw.sleepdiary;

/**
 * 翻面偵測(純 Java,與網頁版 flip.js 同一套邏輯)。
 * 先「放平穩定 ARM_MS」把當時的朝向定為基準(rest = 睡覺中);之後翻到另一面並穩定
 * HOLD_MS = awake,翻回來 = rest。事件時間回溯到「開始穩定」的那一刻。
 */
public class FlipLogic {
    public static final double THRESHOLD = 6.5;   // m/s²,|z| 超過才算放平
    public static final long HOLD_MS = 2500;      // 翻面後需穩定停留
    public static final long ARM_MS = 2000;       // 放平穩定多久才就緒
    public static final double ALPHA = 0.3;       // 低通濾波

    public static final class Event {
        public final String type; public final long t;
        public Event(String type, long t) { this.type = type; this.t = t; }
    }

    public int restSign = 0;                      // 0 = 尚未就緒;+1 / -1 = 基準朝向的 z 正負號
    public String state = "rest";
    private Double smoothed = null;
    private String cand = null; private long candSince = 0;
    private long flatSince = -1;

    /** 手動標記或還原狀態時同步目前狀態,避免重複事件。 */
    public void setState(String s) { state = s; cand = null; }

    public boolean armed() { return restSign != 0; }

    public Event feed(long t, double z) {
        smoothed = smoothed == null ? z : smoothed + ALPHA * (z - smoothed);
        if (restSign == 0) {                      // 尚未就緒:等手機放平穩定
            if (Math.abs(z) >= THRESHOLD) {
                if (flatSince < 0) flatSince = t;
                if (t - flatSince >= ARM_MS) { restSign = z > 0 ? 1 : -1; flatSince = -1; cand = null; }
            } else flatSince = -1;
            return null;
        }
        String o;
        if (Math.abs(smoothed) < THRESHOLD) o = "tilted";
        else o = ((smoothed > 0 ? 1 : -1) == restSign) ? "rest" : "awake";
        if (o.equals("tilted") || o.equals(state)) { cand = null; return null; }
        if (cand == null || !cand.equals(o)) { cand = o; candSince = t; return null; }
        if (t - candSince >= HOLD_MS) {
            Event ev = new Event(o, candSince);
            state = o; cand = null;
            return ev;
        }
        return null;
    }
}
