/* 24 小時時間軸:把「在時段上點選活動」換算成睡眠日記欄位(純函式) */
(function (root) {
  'use strict';
  // 時間軸視窗:起床日 D 的前一天 18:00 → D 當天 24:00,共 30 小時、每格 30 分鐘 = 60 格
  var N = 60, START_MIN = 18 * 60, STEP = 30, NIGHT_END = 36; // index 36 = D 12:00,之前視為「前一晚」
  var STATES = ['inbed', 'sleep', 'nap'];                     // 互斥:躺床醒著 / 睡著 / 小睡
  var MARKS = ['caffeine', 'alcohol', 'med', 'light', 'exercise', 'ritual', 'screen', 'meal', 'alarm'];

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function hhmm(min) { min = ((min % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function slotStart(i) { return hhmm(START_MIN + i * STEP); }
  function slotEnd(i) { return hhmm(START_MIN + (i + 1) * STEP); }
  function has(slots, i, k) { return !!slots[i] && slots[i].indexOf(k) >= 0; }

  /** 從 a 到 b(含)塗上 brush;範圍內已全部有該活動則取消;'erase' 清空。 */
  function paint(slots, brush, a, b) {
    var lo = Math.max(0, Math.min(a, b)), hi = Math.min(N - 1, Math.max(a, b)), i;
    if (brush === 'erase') { for (i = lo; i <= hi; i++) delete slots[i]; return slots; }
    var all = true;
    for (i = lo; i <= hi; i++) if (!has(slots, i, brush)) all = false;
    for (i = lo; i <= hi; i++) {
      var cur = (slots[i] || []).slice();
      if (all) cur = cur.filter(function (k) { return k !== brush; });
      else {
        if (STATES.indexOf(brush) >= 0) cur = cur.filter(function (k) { return STATES.indexOf(k) < 0; });
        if (cur.indexOf(brush) < 0) cur.push(brush);
      }
      if (cur.length) slots[i] = cur; else delete slots[i];
    }
    return slots;
  }

  /** 只新增、不切換(即時計時用):在第 i 格加上 kind;狀態類活動互斥。 */
  function add(slots, kind, i) {
    if (i < 0 || i >= N) return slots;
    var cur = (slots[i] || []).slice();
    if (STATES.indexOf(kind) >= 0) cur = cur.filter(function (k) { return STATES.indexOf(k) < 0; });
    if (cur.indexOf(kind) < 0) cur.push(kind);
    slots[i] = cur;
    return slots;
  }

  function idx(slots, pred) { var r = []; for (var i = 0; i < N; i++) if (slots[i] && pred(i, slots[i])) r.push(i); return r; }
  function runs(list) { // 排序後的 index → 連續區段 [[from,to],...]
    var out = [];
    list.forEach(function (i) {
      var l = out[out.length - 1];
      if (l && i === l[1] + 1) l[1] = i; else out.push([i, i]);
    });
    return out;
  }
  var range = function (r) { return slotStart(r[0]) + '-' + slotEnd(r[1]); };

  /** 時間軸 → 日記欄位。時間軸全空回傳 null(不覆蓋手動輸入)。 */
  function derive(slots) {
    if (!Object.keys(slots).length) return null;
    var out = { bedTime: '', tryTime: '', latencyMin: '', awakenings: '', awakeMin: '', finalWake: '', getUp: '',
      alarm: '否', napCount: '', napMin: '', alcoholLast: '', caffeineLast: '', medTime: '', light: '', exercise: '', ritual: '', screen: '', meal: '' };
    var inBed = idx(slots, function (i, a) { return i < NIGHT_END && (a.indexOf('inbed') >= 0 || a.indexOf('sleep') >= 0); });
    var sleep = idx(slots, function (i) { return i < NIGHT_END && has(slots, i, 'sleep'); });
    if (inBed.length) {
      var first = inBed[0], last = inBed[inBed.length - 1];
      out.bedTime = out.tryTime = slotStart(first);
      out.getUp = slotEnd(last);
      if (sleep.length) {
        var fs = sleep[0], ls = sleep[sleep.length - 1], gaps = [];
        for (var i = fs; i <= ls; i++) if (!has(slots, i, 'sleep')) gaps.push(i);
        var g = runs(gaps);
        out.latencyMin = (fs - first) * STEP;
        out.awakenings = g.length;
        out.awakeMin = gaps.length * STEP;
        out.finalWake = slotEnd(ls);
      }
    }
    if (idx(slots, function (i) { return has(slots, i, 'alarm'); }).length) out.alarm = '是';
    var naps = idx(slots, function (i) { return has(slots, i, 'nap'); });
    if (naps.length) { out.napCount = runs(naps).length; out.napMin = naps.length * STEP; }
    var al = idx(slots, function (i) { return has(slots, i, 'alcohol'); });
    if (al.length) out.alcoholLast = slotEnd(al[al.length - 1]);
    var cf = idx(slots, function (i) { return has(slots, i, 'caffeine'); });
    if (cf.length) out.caffeineLast = slotEnd(cf[cf.length - 1]);
    var md = idx(slots, function (i) { return has(slots, i, 'med'); });
    if (md.length) out.medTime = slotStart(md[0]);
    out.light = runs(idx(slots, function (i) { return has(slots, i, 'light'); })).map(range).join(', ');
    out.ritual = runs(idx(slots, function (i) { return has(slots, i, 'ritual'); })).map(range).join(', ');
    out.screen = runs(idx(slots, function (i) { return has(slots, i, 'screen'); })).map(range).join(', ');
    out.meal = runs(idx(slots, function (i) { return has(slots, i, 'meal'); })).map(range).join(', ');
    out.exercise = runs(idx(slots, function (i) { return has(slots, i, 'exercise'); })).map(range).join(', ');
    return out;
  }

  /** 感測器夜間彙整(summarizeSession 的結果)→ 時間軸格子,dateStr = 起床日 YYYY-MM-DD。 */
  function slotsFromSession(sum, dateStr) {
    var p = dateStr.split('-'), w0 = new Date(+p[0], +p[1] - 1, +p[2] - 1, 18, 0, 0).getTime(), ms = STEP * 60000, slots = {};
    for (var i = 0; i < N; i++) {
      var s = w0 + i * ms, e = s + ms, c = s + ms / 2, st = null;
      if (c >= sum.bedAt && c < sum.tryAt) st = 'inbed';
      else if (c >= sum.tryAt && c < sum.finalWakeAt) {
        st = 'sleep';
        (sum.intervals || []).forEach(function (iv) {
          var ov = Math.min(e, iv.to) - Math.max(s, iv.from);
          if ((c >= iv.from && c < iv.to) || ov >= 10 * 60000) st = 'inbed';
        });
      } else if (c >= sum.finalWakeAt && c < sum.getUpAt) st = 'inbed';
      if (st) slots[i] = [st];
    }
    return slots;
  }

  var api = { N: N, STATES: STATES, MARKS: MARKS, paint: paint, add: add, derive: derive, slotStart: slotStart, slotEnd: slotEnd, slotsFromSession: slotsFromSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SleepTimeline = api;
})(typeof self !== 'undefined' ? self : this);
