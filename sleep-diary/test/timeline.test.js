const assert = require('assert');
const T = require('../timeline.js');
const { summarizeSession } = require('../flip.js');
const at = (h, m) => { // 時間 → slot index(18:00 起算)
  const mins = ((h * 60 + m - 18 * 60) + 1440) % 1440; return mins / 30;
};

let s = {};
T.paint(s, 'inbed', at(23, 0), at(23, 0));           // 23:00 躺床醒著
T.paint(s, 'sleep', at(23, 30), at(2, 0));           // 23:30–02:30 睡
T.paint(s, 'sleep', at(3, 0), at(6, 30));            // 02:30–03:00 醒(缺口)→ 03:00–07:00 睡
T.paint(s, 'inbed', at(7, 0), at(7, 0));             // 07:00–07:30 醒後賴床
T.paint(s, 'nap', at(14, 0), at(14, 30));  // 下午小睡(當天 14:00–15:00)
T.paint(s, 'caffeine', 4, 4);                         // 咖啡因
T.paint(s, 'light', at(7, 0) , at(7, 30));            // 照光
let d = T.derive(s);
assert.strictEqual(d.alarm, '否');
T.paint(s, 'alarm', at(7, 0), at(7, 0)); assert.strictEqual(T.derive(s).alarm, '是');
T.paint(s, 'alarm', at(7, 0), at(7, 0));
assert.strictEqual(d.bedTime, '23:00');
assert.strictEqual(d.latencyMin, 30);                 // 23:00 躺 → 23:30 睡
assert.strictEqual(d.awakenings, 1);
assert.strictEqual(d.awakeMin, 30);
assert.strictEqual(d.finalWake, '07:00');
assert.strictEqual(d.getUp, '07:30');
assert.strictEqual(d.napCount, 1); assert.strictEqual(d.napMin, 60);
assert.strictEqual(d.caffeineLast, '20:30');          // index 4 = 20:00–20:30
assert.strictEqual(d.light, '07:00-08:00');

// 再塗一次同範圍 = 取消;erase 清空;全空回傳 null
T.paint(s, 'caffeine', 4, 4); assert.strictEqual(T.derive(s).caffeineLast, '');
T.paint(s, 'erase', 0, T.N - 1); assert.strictEqual(T.derive(s), null);
// 狀態互斥
let t = {}; T.paint(t, 'inbed', 3, 3); T.paint(t, 'sleep', 3, 3); T.paint(t, 'caffeine', 3, 3);
assert.deepStrictEqual(t[3], ['sleep', 'caffeine']);

// 感測器 session → 格子
const mk = (h, m, day) => new Date(2026, 10, day, h, m).getTime();
const sum = summarizeSession({
  bedAt: mk(23, 0, 20), tryAt: mk(23, 20, 20), outAt: mk(7, 30, 21),
  events: [{ type: 'awake', t: mk(3, 5, 21) }, { type: 'rest', t: mk(3, 25, 21) }, { type: 'awake', t: mk(7, 0, 21) }]
});
const sl = T.slotsFromSession(sum, '2026-11-21');
const d2 = T.derive(sl);
assert.strictEqual(d2.awakenings, 1);                 // 03:05–03:25 的醒來(<30 分)仍保留
assert.strictEqual(d2.finalWake, '07:00');
assert.strictEqual(d2.getUp, '07:30');
// 睡前儀式 + 即時計時用 add(不切換)
let r = {}; T.add(r, 'ritual', 9); T.add(r, 'ritual', 10); T.add(r, 'ritual', 10);
assert.deepStrictEqual(r[10], ['ritual']); assert.strictEqual(T.derive(r).ritual, '22:30-23:30');
T.add(r, 'nap', 3); T.add(r, 'sleep', 3); assert.deepStrictEqual(r[3], ['sleep']);
let u = {}; T.add(u, 'screen', 10); T.add(u, 'meal', 2); T.add(u, 'meal', 3);
assert.strictEqual(T.derive(u).screen, '23:00-23:30'); assert.strictEqual(T.derive(u).meal, '19:00-20:00');
// 精確醒來時段:短暫醒來不會被 30 分鐘格子吃掉
const mm = 60000, w0 = new Date(2026, 10, 24, 18, 0).getTime();
const ivs = [[w0 + 340 * mm, w0 + 343 * mm], [w0 + 430 * mm, w0 + 432 * mm]];   // 3 分 + 2 分
assert.strictEqual(T.slotPos(w0 + 300 * mm, '2026-11-25'), 10);
const base = { awakenings: 0, awakeMin: 0 };
const mg = T.mergeAwake(Object.assign({}, base), ivs);
assert.strictEqual(mg.awakenings, 2); assert.strictEqual(mg.awakeMin, 5);
assert.strictEqual(T.mergeAwake({ awakenings: 3, awakeMin: 90 }, ivs).awakenings, 3);   // 格子反算較大時保留較大者
assert.strictEqual(T.mergeAwake({ awakenings: '', awakeMin: '' }, []).awakenings, '');
// 睡眠效率
{
  // 23:00 躺床、23:30–07:00 睡(7.5h),躺到 07:30 → TIB 8.5h、TST 7.5h → 88%
  const sl = {}; T.paint(sl, 'inbed', 10, 10); T.paint(sl, 'sleep', 11, 25); T.paint(sl, 'inbed', 26, 26);
  const d0 = T.derive(sl);
  assert.strictEqual(d0.tibMin, 510); assert.strictEqual(d0.tstMin, 450); assert.strictEqual(d0.effPct, 88);
  // 併入 4 次短暫醒來(3、2、4、6 分 = 15 分):TST = 450 − 15 = 435 → 85%
  const base0 = new Date(2026, 10, 24, 18, 0).getTime(), M = 60000;
  const iv = [[40, 3], [100, 2], [200, 4], [250, 6]].map(([a, b]) => [base0 + (330 + a) * M, base0 + (330 + a + b) * M]);   // 23:30 後
  const d1 = T.deriveWithAwake(sl, iv, '2026-11-25');
  assert.strictEqual(d1.awakenings, 4); assert.strictEqual(d1.awakeMin, 15);
  assert.strictEqual(d1.tstMin, 435); assert.strictEqual(d1.effPct, 85);
  // 長時間醒來(40 分)已造成格子缺口:不重複計算
  const sl2 = {}; T.paint(sl2, 'inbed', 10, 10); T.paint(sl2, 'sleep', 11, 25); T.paint(sl2, 'inbed', 26, 26); T.paint(sl2, 'inbed', 16, 17);   // 02:00–03:00 兩格缺口
  const w = [[base0 + 480 * M, base0 + 520 * M]];   // 02:00–02:40 精確
  const d2 = T.deriveWithAwake(sl2, w, '2026-11-25');
  assert.strictEqual(d2.awakenings, 1); assert.strictEqual(d2.awakeMin, 40);   // 兩格缺口都被精確的 40 分鐘涵蓋,以精確資料為準
  T.paint(sl2, 'inbed', 22, 22);                                               // 另一個沒被精確資料涵蓋的缺口(+30 分)
  const d2b = T.deriveWithAwake(sl2, w, '2026-11-25');
  assert.strictEqual(d2b.awakenings, 2); assert.strictEqual(d2b.awakeMin, 70);
  // 使用者另外手動加的缺口仍會計入
  const sl3 = {}; T.paint(sl3, 'inbed', 10, 10); T.paint(sl3, 'sleep', 11, 25); T.paint(sl3, 'inbed', 26, 26); T.paint(sl3, 'inbed', 20, 20);
  const d3 = T.deriveWithAwake(sl3, iv, '2026-11-25');
  assert.strictEqual(d3.awakenings, 5); assert.strictEqual(d3.awakeMin, 45);
}
console.log('timeline tests passed');
