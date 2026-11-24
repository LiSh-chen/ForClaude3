package tw.sleepdiary;

import java.util.ArrayList;
import java.util.List;

/** 無需 JUnit:javac 編譯後 java tw.sleepdiary.FlipLogicTest 執行。 */
public class FlipLogicTest {
    static void check(boolean ok, String msg) { if (!ok) throw new AssertionError(msg); }

    /** 以 5Hz(SENSOR_DELAY_NORMAL 約略)餵入固定 z,回傳期間事件 */
    static List<FlipLogic.Event> run(FlipLogic d, long t0, int secs, double z) {
        List<FlipLogic.Event> out = new ArrayList<>();
        for (long t = t0; t < t0 + secs * 1000L; t += 200) { FlipLogic.Event e = d.feed(t, z); if (e != null) out.add(e); }
        return out;
    }

    public static void main(String[] a) {
        for (int sign : new int[]{1, -1}) {
            FlipLogic d = new FlipLogic();
            long t = 0;
            check(run(d, t, 1, sign * 3.0).isEmpty() && !d.armed(), "傾斜時不應就緒");
            t = 1000;
            check(run(d, t, 1, sign * 9.8).isEmpty() && !d.armed(), "放平 1 秒尚未就緒");
            t = 2000;
            check(run(d, t, 3, sign * 9.8).isEmpty() && d.armed() && d.restSign == sign, "放平 2 秒後就緒,基準=當時朝向");
            t = 5000;
            check(run(d, t, 60, sign * 9.8).isEmpty(), "睡著不動:無事件");
            t = 65000;
            check(run(d, t, 1, -sign * 9.8).isEmpty(), "只翻 1 秒不算");
            check(run(d, t + 1000, 1, sign * 9.8).isEmpty(), "翻回去");
            t = 67000;
            List<FlipLogic.Event> up = run(d, t, 6, -sign * 9.8);
            check(up.size() == 1 && up.get(0).type.equals("awake"), "翻面並停留 → awake");
            check(up.get(0).t >= t && up.get(0).t <= t + 1200, "事件時間回溯到開始穩定處: " + up.get(0).t);
            t += 6000;
            check(run(d, t, 10, 3.0).isEmpty(), "拿起來傾斜不觸發");
            t += 10000;
            List<FlipLogic.Event> back = run(d, t, 6, sign * 9.8);
            check(back.size() == 1 && back.get(0).type.equals("rest"), "翻回 → rest");
        }
        // 還原狀態:已是 awake 時再偵測到 awake 方向不產生重複事件
        FlipLogic r = new FlipLogic(); r.restSign = -1; r.setState("awake");
        check(run(r, 0, 10, 9.8).isEmpty(), "狀態同步後不重複");
        System.out.println("FlipLogic tests passed");
    }
}
