(function () {
  'use strict';
  const { FlipDetector, summarizeSession } = window.SleepFlip;
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
      _intervals: sum.intervals.map(i => [hm(i.from), hm(i.to)])
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

  const inp = (e, k, type, extra) => `<input type="${type}" data-k="${k}" value="${e[k] ?? ''}" ${extra || ''}>${(e._auto || []).includes(k) ? '' : ''}`;
  const auto = (e, k) => (e._auto || []).includes(k) ? '<span class="auto">自動帶入</span>' : '';
  function viewDiary() {
    const e = entries()[state.date] || { date: state.date };
    const L = (t, k, body) => `<label>${t}${auto(e, k)}</label>${body}`;
    const iv = (e._intervals || []).map(i => `<li>${i[0]} → ${i[1]}</li>`).join('');
    $('#app').innerHTML = `
      <div class="card"><label>日期(表單欄位日期 = 起床當天)</label>
        <div class="row"><input type="date" id="dDate" value="${state.date}"><input disabled value="${wdOf(state.date)}"></div></div>
      <div class="card"><h2>早上填寫(前一晚)</h2>
        ${L('工作日或休息日', 'dayType', `<select data-k="dayType"><option></option><option ${e.dayType === '工作日' ? 'selected' : ''}>工作日</option><option ${e.dayType === '休息日' ? 'selected' : ''}>休息日</option></select>`)}
        <div class="row"><div>${L('就寢時間(躺上床)', 'bedTime', inp(e, 'bedTime', 'time'))}</div><div>${L('嘗試入睡時間', 'tryTime', inp(e, 'tryTime', 'time'))}</div></div>
        ${L('睡著所需時間(分鐘,憑感覺估計)', 'latencyMin', inp(e, 'latencyMin', 'number', 'min="0" inputmode="numeric"'))}
        <div class="row"><div>${L('醒來次數(最後醒來不算)', 'awakenings', inp(e, 'awakenings', 'number', 'min="0" inputmode="numeric"'))}</div><div>${L('總計醒來時間(分鐘)', 'awakeMin', inp(e, 'awakeMin', 'number', 'min="0" inputmode="numeric"'))}</div></div>
        ${iv ? `<p class="hint">感測器記到的夜間醒來:</p><ul class="tl">${iv}</ul>` : ''}
        <div class="row"><div>${L('最後醒來時間', 'finalWake', inp(e, 'finalWake', 'time'))}</div><div>${L('起床時間', 'getUp', inp(e, 'getUp', 'time'))}</div></div>
        <label>自覺睡眠品質(1 非常差 2 差 3 普通 4 好 5 非常好)</label>
        <div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-q="${n}" class="${+e.quality === n ? 'on' : ''}">${n}</button>`).join('')}</div>
        <label>有無使用鬧鐘?(被鬧鐘叫醒=是;自然醒或鬧鐘前醒=否)</label>
        <select data-k="alarm"><option></option><option ${e.alarm === '是' ? 'selected' : ''}>是</option><option ${e.alarm === '否' ? 'selected' : ''}>否</option></select>
        <label>備註</label><input data-k="note" value="${e.note ?? ''}" placeholder="例如:感冒">
      </div>
      <div class="card"><h2>睡前填寫(當天)</h2>
        <div class="row"><div><label>小睡次數</label>${inp(e, 'napCount', 'number', 'min="0" inputmode="numeric"')}</div><div><label>小睡總分鐘</label>${inp(e, 'napMin', 'number', 'min="0" inputmode="numeric"')}</div></div>
        <div class="row"><div><label>飲酒 種類/量(cc)</label>${inp(e, 'alcohol', 'text', 'placeholder="啤酒 250cc"')}</div><div><label>最後飲酒時間</label>${inp(e, 'alcoholLast', 'time')}</div></div>
        <div class="row"><div><label>咖啡因 種類/量(cc)</label>${inp(e, 'caffeine', 'text', 'placeholder="咖啡 250cc"')}</div><div><label>最後咖啡因時間</label>${inp(e, 'caffeineLast', 'time')}</div></div>
        <div class="row"><div><label>助眠藥物 名稱/劑量</label>${inp(e, 'med', 'text')}</div><div><label>服藥時間</label>${inp(e, 'medTime', 'time')}</div></div>
        <div class="row"><div><label>照光時段</label>${inp(e, 'light', 'text', 'placeholder="07:00-08:00"')}</div><div><label>運動時段</label>${inp(e, 'exercise', 'text', 'placeholder="19:00-20:00"')}</div></div>
      </div>
      <button class="btn" id="bSave">儲存</button>`;
    let quality = e.quality;
    document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { quality = +b.dataset.q; document.querySelectorAll('[data-q]').forEach(x => x.classList.toggle('on', x === b)); });
    $('#dDate').onchange = ev => { state.date = ev.target.value; viewDiary(); };
    $('#bSave').onclick = () => {
      const all = entries(), cur = all[state.date] || { date: state.date };
      document.querySelectorAll('[data-k]').forEach(el => { cur[el.dataset.k] = el.value; });
      cur.quality = quality; cur._auto = []; all[state.date] = cur; save(KEY_E, all);
      alert('已儲存'); viewDiary();
    };
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
