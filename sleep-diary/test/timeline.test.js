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
console.log('timeline tests passed');
