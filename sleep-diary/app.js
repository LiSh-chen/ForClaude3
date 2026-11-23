(function () {
  'use strict';
  const { FlipDetector, summarizeSession } = window.SleepFlip;
  const TL = window.SleepTimeline;
  const $ = (s, el) => (el || document).querySelector(s);
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const KEY_E = 'sleepdiary.entries', KEY_S = 'sleepdiary.session';

  // ---------- 儲存 ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const entries = () => load(KEY_E, {});
  const session = () => load(KEY_S, null);

  // ---------- 日期時間 ----------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const wdOf = s => '星期' + WD[new Date(s + 'T00:00').getDay()];

  // ---------- 欄位定義(對應紙本表單每一列) ----------
  const FIELDS = [
    ['morning', '早上填寫(前一晚)'],
    ['dayType', '工作日或休息日'], ['bedTime', '就寢時間(躺上床)'], ['tryTime', '嘗試入睡時間'],
    ['latencyMin', '睡著所需時間(分)'], ['awakenings', '醒來次數(最後醒來不算)'], ['awakeMin', '總計醒來時間(分)'],
    ['finalWake', '最後醒來時間'], ['getUp', '起床時間'], ['quality', '睡眠品質(1-5)'], ['alarm', '使用鬧鐘'], ['note', '備註'],
    ['evening', '睡前填寫(當天)'],
    ['napCount', '小睡次數'], ['napMin', '小睡總分鐘'], ['alcohol', '酒類/量(cc)'], ['alcoholLast', '最後飲酒時間'],
    ['caffeine', '咖啡因飲料/量(cc)'], ['caffeineLast', '最後咖啡因時間'], ['med', '助眠藥物/劑量'], ['medTime', '服藥時間'],
    ['light', '照光(時段)'], ['exercise', '運動(時段)'], ['ritual', '睡前儀式(時段)'], ['ritualNote', '睡前儀式內容'], ['screen', '睡前看螢幕(時段)'], ['meal', '用餐(時段)']
  ];

  // ---------- 感測器 ----------
  const motion = { z: null, ok: false, det: null, listening: false };
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.z == null) return;
    motion.z = g.z; motion.ok = true;
    if (motion.det) {
      const ev = motion.det.feed(Date.now(), g.z);
      if (ev) recordEvent(ev.type, ev.t);
    }
  }
  async function enableSensor() {
    if (!motion.listening) { window.addEventListener('devicemotion', onMotion); motion.listening = true; }
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission(); // iOS 必須由點擊觸發
        return r === 'granted';
      }
      return true;
    } catch (e) { return false; }
  }
  let wakeLock = null;
  async function lockScreen() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('#night').classList.contains('show')) lockScreen(); });

  // ---------- 夜間流程 ----------
  function recordEvent(type, t) {
    const s = session(); if (!s || !s.tryAt) return;
    s.events.push({ type, t }); save(KEY_S, s);
    if (navigator.vibrate) navigator.vibrate(type === 'awake' ? [40, 60, 40] : 40);
    renderNight();
  }
  function startNight() {
    const s = session() || { events: [] };
    s.tryAt = Date.now(); s.bedAt = s.bedAt || s.tryAt; s.events = []; s.outAt = null;
    save(KEY_S, s);
    motion.det = null;
    if (motion.ok && Math.abs(motion.z) >= 6.5) motion.det = new FlipDetector({ restSign: Math.sign(motion.z) });
    $('#night').classList.add('show'); lockScreen(); renderNight();
  }
  function renderNight() {
    const s = session(); if (!s) return;
    const awake = (() => { const l = s.events[s.events.length - 1]; return l && l.type === 'awake'; })();
    $('#night').innerHTML = `
      <div class="st"><b>${awake ? '👀 醒著' : '😴 睡眠中'}</b>${motion.det ? '↕ 翻面偵測中' : '手動模式'}</div>
      <div class="ctl">
        <button id="nAwake">${awake ? '我再睡了' : '我醒了'}</button>
        <button id="nUp">☀ 起床(長按)</button>
      </div>`;
    $('#nAwake').onclick = () => recordEvent(awake ? 'rest' : 'awake', Date.now());
    holdButton($('#nUp'), endNight);
  }
  function holdButton(btn, fn) {
    let timer; const stop = () => clearTimeout(timer);
    btn.addEventListener('pointerdown', () => { timer = setTimeout(fn, 1500); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
  }
  function endNight() {
    const s = session(); s.outAt = Date.now(); save(KEY_S, s);
    motion.det = null; if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    $('#night').classList.remove('show');
    const sum = summarizeSession(s);
    const date = ymd(new Date(sum.getUpAt));
    const all = entries(), e = all[date] || {};
    Object.assign(e, {
      date, bedTime: hm(sum.bedAt), tryTime: hm(sum.tryAt), awakenings: sum.awakenings, awakeMin: sum.awakeMin,
      finalWake: hm(sum.finalWakeAt), getUp: hm(sum.getUpAt), _auto: ['bedTime', 'tryTime', 'awakenings', 'awakeMin', 'finalWake', 'getUp'],
      _intervals: sum.intervals.map(i => [hm(i.from), hm(i.to)]),
      slots: TL.slotsFromSession(sum, date)
    });
    e.dayType = e.dayType || ([0, 6].includes(new Date(date + 'T00:00').getDay()) ? '休息日' : '工作日');
    all[date] = e; save(KEY_E, all); localStorage.removeItem(KEY_S);
    state.date = date; go('diary');
  }

  // ---------- 畫面 ----------
  const state = { tab: 'night', date: ymd(new Date()) };
  const VIEWS = () => ({ night: viewNight, diary: viewDiary, week: viewWeek, data: viewData });
  function go(tab) {
    state.tab = tab;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    VIEWS()[tab](); $('#app').scrollTop = 0;
  }
  const refresh = () => VIEWS()[state.tab]();

  /** 共用的底部彈出面板 */
  function popup(html) {
    const sh = $('#sheet');
    sh.innerHTML = `<div class="back" id="shBack"></div><div class="panel">${html}</div>`;
    sh.classList.add('show');
    const close = () => { sh.classList.remove('show'); sh.innerHTML = ''; if (popup.onClose) { const f = popup.onClose; popup.onClose = null; f(); } };
    $('#shBack').onclick = close;
    return { sh, close };
  }

  // ---------- 首次導覽 ----------
  const KEY_I = 'sleepdiary.intro';
  const INTRO = [
    ['⏱', '記錄', ['做事前按「開始」,結束再按「結束」', '自動畫到時鐘上', '☕🍺💊 按一下 = 記下現在']],
    ['🌙', '睡覺', ['🛏 躺上床 → 🌙 關燈睡覺', '手機螢幕朝下放床邊', '醒了翻成朝上,再睡翻回朝下', '起床:長按「起床」']],
    ['🕐', '日記', ['先點圓上時段的「起點」,再點「終點」', '藍框框住的就是選到的範圍', '然後在跳出的選單選類別(各有顏色)', '點圓心或 ⭐ 記品質、備註;ⓘ 看明細']],
    ['📊', '一週', ['每天一條橫條,時間上下對齊', '左側圓點 = 睡眠品質(紅差 → 綠好)', '點任一天可編輯', 'ⓘ 看圖例']]
  ];
  function showIntro(n) {
    n = n || 0; const [ic, t, lines] = INTRO[n], last = n === INTRO.length - 1;
    const { close } = popup(`<div class="intro"><div class="big-i">${ic}</div><h2>${t}</h2>${lines.map(l => `<p>${l}</p>`).join('')}
      <div class="dots">${INTRO.map((_, i) => `<i class="${i === n ? 'on' : ''}"></i>`).join('')}</div>
      <div class="row2"><button class="btn alt" id="inSkip">略過</button><button class="btn" id="inNext">${last ? '開始使用' : '下一步'}</button></div></div>`);
    localStorage.setItem(KEY_I, '1');
    $('#inSkip').onclick = close;
    $('#inNext').onclick = () => { close(); if (!last) showIntro(n + 1); };
  }

  // ---------- 即時記錄 ----------
  const KEY_T = 'sleepdiary.timers';
  const TIMERS = [['light', '☀', '照光'], ['exercise', '🏃', '運動'], ['ritual', '🧘', '睡前儀式'], ['screen', '📱', '看螢幕'], ['meal', '🍽', '用餐'], ['nap', '💤', '小睡']];
  const EVENTS = [['caffeine', '☕', '咖啡因'], ['alcohol', '🍺', '酒'], ['med', '💊', '助眠藥']];
  const labelOf = k => { const x = TIMERS.concat(EVENTS).find(x => x[0] === k) || [k, '', k]; return x[1] + ' ' + x[2]; };
  const timers = () => load(KEY_T, {});
  /** 某時刻對應的(日記日期, 格子編號):18:00–24:00 歸「隔天」的前一晚內圈,其餘歸當天外圈。 */
  function slotRef(ms) {
    const d = new Date(ms), min = d.getHours() * 60 + d.getMinutes();
    if (min >= 18 * 60) { const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); return { date: ymd(n), idx: Math.floor((min - 18 * 60) / 30) }; }
    return { date: ymd(d), idx: 12 + Math.floor(min / 30) };
  }
  function applyInterval(kind, from, to) {
    const all = entries(), touched = new Set(), t0 = new Date(from);
    t0.setMinutes(Math.floor(t0.getMinutes() / 30) * 30, 0, 0);
    for (let t = t0.getTime(); t <= Math.max(from, to - 1); t += 30 * 60000) {
      const r = slotRef(t), cur = all[r.date] || (all[r.date] = { date: r.date });
      cur.slots = TL.add(cur.slots || {}, kind, r.idx); touched.add(r.date);
    }
    touched.forEach(dt => { const c = all[dt], dv = TL.derive(c.slots); if (dv) { Object.assign(c, dv); c._auto = []; } if (!c.dayType) c.dayType = defType(dt); });
    save(KEY_E, all); return [...touched];
  }
  function toast(msg) {
    let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2500);
  }
  function startTimer(kind) { const T = timers(); T[kind] = Date.now(); save(KEY_T, T); renderTimerBar(); if (state.tab === 'night') viewNight(); }
  function endTimer(kind) {
    const T = timers(), from = T[kind]; if (!from) return;
    const to = Date.now(); delete T[kind]; save(KEY_T, T);
    const dates = applyInterval(kind, from, to);
    toast(`${labelOf(kind)} ${hm(from)}–${hm(to)} ✓`);
    renderTimerBar(); if (state.tab !== 'data') refresh();
    if (kind === 'ritual') openSheet('ritualNote', dates[0]);
  }
  function recordEvent2(kind) {   // 咖啡因/酒/藥:記錄「現在」這一格,再問內容
    const now = Date.now(), dates = applyInterval(kind, now, now);
    toast(`${labelOf(kind)} ${hm(now)} ✓`); openSheet(kind, dates[0]);
  }
  const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${m}分`; };
  function renderTimerBar() {
    let el = $('#timerbar'); if (!el) { el = document.createElement('div'); el.id = 'timerbar'; document.body.appendChild(el); }
    const T = timers(), ks = Object.keys(T);
    el.style.display = ks.length ? 'block' : 'none'; document.body.classList.toggle('hasTimer', ks.length > 0);
    el.innerHTML = ks.map(k => `<div class="tbr"><span>${labelOf(k)} · ${hm(T[k])} · ${dur(Date.now() - T[k])}</span><button data-end="${k}">結束</button></div>`).join('');
    el.querySelectorAll('[data-end]').forEach(b => b.onclick = () => endTimer(b.dataset.end));
  }
  setInterval(renderTimerBar, 20000);

  // ---------- 記錄 ----------
  function viewNight() {
    const s = session(), T = timers(), inNight = s && s.tryAt && !s.outAt;
    const nT = Object.keys(T).length;
    $('#app').innerHTML = `<div class="rec">
      <div class="sec">⏱ 即時計時 <small>${nT ? nT + ' 項進行中' : '點一下開始,再點一下結束'}</small></div>
      <div class="g3 t">${TIMERS.map(([k, ic, t]) => T[k]
        ? `<button class="tb run" data-t="${k}"><span class="i">⏹</span>${t}<small>自 ${hm(T[k])}</small></button>`
        : `<button class="tb" data-t="${k}"><span class="i">${ic}</span>${t}<small>開始</small></button>`).join('')}</div>
      <div class="sec">⚡ 單次事件 <small>記下「現在」</small></div>
      <div class="g3 e">${EVENTS.map(([k, ic, t]) => `<button class="tb ev" data-ev="${k}"><span class="i" style="font-size:22px">${ic}</span>${t}</button>`).join('')}</div>
      <div class="sec">🌙 睡眠 <small>手機螢幕朝下放床邊</small></div>
      <div class="nightrow">
        <button class="tb" id="bBed"><span class="i">🛏</span>躺上床<small>${s && s.bedAt ? '已記 ' + hm(s.bedAt) : '記下上床時間'}</small></button>
        <button class="big" id="bTry">${inNight ? '🌙 回夜間畫面' : '🌙 關燈睡覺'}<small>${inNight ? '睡眠記錄進行中' : '翻面偵測 · 自動記錄醒來'}</small></button>
      </div></div>`;
    document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => (timers()[b.dataset.t] ? endTimer : startTimer)(b.dataset.t));
    document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => recordEvent2(b.dataset.ev));
    $('#bBed').onclick = () => { const x = session() || { events: [] }; x.bedAt = Date.now(); save(KEY_S, x); toast('🛏 ' + hm(x.bedAt) + ' ✓'); viewNight(); };
    $('#bTry').onclick = async () => {
      if (inNight) { $('#night').classList.add('show'); lockScreen(); renderNight(); return; }
      await enableSensor(); await new Promise(r => setTimeout(r, 400)); startNight();
    };
  }

  // ---------- 日記(時鐘) ----------
  // 類別:[代碼, 圖示, 名稱]。顏色:睡眠三態在 COL,其餘在 MCOL(一週圖共用)
  const BRUSHES = [['sleep', '😴', '睡著'], ['inbed', '🛏', '躺著醒著'], ['nap', '💤', '小睡'], ['caffeine', '☕', '咖啡因'], ['alcohol', '🍺', '酒'],
    ['med', '💊', '助眠藥'], ['light', '☀', '照光'], ['exercise', '🏃', '運動'], ['ritual', '🧘', '睡前儀式'], ['screen', '📱', '看螢幕'], ['meal', '🍽', '用餐'], ['alarm', '⏰', '鬧鐘'], ['erase', '⌫', '清除']];
  const ICON = { caffeine: '☕', alcohol: '🍺', med: '💊', light: '☀', exercise: '🏃', ritual: '🧘', screen: '📱', meal: '🍽', alarm: '⏰' };
  const tl = { anchor: null, sel: null };   // anchor = 已點的起點;sel = 已框選的範圍 {lo, hi}
  const catColor = k => COL[k] || MCOL[k] || '#888';
  const LIGHT_BG = ['inbed', 'nap', 'light'];
  const COL = { sleep: '#2f4a8a', inbed: '#f6c177', nap: '#9ecbf5' };
  const rad = d => d * Math.PI / 180;
  const pt = (r, d) => [200 + r * Math.sin(rad(d)), 200 - r * Math.cos(rad(d))];
  const f = n => n.toFixed(1);
  const FACE = ['😫', '😕', '😐', '🙂', '😄'];
  function sector(r0, r1, a0, a1) {
    const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
    return `M${f(x0)} ${f(y0)}A${r1} ${r1} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${r0} ${r0} 0 0 0 ${f(x3)} ${f(y3)}Z`;
  }
  const durTxt = n => { const m = n * 30; return m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ' ' + m % 60 + ' 分' : ''}` : `${m} 分`; };
  /** 外圈 = 當天 0–24 時,內圈 = 前一晚 18–24 時;12 點鐘方向 = 0 時,順時針 */
  function drawClock(e) {
    const slots = e.slots || {}, parts = [], over = [];
    const lo = tl.sel ? tl.sel.lo : tl.anchor, hi = tl.sel ? tl.sel.hi : tl.anchor;
    for (let i = 0; i < 60; i++) {
      const inner = i < 12, a0 = inner ? 270 + i * 7.5 : (i - 12) * 7.5, a1 = a0 + 7.5;
      const [r0, r1] = inner ? [84, 124] : [128, 172];
      const a = slots[i] || [], st = a.find(k => COL[k]) || '', ms = a.filter(k => MCOL[k]);
      const h = ((inner ? 18 * 60 + i * 30 : (i - 12) * 30) / 60) % 24, night = h >= 22 || h < 7;
      parts.push(`<path data-i="${i}" d="${sector(r0, r1, a0, a1)}" fill="${st ? COL[st] : night ? '#e6e9f4' : '#fdf6dc'}" stroke="#fff" stroke-width="1"/>`);
      if (ms.length) {   // 其他活動:專屬顏色色塊(有睡眠狀態時佔外側 45%,否則佔滿)
        const rm = st ? r0 + (r1 - r0) * 0.55 : r0, th = (r1 - rm) / ms.length;
        ms.forEach((k, n) => parts.push(`<path data-i="${i}" d="${sector(rm + n * th, rm + (n + 1) * th, a0, a1)}" fill="${MCOL[k]}" stroke="#fff" stroke-width=".8"/>`));
        if (ms.length === 1 && !st) { const [x, y] = pt((r0 + r1) / 2, a0 + 3.75); parts.push(`<text x="${f(x)}" y="${f(y)}" font-size="11" text-anchor="middle" dominant-baseline="central" pointer-events="none">${ICON[ms[0]]}</text>`); }
      }
      if (lo != null && i >= lo && i <= hi) over.push(`<path data-i="${i}" d="${sector(r0 - 2, r1 + 2, a0, a1)}" fill="rgba(25,118,210,.30)" stroke="#1565c0" stroke-width="${tl.sel ? 2.5 : 4}"/>`);
    }
    parts.push(...over);
    for (let h = 0; h < 24; h++) {   // 每小時刻度,每 3 小時標數字
      const [x1, y1] = pt(173, h * 15), [x2, y2] = pt(h % 3 ? 177 : 181, h * 15);
      parts.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${h % 3 ? '#bbb' : '#777'}"/>`);
      if (h % 3 === 0) { const [x, y] = pt(191, h * 15); parts.push(`<text x="${f(x)}" y="${f(y)}" font-size="12" fill="#555" text-anchor="middle" dominant-baseline="central" pointer-events="none">${h}</text>`); }
    }
    const [lx, ly] = pt(104, 315);
    parts.push(`<text x="${f(lx)}" y="${f(ly)}" font-size="9" fill="#667" text-anchor="middle" pointer-events="none" transform="rotate(-45 ${f(lx)} ${f(ly)})">前一晚</text>`);
    parts.push('<circle data-c="1" cx="200" cy="200" r="80" fill="#fff" stroke="#e3e7f1"/>');
    const d = TL.derive(slots), sleepN = Object.keys(slots).filter(k => +k < 36 && slots[k].includes('sleep')).length, mins = sleepN * 30, c = [];
    let y0 = 190;
    if (tl.sel) {
      c.push(`<tspan x="200" dy="0" font-size="22" font-weight="700" fill="#1565c0">${TL.slotStart(lo)}</tspan><tspan x="200" dy="24" font-size="22" font-weight="700" fill="#1565c0">→ ${TL.slotEnd(hi)}</tspan><tspan x="200" dy="22" font-size="13" fill="#555">${durTxt(hi - lo + 1)}</tspan>`); y0 = 178;
    } else if (tl.anchor != null) {
      c.push(`<tspan x="200" dy="0" font-size="13" fill="#555">起點</tspan><tspan x="200" dy="28" font-size="26" font-weight="700" fill="#1565c0">${TL.slotStart(tl.anchor)}</tspan><tspan x="200" dy="22" font-size="13" fill="#555">再點終點</tspan>`); y0 = 175;
    } else if (sleepN) {
      c.push(`<tspan x="200" dy="0" font-size="22" font-weight="700" fill="#2f4a8a">😴 ${Math.floor(mins / 60)}h${mins % 60 ? pad(mins % 60) : ''}</tspan>`);
      if (d && d.bedTime) c.push(`<tspan x="200" dy="22" font-size="13" fill="#555">${d.bedTime} → ${d.getUp}</tspan>`);
      c.push(`<tspan x="200" dy="26" font-size="20">${e.quality ? FACE[e.quality - 1] : '⭐'}</tspan>`);
    } else c.push(`<tspan x="200" dy="0" font-size="26">👆</tspan><tspan x="200" dy="24" font-size="13" fill="#888">點時段開始</tspan>`);
    parts.push(`<text x="200" y="${y0}" text-anchor="middle" pointer-events="none">${c.join('')}</text>`);
    $('#grid').innerHTML = `<svg class="clock" viewBox="0 0 400 400">${parts.join('')}</svg>`;
    const stl = $('#tlstat'), mini = $('#mini');
    if (stl) stl.innerHTML = tl.sel ? `已選 <b>${TL.slotStart(lo)} – ${TL.slotEnd(hi)}</b>(${durTxt(hi - lo + 1)})` : tl.anchor != null ? `起點 <b>${TL.slotStart(tl.anchor)}</b> · 再點終點` : '👆 點一個時段當起點,再點終點';
    if (mini) mini.innerHTML = [['🛏 上床', d && d.bedTime || '—'], ['🌅 起床', d && d.getUp || '—'], ['👀 中途醒', d && d.awakenings !== '' && d.awakenings !== undefined ? d.awakenings + ' 次' : '—']].map(([l, v]) => `<div class="mc"><small>${l}</small><b>${v}</b></div>`).join('');
  }

  function tapSlot(i) {
    if (tl.anchor == null) { tl.anchor = i; drawClock(entries()[state.date] || {}); return; }
    tl.sel = { lo: Math.min(tl.anchor, i), hi: Math.max(tl.anchor, i) }; tl.anchor = null;
    drawClock(entries()[state.date] || {}); openCategory();
  }

  /** 框選範圍後,跳出類別選單;已全部套用的類別打勾,再點一次就取消 */
  function openCategory() {
    const { lo, hi } = tl.sel, e = entries()[state.date] || {}, slots = e.slots || {};
    const has = k => { for (let i = lo; i <= hi; i++) if (!(slots[i] || []).includes(k)) return false; return true; };
    const { sh, close } = popup(`<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px"><b style="font-size:20px;color:#1565c0">${TL.slotStart(lo)} → ${TL.slotEnd(hi)}</b><span class="hint">${durTxt(hi - lo + 1)} · 選類別</span></div>
      <div class="cat">${BRUSHES.map(([k, ic, t]) => { const c = catColor(k), on = k !== 'erase' && has(k), ink = on && !LIGHT_BG.includes(k) ? '#fff' : '#1b2437';
        return `<button data-k="${k}" style="border-color:${c};background:${on ? c : c + '22'};color:${ink}"><span>${ic}</span>${t}${on ? '<small>✓ 再點取消</small>' : ''}</button>`; }).join('')}</div>
      <button class="btn alt" id="catCancel">取消</button>`);
    popup.onClose = () => { tl.sel = null; tl.anchor = null; if (state.tab === 'diary') drawClock(entries()[state.date] || {}); };
    $('#catCancel').onclick = close;
    sh.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
      const k = b.dataset.k, all = entries(), cur = all[state.date] || { date: state.date };
      cur.slots = TL.paint(cur.slots || {}, k, lo, hi);
      const dv = TL.derive(cur.slots); if (dv) { Object.assign(cur, dv); cur._auto = []; }
      all[state.date] = cur; save(KEY_E, all);
      const added = k !== 'erase' && Object.keys(cur.slots).some(i => +i >= lo && +i <= hi && cur.slots[i].includes(k));
      close(); toast(`${b.textContent.replace('✓ 再點取消', '')} ${added ? '✓' : '已取消'}`);
      if (added && ['alcohol', 'caffeine', 'med', 'ritual'].includes(k)) openSheet(k === 'ritual' ? 'ritualNote' : k);
    });
  }

  const patch = (k, v, date) => { date = date || state.date; const all = entries(), cur = all[date] || { date }; cur[k] = v; all[date] = cur; save(KEY_E, all); };
  const QCOL = ['#d64545', '#ec8a3b', '#e6c229', '#8bc34a', '#2e9e5b'];
  const qInk = n => n === 2 || n === 3 ? '#1b2437' : '#fff';
  const defType = date => [0, 6].includes(new Date(date + 'T00:00').getDay()) ? '休息日' : '工作日';
  const PRESETS = { alcohol: ['啤酒 350cc', '紅酒 150cc', '烈酒 45cc'], caffeine: ['咖啡 250cc', '茶 250cc', '可樂 330cc'], ritualNote: ['泡澡/泡腳', '閱讀', '冥想/呼吸', '伸展', '聽音樂', '寫日記', '熱飲', '關手機'] };
  const FIELD = { note: ['📝 備註', '例如:感冒'], ritualNote: ['🧘 做了什麼', '例如:泡澡、閱讀'], alcohol: ['🍺 種類/量', '啤酒 250cc'], caffeine: ['☕ 種類/量', '咖啡 250cc'], med: ['💊 名稱/劑量', 'Stilnox 50mg'] };

  /** 彈出面板:有 focus 只問那一項;沒有 focus 則是品質 + 備註(其餘收在「內容」)。即時自動儲存。 */
  function openSheet(focus, date) {
    date = date || state.date;
    const e = entries()[date] || {};
    const inp = k => `<label>${FIELD[k][0]}</label><input data-s="${k}" value="${(e[k] ?? '').toString().replace(/"/g, '&quot;')}" placeholder="${FIELD[k][1]}">
      <div class="chips">${(PRESETS[k] || []).map(p => `<button type="button" data-p="${k}" data-v="${p}">${p}</button>`).join('')}</div>`;
    const stars = `<div class="stars">${FACE.map((fc, n) => `<button type="button" data-q="${n + 1}" style="border-color:${QCOL[n]};${+e.quality === n + 1 ? `background:${QCOL[n]};color:${qInk(n)}` : ''}">${fc}<br><b style="font-size:15px">${n + 1}</b></button>`).join('')}</div>`;
    const body = focus ? inp(focus) : stars + inp('note') + `<details><summary>🍺 ☕ 💊 🧘</summary>${['alcohol', 'caffeine', 'med', 'ritualNote'].map(inp).join('')}</details>`;
    const { sh, close } = popup(`<h2>${date.slice(5).replace('-', '/')}</h2>${body}<button class="btn" id="shDone">完成</button>`);
    popup.onClose = () => { if (state.tab !== 'data') refresh(); };
    sh.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      patch('quality', +b.dataset.q, date);
      sh.querySelectorAll('[data-q]').forEach((x, n) => { const on = x === b; x.style.background = on ? QCOL[n] : ''; x.style.color = on ? qInk(n) : ''; });
    });
    sh.querySelectorAll('[data-s]').forEach(el => el.oninput = () => patch(el.dataset.s, el.value, date));
    sh.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      const el = sh.querySelector(`[data-s=${b.dataset.p}]`), multi = b.dataset.p === 'ritualNote';
      el.value = multi && el.value ? (el.value.includes(b.dataset.v) ? el.value : el.value + '、' + b.dataset.v) : b.dataset.v;
      patch(b.dataset.p, el.value, date);
    });
    $('#shDone').onclick = close;
    if (focus) { const el = sh.querySelector(`[data-s=${focus}]`); if (el) setTimeout(() => el.focus(), 50); }
  }

  /** ⓘ:自動算出的明細 */
  function openInfo() {
    const e = entries()[state.date] || {}, d = e.slots && Object.keys(e.slots).length ? TL.derive(e.slots) : null;
    const rows = d ? [['🛏 上床', d.bedTime], ['⏳ 入睡約', d.latencyMin !== '' ? d.latencyMin + ' 分' : ''], ['👀 中途醒', d.awakenings !== '' ? `${d.awakenings} 次 / ${d.awakeMin} 分` : ''],
      ['🌅 最後醒來', d.finalWake], ['🚪 起床', d.getUp], ['💤 小睡', d.napCount !== '' ? `${d.napCount} 次 / ${d.napMin} 分` : ''],
      ['☕ 最後咖啡因', d.caffeineLast ? d.caffeineLast + (e.caffeine ? ' ' + e.caffeine : '') : ''], ['🍺 最後飲酒', d.alcoholLast ? d.alcoholLast + (e.alcohol ? ' ' + e.alcohol : '') : ''],
      ['💊 服藥', d.medTime ? d.medTime + (e.med ? ' ' + e.med : '') : ''], ['☀ 照光', d.light], ['🏃 運動', d.exercise],
      ['🧘 睡前儀式', [d.ritual, e.ritualNote].filter(Boolean).join(' ')], ['📱 看螢幕', d.screen], ['🍽 用餐', d.meal], ['⏰ 鬧鐘', d.alarm], ['📝 備註', e.note || '']].filter(r => r[1]) : [];
    const { close } = popup(`<h2>${state.date.slice(5).replace('-', '/')} ${wdOf(state.date).slice(2)} · ${e.dayType || defType(state.date)}</h2>${rows.length ? `<div class="kv">${rows.map(r => `<span>${r[0]}</span><b>${r[1]}</b>`).join('')}</div>` : '<p class="hint">尚無紀錄</p>'}<div class="lg" style="margin-top:12px">${BRUSHES.filter(b => b[0] !== 'erase').map(b => `<span><i style="background:${catColor(b[0])}"></i>${b[1]} ${b[2]}</span>`).join('')}</div><button class="btn" id="shDone">完成</button>`);
    $('#shDone').onclick = close;
  }

  function viewDiary() {
    const e = entries()[state.date] || { date: state.date };
    tl.anchor = null; tl.sel = null;
    const dtxt = s => { const [y, m, dd] = s.split('-'); return `${+y !== new Date().getFullYear() ? y + '/' : ''}${m}/${dd} ${wdOf(s).slice(2) ? '週' + wdOf(s).slice(2) : ''}`; };
    $('#app').innerHTML = `
      <div class="bar">
        <button class="ib" id="dPrev">◀</button>
        <label class="dt"><span>${dtxt(state.date)}</span><input type="date" id="dDate" value="${state.date}"></label>
        <button class="ib" id="dNext">▶</button>
        <button class="ib t" id="bType">${e.dayType || defType(state.date)}</button><button class="ib" id="bStar">⭐</button><button class="ib" id="bInfo">ⓘ</button>
      </div>
      <div class="stl" id="tlstat"></div>
      <div id="grid"></div>
      <div class="g3 mini" id="mini"></div>`;
    if (!e.dayType) patch('dayType', defType(state.date));
    drawClock(e);
    $('#grid').onclick = ev => { if (ev.target.closest('[data-c]')) return openSheet(); const c = ev.target.closest('[data-i]'); if (c) tapSlot(+c.dataset.i); };
    $('#bStar').onclick = () => openSheet();
    $('#bInfo').onclick = openInfo;
    $('#bType').onclick = () => { const cur = (entries()[state.date] || {}).dayType || defType(state.date); const nx = cur === '工作日' ? '休息日' : '工作日'; patch('dayType', nx); $('#bType').textContent = nx; };
    const shift = n => { const d = new Date(state.date + 'T00:00'); d.setDate(d.getDate() + n); state.date = ymd(d); viewDiary(); };
    $('#dPrev').onclick = () => shift(-1); $('#dNext').onclick = () => shift(1);
    $('#dDate').onchange = ev => { if (ev.target.value) { state.date = ev.target.value; viewDiary(); } };
  }

  // ---------- 一週 ----------
  const MCOL = { caffeine: '#8d5524', alcohol: '#d98e04', med: '#8e44ad', light: '#f4c20d', exercise: '#2e8b57', ritual: '#17a2b8', screen: '#546e7a', meal: '#e85d9a', alarm: '#e03e3e' };
  function openLegend() {
    const sw = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;
    const { close } = popup(`<h2>圖例</h2><div class="lg">${sw(COL.sleep, '睡著')}${sw(COL.inbed, '躺著醒著')}${sw(COL.nap, '小睡')}${sw('#eef0f8', '22:00–07:00')}
      ${BRUSHES.filter(b => MCOL[b[0]]).map(b => sw(MCOL[b[0]], b[1] + ' ' + b[2])).join('')}</div>
      <div class="lg" style="margin-top:12px">${[1, 2, 3, 4, 5].map(n => `<span><i style="background:${QCOL[n - 1]};border-radius:50%"></i>品質 ${n}</span>`).join('')}</div>
      <p class="hint">下方一排:😴 平均睡眠 · 🛏 平均上床 · 🌅 平均起床 · ⭐ 平均品質 · 📊 睡眠效率(睡著 ÷ 在床上)</p><button class="btn" id="shDone">完成</button>`);
    $('#shDone').onclick = close;
  }
  function viewWeek() {
    const all = entries(), end = new Date(state.date + 'T00:00'), days = [];
    for (let k = 6; k >= 0; k--) { const d = new Date(end); d.setDate(d.getDate() - k); days.push(ymd(d)); }
    const W = 360, L = 66, BW = W - L - 6, SW = BW / 60, RH = 44, TOP = 22, H = TOP + days.length * RH + 4, p = [];
    p.push(`<rect x="${L + 8 * SW}" y="${TOP - 4}" width="${18 * SW}" height="${days.length * RH + 4}" fill="#eef0f8"/>`);
    for (let k = 0; k <= 10; k++) {
      const x = L + k * 6 * SW, h = (18 + 3 * k) % 24;
      p.push(`<line x1="${x}" y1="${TOP - 4}" x2="${x}" y2="${H}" stroke="${h === 0 ? '#999' : '#dde2ee'}" stroke-width="${h === 0 ? 1.5 : 1}"/><text x="${x}" y="12" font-size="10" fill="#667" text-anchor="middle">${h}</text>`);
    }
    days.forEach((d, r) => {
      const y = TOP + r * RH, slots = (all[d] || {}).slots || {}, has = Object.keys(slots).length, q = (all[d] || {}).quality;
      p.push(`<g data-d="${d}" style="cursor:pointer"><rect x="0" y="${y - 2}" width="${W}" height="${RH - 2}" fill="transparent"/>`);
      p.push(`<text x="4" y="${y + 13}" font-size="11" fill="${has ? '#1b2437' : '#aaa'}">${d.slice(5).replace('-', '/')}</text><text x="4" y="${y + 26}" font-size="10" fill="#889">週${WD[new Date(d + 'T00:00').getDay()]}</text>`);
      if (q) p.push(`<circle cx="52" cy="${y + 16}" r="9" fill="${QCOL[q - 1]}"/><text x="52" y="${y + 16}" font-size="12" font-weight="700" fill="${qInk(q - 1)}" text-anchor="middle" dominant-baseline="central">${q}</text>`);
      for (let s = 0; s < 60; s++) {
        const a2 = slots[s]; if (!a2) continue;
        const st = a2.find(k => COL[k]);
        if (st) p.push(`<rect x="${(L + s * SW).toFixed(1)}" y="${y + 2}" width="${(SW + 0.3).toFixed(1)}" height="14" fill="${COL[st]}"/>`);
        const ms = a2.filter(k => MCOL[k]);
        ms.forEach((k, n) => p.push(`<rect x="${(L + s * SW).toFixed(1)}" y="${y + 19 + n * (9 / ms.length)}" width="${(SW + 0.3).toFixed(1)}" height="${9 / ms.length}" fill="${MCOL[k]}"/>`));
      }
      p.push('</g>');
    });
    const st = days.map(d => (all[d] || {}).slots).filter(s => s && Object.keys(s).length).map(s => {
      const inb = Object.keys(s).map(Number).filter(i => i < 36 && (s[i].includes('sleep') || s[i].includes('inbed')));
      return { sleep: Object.keys(s).filter(i => +i < 36 && s[i].includes('sleep')).length / 2, bed: inb.length ? Math.min(...inb) : null, up: inb.length ? Math.max(...inb) + 1 : null, inBed: inb.length / 2 };
    }).filter(x => x.bed !== null);
    const qs = days.map(d => +(all[d] || {}).quality).filter(Boolean);
    const per = days.map(d => { const s = (all[d] || {}).slots; if (!s || !Object.keys(s).length) return null; const k = Object.keys(s).map(Number).filter(i => i < 36 && (s[i].includes('sleep') || s[i].includes('inbed'))); return { d, sleep: Object.keys(s).filter(i => +i < 36 && s[i].includes('sleep')).length / 2, bed: k.length ? Math.min(...k) : null }; }).filter(x => x && x.bed !== null);
    const mmdd = d => d.slice(5).replace('-', '/');
    const tips = per.length >= 2 ? (() => { const lo = per.reduce((x, y) => y.sleep < x.sleep ? y : x), hi = per.reduce((x, y) => y.sleep > x.sleep ? y : x), beds = per.map(x => x.bed), gap = (Math.max(...beds) - Math.min(...beds)) / 2;
      return `<div class="srow" style="margin:8px 0 0;padding:8px 12px;font-size:14px;line-height:1.7">⏳ 最長 <b>${mmdd(hi.d)}</b> ${hi.sleep}h · 最短 <b>${mmdd(lo.d)}</b> ${lo.sleep}h<br>🕒 上床時間落差 <b>${gap}</b> 小時 ${gap <= 1 ? '(很規律 👍)' : gap >= 2 ? '(落差偏大)' : ''}</div>`; })() : '';
    const avg = arr => arr.reduce((x, y) => x + y, 0) / arr.length, sT = i => TL.slotStart(Math.round(i));
    const stats = st.length ? `<div class="stats"><span>😴 ${avg(st.map(x => x.sleep)).toFixed(1)}h<small>平均睡眠</small></span><span>🛏 ${sT(avg(st.map(x => x.bed)))}<small>平均上床</small></span><span>🌅 ${sT(avg(st.map(x => x.up)))}<small>平均起床</small></span>${qs.length ? `<span>⭐ ${avg(qs).toFixed(1)}<small>平均品質</small></span>` : ''}<span>📊 ${Math.round(100 * st.reduce((x, y) => x + y.sleep, 0) / st.reduce((x, y) => x + y.inBed, 0))}%<small>睡眠效率</small></span></div>` : '<div class="stats" style="font-weight:400;color:var(--sub)">這週還沒有紀錄,到「記錄」或「日記」開始吧</div>';
    const leg = `<div class="leg"><span><i style="background:${COL.sleep}"></i>睡著</span><span><i style="background:${COL.inbed}"></i>躺著醒著</span><span><i style="background:${COL.nap}"></i>小睡</span><span><i style="background:#17a2b8"></i>活動(細條)</span><span><i style="background:${QCOL[0]};border-radius:50%"></i>→<i style="background:${QCOL[4]};border-radius:50%;margin-left:4px"></i>品質 1→5</span></div>`;
    const prev = new Date(end); prev.setDate(prev.getDate() - 7); const next = new Date(end); next.setDate(next.getDate() + 7);
    $('#app').innerHTML = `<div class="bar"><button class="ib" id="wPrev">◀</button><b style="flex:1;text-align:center">${days[0].slice(5).replace('-', '/')} – ${days[6].slice(5).replace('-', '/')}</b><button class="ib" id="wNext">▶</button><button class="ib noprint" id="wInfo">ⓘ</button><button class="ib noprint" id="wPrint">🖨</button></div>
      <svg class="wk" viewBox="0 0 ${W} ${H}">${p.join('')}</svg>${stats}${tips}${leg}`;
    $('#wPrev').onclick = () => { state.date = ymd(prev); viewWeek(); };
    $('#wNext').onclick = () => { state.date = ymd(next); viewWeek(); };
    $('#wInfo').onclick = openLegend; $('#wPrint').onclick = () => window.print();
    document.querySelectorAll('[data-d]').forEach(g => g.onclick = () => { state.date = g.dataset.d; go('diary'); });
  }

  // ---------- 設定 ----------
  function viewData() {
    const all = entries(), keys = ['date'].concat(FIELDS.map(f => f[0]).filter(k => !['morning', 'evening'].includes(k)));
    const n = Object.keys(all).length;
    $('#app').innerHTML = `
      <div class="srow"><button class="btn" id="bCsv">📤 匯出 CSV</button><p>把全部紀錄存成試算表檔,可拿給醫師或用 Excel 開啟</p></div>
      <div class="srow"><button class="btn alt" id="bHelp">❓ 使用導覽</button><p>重新查看每個按鈕與圖示的用法</p></div>
      <div class="srow"><button class="btn danger" id="bClr">🗑 清除所有資料</button><p>刪除這支手機上的全部紀錄,無法復原</p></div>
      <p class="hint" style="text-align:center;margin:4px 0 0">📅 已記錄 ${n} 天 · 🔒 資料只存在這支手機,不會上傳</p>`;
    $('#bHelp').onclick = () => showIntro(0);
    $('#bCsv').onclick = () => {
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = '﻿' + keys.join(',') + '\n' + Object.keys(all).sort().map(d => keys.map(k => q(all[d][k])).join(',')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'sleep-diary.csv'; a.click();
    };
    $('#bClr').onclick = () => { if (confirm('確定清除所有紀錄?')) { localStorage.removeItem(KEY_E); localStorage.removeItem(KEY_S); localStorage.removeItem(KEY_T); renderTimerBar(); viewData(); } };
  }

  document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
  renderTimerBar();
  go('night');
  if (!localStorage.getItem(KEY_I)) showIntro(0);
  window.__sleepdiary = { recordEvent, startNight, endNight, state };
})();
