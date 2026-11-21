/* 翻面偵測 + 夜間事件彙整(純函式,瀏覽器與 Node 皆可用) */
(function (root) {
  'use strict';

  /**
   * 以加速度計 z 軸(含重力)判斷手機「放平且朝哪一面」。
   * 不同平台 z 軸正負號相反(Android 螢幕朝上 z≈+9.8,iOS 相反),
   * 所以用「開始時的朝向」當作 rest 基準,只看「是否與基準相反」。
   *   rest  = 睡覺中(開始時的朝向,建議螢幕朝下)
   *   awake = 翻到另一面(醒了)
   * 需穩定停留 holdMs 才算,避免拿起、碰撞、翻身震動誤觸。
   * 事件時間回溯到「開始穩定」的那一刻。
   */
  function FlipDetector(opts) {
    opts = opts || {};
    this.threshold = opts.threshold != null ? opts.threshold : 6.5; // m/s²,|z| 超過才算放平
    this.holdMs = opts.holdMs != null ? opts.holdMs : 2500;
    this.alpha = opts.alpha != null ? opts.alpha : 0.3;            // 低通濾波
    this.restSign = opts.restSign;                                  // +1 或 -1
    this.state = 'rest';
    this.cand = null;
    this.smoothed = null;
  }

  FlipDetector.prototype.orientation = function () {
    if (this.smoothed === null || Math.abs(this.smoothed) < this.threshold) return 'tilted';
    return Math.sign(this.smoothed) === this.restSign ? 'rest' : 'awake';
  };

  FlipDetector.prototype.feed = function (t, z) {
    this.smoothed = this.smoothed === null ? z : this.smoothed + this.alpha * (z - this.smoothed);
    var o = this.orientation();
    if (o === 'tilted' || o === this.state) { this.cand = null; return null; }
    if (!this.cand || this.cand.state !== o) { this.cand = { state: o, since: t }; return null; }
    if (t - this.cand.since >= this.holdMs) {
      var ev = { type: o, t: this.cand.since };
      this.state = o;
      this.cand = null;
      return ev;
    }
    return null;
  };

  /**
   * 夜間 session → 睡眠日記欄位。
   * session = { bedAt, tryAt, outAt, events:[{type:'awake'|'rest', t}] }  (t 為 ms 時間戳)
   * 「醒來次數/總醒來時間」不含最後一次醒來。
   */
  function summarizeSession(session) {
    var evs = (session.events || []).slice().sort(function (a, b) { return a.t - b.t; });
    var intervals = [], awakeStart = null;
    evs.forEach(function (e) {
      if (e.type === 'awake' && awakeStart === null) awakeStart = e.t;
      else if (e.type === 'rest' && awakeStart !== null) {
        intervals.push({ from: awakeStart, to: e.t });
        awakeStart = null;
      }
    });
    var finalWakeAt = null;
    if (awakeStart !== null) finalWakeAt = awakeStart;       // 最後一次翻起來沒翻回去
    else if (session.outAt) finalWakeAt = session.outAt;     // 沒翻面,直接按「起床」
    var totalMs = intervals.reduce(function (s, i) { return s + (i.to - i.from); }, 0);
    return {
      bedAt: session.bedAt || session.tryAt || null,
      tryAt: session.tryAt || null,
      awakenings: intervals.length,
      awakeMin: Math.round(totalMs / 60000),
      intervals: intervals,
      finalWakeAt: finalWakeAt,
      getUpAt: session.outAt || null
    };
  }

  var api = { FlipDetector: FlipDetector, summarizeSession: summarizeSession };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SleepFlip = api;
})(typeof self !== 'undefined' ? self : this);
