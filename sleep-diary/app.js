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
    ['light', '照光(時段)'], ['exercise', '運動(時段)']
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

  function viewNight() {
    const s = session();
    $('#app').innerHTML = `
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
    $('#bSensor').onclick = async () => { const ok = await enableSensor(); if (!ok) alert('無法啟用感測器(桌機或權限被拒)。仍可用手動按鈕標記。'); viewNight(); };
    $('#bBed').onclick = () => { const x = session() || { events: [] }; x.bedAt = Date.now(); save(KEY_S, x); viewNight(); };
    $('#bTry').onclick = async () => { await enableSensor(); await new Promise(r => setTimeout(r, 400)); startNight(); };
    if ($('#bResume')) $('#bResume').onclick = () => { $('#night').classList.add('show'); lockScreen(); renderNight(); };
  }

  const BRUSHES = [['sleep', '😴 睡著'], ['inbed', '🛏 躺著醒著'], ['nap', '💤 小睡'], ['caffeine', '☕ 咖啡因'], ['alcohol', '🍺 酒'],
    ['med', '💊 助眠藥'], ['light', '☀ 照光'], ['exercise', '🏃 運動'], ['alarm', '⏰ 鬧鐘'], ['erase', '⌫ 清除']];
  const ICON = { caffeine: '☕', alcohol: '🍺', med: '💊', light: '☀', exercise: '🏃', alarm: '⏰', nap: '💤' };
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
    if (['alcohol', 'caffeine', 'med'].includes(tl.brush) && cur.slots && Object.values(cur.slots).some(a => a.includes(tl.brush))) openSheet(tl.brush);
  }

  const patch = (k, v) => { const all = entries(), cur = all[state.date] || { date: state.date }; cur[k] = v; all[state.date] = cur; save(KEY_E, all); };
  const defType = date => [0, 6].includes(new Date(date + 'T00:00').getDay()) ? '休息日' : '工作日';
  const FACES = ['😫 非常差', '😕 差', '😐 普通', '🙂 好', '😄 非常好'];
  const PRESETS = { alcohol: ['啤酒 350cc', '紅酒 150cc', '烈酒 45cc'], caffeine: ['咖啡 250cc', '茶 250cc', '可樂 330cc'], med: [] };

  /** 底部面板:睡眠品質、備註、酒/咖啡因/藥物內容(即時自動儲存)。focus = 要聚焦的欄位。 */
  function openSheet(focus) {
    const e = entries()[state.date] || {};
    const f = (k, label, ph) => `<label>${label}</label><input data-s="${k}" value="${(e[k] ?? '').toString().replace(/"/g, '&quot;')}" placeholder="${ph}">
      <div class="chips">${(PRESETS[k] || []).map(p => `<button type="button" data-p="${k}" data-v="${p}">${p}</button>`).join('')}</div>`;
    const sh = $('#sheet');
    sh.innerHTML = `<div class="back" id="shBack"></div><div class="panel">
      <h2>這一天的感受與內容</h2>
      <label>自覺睡眠品質</label>
      <div class="stars">${FACES.map((t, n) => `<button type="button" data-q="${n + 1}" class="${+e.quality === n + 1 ? 'on' : ''}">${t.split(' ')[0]}</button>`).join('')}</div>
      <div class="hint" id="qtxt">${e.quality ? FACES[e.quality - 1] : '點一個表情'}</div>
      ${f('note', '備註', '例如:感冒')}${f('alcohol', '🍺 酒 種類/量', '啤酒 250cc')}${f('caffeine', '☕ 咖啡因 種類/量', '咖啡 250cc')}${f('med', '💊 助眠藥物 名稱/劑量', 'Stilnox 50mg')}
      <button class="btn" id="shDone">完成</button></div>`;
    sh.classList.add('show');
    sh.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
      patch('quality', +b.dataset.q);
      sh.querySelectorAll('[data-q]').forEach(x => x.classList.toggle('on', x === b)); $('#qtxt').textContent = FACES[+b.dataset.q - 1];
    });
    sh.querySelectorAll('[data-s]').forEach(el => el.oninput = () => patch(el.dataset.s, el.value));
    sh.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const el = sh.querySelector(`[data-s=${b.dataset.p}]`); el.value = b.dataset.v; patch(b.dataset.p, b.dataset.v); });
    const close = () => { sh.classList.remove('show'); sh.innerHTML = ''; drawGrid(entries()[state.date] || {}); };
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

  function viewWeek() {
    const all = entries(), days = [];
    const base = new Date(state.date + 'T00:00');
    for (let i = 6; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); days.push(ymd(d)); }
    const rows = FIELDS.map(([k, label]) => ['morning', 'evening'].includes(k)
      ? `<tr><th colspan="8">${label}</th></tr>`
      : `<tr><th class="l">${label}</th>${days.map(d => `<td>${(all[d] || {})[k] ?? ''}</td>`).join('')}</tr>`).join('');
    $('#app').innerHTML = `<div class="card"><h2>睡眠日記(7 天,至 ${state.date.slice(5)})</h2>
      <div class="scroll"><table><tr><th class="l">日期</th>${days.map(d => `<th>${d.slice(5).replace('-', '/')}</th>`).join('')}</tr>
      <tr><th class="l">星期幾</th>${days.map(d => `<th>${wdOf(d).slice(2)}</th>`).join('')}</tr>${rows}</table></div>
      <button class="btn alt noprint" onclick="window.print()">列印 / 存成 PDF(給醫師)</button></div>`;
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
  if (session() && session().tryAt && !session().outAt) { go('night'); } else go('night');
  window.__sleepdiary = { recordEvent, startNight, endNight, state };
})();
