const assert = require('assert');
const { FlipDetector, summarizeSession } = require('../flip.js');

// 以 50Hz 餵入固定 z 值,回傳期間觸發的事件
function run(det, t0, secs, z) {
  const out = [];
  for (let t = t0; t < t0 + secs * 1000; t += 20) { const e = det.feed(t, z); if (e) out.push(e); }
  return out;
}

for (const sign of [+1, -1]) { // Android / iOS 兩種 z 軸符號
  const d = new FlipDetector({ restSign: sign });
  let t = 0;
  assert.deepStrictEqual(run(d, t, 60, 9.8 * sign), []);               // 睡著:朝下放著,無事件
  t = 60000;
  assert.deepStrictEqual(run(d, t, 1, -9.8 * sign), []);               // 只翻 1 秒(碰撞)不算
  assert.deepStrictEqual(run(d, t + 1000, 1, 9.8 * sign), []);
  t = 62000;
  const up = run(d, t, 5, -9.8 * sign);                                // 翻面並停留
  assert.strictEqual(up.length, 1); assert.strictEqual(up[0].type, 'awake');
  assert.ok(up[0].t >= t && up[0].t <= t + 400);                       // 時間回溯到開始穩定處
  t += 5000;
  const noise = run(d, t, 10, 3);                                      // 拿起來傾斜:不觸發
  assert.deepStrictEqual(noise, []);
  t += 10000;
  const back = run(d, t, 5, 9.8 * sign);
  assert.strictEqual(back.length, 1); assert.strictEqual(back[0].type, 'rest');
}

const min = 60000, T = Date.UTC(2026, 10, 20, 15, 0);
// 兩次中途醒來(10 分 + 20 分),最後一次醒來後沒翻回去
let s = summarizeSession({
  bedAt: T, tryAt: T + 15 * min, outAt: T + 500 * min,
  events: [
    { type: 'awake', t: T + 120 * min }, { type: 'rest', t: T + 130 * min },
    { type: 'awake', t: T + 240 * min }, { type: 'rest', t: T + 260 * min },
    { type: 'awake', t: T + 470 * min }
  ]
});
assert.strictEqual(s.awakenings, 2); assert.strictEqual(s.awakeMin, 30);
assert.strictEqual(s.finalWakeAt, T + 470 * min); assert.strictEqual(s.getUpAt, T + 500 * min);
// 沒有任何翻面:最後醒來 = 按起床的時間
s = summarizeSession({ tryAt: T, outAt: T + 400 * min, events: [] });
assert.strictEqual(s.awakenings, 0); assert.strictEqual(s.finalWakeAt, T + 400 * min);
console.log('flip tests passed');
