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
      alarm: '否', napCount: '', napMin: '', alcoholLast: '', caffeineLast: '', medTime: '', light: '', exercise: '', ritual: '', screen: '', meal: '', tibMin: '', spanMin: '', tstMin: '', effPct: '' };
    var inBed = idx(slots, function (i, a) { return i < NIGHT_END && (a.indexOf('inbed') >= 0 || a.indexOf('sleep') >= 0); });
    var sleep = idx(slots, function (i) { return i < NIGHT_END && has(slots, i, 'sleep'); });
    if (inBed.length) {
      var first = inBed[0], last = inBed[inBed.length - 1];
      out.bedTime = out.tryTime = slotStart(first);
      out.getUp = slotEnd(last);
      out.tibMin = (last - first + 1) * STEP;                  // 在床時間 TIB:躺上床 → 起床
      if (sleep.length) {
        var fs = sleep[0], ls = sleep[sleep.length - 1], gaps = [];
        for (var i = fs; i <= ls; i++) if (!has(slots, i, 'sleep')) gaps.push(i);
        var g = runs(gaps);
        out.latencyMin = (fs - first) * STEP;
        out.awakenings = g.length;
        out.awakeMin = gaps.length * STEP;
        out.finalWake = slotEnd(ls);
        out.spanMin = (ls - fs + 1) * STEP;                    // 第一次睡著 → 最後醒來
        out.tstMin = sleep.length * STEP;                      // 實際睡著時間 TST
        out.effPct = Math.round(100 * out.tstMin / out.tibMin);   // 睡眠效率 = TST ÷ TIB
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
          if ((c >= iv.from && c < iv.to) || ov >= 20 * 60000) st = 'inbed';   // 短暫醒來由精確資料呈現
        });
      } else if (c >= sum.finalWakeAt && c < sum.getUpAt) st = 'inbed';
      if (st) slots[i] = [st];
    }
    return slots;
  }

  /** 時間戳 → 時間軸上的小數格位置(0 = 前一天 18:00,60 = 當天 24:00),dateStr = 起床日。 */
  function slotPos(ms, dateStr) {
    var p = dateStr.split('-'), w0 = new Date(+p[0], +p[1] - 1, +p[2] - 1, 18, 0, 0).getTime();
    return (ms - w0) / (STEP * 60000);
  }

  /** 精確的醒來時段 [[fromMs,toMs],...] 併入由格子反算的欄位:30 分鐘格子會吃掉短暫醒來,所以次數/分鐘取較大者。 */
  function mergeAwake(d, ivs) {
    if (!d || !ivs || !ivs.length) return d;
    var ms = 0; ivs.forEach(function (iv) { ms += Math.max(0, iv[1] - iv[0]); });
    d.awakenings = Math.max(+d.awakenings || 0, ivs.length);
    d.awakeMin = Math.max(+d.awakeMin || 0, Math.max(1, Math.round(ms / 60000)));
    return d;
  }

  /**
   * derive + 精確醒來時段。精確時段所在的格子缺口不重複計算;使用者手動在時鐘上加的缺口仍會計入。
   * 睡眠效率 = (第一次睡著到最後醒來 − 醒來總分鐘) ÷ 在床時間。
   */
  function deriveWithAwake(slots, ivs, dateStr) {
    var d = derive(slots);
    if (!d || !ivs || !ivs.length) return d;
    var sleep = idx(slots, function (i) { return i < NIGHT_END && has(slots, i, 'sleep'); });
    var preciseMs = 0; ivs.forEach(function (iv) { preciseMs += Math.max(0, iv[1] - iv[0]); });
    var remaining = [];
    if (sleep.length) {
      for (var i = sleep[0]; i <= sleep[sleep.length - 1]; i++) {
        if (has(slots, i, 'sleep')) continue;
        var covered = ivs.some(function (iv) { return slotPos(iv[0], dateStr) < i + 1 && Math.max(slotPos(iv[1], dateStr), slotPos(iv[0], dateStr) + 0.01) > i; });
        if (!covered) remaining.push(i);
      }
    }
    d.awakenings = ivs.length + runs(remaining).length;
    d.awakeMin = Math.max(1, Math.round(preciseMs / 60000)) + remaining.length * STEP;
    if (d.spanMin !== '' && d.tibMin !== '') {
      d.tstMin = Math.max(0, d.spanMin - d.awakeMin);
      d.effPct = Math.min(100, Math.round(100 * d.tstMin / d.tibMin));
    }
    return d;
  }

  /**
   * 精確醒來時段 → 要畫在時鐘/橫條上的小段 [[from,to],...](單位:格,小數)。
   * 只保留「該格還不是躺著醒著」的部分(已是橘色的不重複畫),每段最少 0.3 格寬,確保幾分鐘的醒來也看得見。
   */
  function awakeSegments(ivs, dateStr, slots) {
    var out = [];
    (ivs || []).forEach(function (iv) {
      var p0 = slotPos(iv[0], dateStr), p1 = Math.max(slotPos(iv[1], dateStr), p0 + 0.3);
      p0 = Math.max(0, p0); p1 = Math.min(N, p1);
      if (p1 <= p0) return;
      for (var i = Math.floor(p0); i < Math.ceil(p1); i++) {
        if (i < 0 || i >= N || has(slots || {}, i, 'inbed')) continue;
        var a = Math.max(p0, i), b = Math.min(p1, i + 1);
        if (b - a > 0.001) out.push([a, b]);
      }
    });
    return out;
  }

  var api = { awakeSegments: awakeSegments, slotPos: slotPos, mergeAwake: mergeAwake, deriveWithAwake: deriveWithAwake, N: N, STATES: STATES, MARKS: MARKS, paint: paint, add: add, derive: derive, slotStart: slotStart, slotEnd: slotEnd, slotsFromSession: slotsFromSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SleepTimeline = api;
})(typeof self !== 'undefined' ? self : this);
