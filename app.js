'use strict';

/* =========================================================
   מעקב ביוץ - כל המידע נשמר מקומית ב-IndexedDB
   ========================================================= */

// ---------- תאריכים ----------
const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 864e5); // b - a
const todayKey = () => toKey(new Date());
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtShort = k => { const d = fromKey(k); return `${d.getDate()}.${d.getMonth() + 1}`; };
const fmtDate = k => { const d = fromKey(k); return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`; };
const fmtLong = k => fromKey(k).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthName = (y, m) => new Date(y, m, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const daysWord = n => (n === 1 ? 'יום אחד' : n === 2 ? 'יומיים' : `${n} ימים`);

const RESULTS = {
  negative: 'שלילי',
  faint: 'חלש / עולה',
  positive: 'חיובי',
  peak: 'שיא',
};
const MUCUS = { '': '—', dry: 'יבש', sticky: 'דביק', creamy: 'קרמי', watery: 'מימי', eggwhite: 'חלבון ביצה' };
const SYMPTOMS = ['כאב ביוץ', 'רגישות בחזה', 'נפיחות', 'כאב ראש', 'כתמים', 'עלייה בחשק', 'עייפות', 'בחילה'];
const OV_SOURCES = { lh: 'בדיקת ביוץ', us: 'אולטרסאונד', bbt: 'טמפרטורה', signs: 'סימנים בגוף', other: 'אחר' };
const OV_TYPES = { confirmed: 'מאומת', lh: 'לפי בדיקה חיובית', estimated: 'משוער', predicted: 'צפוי' };

// ---------- IndexedDB ----------
const DB_NAME = 'ttc-tracker';
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('days', { keyPath: 'date' });
      d.createObjectStore('cycles', { keyPath: 'start' });
      const t = d.createObjectStore('tests', { keyPath: 'id', autoIncrement: true });
      t.createIndex('date', 'date');
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const getAll = store => idb(store, 'readonly', s => s.getAll());
const put = (store, val) => idb(store, 'readwrite', s => s.put(val));
const del = (store, key) => idb(store, 'readwrite', s => s.delete(key));
const clearStore = store => idb(store, 'readwrite', s => s.clear());

// ---------- מצב ----------
const DEFAULT_SETTINGS = { cycleLength: 28, luteal: 14, periodLength: 5 };
const state = {
  days: {},        // date -> {date, ovulation, ovSource, sex:[time], bbt, mucus, symptoms:[], notes}
  cycles: [],      // {start, periodLength}
  tests: [],       // {id, date, time, result, blob}
  settings: { ...DEFAULT_SETTINGS },
  viewMonth: null, // {y, m}
  openDay: null,
  model: null,
};
const urlCache = new Map();
function testUrl(t) {
  if (!urlCache.has(t.id)) urlCache.set(t.id, URL.createObjectURL(t.blob));
  return urlCache.get(t.id);
}

async function loadAll() {
  const [days, cycles, tests, settings] = await Promise.all([getAll('days'), getAll('cycles'), getAll('tests'), getAll('settings')]);
  state.days = Object.fromEntries(days.map(d => [d.date, d]));
  state.cycles = cycles;
  state.tests = tests;
  const s = settings.find(x => x.key === 'main');
  state.settings = { ...DEFAULT_SETTINGS, ...(s ? s.value : {}) };
}

function getDay(date) {
  return state.days[date] || { date, ovulation: false, ovSource: '', sex: [], bbt: '', mucus: '', symptoms: [], notes: '' };
}
async function saveDay(day) {
  const empty = !day.ovulation && !day.sex.length && !day.bbt && !day.mucus && !day.symptoms.length && !day.notes;
  if (empty) { delete state.days[day.date]; await del('days', day.date); }
  else { state.days[day.date] = day; await put('days', day); }
}

// =========================================================
//   חישוב מחזורים, ביוץ וחלון פוריות
// =========================================================
function buildModel() {
  const S = state.settings;
  const today = todayKey();
  const starts = [...state.cycles].sort((a, b) => (a.start < b.start ? -1 : 1));
  const ovDates = Object.values(state.days).filter(d => d.ovulation).map(d => d.date).sort();
  const positives = state.tests.filter(t => t.result === 'positive' || t.result === 'peak').map(t => t.date).sort();

  // אורכי מחזור (מתעלמים מפערים לא סבירים - כנראה מחזור שלא הוזן)
  const lengths = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const L = diffDays(starts[i].start, starts[i + 1].start);
    if (L >= 18 && L <= 60) lengths.push(L);
  }
  const recent = lengths.slice(-6);
  const avgLen = recent.length ? Math.round(mean(recent)) : S.cycleLength;

  // שלב לוטאלי מתוך ביוצים ידועים: הימים שבין הביוץ לווסת הבאה
  const luteals = [];
  for (const ov of ovDates) {
    const next = starts.find(c => c.start > ov);
    if (next) {
      const l = diffDays(ov, next.start) - 1;
      if (l >= 8 && l <= 20) luteals.push(l);
    }
  }
  const luteal = luteals.length ? Math.round(mean(luteals.slice(-6))) : S.luteal;
  const periods = starts.map(c => c.periodLength).filter(Boolean);
  const avgPeriod = periods.length ? Math.round(mean(periods.slice(-6))) : S.periodLength;

  const ovFor = (start, next) => {
    const end = next ? addDays(next, -1) : addDays(start, 60);
    const conf = ovDates.find(d => d >= start && d <= end);
    if (conf) return { date: conf, type: 'confirmed' };
    const pos = positives.find(d => d >= start && d <= end);
    if (pos) return { date: addDays(pos, 1), type: 'lh', lhDate: pos };
    if (next) return { date: addDays(next, -luteal - 1), type: 'estimated' };
    return { date: addDays(start, Math.max(avgLen - luteal - 1, 6)), type: 'predicted' };
  };

  const cycles = starts.map((c, i) => {
    const next = starts[i + 1] ? starts[i + 1].start : null;
    const ov = ovFor(c.start, next);
    const fertileStart = addDays(ov.date, -5);
    const expectedNext = next || (ov.type === 'confirmed' || ov.type === 'lh'
      ? addDays(ov.date, luteal + 1)
      : addDays(c.start, avgLen));
    let attempts = 0;
    for (let d = fertileStart; d <= ov.date; d = addDays(d, 1)) attempts += (state.days[d]?.sex?.length ? 1 : 0);
    return {
      start: c.start,
      next,
      length: next ? diffDays(c.start, next) : null,
      periodLength: c.periodLength || avgPeriod,
      ov,
      fertileStart,
      fertileEnd: ov.date,
      expectedNext,
      attempts,
      projected: false,
    };
  });

  // מחזורים עתידיים צפויים
  const projected = [];
  const current = [...cycles].reverse().find(c => c.start <= today) || null;
  const last = cycles[cycles.length - 1];
  if (last && !last.next) {
    let st = last.expectedNext;
    if (st > today) {
      for (let k = 0; k < 4; k++) {
        const ovDate = addDays(st, Math.max(avgLen - luteal - 1, 6));
        projected.push({
          start: st, next: addDays(st, avgLen), length: avgLen, periodLength: avgPeriod,
          ov: { date: ovDate, type: 'predicted' }, fertileStart: addDays(ovDate, -5), fertileEnd: ovDate,
          expectedNext: addDays(st, avgLen), attempts: 0, projected: true,
        });
        st = addDays(st, avgLen);
      }
    }
  }

  // מפת ימים לתצוגה
  const dayMap = {};
  const mark = (d, patch) => { dayMap[d] = Object.assign(dayMap[d] || {}, patch); };
  for (const c of [...cycles, ...projected]) {
    const end = c.next ? addDays(c.next, -1) : (c === last ? addDays(c.start, Math.max(avgLen, diffDays(c.start, today) + 1) - 1) : addDays(c.start, avgLen - 1));
    for (let d = c.start, i = 1; d <= end; d = addDays(d, 1), i++) mark(d, { cycleDay: i, cycleStart: c.start });
    for (let i = 0; i < c.periodLength; i++) {
      const d = addDays(c.start, i);
      if (c.next && d >= c.next) break;
      mark(d, { period: c.projected ? 'predicted' : 'actual' });
    }
    for (let d = c.fertileStart; d <= c.fertileEnd; d = addDays(d, 1)) {
      if (dayMap[d]?.period === 'actual') continue;
      mark(d, { fertile: true, peak: diffDays(d, c.fertileEnd) <= 2 });
    }
    mark(c.ov.date, { ov: c.ov.type });
  }
  // ווסת צפויה של המחזור הנוכחי (אם עוד לא התחילה)
  if (last && !last.next && !projected.length && last.expectedNext > today) {
    for (let i = 0; i < avgPeriod; i++) mark(addDays(last.expectedNext, i), { period: 'predicted' });
  }

  return {
    cycles, projected, current, dayMap, avgLen, luteal, avgPeriod, lengths,
    minLen: lengths.length ? Math.min(...lengths) : null,
    maxLen: lengths.length ? Math.max(...lengths) : null,
    lutealMeasured: luteals.length > 0,
  };
}

// =========================================================
//   תצוגה: סיכום
// =========================================================
function renderSummary() {
  const el = document.getElementById('summary');
  const M = state.model;
  const today = todayKey();
  const c = M.current;
  if (!c) {
    el.innerHTML = `
      <p class="big">ברוכה הבאה 🌸</p>
      <p class="sub">כדי לחשב את חלון הפוריות, צריך להזין מתי התחילה הווסת האחרונה. אפשר להוסיף גם מחזורים קודמים בלשונית "היסטוריה".</p>
      <div class="btn-row">
        <button class="btn primary" data-act="period-today">הווסת התחילה היום</button>
        <button class="btn soft" data-act="go-history">הזנת מחזורים קודמים</button>
      </div>`;
    return;
  }
  const cd = diffDays(c.start, today) + 1;
  let windowC = c;
  if (today > c.fertileEnd && M.projected.length) windowC = M.projected[0];
  const inWindow = today >= windowC.fertileStart && today <= windowC.fertileEnd;
  const ovIn = diffDays(today, windowC.ov.date);
  const nextPeriod = c.next || c.expectedNext;
  const lateBy = !c.next ? diffDays(c.expectedNext, today) : 0;

  let ovText;
  if (ovIn > 0) ovText = `בעוד ${daysWord(ovIn)} (${fmtShort(windowC.ov.date)})`;
  else if (ovIn === 0) ovText = 'היום';
  else ovText = `${fmtShort(windowC.ov.date)} (לפני ${daysWord(-ovIn)})`;

  const recentPos = state.tests.filter(t => (t.result === 'positive' || t.result === 'peak') && diffDays(t.date, today) >= 0 && diffDays(t.date, today) <= 1);
  const todayTests = state.tests.filter(t => t.date === today).length;

  let status = '';
  if (M.dayMap[today]?.period === 'actual') status = '<span class="pill period">וסת</span>';
  else if (inWindow) status = `<span class="pill fertile">${M.dayMap[today]?.peak ? 'הכי פורה' : 'בחלון הפוריות'}</span>`;
  if (lateBy > 0) status += ' <span class="pill late">הווסת מאחרת</span>';

  el.innerHTML = `
    <p class="big">יום ${cd} במחזור ${status}</p>
    <p class="sub">${fmtLong(today)}</p>
    ${recentPos.length ? '<div class="alert">🎯 יש בדיקת ביוץ חיובית. הביוץ צפוי בדרך כלל תוך 24 עד 36 שעות, אז זה הזמן לנסות.</div>' : ''}
    ${lateBy > 0 ? `<div class="alert">הווסת מאחרת ב-${daysWord(lateBy)} לעומת הצפוי. אם היא התחילה, כדאי לסמן אותה. אולי זה זמן טוב לבדיקת היריון 🤞</div>` : ''}
    <div class="summary-grid">
      <div class="full"><span class="k">חלון הפוריות${windowC !== c ? ' (המחזור הבא)' : ''}</span>
        <span class="v">${fmtShort(windowC.fertileStart)} – ${fmtShort(windowC.fertileEnd)}</span>
        <span class="muted small"> · הכי פורה: ${fmtShort(addDays(windowC.fertileEnd, -2))}–${fmtShort(windowC.fertileEnd)}</span></div>
      <div><span class="k">ביוץ ${OV_TYPES[windowC.ov.type]}</span><span class="v">${ovText}</span></div>
      <div><span class="k">וסת הבאה ${c.next ? '' : 'צפויה'}</span><span class="v">${fmtShort(nextPeriod)}</span></div>
      <div><span class="k">ניסיונות בחלון</span><span class="v">${c.attempts}</span></div>
      <div><span class="k">בדיקות היום</span><span class="v">${todayTests}</span></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" data-act="snap-today">📷 צלמי בדיקה</button>
      <button class="btn soft" data-act="sex-today">♥ ניסיון היום</button>
      <button class="btn" data-act="open-today">עוד…</button>
    </div>`;
}

// =========================================================
//   תצוגה: לוח שנה
// =========================================================
function renderCalendar() {
  const { y, m } = state.viewMonth;
  document.getElementById('monthLabel').textContent = monthName(y, m);
  const grid = document.getElementById('calGrid');
  const first = new Date(y, m, 1, 12);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = todayKey();
  const testsByDate = {};
  for (const t of state.tests) (testsByDate[t.date] ||= []).push(t);

  let html = '';
  for (let i = 0; i < first.getDay(); i++) html += '<div class="cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const info = state.model.dayMap[key] || {};
    const day = state.days[key];
    const cls = ['cell'];
    if (info.period === 'actual') cls.push('period');
    else if (info.period === 'predicted') cls.push('pperiod');
    if (info.peak && info.period !== 'actual') cls.push('peak');
    else if (info.fertile && info.period !== 'actual') cls.push('fertile');
    if (info.ov === 'confirmed') cls.push('ovc');
    else if (info.ov) cls.push('ov');
    if (key === today) cls.push('today');

    let marks = '';
    const tests = testsByDate[key];
    if (tests) {
      const best = tests.some(t => t.result === 'positive' || t.result === 'peak') ? 'pos'
        : tests.some(t => t.result === 'faint') ? 'faint' : 'neg';
      marks += `<i class="dot dot-${best}"></i>`;
    }
    if (day?.sex?.length) marks += '<span class="heart">♥</span>';
    const cd = info.cycleDay && key <= addDays(today, 60) ? `<span class="cd">${info.cycleDay}</span>` : '';
    html += `<button class="${cls.join(' ')}" data-date="${key}" aria-label="${fmtLong(key)}">${cd}<span class="num">${d}</span><span class="marks">${marks}</span></button>`;
  }
  grid.innerHTML = html;
}

// =========================================================
//   גיליון יום
// =========================================================
function openDay(date) {
  state.openDay = date;
  document.getElementById('sheetTitle').textContent = fmtLong(date);
  renderDaySheet();
  document.getElementById('sheetBackdrop').hidden = false;
  document.getElementById('daySheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDay() {
  state.openDay = null;
  document.getElementById('sheetBackdrop').hidden = true;
  document.getElementById('daySheet').hidden = true;
  document.body.style.overflow = '';
}

function renderDaySheet() {
  const date = state.openDay;
  if (!date) return;
  const body = document.getElementById('sheetBody');
  const info = state.model.dayMap[date] || {};
  const day = getDay(date);
  const isStart = state.cycles.some(c => c.start === date);
  const tests = state.tests.filter(t => t.date === date).sort((a, b) => (a.time < b.time ? -1 : 1));

  const pills = [];
  if (info.cycleDay) pills.push(`<span class="pill" style="background:var(--bg)">יום ${info.cycleDay} במחזור</span>`);
  if (info.period === 'actual') pills.push('<span class="pill period">וסת</span>');
  if (info.period === 'predicted') pills.push('<span class="pill" style="border:1px dashed var(--period)">וסת צפויה</span>');
  if (info.peak) pills.push('<span class="pill fertile">הכי פורה</span>');
  else if (info.fertile) pills.push('<span class="pill fertile" style="background:var(--fertile)">חלון פוריות</span>');
  if (info.ov) pills.push(`<span class="pill" style="background:var(--ov);color:#fff">ביוץ ${OV_TYPES[info.ov]}</span>`);

  body.innerHTML = `
    ${pills.length ? `<div class="status-line">${pills.join('')}</div>` : ''}

    <div class="section">
      <h3>וסת</h3>
      <button class="btn ${isStart ? 'on' : ''}" data-act="toggle-start">${isStart ? '✓ יום ראשון של מחזור (לחיצה לביטול)' : 'סמני כיום הראשון של הווסת'}</button>
      ${isStart ? `<label class="field" style="margin-top:8px"><span>ימי וסת במחזור הזה</span>
        <input type="number" min="1" max="15" value="${state.cycles.find(c => c.start === date).periodLength}" data-act="period-len"></label>` : ''}
    </div>

    <div class="section">
      <h3>בדיקות ביוץ</h3>
      <div class="btn-row">
        <button class="btn primary" data-act="snap">📷 צילום בדיקה</button>
        <button class="btn" data-act="gallery">🖼️ מהגלריה</button>
      </div>
      <div class="test-list" style="margin-top:10px">
        ${tests.map(t => `
          <div class="test-item">
            <img src="${testUrl(t)}" data-view-test="${t.id}" alt="בדיקה ${esc(t.time)}">
            <div class="meta">
              <div style="display:flex;gap:6px;align-items:center">
                <input type="time" class="inline-input" style="max-width:120px;min-height:34px;padding:4px 8px" value="${esc(t.time)}" data-test-time="${t.id}">
                <button class="btn small danger" data-del-test="${t.id}">מחיקה</button>
              </div>
              <div class="result-row">
                ${Object.entries(RESULTS).map(([k, v]) => `<button class="r-${k} ${t.result === k ? 'sel' : ''}" data-test-result="${t.id}" data-val="${k}">${v}</button>`).join('')}
              </div>
            </div>
          </div>`).join('') || '<div class="empty-note">עדיין אין בדיקות ליום הזה</div>'}
      </div>
    </div>

    <div class="section">
      <h3>ניסיונות</h3>
      <div class="row-form">
        <label class="field narrow" style="flex:0 1 130px"><span>שעה (לא חובה)</span><input type="time" id="sexTime"></label>
        <button class="btn soft" data-act="add-sex">♥ הוספת ניסיון</button>
      </div>
      <div class="attempts">
        ${day.sex.map((t, i) => `<span class="attempt-chip">♥ ${t ? esc(t) : 'ניסיון'}<button data-del-sex="${i}" aria-label="מחיקה">✕</button></span>`).join('')}
      </div>
    </div>

    <div class="section">
      <h3>ביוץ</h3>
      <label class="check-row"><input type="checkbox" data-act="ov" ${day.ovulation ? 'checked' : ''}> ביוץ ידוע ביום הזה</label>
      ${day.ovulation ? `<label class="field" style="margin-top:8px"><span>מקור</span>
        <select data-act="ov-source">${Object.entries(OV_SOURCES).map(([k, v]) => `<option value="${k}" ${day.ovSource === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
    </div>

    <div class="section">
      <h3>עוד פרטים</h3>
      <div class="row-form">
        <label class="field"><span>טמפרטורה בסיסית (°C)</span><input type="number" step="0.01" min="34" max="39" inputmode="decimal" value="${esc(day.bbt)}" data-act="bbt" placeholder="36.50"></label>
        <label class="field"><span>ריר צווארי</span>
          <select data-act="mucus">${Object.entries(MUCUS).map(([k, v]) => `<option value="${k}" ${day.mucus === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>תסמינים</span>
        <div class="chips">${SYMPTOMS.map(s => `<button class="chip ${day.symptoms.includes(s) ? 'sel' : ''}" data-symptom="${esc(s)}">${s}</button>`).join('')}</div>
      </div>
      <label class="field"><span>הערות</span><textarea data-act="notes" placeholder="כל דבר שתרצי לזכור…">${esc(day.notes)}</textarea></label>
    </div>`;
}

// ---------- פעולות יום ----------
async function toggleCycleStart(date) {
  const existing = state.cycles.find(c => c.start === date);
  if (existing) {
    state.cycles = state.cycles.filter(c => c !== existing);
    await del('cycles', date);
    toast('סימון תחילת המחזור בוטל');
  } else {
    const near = state.cycles.find(c => Math.abs(diffDays(c.start, date)) < 10);
    if (near && !confirm(`כבר יש מחזור שמתחיל ב-${fmtDate(near.start)}, פחות מ-10 ימים מכאן. להוסיף בכל זאת?`)) return;
    const c = { start: date, periodLength: state.model.avgPeriod || state.settings.periodLength };
    state.cycles.push(c);
    await put('cycles', c);
    toast('מחזור חדש סומן');
  }
  refresh();
}
async function addSex(date, time) {
  const day = getDay(date);
  day.sex = [...day.sex, time || ''];
  await saveDay(day);
  toast('ניסיון נשמר ♥');
  refresh();
}

// ---------- תמונות ----------
let pendingPhotoDate = null;
function compressImage(file, max = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא ניתן לקרוא את התמונה')); };
    img.src = url;
  });
}
async function addPhotos(files) {
  const date = pendingPhotoDate || todayKey();
  pendingPhotoDate = null;
  let n = 0;
  for (const f of files) {
    try {
      const blob = await compressImage(f);
      const time = date === todayKey() ? nowTime() : (f.lastModified ? (d => `${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(f.lastModified)) : '12:00');
      const t = { date, time, result: '', blob };
      t.id = await idb('tests', 'readwrite', s => s.add(t));
      state.tests.push(t);
      n++;
    } catch (e) { toast('שגיאה בשמירת התמונה: ' + e.message); }
  }
  if (n) toast(n === 1 ? 'הבדיקה נשמרה. עכשיו אפשר לסמן את התוצאה' : `${n} בדיקות נשמרו`);
  if (state.openDay !== date) openDay(date);
  refresh();
}
function pickPhoto(date, camera) {
  pendingPhotoDate = date;
  document.getElementById(camera ? 'cameraInput' : 'galleryInput').click();
}
function showViewer(t) {
  const c = state.model.dayMap[t.date]?.cycleDay;
  document.getElementById('viewerImg').src = testUrl(t);
  document.getElementById('viewerCaption').textContent = `${fmtDate(t.date)} ${t.time}${c ? ` · יום ${c} במחזור` : ''} · ${RESULTS[t.result] || 'ללא תוצאה'}`;
  document.getElementById('viewer').hidden = false;
}

// =========================================================
//   תצוגה: השוואת בדיקות
// =========================================================
function renderTests() {
  const sel = document.getElementById('testsCycleSelect');
  const M = state.model;
  const opts = [...M.cycles].reverse().map(c => {
    const end = c.next ? addDays(c.next, -1) : null;
    return { v: c.start, label: `${fmtDate(c.start)}${end ? ' – ' + fmtDate(end) : ' (נוכחי)'}` };
  });
  const prev = sel.value;
  sel.innerHTML = opts.map(o => `<option value="${o.v}">${o.label}</option>`).join('') + '<option value="all">כל הבדיקות</option>';
  sel.value = opts.some(o => o.v === prev) || prev === 'all' ? prev : (opts[0]?.v || 'all');

  let list = [...state.tests];
  if (sel.value !== 'all') {
    const c = M.cycles.find(x => x.start === sel.value);
    list = list.filter(t => t.date >= c.start && (!c.next || t.date < c.next));
  }
  list.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  const strip = document.getElementById('testsStrip');
  strip.innerHTML = list.length ? list.map(t => {
    const cd = M.dayMap[t.date]?.cycleDay;
    return `<div class="strip-card">
      <img src="${testUrl(t)}" data-view-test="${t.id}" alt="">
      <div class="d">${fmtShort(t.date)} · ${esc(t.time)}</div>
      ${cd ? `<div class="cdl">יום ${cd}</div>` : ''}
      <span class="badge r-${t.result || 'none'}">${RESULTS[t.result] || 'ללא תוצאה'}</span>
    </div>`;
  }).join('') : '<div class="card empty-note" style="flex:1">אין בדיקות במחזור הזה עדיין. אפשר לצלם בדיקה דרך לוח השנה.</div>';
}

// =========================================================
//   תצוגה: היסטוריה
// =========================================================
function renderHistory() {
  const M = state.model;
  document.getElementById('stats').innerHTML = `
    <div><span class="k">אורך מחזור ממוצע</span><span class="v">${M.avgLen}</span> <span class="muted small">${M.lengths.length ? `(${Math.min(M.lengths.length, 6)} אחרונים)` : '(ברירת מחדל)'}</span></div>
    <div><span class="k">טווח</span><span class="v">${M.minLen ? `${M.minLen}–${M.maxLen}` : '—'}</span></div>
    <div><span class="k">שלב לוטאלי</span><span class="v">${M.luteal}</span> <span class="muted small">${M.lutealMeasured ? '(מחושב)' : '(ברירת מחדל)'}</span></div>
    <div><span class="k">מחזורים מתועדים</span><span class="v">${M.cycles.length}</span></div>`;

  const cl = document.getElementById('cyclesList');
  cl.innerHTML = M.cycles.length ? [...M.cycles].reverse().map(c => `
    <div class="list-item">
      <div class="grow">
        <div class="title">${fmtDate(c.start)} ${c.next ? `· ${c.length} ימים` : '· נוכחי'}</div>
        <div class="desc">וסת ${c.periodLength} ימים · ביוץ ${OV_TYPES[c.ov.type]} ${fmtShort(c.ov.date)} (יום ${diffDays(c.start, c.ov.date) + 1}) · חלון ${fmtShort(c.fertileStart)}–${fmtShort(c.fertileEnd)} · ${c.attempts} ניסיונות בחלון</div>
      </div>
      <div class="actions">
        <button data-edit-cycle="${c.start}" aria-label="עריכה">✏️</button>
        <button data-del-cycle="${c.start}" aria-label="מחיקה">🗑️</button>
      </div>
    </div>`).join('') : '<div class="empty-note">עדיין אין מחזורים. כדאי להוסיף לפחות 2–3 מחזורים קודמים, כך התחזית תהיה מדויקת יותר.</div>';

  const ovs = Object.values(state.days).filter(d => d.ovulation).sort((a, b) => (a.date < b.date ? 1 : -1));
  document.getElementById('ovList').innerHTML = ovs.length ? ovs.map(d => `
    <div class="list-item">
      <div class="grow"><div class="title">${fmtDate(d.date)}</div><div class="desc">${OV_SOURCES[d.ovSource] || 'אחר'}</div></div>
      <div class="actions"><button data-del-ov="${d.date}" aria-label="מחיקה">🗑️</button></div>
    </div>`).join('') : '<div class="empty-note">אין ביוצים מתועדים. ביוץ ידוע עוזר לחשב את אורך השלב הלוטאלי שלך.</div>';
}

// =========================================================
//   הגדרות, גיבוי
// =========================================================
function renderSettings() {
  document.getElementById('setCycle').value = state.settings.cycleLength;
  document.getElementById('setLuteal').value = state.settings.luteal;
  document.getElementById('setPeriod').value = state.settings.periodLength;
  const info = document.getElementById('storageInfo');
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(e => {
      info.textContent = `${state.tests.length} תמונות · נפח בשימוש: ${(e.usage / 1048576).toFixed(1)} MB`;
    }).catch(() => {});
  }
}
async function saveSettings() {
  const v = id => parseInt(document.getElementById(id).value, 10);
  const s = { cycleLength: v('setCycle'), luteal: v('setLuteal'), periodLength: v('setPeriod') };
  if (!(s.cycleLength >= 18 && s.cycleLength <= 60) || !(s.luteal >= 8 && s.luteal <= 20) || !(s.periodLength >= 1 && s.periodLength <= 15)) {
    toast('ערך לא תקין'); renderSettings(); return;
  }
  state.settings = s;
  await put('settings', { key: 'main', value: s });
  toast('נשמר');
  refresh();
}
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();

async function exportData() {
  const tests = await Promise.all(state.tests.map(async t => ({ id: t.id, date: t.date, time: t.time, result: t.result, image: await blobToDataURL(t.blob) })));
  const data = { app: 'ttc-tracker', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, cycles: state.cycles, days: Object.values(state.days), tests };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `ttc-backup-${todayKey()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: 'גיבוי מעקב ביוץ' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('הקובץ לא תקין'); return; }
  if (data.app !== 'ttc-tracker') { toast('זה לא קובץ גיבוי של האפליקציה'); return; }
  if (!confirm('הייבוא יחליף את כל המידע הקיים במכשיר. להמשיך?')) return;
  for (const s of ['days', 'cycles', 'tests', 'settings']) await clearStore(s);
  for (const c of data.cycles || []) await put('cycles', c);
  for (const d of data.days || []) await put('days', d);
  if (data.settings) await put('settings', { key: 'main', value: data.settings });
  for (const t of data.tests || []) {
    const blob = await dataURLToBlob(t.image);
    await put('tests', { id: t.id, date: t.date, time: t.time, result: t.result, blob });
  }
  urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
  await loadAll();
  toast('הגיבוי שוחזר');
  refresh();
}
async function wipeAll() {
  if (!confirm('למחוק את כל המידע, כולל התמונות? אי אפשר לבטל את זה.')) return;
  if (!confirm('בטוח? מומלץ לייצא גיבוי קודם.')) return;
  for (const s of ['days', 'cycles', 'tests', 'settings']) await clearStore(s);
  urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
  await loadAll();
  toast('הכל נמחק');
  refresh();
}

// =========================================================
//   כללי
// =========================================================
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
const VIEW_TITLES = { calendar: 'מעקב ביוץ', tests: 'השוואת בדיקות', history: 'היסטוריה', settings: 'הגדרות' };
let currentView = 'calendar';
function showView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.getElementById('viewTitle').textContent = VIEW_TITLES[v];
  window.scrollTo(0, 0);
  renderView();
}
function renderView() {
  if (currentView === 'calendar') { renderSummary(); renderCalendar(); }
  if (currentView === 'tests') renderTests();
  if (currentView === 'history') renderHistory();
  if (currentView === 'settings') renderSettings();
}
function refresh() {
  state.model = buildModel();
  renderView();
  if (state.openDay) {
    const sb = document.getElementById('sheetBody');
    const scroll = sb.scrollTop;
    renderDaySheet();
    sb.scrollTop = scroll;
  }
}
function shiftMonth(n) {
  let { y, m } = state.viewMonth;
  m += n;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.viewMonth = { y, m };
  renderCalendar();
}

function bindEvents() {
  document.querySelector('.tabbar').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  document.getElementById('prevMonth').onclick = () => shiftMonth(-1);
  document.getElementById('nextMonth').onclick = () => shiftMonth(1);
  document.getElementById('todayBtn').onclick = () => { const d = new Date(); state.viewMonth = { y: d.getFullYear(), m: d.getMonth() }; renderCalendar(); };

  // החלקה בין חודשים
  let sx = null;
  const grid = document.getElementById('calGrid');
  grid.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  grid.addEventListener('touchend', e => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 60) shiftMonth(dx > 0 ? 1 : -1); // RTL: החלקה ימינה = החודש הבא
  });
  grid.addEventListener('click', e => {
    const c = e.target.closest('.cell[data-date]');
    if (c) openDay(c.dataset.date);
  });

  document.getElementById('summary').addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    const t = todayKey();
    if (a === 'period-today') toggleCycleStart(t);
    if (a === 'go-history') showView('history');
    if (a === 'snap-today') pickPhoto(t, true);
    if (a === 'sex-today') addSex(t, nowTime());
    if (a === 'open-today') openDay(t);
  });

  document.getElementById('closeSheet').onclick = closeDay;
  document.getElementById('sheetBackdrop').onclick = closeDay;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!document.getElementById('viewer').hidden) document.getElementById('viewer').hidden = true; else closeDay(); }
  });

  const sb = document.getElementById('sheetBody');
  sb.addEventListener('click', async e => {
    const date = state.openDay;
    const el = e.target.closest('button, img');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle-start') return toggleCycleStart(date);
    if (act === 'snap') return pickPhoto(date, true);
    if (act === 'gallery') return pickPhoto(date, false);
    if (act === 'add-sex') return addSex(date, document.getElementById('sexTime').value);
    if (el.dataset.delSex !== undefined) {
      const day = getDay(date);
      day.sex = day.sex.filter((_, i) => i !== Number(el.dataset.delSex));
      await saveDay(day); return refresh();
    }
    if (el.dataset.symptom) {
      const day = getDay(date);
      const s = el.dataset.symptom;
      day.symptoms = day.symptoms.includes(s) ? day.symptoms.filter(x => x !== s) : [...day.symptoms, s];
      await saveDay(day); return refresh();
    }
    if (el.dataset.testResult) {
      const t = state.tests.find(x => x.id === Number(el.dataset.testResult));
      t.result = t.result === el.dataset.val ? '' : el.dataset.val;
      await put('tests', t);
      if (t.result === 'positive' || t.result === 'peak') toast('בדיקה חיובית! הביוץ צפוי תוך 24 עד 36 שעות');
      return refresh();
    }
    if (el.dataset.delTest) {
      if (!confirm('למחוק את הבדיקה?')) return;
      const id = Number(el.dataset.delTest);
      await del('tests', id);
      state.tests = state.tests.filter(x => x.id !== id);
      if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
      return refresh();
    }
    if (el.dataset.viewTest) showViewer(state.tests.find(x => x.id === Number(el.dataset.viewTest)));
  });
  sb.addEventListener('change', async e => {
    const el = e.target;
    const date = state.openDay;
    const act = el.dataset.act;
    if (el.dataset.testTime) {
      const t = state.tests.find(x => x.id === Number(el.dataset.testTime));
      t.time = el.value; await put('tests', t); return refresh();
    }
    if (act === 'period-len') {
      const c = state.cycles.find(x => x.start === date);
      const n = parseInt(el.value, 10);
      if (c && n >= 1 && n <= 15) { c.periodLength = n; await put('cycles', c); refresh(); }
      return;
    }
    const day = getDay(date);
    if (act === 'ov') { day.ovulation = el.checked; day.ovSource = el.checked ? (day.ovSource || 'lh') : ''; }
    else if (act === 'ov-source') day.ovSource = el.value;
    else if (act === 'bbt') day.bbt = el.value;
    else if (act === 'mucus') day.mucus = el.value;
    else if (act === 'notes') day.notes = el.value;
    else return;
    await saveDay(day);
    refresh();
  });

  document.getElementById('cameraInput').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addPhotos(f); });
  document.getElementById('galleryInput').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) addPhotos(f); });

  document.getElementById('viewer').onclick = () => { document.getElementById('viewer').hidden = true; };
  document.getElementById('testsCycleSelect').onchange = renderTests;
  document.getElementById('testsStrip').addEventListener('click', e => {
    const id = e.target.closest('[data-view-test]')?.dataset.viewTest;
    if (id) showViewer(state.tests.find(x => x.id === Number(id)));
  });

  // היסטוריה
  document.getElementById('addCycleForm').addEventListener('submit', async e => {
    e.preventDefault();
    const start = document.getElementById('cycleStartInput').value;
    const periodLength = parseInt(document.getElementById('cyclePeriodInput').value, 10);
    if (!start) return;
    if (start > todayKey()) { toast('אי אפשר להזין תאריך עתידי'); return; }
    if (state.cycles.some(c => c.start === start)) { toast('המחזור הזה כבר קיים'); return; }
    document.getElementById('cycleStartInput').value = '';
    const c = { start, periodLength };
    state.cycles.push(c);
    await put('cycles', c);
    toast('המחזור נוסף');
    refresh();
  });
  document.getElementById('addOvForm').addEventListener('submit', async e => {
    e.preventDefault();
    const date = document.getElementById('ovDateInput').value;
    if (!date) return;
    document.getElementById('ovDateInput').value = '';
    const day = getDay(date);
    day.ovulation = true;
    day.ovSource = document.getElementById('ovSourceInput').value;
    await saveDay(day);
    toast('הביוץ נוסף');
    refresh();
  });
  document.getElementById('cyclesList').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.delCycle) {
      if (!confirm(`למחוק את המחזור שהתחיל ב-${fmtDate(b.dataset.delCycle)}?`)) return;
      state.cycles = state.cycles.filter(c => c.start !== b.dataset.delCycle);
      await del('cycles', b.dataset.delCycle);
      refresh();
    }
    if (b.dataset.editCycle) {
      const c = state.cycles.find(x => x.start === b.dataset.editCycle);
      const newStart = prompt('תאריך התחלה (YYYY-MM-DD):', c.start);
      if (newStart === null) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart) || isNaN(fromKey(newStart))) { toast('תאריך לא תקין'); return; }
      const len = parseInt(prompt('ימי וסת:', c.periodLength), 10);
      if (!(len >= 1 && len <= 15)) { toast('מספר ימים לא תקין'); return; }
      if (newStart !== c.start) {
        if (state.cycles.some(x => x.start === newStart)) { toast('כבר קיים מחזור בתאריך הזה'); return; }
        await del('cycles', c.start);
        c.start = newStart;
      }
      c.periodLength = len;
      await put('cycles', c);
      refresh();
    }
  });
  document.getElementById('ovList').addEventListener('click', async e => {
    const d = e.target.closest('button')?.dataset.delOv;
    if (!d) return;
    const day = getDay(d);
    day.ovulation = false; day.ovSource = '';
    await saveDay(day);
    refresh();
  });

  // הגדרות
  ['setCycle', 'setLuteal', 'setPeriod'].forEach(id => document.getElementById(id).addEventListener('change', saveSettings));
  document.getElementById('exportBtn').onclick = () => exportData().catch(e => toast('שגיאה בייצוא: ' + e.message));
  document.getElementById('importInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importData(f).catch(err => toast('שגיאה בייבוא: ' + err.message)); });
  document.getElementById('wipeBtn').onclick = wipeAll;

  // רענון כשחוזרים לאפליקציה ביום חדש
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayKey() !== lastDay) { lastDay = todayKey(); refresh(); }
  });
}

async function init() {
  try {
    db = await openDB();
    await loadAll();
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="card">לא ניתן לפתוח את מאגר הנתונים במכשיר (${esc(e?.message || e)}). אם זה חלון גלישה פרטית, נסי חלון רגיל.</div>`;
    return;
  }
  const d = new Date();
  state.viewMonth = { y: d.getFullYear(), m: d.getMonth() };
  bindEvents();
  refresh();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
