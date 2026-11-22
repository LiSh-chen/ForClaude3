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
    const el = $('#orient'); if (el) el.textContent = orientText();
  }
  function orientText() {
    if (!motion.ok) return '尚未收到感測器資料';
    const z = motion.z; if (Math.abs(z) < 6.5) return '傾斜(請平放)';
    return z > 0 ? '平放 z+(Android=螢幕朝上)' : '平放 z−(Android=螢幕朝下)';
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
    const sensing = !!motion.det;
    const awake = (() => { const l = s.events[s.events.length - 1]; return l && l.type === 'awake'; })();
    $('#night').innerHTML = `
      <div class="st"><b>${awake ? '醒著' : '睡眠中'}</b>${sensing ? '把手機翻到另一面 = 醒了;翻回來 = 重新入睡' : '感測器未啟用,請用下方按鈕標記'}<br>(此畫面不顯示時間)</div>
      <div class="ctl">
        <button id="nAwake">${awake ? '我再睡了' : '我醒了'}</button>
        <button id="nUp" data-hold>起床(長按 1.5 秒)</button>
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
  function go(tab) {
    state.tab = tab;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    ({ night: viewNight, diary: viewDiary, week: viewWeek, data: viewData })[tab]();
    window.scrollTo(0, 0);
  }

  // ---------- 即時記錄:按「開始」「結束」自動把這段時間塗到時鐘上 ----------
  const KEY_T = 'sleepdiary.timers';
  const TIMERS = [['light', '☀ 照光'], ['exercise', '🏃 運動'], ['ritual', '🧘 睡前儀式'], ['screen', '📱 睡前看螢幕'], ['meal', '🍽 用餐'], ['nap', '💤 小睡']];
  const EVENTS = [['caffeine', '☕ 咖啡因'], ['alcohol', '🍺 酒'], ['med', '💊 助眠藥']];
  const labelOf = k => (TIMERS.concat(EVENTS).find(x => x[0] === k) || [k, k])[1];
  const timers = () => load(KEY_T, {});
  /** 某時刻對應的(日記日期, 格子編號):18:00–24:00 歸「隔天」的前一晚內圈,其餘歸當天外圈。 */
  function slotRef(ms) {
    const d = new Date(ms), min = d.getHours() * 60 + d.getMinutes();
    if (min >= 18 * 60) { const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); return { date: ymd(n), idx: Math.floor((min - 18 * 60) / 30) }; }
    return { date: ymd(d), idx: 12 + Math.floor(min / 30) };
  }
  /** 把 [from,to] 涵蓋的每個 30 分鐘格加上 kind;回傳受影響的日期。 */
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
    el.textContent = msg; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3500);
  }
  function startTimer(kind) { const T = timers(); T[kind] = Date.now(); save(KEY_T, T); renderTimerBar(); if (state.tab === 'night') viewNight(); }
  function endTimer(kind) {
    const T = timers(), from = T[kind]; if (!from) return;
    const to = Date.now(); delete T[kind]; save(KEY_T, T);
    const dates = applyInterval(kind, from, to);
    toast(`已記錄 ${labelOf(kind)} ${hm(from)}–${hm(to)}`);
    renderTimerBar(); if (state.tab === 'night') viewNight(); else if (state.tab === 'week') viewWeek(); else if (state.tab === 'diary') viewDiary();
    if (kind === 'ritual') openSheet('ritualNote', dates[0]);
  }
  function recordEvent2(kind) {   // 咖啡因/酒/藥:記錄「現在」這一格,再問內容
    const now = Date.now(), dates = applyInterval(kind, now, now);
    toast(`已記錄 ${labelOf(kind)} ${hm(now)}`); openSheet(kind, dates[0]);
  }
  const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`; };
  function renderTimerBar() {
    let el = $('#timerbar'); if (!el) { el = document.createElement('div'); el.id = 'timerbar'; document.body.appendChild(el); }
    const T = timers(), ks = Object.keys(T);
    el.style.display = ks.length ? 'block' : 'none';
    el.innerHTML = ks.map(k => `<div class="tb"><span>${labelOf(k)} 進行中 · 自 ${hm(T[k])}(${dur(Date.now() - T[k])})</span><button data-end="${k}">結束</button></div>`).join('');
    el.querySelectorAll('[data-end]').forEach(b => b.onclick = () => endTimer(b.dataset.end));
  }
  setInterval(renderTimerBar, 20000);

  function viewNight() {
    const s = session();
    const T = timers();
    $('#app').innerHTML = `
      <div class="card"><h2>⏱ 即時記錄</h2>
        <p class="hint">開始做的時候按「開始」,結束時按「結束」,App 自動把這段時間塗到時鐘上。</p>
        <div class="row" style="flex-wrap:wrap">${TIMERS.map(([k, t]) => T[k]
          ? `<button class="btn danger" style="flex:1 1 45%;margin-top:6px;padding:12px" data-t="${k}">⏹ 結束${t.slice(2)}<br><small>自 ${hm(T[k])}</small></button>`
          : `<button class="btn alt" style="flex:1 1 45%;margin-top:6px;padding:12px" data-t="${k}">▶ 開始 ${t}</button>`).join('')}</div>
        <p class="hint" style="margin-top:12px">單次事件(記下「現在」並詢問內容):</p>
        <div class="row">${EVENTS.map(([k, t]) => `<button class="btn alt" style="margin-top:0;padding:10px;font-size:14px" data-ev="${k}">${t}</button>`).join('')}</div>
      </div>
      <div class="card"><h2>今晚怎麼記?</h2>
        <p class="hint">不用看時間:按下按鈕或翻面,App 自動記下時間。夜間畫面全黑、不顯示時間(避免看時鐘更睡不著)。</p>
        <h3>1. 啟用翻面感測</h3>
        <button class="btn alt" id="bSensor">啟用/檢查感測器</button>
        <p class="hint">目前狀態:<span class="pill ${motion.ok ? 'ok' : 'warn'}" id="orient">${orientText()}</span></p>
        <h3>2. 睡前</h3>
        <button class="btn alt" id="bBed">${s && s.bedAt ? '已記錄上床 ' + hm(s.bedAt) + '(再按重記)' : '我躺上床了'}</button>
        <p class="hint">把手機<b>螢幕朝下</b>平放在床邊(充電中),再按下面按鈕。之後<b>翻成螢幕朝上 = 我醒了</b>,翻回朝下 = 重新入睡。</p>
        <button class="btn" id="bTry">關燈,準備睡覺</button>
        ${s && s.tryAt ? '<button class="btn alt" id="bResume">回到夜間畫面</button>' : ''}
      </div>
      <div class="card"><h2>注意</h2><p class="hint">瀏覽器版需整夜保持螢幕開著(純黑)並接上充電器;手機鎖屏後網頁的感測器會停止。想整夜免開螢幕,需做成原生 App,詳見 EVALUATION.md。</p></div>`;
    document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => (timers()[b.dataset.t] ? endTimer : startTimer)(b.dataset.t));
    document.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => recordEvent2(b.dataset.ev));
    $('#bSensor').onclick = async () => { const ok = await enableSensor(); if (!ok) alert('無法啟用感測器(桌機或權限被拒)。仍可用手動按鈕標記。'); viewNight(); };
    $('#bBed').onclick = () => { const x = session() || { events: [] }; x.bedAt = Date.now(); save(KEY_S, x); viewNight(); };
    $('#bTry').onclick = async () => { await enableSensor(); await new Promise(r => setTimeout(r, 400)); startNight(); };
    if ($('#bResume')) $('#bResume').onclick = () => { $('#night').classList.add('show'); lockScreen(); renderNight(); };
  }

  const BRUSHES = [['sleep', '😴 睡著'], ['inbed', '🛏 躺著醒著'], ['nap', '💤 小睡'], ['caffeine', '☕ 咖啡因'], ['alcohol', '🍺 酒'],
    ['med', '💊 助眠藥'], ['light', '☀ 照光'], ['exercise', '🏃 運動'], ['ritual', '🧘 睡前儀式'], ['screen', '📱 睡前看螢幕'], ['meal', '🍽 用餐'], ['alarm', '⏰ 鬧鐘'], ['erase', '⌫ 清除']];
  const ICON = { caffeine: '☕', alcohol: '🍺', med: '💊', light: '☀', exercise: '🏃', ritual: '🧘', screen: '📱', meal: '🍽', alarm: '⏰', nap: '💤' };
  const tl = { brush: null, anchor: null, view: 'clock' };

  // ---- 時鐘圓餅:外圈 = 當天 00:00–24:00,內圈 = 前一晚 18:00–24:00;12 點鐘方向 = 00:00,順時針 ----
  const COL = { sleep: '#2f4a8a', inbed: '#f6c177', nap: '#9ecbf5' };
  const rad = d => d * Math.PI / 180;
  const pt = (r, d) => [200 + r * Math.sin(rad(d)), 200 - r * Math.cos(rad(d))];
  const f = n => n.toFixed(1);
  function sector(r0, r1, a0, a1) {
    const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
    return `M${f(x0)} ${f(y0)}A${r1} ${r1} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${r0} ${r0} 0 0 0 ${f(x3)} ${f(y3)}Z`;
  }
  function gridClock(e) {
    const slots = e.slots || {}, parts = [];
    for (let i = 0; i < 60; i++) {
      const inner = i < 12, a0 = inner ? 270 + i * 7.5 : (i - 12) * 7.5, a1 = a0 + 7.5;
      const [r0, r1] = inner ? [84, 124] : [128, 172];
      const a = slots[i] || [], st = a.find(k => COL[k]) || '';
      const hourOfDay = ((inner ? 18 * 60 + i * 30 : (i - 12) * 30) / 60) % 24, night = hourOfDay >= 22 || hourOfDay < 7;
      const fill = st ? COL[st] : night ? '#e6e9f4' : '#fdf6dc';
      parts.push(`<path data-i="${i}" d="${sector(r0, r1, a0, a1)}" fill="${fill}" stroke="${tl.anchor === i ? '#e03e3e' : '#fff'}" stroke-width="${tl.anchor === i ? 3 : 1}"/>`);
      const marks = a.filter(k => ICON[k] && k !== 'nap');
      if (marks.length) {
        const [x, y] = pt((r0 + r1) / 2, a0 + 3.75);
        parts.push(`<text x="${f(x)}" y="${f(y)}" font-size="${marks.length > 1 ? 8 : 12}" text-anchor="middle" dominant-baseline="central" pointer-events="none">${marks.map(k => ICON[k]).join('')}</text>`);
      }
    }
    for (let h = 0; h < 24; h += 3) {      // 時刻標示
      const [x, y] = pt(187, h * 15), [x1, y1] = pt(174, h * 15), [x2, y2] = pt(178, h * 15);
      parts.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#888"/>`);
      parts.push(`<text x="${f(x)}" y="${f(y)}" font-size="12" fill="#555" text-anchor="middle" dominant-baseline="central" pointer-events="none">${h}</text>`);
    }
    const [lx, ly] = pt(104, 315);
    parts.push(`<text x="${f(lx)}" y="${f(ly)}" font-size="9" fill="#667" text-anchor="middle" pointer-events="none" transform="rotate(-45 ${f(lx)} ${f(ly)})">前一晚</text>`);
    parts.push('<circle data-c="1" cx="200" cy="200" r="80" fill="#fff" stroke="#e3e7f1"/>');
    const d = TL.derive(slots), sleepN = Object.keys(slots).filter(k => +k < 36 && slots[k].includes('sleep')).length;
    const mins = sleepN * 30, c = [];
    if (sleepN) c.push(`<tspan x="200" dy="0" font-size="20" font-weight="700" fill="#2f4a8a">睡 ${Math.floor(mins / 60)}h${mins % 60 ? String(mins % 60).padStart(2, '0') : ''}</tspan>`);
    if (d && d.bedTime) c.push(`<tspan x="200" dy="20" font-size="12" fill="#555">${d.bedTime} → ${d.getUp}</tspan>`);
    const FACE = ['😫', '😕', '😐', '🙂', '😄'];
    if (c.length) c.push(`<tspan x="200" dy="24" font-size="18">${e.quality ? FACE[e.quality - 1] : '<tspan font-size="11" fill="#888">點此評分/備註</tspan>'}</tspan>`);
    if (!c.length) c.push(`<tspan x="200" dy="0" font-size="13" fill="#888">選活動後</tspan><tspan x="200" dy="18" font-size="13" fill="#888">點圓上時段</tspan><tspan x="200" dy="24" font-size="11" fill="#888">點圓心:評分/備註</tspan>`);
    parts.push(`<text x="200" y="${sleepN ? 192 : 192}" text-anchor="middle" pointer-events="none">${c.join('')}</text>`);
    $('#grid').innerHTML = `<svg viewBox="0 0 400 400" style="width:100%;max-width:440px;display:block;margin:0 auto;touch-action:manipulation">${parts.join('')}</svg>
      <p class="hint" style="text-align:center;margin:4px 0 0">外圈 = 當天 0–24 時 · 內圈 = 前一晚 18–24 時 · 每格 30 分</p>`;
  }

  function gridList(e) {
    const slots = e.slots || {}, rows = [];
    for (let h = 0; h < 30; h++) {
      const hour = (18 + h) % 24, cells = [0, 1].map(half => {
        const i = h * 2 + half, a = slots[i] || [];
        const st = a.find(k => ['sleep', 'inbed', 'nap'].includes(k)) || '';
        const dark = (hour >= 22 || hour < 7) && !st ? ' dark' : '';
        return `<div class="cell ${st}${dark}${tl.anchor === i ? ' anchor' : ''}" data-i="${i}">${a.filter(k => ICON[k] && k !== 'nap').map(k => ICON[k]).join('')}</div>`;
      }).join('');
      rows.push(`<div class="hr${hour === 0 ? ' day0' : ''}"><div class="lb">${String(hour).padStart(2, '0')}:00${hour === 0 ? '<br>當天' : ''}</div>${cells}</div>`);
    }
    $('#grid').innerHTML = rows.join('');
  }

  function drawGrid(e) {
    (tl.view === 'list' ? gridList : gridClock)(e);
    document.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === (tl.view || 'clock')));
    const sum = [];
    const d = e.slots && Object.keys(e.slots).length ? TL.derive(e.slots) : null;
    if (d) {
      if (d.bedTime) sum.push(`上床 ${d.bedTime}`);
      if (d.finalWake) sum.push(`最後醒來 ${d.finalWake}`);
      if (d.getUp) sum.push(`起床 ${d.getUp}`);
      if (d.latencyMin !== '') sum.push(`入睡約 ${d.latencyMin} 分`);
      if (d.awakenings !== '') sum.push(`中途醒 ${d.awakenings} 次/${d.awakeMin} 分`);
    }
    $('#tlsum').textContent = sum.length ? '自動算出:' + sum.join(' · ') : '尚未標記。選一個活動,再點時段。';
    $('#tlhelp').textContent = !tl.brush ? '① 先選上方一種活動' : tl.anchor == null ? '② 點「開始」的時段' : '③ 點「結束」的時段(只要一格就再點同一格)';
  }

  function tapSlot(i) {
    if (!tl.brush) { $('#tlhelp').textContent = '請先選上方一種活動'; return; }
    if (tl.anchor == null) { tl.anchor = i; drawGrid(entries()[state.date] || {}); return; }
    const all = entries(), cur = all[state.date] || { date: state.date };
    cur.slots = TL.paint(cur.slots || {}, tl.brush, tl.anchor, i);
    tl.anchor = null;
    const d = TL.derive(cur.slots);
    if (d) { Object.assign(cur, d); cur._auto = []; }
    all[state.date] = cur; save(KEY_E, all);
    drawGrid(cur);
    if (['alcohol', 'caffeine', 'med', 'ritual'].includes(tl.brush) && cur.slots && Object.values(cur.slots).some(a => a.includes(tl.brush))) openSheet(tl.brush);
  }

  const patch = (k, v, date) => { date = date || state.date; const all = entries(), cur = all[date] || { date }; cur[k] = v; all[date] = cur; save(KEY_E, all); };
  const QCOL = ['#d64545', '#ec8a3b', '#e6c229', '#8bc34a', '#2e9e5b'];
  const defType = date => [0, 6].includes(new Date(date + 'T00:00').getDay()) ? '休息日' : '工作日';
  const FACES = ['😫 非常差', '😕 差', '😐 普通', '🙂 好', '😄 非常好'];
  const PRESETS = { alcohol: ['啤酒 350cc', '紅酒 150cc', '烈酒 45cc'], caffeine: ['咖啡 250cc', '茶 250cc', '可樂 330cc'], med: [], ritualNote: ['泡澡/泡腳', '閱讀', '冥想/呼吸', '伸展', '聽音樂', '寫日記', '熱飲(無咖啡因)', '關手機'] };

  /** 底部面板:睡眠品質、備註、酒/咖啡因/藥物內容(即時自動儲存)。focus = 要聚焦的欄位。 */
  function openSheet(focus, date) {
    date = date || state.date;
    const e = entries()[date] || {};
    const f = (k, label, ph) => `<label>${label}</label><input data-s="${k}" value="${(e[k] ?? '').toString().replace(/"/g, '&quot;')}" placeholder="${ph}">
      <div class="chips">${(PRESETS[k] || []).map(p => `<button type="button" data-p="${k}" data-v="${p}">${p}</button>`).join('')}</div>`;
    const sh = $('#sheet');
    sh.innerHTML = `<div class="back" id="shBack"></div><div class="panel">
      <h2>${date.slice(5).replace('-', '/')} 的感受與內容</h2>
      <label>自覺睡眠品質</label>
      <div class="stars">${FACES.map((t, n) => `<button type="button" data-q="${n + 1}" class="${+e.quality === n + 1 ? 'on' : ''}" style="border-color:${QCOL[n]};${+e.quality === n + 1 ? `background:${QCOL[n]};color:${n === 2 || n === 3 ? '#1b2437' : '#fff'}` : ''}">${t.split(' ')[0]}<br><b>${n + 1}</b></button>`).join('')}</div>
      <div class="hint" id="qtxt">${e.quality ? FACES[e.quality - 1] : '點一個表情'}</div>
      ${f('note', '備註', '例如:感冒')}${f('ritualNote', '🧘 睡前儀式做了什麼', '例如:泡澡、閱讀')}${f('alcohol', '🍺 酒 種類/量', '啤酒 250cc')}${f('caffeine', '☕ 咖啡因 種類/量', '咖啡 250cc')}${f('med', '💊 助眠藥物 名稱/劑量', 'Stilnox 50mg')}
      <button class="btn" id="shDone">完成</button></div>`;
    sh.classList.add('show');
    sh.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      patch('quality', +b.dataset.q, date);
      sh.querySelectorAll('[data-q]').forEach((x, n) => { const on = x === b; x.classList.toggle('on', on); x.style.background = on ? QCOL[n] : ''; x.style.color = on ? (n === 2 || n === 3 ? '#1b2437' : '#fff') : ''; }); $('#qtxt').textContent = FACES[+b.dataset.q - 1];
    });
    sh.querySelectorAll('[data-s]').forEach(el => el.oninput = () => patch(el.dataset.s, el.value, date));
    sh.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const el = sh.querySelector(`[data-s=${b.dataset.p}]`); el.value = b.dataset.p === 'ritualNote' && el.value && !el.value.includes(b.dataset.v) ? el.value + '、' + b.dataset.v : (b.dataset.p === 'ritualNote' && el.value ? el.value : b.dataset.v); patch(b.dataset.p, el.value, date); });
    const close = () => { sh.classList.remove('show'); sh.innerHTML = ''; if (state.tab === 'diary') drawGrid(entries()[state.date] || {}); };
    $('#shBack').onclick = $('#shDone').onclick = close;
    if (focus) { const el = sh.querySelector(`[data-s=${focus}]`); if (el) setTimeout(() => el.focus(), 50); }
  }

  function viewDiary() {
    const e = entries()[state.date] || { date: state.date };
    tl.anchor = null;
    $('#app').innerHTML = `
      <div class="card"><div class="row" style="align-items:end">
        <div style="flex:2"><label style="margin-top:0">日期(= 起床當天)</label><input type="date" id="dDate" value="${state.date}"></div>
        <div><label style="margin-top:0">${wdOf(state.date)}</label><button type="button" class="btn alt" id="bType" style="margin:0;padding:9px;font-size:15px">${e.dayType || defType(state.date)}</button></div>
      </div></div>
      <div class="card"><h2>24 小時時鐘</h2>
        <div class="brushes">${BRUSHES.map(([k, t]) => `<button type="button" data-b="${k}">${t}</button>`).join('')}</div>
        <div class="row noprint" style="margin-bottom:6px"><button type="button" class="btn alt" style="margin:0;padding:8px;font-size:14px" data-v="clock">🕐 時鐘圖</button><button type="button" class="btn alt" style="margin:0;padding:8px;font-size:14px" data-v="list">☰ 清單</button></div>
        <div class="tl-help" id="tlhelp"></div>
        <div class="grid" id="grid"></div>
        <div class="tlsum" id="tlsum"></div>
        <button type="button" class="btn alt" id="bSheet">⭐ 睡眠品質・備註・飲料內容</button>
        <p class="hint">所有變更自動儲存。每格 30 分鐘;範圍內已全是同一活動時,再塗一次就是取消。⏰ 塗在被鬧鐘叫醒的時段;沒塗就代表沒用鬧鐘。</p>
      </div>`;
    if (!e.dayType) patch('dayType', defType(state.date));
    drawGrid(e);
    document.querySelectorAll('[data-b]').forEach(b => b.onclick = () => {
      tl.brush = b.dataset.b; tl.anchor = null;
      document.querySelectorAll('[data-b]').forEach(x => x.classList.toggle('on', x === b));
      drawGrid(entries()[state.date] || {});
    });
    document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { tl.view = b.dataset.v; tl.anchor = null; drawGrid(entries()[state.date] || {}); });
    $('#grid').onclick = ev => { if (ev.target.closest('[data-c]')) return openSheet(); const c = ev.target.closest('[data-i]'); if (c) tapSlot(+c.dataset.i); };
    $('#bSheet').onclick = () => openSheet();
    $('#bType').onclick = () => { const cur = (entries()[state.date] || {}).dayType || defType(state.date); const nx = cur === '工作日' ? '休息日' : '工作日'; patch('dayType', nx); $('#bType').textContent = nx; };
    $('#dDate').onchange = ev => { state.date = ev.target.value; viewDiary(); };
  }

  // ---- 一週條狀圖:每天一條橫條,橫軸 = 前一天 18:00 → 當天 24:00(30 小時),各列時間對齊 ----
  const MCOL = { caffeine: '#8d5524', alcohol: '#d98e04', med: '#8e44ad', light: '#f4c20d', exercise: '#2e8b57', ritual: '#17a2b8', screen: '#546e7a', meal: '#e85d9a', alarm: '#e03e3e' };
  function viewWeek() {
    const all = entries(), end = new Date(state.date + 'T00:00'), days = [];
    for (let k = 6; k >= 0; k--) { const d = new Date(end); d.setDate(d.getDate() - k); days.push(ymd(d)); }
    const W = 360, L = 66, BW = W - L - 6, SW = BW / 60, RH = 38, TOP = 22, H = TOP + days.length * RH + 4, p = [];
    p.push(`<rect x="${L + 8 * SW}" y="${TOP - 4}" width="${18 * SW}" height="${days.length * RH + 4}" fill="#eef0f8"/>`); // 22:00–07:00 夜間底色
    for (let k = 0; k <= 10; k++) {                                                                                   // 時刻軸
      const x = L + k * 6 * SW, h = (18 + 3 * k) % 24;
      p.push(`<line x1="${x}" y1="${TOP - 4}" x2="${x}" y2="${H}" stroke="${h === 0 ? '#999' : '#dde2ee'}" stroke-width="${h === 0 ? 1.5 : 1}"/>`);
      p.push(`<text x="${x}" y="12" font-size="10" fill="#667" text-anchor="middle">${h}</text>`);
    }
    days.forEach((d, r) => {
      const y = TOP + r * RH, slots = (all[d] || {}).slots || {}, has = Object.keys(slots).length;
      p.push(`<g data-d="${d}" style="cursor:pointer"><rect x="0" y="${y - 2}" width="${W}" height="${RH - 2}" fill="transparent"/>`);
      const q = (all[d] || {}).quality;
      p.push(`<text x="4" y="${y + 13}" font-size="11" fill="${has ? '#1b2437' : '#aaa'}">${d.slice(5).replace('-', '/')}</text><text x="4" y="${y + 26}" font-size="10" fill="#889">週${WD[new Date(d + 'T00:00').getDay()]}</text>`);
      if (q) p.push(`<circle cx="52" cy="${y + 16}" r="9" fill="${QCOL[q - 1]}"/><text x="52" y="${y + 16}" font-size="12" font-weight="700" fill="${q === 3 || q === 4 ? '#1b2437' : '#fff'}" text-anchor="middle" dominant-baseline="central">${q}</text>`);
      for (let s = 0; s < 60; s++) {
        const a2 = slots[s]; if (!a2) continue;
        const st = a2.find(k => COL[k]);
        if (st) p.push(`<rect x="${(L + s * SW).toFixed(1)}" y="${y + 2}" width="${(SW + 0.3).toFixed(1)}" height="14" fill="${COL[st]}"/>`);
        const ms = a2.filter(k => MCOL[k]);
        ms.forEach((k, n) => p.push(`<rect x="${(L + s * SW).toFixed(1)}" y="${y + 19 + n * (9 / ms.length)}" width="${(SW + 0.3).toFixed(1)}" height="${9 / ms.length}" fill="${MCOL[k]}"/>`));
      }
      p.push('</g>');
    });
    // 統計
    const st = days.map(d => (all[d] || {}).slots).filter(s => s && Object.keys(s).length).map(s => {
      const idx = k => Object.keys(s).map(Number).filter(i => i < 36 && s[i].includes(k));
      const sl = idx('sleep'), inb = Object.keys(s).map(Number).filter(i => i < 36 && (s[i].includes('sleep') || s[i].includes('inbed')));
      return { sleep: sl.length / 2, bed: inb.length ? Math.min(...inb) : null, up: inb.length ? Math.max(...inb) + 1 : null, inBed: inb.length / 2 };
    }).filter(x => x.bed !== null);
    const qs = days.map(d => +(all[d] || {}).quality).filter(Boolean);
    const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length, sT = i => TL.slotStart(Math.round(i));
    const stats = st.length ? `<div class="tlsum">近 7 天有 ${st.length} 天紀錄 · 平均睡眠 <b>${avg(st.map(x => x.sleep)).toFixed(1)} 小時</b> · 平均上床 <b>${sT(avg(st.map(x => x.bed)))}</b> · 平均起床 <b>${sT(avg(st.map(x => x.up)))}</b> ${qs.length ? ` · 平均品質 <b>${(qs.reduce((x, y) => x + y, 0) / qs.length).toFixed(1)}</b>` : ''} · 睡眠效率 <b>${Math.round(100 * st.reduce((x, y) => x + y.sleep, 0) / st.reduce((x, y) => x + y.inBed, 0))}%</b></div>` : '<div class="tlsum">這一週還沒有時鐘圖紀錄。</div>';
    const prev = new Date(end); prev.setDate(prev.getDate() - 7); const next = new Date(end); next.setDate(next.getDate() + 7);
    $('#app').innerHTML = `<div class="card"><h2>一週睡眠(${days[0].slice(5).replace('-', '/')} – ${days[6].slice(5).replace('-', '/')})</h2>
      <div class="row noprint" style="margin-bottom:6px"><button class="btn alt" id="wPrev" style="margin:0;padding:8px">◀ 前一週</button><button class="btn alt" id="wNext" style="margin:0;padding:8px">後一週 ▶</button></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${p.join('')}</svg>
      <div class="hint" style="margin-top:6px"><span style="color:${COL.sleep}">■</span> 睡著 <span style="color:${COL.inbed}">■</span> 躺著醒著 <span style="color:${COL.nap}">■</span> 小睡 · 下方細條:
        <span style="color:${MCOL.caffeine}">■</span>咖啡因 <span style="color:${MCOL.alcohol}">■</span>酒 <span style="color:${MCOL.med}">■</span>藥 <span style="color:${MCOL.light}">■</span>照光 <span style="color:${MCOL.exercise}">■</span>運動 <span style="color:${MCOL.ritual}">■</span>睡前儀式 <span style="color:${MCOL.screen}">■</span>看螢幕 <span style="color:${MCOL.meal}">■</span>用餐 <span style="color:${MCOL.alarm}">■</span>鬧鐘 · 灰底 = 22:00–07:00 · 左側圓點 = 睡眠品質 1 差(紅)→5 好(綠) · 點任一天可進入編輯</div>
      ${stats}
      <button class="btn alt noprint" onclick="window.print()">列印 / 存成 PDF(給醫師)</button></div>`;
    $('#wPrev').onclick = () => { state.date = ymd(prev); viewWeek(); };
    $('#wNext').onclick = () => { state.date = ymd(next); viewWeek(); };
    document.querySelectorAll('[data-d]').forEach(g => g.onclick = () => { state.date = g.dataset.d; go('diary'); });
  }

  function viewData() {
    const all = entries(), keys = ['date'].concat(FIELDS.map(f => f[0]).filter(k => !['morning', 'evening'].includes(k)));
    $('#app').innerHTML = `<div class="card"><h2>資料</h2><p class="hint">資料只存在這支手機的瀏覽器內。共 ${Object.keys(all).length} 天。</p>
      <button class="btn" id="bCsv">匯出 CSV</button>
      <button class="btn danger" id="bClr">清除所有資料</button></div>`;
    $('#bCsv').onclick = () => {
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = '﻿' + keys.join(',') + '\n' + Object.keys(all).sort().map(d => keys.map(k => q(all[d][k])).join(',')).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'sleep-diary.csv'; a.click();
    };
    $('#bClr').onclick = () => { if (confirm('確定清除所有紀錄?')) { localStorage.removeItem(KEY_E); localStorage.removeItem(KEY_S); viewData(); } };
  }

  document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
  renderTimerBar();
  if (session() && session().tryAt && !session().outAt) { go('night'); } else go('night');
  window.__sleepdiary = { recordEvent, startNight, endNight, state };
})();
