'use strict';

// ページの中身は「論理座標」1000 x 690（横向き iPad の画面比）で記録する。画面の大きさが変わっても線がずれない。
const APP_VERSION = '0.10.0';
const PAGE_W = 1000;
const PAGE_H = 690;
const WEEKDAYS_JA = ['月', '火', '水', '木', '金', '土', '日'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const ERASER_R = 9;          // 消しゴムの半径（論理座標）
const PALM_GUARD_MS = 800;   // ペンを使った直後に触れた指は無視する（手のひら対策）

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const page = $('page');
const template = $('template');
const inkCanvas = $('ink');
const liveCanvas = $('live');
const ink = inkCanvas.getContext('2d', { desynchronized: true });
const live = liveCanvas.getContext('2d', { desynchronized: true });

const state = {
  weekStart: mondayOf(new Date()),
  tool: 'pen',
  pen: { color: '#1f2328', size: 2.4 },
  marker: { color: '#ffd60a', size: 14 },
  strokes: null,   // 表示中の週の線。読み込み中は null
};

let lastPenTime = 0;

// ---------------------------------------------------------------- 日付

function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
const currentKey = () => dateKey(state.weekStart);

// ---------------------------------------------------------------- 保存（IndexedDB）

const store = (() => {
  let dbPromise;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('techo', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('weeks');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('weeks').objectStore('weeks').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function put(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('weeks', 'readwrite');
      tx.objectStore('weeks').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getAllWeeks() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = {};
      const req = db.transaction('weeks').objectStore('weeks').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        out[cur.key] = cur.value;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function replaceAllWeeks(all) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('weeks', 'readwrite');
      const os = tx.objectStore('weeks');
      os.clear();
      for (const [key, value] of Object.entries(all)) os.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return { get, put, getAllWeeks, replaceAllWeeks };
})();

const weeks = new Map();   // 週キー → 線の配列（読み込み済みの週）
const inkWeeks = new Set(); // 何か書いてある週のキー（カレンダーの点に使う）
const dirty = new Set();
let saveTimer = null;

function markDirty() {
  dirty.add(currentKey());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const keys = [...dirty];
  dirty.clear();
  for (const key of keys) {
    try {
      const strokes = weeks.get(key) || [];
      await store.put(key, { strokes, updated: Date.now() });
      if (strokes.length) inkWeeks.add(key);
      else inkWeeks.delete(key);
    } catch (err) {
      dirty.add(key);
      toast('保存に失敗しました');
    }
  }
  updateBackupInfo();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', flush);

// ---------------------------------------------------------------- 日本の祝日
// 祝日法のきまりから計算する（ネット不要）。春分・秋分の式は 2099年まで有効。
// 法律が変わって祝日が増えたり動いたりしたら、ここを直す。

const holidayCache = new Map();   // 年 → Map(日付キー → 祝日の名前)

function holidaysOf(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const h = new Map();
  const add = (m, d, name) => h.set(dateKey(new Date(y, m - 1, d)), name);
  const nthMonday = (m, n) => 1 + ((8 - new Date(y, m - 1, 1).getDay()) % 7) + (n - 1) * 7;
  const k = y - 1980;

  add(1, 1, '元日');
  add(1, nthMonday(1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  add(2, 23, '天皇誕生日');
  add(3, Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4)), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthMonday(7, 3), '海の日');
  add(8, 11, '山の日');
  add(9, nthMonday(9, 3), '敬老の日');
  add(9, Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4)), '秋分の日');
  add(10, nthMonday(10, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  const base = [...h.keys()];
  // 国民の休日：祝日と祝日にはさまれた日（日曜をのぞく）
  for (const key of base) {
    const next = addDays(keyToDate(key), 1);
    if (!h.has(dateKey(next)) && h.has(dateKey(addDays(next, 1))) && next.getDay() !== 0) {
      h.set(dateKey(next), '国民の休日');
    }
  }
  // 振替休日：祝日が日曜なら、そのあと最初の祝日でない日
  for (const key of base) {
    const d = keyToDate(key);
    if (d.getDay() !== 0) continue;
    let n = addDays(d, 1);
    while (h.has(dateKey(n))) n = addDays(n, 1);
    h.set(dateKey(n), '振替休日');
  }
  holidayCache.set(y, h);
  return h;
}

function holidayName(d) {
  return holidaysOf(d.getFullYear()).get(dateKey(d)) || '';
}

// ---------------------------------------------------------------- カレンダーの予定（取り込み）
// iPad の「ショートカット」がカレンダーの予定を「開始|終了|タイトル」の行にしてコピーし、
// それをここで読み取る。予定は localStorage `events` に { days: {日付キー: [{t, title}]}, imported } で持つ。

const EVENTS_MAX_PER_DAY = 3;
let events = { days: {}, imported: 0 };
try {
  const saved = JSON.parse(localStorage.getItem('events') || 'null');
  if (saved && saved.days) events = saved;
} catch (err) { /* 読めなければ予定なしで始める */ }

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function eventsHtml(key) {
  const list = events.days[key];
  if (!list || !list.length) return '';
  const shown = list.slice(0, EVENTS_MAX_PER_DAY).map((ev) =>
    `<span class="ev">${ev.t ? `<b>${ev.t}</b>` : ''}${escapeHtml(ev.title)}</span>`).join('');
  const more = list.length > EVENTS_MAX_PER_DAY ? `<span class="ev more">ほか${list.length - EVENTS_MAX_PER_DAY}件</span>` : '';
  return `<span class="evs">${shown}${more}</span>`;
}

// 「2026-11-09T10:00:00+09:00」「2026/11/09 10:00」「2026年11月9日 午後3:00」などを読む（時差は見ず、書いてある時刻のまま）
function parseEventDate(text) {
  const m = /(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})\s*日?(?:[^\d午]*?(午前|午後|AM|PM)?\s*(\d{1,2})\s*[:時]\s*(\d{2}))?/i.exec(text);
  if (!m) return null;
  let h = m[5] == null ? null : Number(m[5]);
  if (h != null && /午後|PM/i.test(m[4] || '') && h < 12) h += 12;
  if (h != null && /午前|AM/i.test(m[4] || '') && h === 12) h = 0;
  return { day: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), h, min: h == null ? null : Number(m[6]) };
}

function parseEvents(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split(/[|｜\t]/);
    if (parts.length < 3) continue;
    const st = parseEventDate(parts[0]);
    const en = parseEventDate(parts[1]) || st;
    const title = parts.slice(2).join('|').trim() || '（予定）';
    if (!st) continue;
    const midnight = (x) => x.h === 0 && x.min === 0;
    const allDay = st.h == null || (midnight(st) && (en.h == null || midnight(en) || (en.h === 23 && en.min === 59)));
    let last = en.day < st.day ? st.day : en.day;
    // 終わりが「次の日の 0:00」ならその日は含めない
    if (last > st.day && en.h != null && midnight(en)) last = addDays(last, -1);
    const t = allDay ? '' : `${st.h}:${String(st.min).padStart(2, '0')}`;
    let d = st.day;
    for (let n = 0; d <= last && n < 62; n++, d = addDays(d, 1)) {
      out.push({ key: dateKey(d), first: n === 0, t: n === 0 ? t : '', title, sort: allDay || n > 0 ? -1 : st.h * 60 + st.min });
    }
  }
  return out;
}

// 取り込んだ予定の「最初の日〜最後の日」の分だけ入れ替える（それより前の予定は残す）
function applyEvents(list) {
  const keys = list.map((e) => e.key).sort();
  const from = keys[0];
  const to = keys[keys.length - 1];
  for (const k of Object.keys(events.days)) if (k >= from && k <= to) delete events.days[k];
  list.sort((a, b) => a.sort - b.sort);
  for (const e of list) (events.days[e.key] = events.days[e.key] || []).push({ t: e.t, title: e.title });
  events.imported = Date.now();
  try { localStorage.setItem('events', JSON.stringify(events)); } catch (err) { /* 表示はできる */ }
  renderTemplate();
  updateEventsNote();
}

function importEventsText(text) {
  const list = parseEvents(text);
  if (!list.length) {
    toast('予定が見つかりませんでした。先にショートカットを実行してください');
    return false;
  }
  applyEvents(list);
  const n = list.filter((e) => e.first).length;
  toast(`予定を取り込みました（${n}件）`);
  return true;
}

function updateEventsNote() {
  const el = $('eventsNote');
  if (!el) return;
  if (!events.imported) { el.textContent = 'iPad のカレンダーの予定を表示できます'; return; }
  const d = new Date(events.imported);
  el.textContent = `予定の取り込み: ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 週の表示

function renderTemplate() {
  const ws = state.weekStart;   // 見出しの月は Planner と同じく月曜日の月
  const todayKey = dateKey(new Date());
  let html = '<div class="left"><div class="head">' +
    `<span class="m">${ws.getMonth() + 1}月</span>` +
    `<span class="en"><span>${MONTHS_EN[ws.getMonth()]}</span><span>${ws.getFullYear()}</span></span></div>`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const hol = holidayName(d);
    const cls = ['day', i === 5 ? 'sat' : '', i === 6 ? 'sun' : '', hol ? 'hol' : '',
      dateKey(d) === todayKey ? 'today' : ''].join(' ');
    const num = d.getDate() === 1 ? `${d.getMonth() + 1}/1` : d.getDate();
    html += `<div class="${cls}"><span class="num">${num}</span><span class="wd">${WEEKDAYS_JA[i]}</span>` +
      (hol ? `<span class="hname">${hol}</span>` : '') + eventsHtml(dateKey(d)) + '</div>';
  }
  html += '</div>';
  template.innerHTML = html;
  document.title = `${ws.getMonth() + 1}月 - 手帳`;
}

let loadToken = 0;
async function showWeek() {
  const key = currentKey();
  renderTemplate();
  let strokes = weeks.get(key);
  if (!strokes) {
    state.strokes = null;
    clearCtx(ink);
    const token = ++loadToken;
    try {
      const rec = await store.get(key);
      strokes = (rec && rec.strokes) || [];
    } catch (err) {
      strokes = [];
      toast('読み込みに失敗しました');
    }
    if (token !== loadToken) return;
    if (!weeks.has(key)) weeks.set(key, strokes);
    strokes = weeks.get(key);
  }
  state.strokes = strokes;
  redrawAll();
  updateUndoButtons();
  updateThisWeekButton();
}

// 月曜日 monday の週へ移動する（カレンダー・今週ボタン用）
function goToWeek(monday) {
  const delta = Math.round((monday - state.weekStart) / (7 * 864e5));
  if (delta) goWeek(delta);
}

function goWeek(delta) {
  endStroke();
  flush();
  state.weekStart = addDays(state.weekStart, delta * 7);
  showWeek();
  template.animate(
    [{ transform: `translateX(${delta * 36}px)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }],
    { duration: 180, easing: 'ease-out' }
  );
  inkCanvas.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
}

// ---------------------------------------------------------------- 画面サイズと拡大
// 論理座標 → 画面:  画面x = view.x + 論理x * view.k  （k = 画面に合わせた倍率 s0 × 拡大率 z）
// キャンバスは画面と同じ大きさで、拡大しても大きくしない（iPad はキャンバスの大きさに上限がある）。

const MAX_ZOOM = 4;
const view = { s0: 1, z: 1, x: 0, y: 0, k: 1 };
let stageW = 0;
let stageH = 0;
let dpr = 1;
let stageRect = null;
let previewBase = null;   // 指で拡大している途中は、キャンバスを CSS で仮に伸ばし、離したら描き直す

function clampView() {
  view.z = Math.min(MAX_ZOOM, Math.max(1, view.z));
  view.k = view.s0 * view.z;
  const pw = PAGE_W * view.k;
  const ph = PAGE_H * view.k;
  view.x = pw <= stageW ? (stageW - pw) / 2 : Math.min(0, Math.max(stageW - pw, view.x));
  view.y = ph <= stageH ? (stageH - ph) / 2 : Math.min(0, Math.max(stageH - ph, view.y));
}

// 画面上の点 from にあったページの場所が、拡大率 z のとき点 to に来るようにする
function zoomAround(from, to, z, base) {
  const lx = (from.x - base.x) / base.k;
  const ly = (from.y - base.y) / base.k;
  view.z = Math.min(MAX_ZOOM, Math.max(1, z));
  view.k = view.s0 * view.z;
  view.x = to.x - lx * view.k;
  view.y = to.y - ly * view.k;
  clampView();
}

function layout() {
  const r = stage.getBoundingClientRect();
  stageW = r.width;
  stageH = r.height;
  dpr = window.devicePixelRatio || 1;
  const ratio = 1 / view.s0;
  view.s0 = Math.max(0.1, Math.min(stageW / PAGE_W, stageH / PAGE_H));
  view.x *= view.s0 * ratio;
  view.y *= view.s0 * ratio;
  page.style.width = PAGE_W * view.s0 + 'px';
  page.style.height = PAGE_H * view.s0 + 'px';
  clampView();
  commitView();
}

function setupCtx(c, ctx) {
  c.width = Math.round(stageW * dpr);   // 大きさを設定し直すと、中身と設定がリセットされる
  c.height = Math.round(stageH * dpr);
  const k = view.k * dpr;
  ctx.setTransform(k, 0, 0, k, view.x * dpr, view.y * dpr);
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function commitView() {
  previewBase = null;
  page.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  inkCanvas.style.transform = '';
  setupCtx(inkCanvas, ink);
  setupCtx(liveCanvas, live);
  liveDirty = false;
  redrawAll();
}

function previewView() {
  if (!previewBase) previewBase = { ...view };
  page.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  const r = view.k / previewBase.k;
  inkCanvas.style.transform =
    `translate(${view.x - previewBase.x * r}px, ${view.y - previewBase.y * r}px) scale(${r})`;
}

function clearCtx(ctx) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

// ---------------------------------------------------------------- 線の描画
// 線は [x, y, 筆圧, x, y, 筆圧, ...] で持つ。
// 点と点の間は、前後の点も使った滑らかな3次曲線（Catmull-Rom）で、必ず点の上を通るように描く。
// ペンの点がまばらでも（速く書いても）カクカクしない。

// 筆圧で太さを変える幅（v0.9.3 で狭くした：強く押した所がこぶのようにふくらまないように）
function widthAt(s, p) {
  return s.size * (0.5 + 1.0 * p);
}

// 点 i-1 から点 i までの曲線の制御点。区間の長さが0なら null。
function segCurve(P, i) {
  const n = P.length / 3;
  const a = Math.max(i - 2, 0) * 3, b = (i - 1) * 3, c = i * 3, d = Math.min(i + 1, n - 1) * 3;
  const x0 = P[a], y0 = P[a + 1];
  const x1 = P[b], y1 = P[b + 1];
  const x2 = P[c], y2 = P[c + 1];
  const x3 = P[d], y3 = P[d + 1];
  const d12 = Math.hypot(x2 - x1, y2 - y1);
  if (!d12) return null;
  // 隣の区間との長さの比で向きを決めると、点の間隔がばらばらでも曲線がはみ出さない
  const t1 = d12 / (Math.hypot(x1 - x0, y1 - y0) + d12) / 3;
  const t2 = d12 / (d12 + Math.hypot(x3 - x2, y3 - y2)) / 3;
  return [x1, y1, x1 + (x2 - x0) * t1, y1 + (y2 - y0) * t1, x2 - (x3 - x1) * t2, y2 - (y3 - y1) * t2, x2, y2, d12];
}

// 点 i-1 から点 i までの区間を描く。太さは区間の中で筆圧に合わせて少しずつ変える。
function drawSeg(ctx, s, i) {
  const P = s.pts;
  const cv = segCurve(P, i);
  if (!cv) return;
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2, d12] = cv;
  const p1 = P[i * 3 - 1], p2 = P[i * 3 + 2];

  const steps = Math.min(32, Math.max(1, Math.ceil(d12 * view.k / 1.5)));
  const q = 4 * view.k;   // 太さを 0.25 画面ピクセル単位にそろえ、同じ太さの部分は1本にまとめて描く
  let w = 0;
  let px = x1, py = y1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let j = 1; j <= steps; j++) {
    const t = j / steps, u = 1 - t;
    const B0 = u * u * u, B1 = 3 * u * u * t, B2 = 3 * u * t * t, B3 = t * t * t;
    const x = B0 * x1 + B1 * c1x + B2 * c2x + B3 * x2;
    const y = B0 * y1 + B1 * c1y + B2 * c2y + B3 * y2;
    const wj = Math.max(1, Math.round(widthAt(s, p1 + (p2 - p1) * (t - 0.5 / steps)) * q)) / q;
    if (w && wj !== w) {
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px, py);
    }
    w = wj;
    ctx.lineTo(x, y);
    px = x;
    py = y;
  }
  ctx.lineWidth = w;
  ctx.stroke();
}

function drawDot(ctx, s) {
  ctx.beginPath();
  ctx.arc(s.pts[0], s.pts[1], widthAt(s, s.pts[2]) / 2, 0, Math.PI * 2);
  ctx.fill();
}

// マーカー：半透明・太さ一定。1本を1つの形として一度に塗るので、重なった部分がムラにならない。
const MARKER_ALPHA = 0.38;
const isMarker = (s) => s.tool === 'marker';

function drawMarker(ctx, s) {
  const P = s.pts;
  const n = P.length / 3;
  ctx.save();
  ctx.globalAlpha = MARKER_ALPHA;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.beginPath();
  if (n === 1) {
    ctx.arc(P[0], P[1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(P[0], P[1]);
    for (let i = 1; i < n; i++) {
      const cv = segCurve(P, i);
      if (cv) ctx.bezierCurveTo(cv[2], cv[3], cv[4], cv[5], cv[6], cv[7]);
    }
    ctx.lineWidth = s.size;
    ctx.stroke();
  }
  ctx.restore();
}

function drawStroke(ctx, s) {
  if (isMarker(s)) return drawMarker(ctx, s);
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  const n = s.pts.length / 3;
  if (n === 1) return drawDot(ctx, s);
  for (let i = 1; i < n; i++) drawSeg(ctx, s, i);
}

// マーカーを先に塗り、ペンをその上に描く（塗った上からでも文字がくっきり読める）
function redrawAll() {
  clearCtx(ink);
  if (!state.strokes) return;
  for (const s of state.strokes) if (isMarker(s)) drawStroke(ink, s);
  for (const s of state.strokes) if (!isMarker(s)) drawStroke(ink, s);
}

// ---------------------------------------------------------------- ペンの入力

// ペンの位置 → ページの論理座標。
// キャンバスが今画面に出ている大きさ（stageRect）と、描いたときの大きさ（stageW/H）の比も使うので、
// iPad が知らせずに表示の大きさを変えても、線はペンの真下に出る。
function toPage(e) {
  const sx = (e.clientX - stageRect.left) * (stageW / stageRect.width);
  const sy = (e.clientY - stageRect.top) * (stageH / stageRect.height);
  return [(sx - view.x) / view.k, (sy - view.y) / view.k];
}

let current = null;   // 書いている途中の線
let erasing = null;   // 消しゴム中の情報

function isDrawingPointer(e) {
  // iPad では Apple Pencil = 'pen'、指や手のひら = 'touch'。Mac での確認用にマウスも書ける。
  return e.pointerType === 'pen' || e.pointerType === 'mouse';
}

stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touchDown(e);
    return;
  }
  if (!isDrawingPointer(e) || e.button !== 0 || !state.strokes) return;
  e.preventDefault();
  lastPenTime = Date.now();
  cancelGesture();   // 先に置いていた手のひらでページが動いていたら元に戻す
  if (previewBase) commitView();
  for (const a of template.getAnimations()) a.finish();
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);   // 画面全体がずれていたら戻す
  stageRect = inkCanvas.getBoundingClientRect();
  if (Math.abs(stageRect.width - stageW) > 1 || Math.abs(stageRect.height - stageH) > 1) {
    layout();   // 表示の大きさが変わっていたら、ここで合わせ直す
    stageRect = inkCanvas.getBoundingClientRect();
  }
  const [x, y] = toPage(e);
  if (x < 0 || y < 0 || x > PAGE_W || y > PAGE_H) return;   // ページの外
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても描ける */ }

  if (state.tool === 'eraser') {
    erasing = { id: e.pointerId, x, y, items: [] };
    eraseAlong(x, y, x, y);
    drawEraserCursor(x, y);
  } else {
    const p = pressureOf(e, null, 0);
    current = {
      id: e.pointerId,
      sx: x, sy: y,          // ならした位置
      raw: [x, y],           // ペンの今の本当の位置
      t: e.timeStamp,
      stroke: state.tool === 'marker'
        ? { tool: 'marker', color: state.marker.color, size: state.marker.size, pts: [round1(x), round1(y), p] }
        : { color: state.pen.color, size: state.pen.size, pts: [round1(x), round1(y), p] },
      lastP: p,
    };
    drawLive(e);
  }
});

stage.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    touchMove(e);
    return;
  }
  if (current && e.pointerId === current.id) {
    lastPenTime = Date.now();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (events.length ? events : [e])) addPoint(ev);
    drawLive(e);
  } else if (erasing && e.pointerId === erasing.id) {
    lastPenTime = Date.now();
    const [x, y] = toPage(e);
    eraseAlong(erasing.x, erasing.y, x, y);
    erasing.x = x;
    erasing.y = y;
    drawEraserCursor(x, y);
  }
});

const finishPointer = (e) => {
  if (e.pointerType === 'touch') {
    touchUp(e);
    return;
  }
  if (current && e.pointerId === current.id && e.type === 'pointerup') current.raw = toPage(e);   // 離した場所
  if ((current && e.pointerId === current.id) || (erasing && e.pointerId === erasing.id)) endStroke();
};
stage.addEventListener('pointerup', finishPointer);
stage.addEventListener('pointercancel', finishPointer);

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---- 手ぶれ補正
// Apple Pencil は1秒に約240回、ほんの少しずつずれた位置を送ってくる。そのまま全部の点を通すと
// 線が細かくガタガタするので、位置と筆圧を時間でならし、近すぎる点は捨ててから曲線にする。
const POS_TAU = 10;       // 位置をならす強さ（ミリ秒。大きいほどなめらか・遅れる）
const PRESS_TAU = 30;     // 筆圧をならす強さ（ミリ秒）
const MIN_STEP_PX = 2;    // これより近い点は使わない（画面のピクセル）

const smoothing = (dt, tau) => 1 - Math.exp(-dt / tau);

function pressureOf(e, prev, dt) {
  // マウスは筆圧が無いので中間の値
  let p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
  p = Math.min(1, Math.max(0.05, p));
  if (prev != null) p = prev + (p - prev) * smoothing(dt, PRESS_TAU);
  return Math.round(p * 100) / 100;
}

function addPoint(e) {
  const s = current.stroke;
  const [x, y] = toPage(e);
  const dt = Math.max(0.5, Math.min(50, e.timeStamp - current.t));
  current.t = e.timeStamp;
  current.raw = [x, y];
  const a = smoothing(dt, POS_TAU);
  current.sx += (x - current.sx) * a;
  current.sy += (y - current.sy) * a;
  current.lastP = pressureOf(e, current.lastP, dt);
  const n = s.pts.length / 3;
  if (Math.hypot(current.sx - s.pts[n * 3 - 3], current.sy - s.pts[n * 3 - 2]) * view.k < MIN_STEP_PX) return;
  s.pts.push(round1(current.sx), round1(current.sy), current.lastP);
  // 1つ前の区間は、次の点が来て形が決まったので本番のキャンバスに描く（マーカーは書き終わりにまとめて）
  if (n >= 2 && !isMarker(s)) {
    ink.strokeStyle = s.color;
    drawSeg(ink, s, n - 1);
  }
}

// まだ形が決まらない最後の区間と、ブラウザが予測した先の点を上のキャンバスに描いて遅れを小さく見せる
let liveDirty = false;
function drawLive(e) {
  clearCtx(live);
  const s = current.stroke;
  liveDirty = true;
  if (isMarker(s)) {
    drawMarker(live, s);   // 書いている間は、上のキャンバスに1本まるごと描き直す
    return;
  }
  const n = s.pts.length / 3;
  live.strokeStyle = s.color;
  live.fillStyle = s.color;
  if (n === 1) drawDot(live, s);
  else drawSeg(live, s, n - 1);
  // 最後の点からペン先（と予測した先）まではまっすぐつないで、線がペンから遅れて見えないようにする
  let ahead = [current.raw];
  if (e.getPredictedEvents) {
    try { ahead = ahead.concat(e.getPredictedEvents().map(toPage)); } catch (err) { /* 予測なしでよい */ }
  }
  live.lineWidth = widthAt(s, current.lastP);
  live.beginPath();
  live.moveTo(s.pts[n * 3 - 3], s.pts[n * 3 - 2]);
  for (const [x, y] of ahead) live.lineTo(x, y);
  live.stroke();
}

function drawEraserCursor(x, y) {
  clearCtx(live);
  live.lineWidth = 1 / view.k;
  live.strokeStyle = 'rgba(0,0,0,0.35)';
  live.beginPath();
  live.arc(x, y, ERASER_R / view.z, 0, Math.PI * 2);
  live.stroke();
  liveDirty = true;
}

function endStroke() {
  if (current) {
    const s = current.stroke;
    const before = s.pts.length / 3;
    // ならした位置は少し遅れているので、ペンを離した本当の位置で線を終える
    const [rx, ry] = current.raw;
    if (Math.hypot(rx - s.pts[before * 3 - 3], ry - s.pts[before * 3 - 2]) * view.k >= MIN_STEP_PX) {
      s.pts.push(round1(rx), round1(ry), current.lastP);
    }
    const n = s.pts.length / 3;
    state.strokes.push(s);
    if (isMarker(s)) {
      redrawAll();   // ペンの文字の下に入るように描き直す
    } else {
      ink.strokeStyle = s.color;
      ink.fillStyle = s.color;
      if (n === 1) drawDot(ink, s);
      else {
        if (n > before && n >= 3) drawSeg(ink, s, n - 2);   // 最後の点が増えて形が決まった区間
        drawSeg(ink, s, n - 1);
      }
    }
    current = null;
    markDirty();
    record({ type: 'add', stroke: s });
  }
  if (erasing && erasing.items.length) record({ type: 'erase', items: erasing.items });
  erasing = null;
  if (liveDirty) {
    clearCtx(live);
    liveDirty = false;
  }
}

// ---------------------------------------------------------------- 元に戻す／やり直し
// 週ごとに「したこと」を覚えておく（アプリを開いている間だけ。閉じると消える）。
// 書いた線は { type: 'add', stroke }、消しゴムはペンを離すまでに消した線をまとめて { type: 'erase', items }。

const HISTORY_MAX = 200;
const histories = new Map();   // 週キー → { undo: [], redo: [] }

function history() {
  const key = currentKey();
  let h = histories.get(key);
  if (!h) {
    h = { undo: [], redo: [] };
    histories.set(key, h);
  }
  return h;
}

function record(action) {
  const h = history();
  h.undo.push(action);
  if (h.undo.length > HISTORY_MAX) h.undo.shift();
  h.redo.length = 0;
  updateUndoButtons();
}

function applyAction(a, reverse) {
  const S = state.strokes;
  if (a.type === 'add') {
    if (reverse) {
      const i = S.indexOf(a.stroke);
      if (i >= 0) S.splice(i, 1);
    } else {
      S.push(a.stroke);
    }
  } else if (reverse) {
    // 消した順の逆に、元の場所へ戻す（重なり順もそのまま）
    for (let j = a.items.length - 1; j >= 0; j--) {
      S.splice(Math.min(a.items[j].index, S.length), 0, a.items[j].stroke);
    }
  } else {
    for (const it of a.items) {
      const i = S.indexOf(it.stroke);
      if (i >= 0) S.splice(i, 1);
    }
  }
}

function undoRedo(isUndo) {
  if (current || erasing || !state.strokes) return;
  const h = history();
  const a = (isUndo ? h.undo : h.redo).pop();
  if (!a) return;
  applyAction(a, isUndo);
  (isUndo ? h.redo : h.undo).push(a);
  redrawAll();
  markDirty();
  updateUndoButtons();
}

function updateUndoButtons() {
  const h = histories.get(currentKey());
  $('undoBtn').disabled = !(h && h.undo.length);
  $('redoBtn').disabled = !(h && h.redo.length);
}

// ---------------------------------------------------------------- 消しゴム（触れた線をまるごと消す）

const bboxCache = new WeakMap();
function bboxOf(s) {
  let b = bboxCache.get(s);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.pts.length; i += 3) {
      b[0] = Math.min(b[0], s.pts[i]);
      b[1] = Math.min(b[1], s.pts[i + 1]);
      b[2] = Math.max(b[2], s.pts[i]);
      b[3] = Math.max(b[3], s.pts[i + 1]);
    }
    bboxCache.set(s, b);
  }
  return b;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len = vx * vx + vy * vy;
  let t = len ? ((px - ax) * vx + (py - ay) * vy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function hits(s, x, y, er) {
  const b = bboxOf(s);
  const r = er + (isMarker(s) ? s.size / 2 : s.size * 1.7);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  const P = s.pts;
  if (P.length === 3) return Math.hypot(P[0] - x, P[1] - y) <= r;
  for (let i = 3; i < P.length; i += 3) {
    if (distToSeg(x, y, P[i - 3], P[i - 2], P[i], P[i + 1]) <= r) return true;
  }
  return false;
}

function eraseAlong(x0, y0, x1, y1) {
  const strokes = state.strokes;
  const er = ERASER_R / view.z;   // 拡大しても、画面上の消しゴムの大きさは同じ
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (er / 2)));
  let removed = false;
  for (let k = 0; k <= steps; k++) {
    const x = x0 + (x1 - x0) * (k / steps);
    const y = y0 + (y1 - y0) * (k / steps);
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (hits(strokes[i], x, y, er)) {
        if (erasing) erasing.items.push({ stroke: strokes[i], index: i });
        strokes.splice(i, 1);
        removed = true;
      }
    }
  }
  if (removed) {
    redrawAll();
    markDirty();
  }
}

// ---------------------------------------------------------------- 指の操作
// 1本指: 横にはらうと週を移動（拡大中はページを動かす）／ダブルタップで拡大・元の大きさ
// 2本指: 広げる・つまむで拡大・縮小
// ペンを使っている最中・直後に触れた指は手のひらとみなして無視する。

const touches = new Map();   // 指の id → 画面上の位置
let gesture = null;          // { type: 'one' | 'pinch' | 'blocked', ... }
let lastTap = null;

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function cancelGesture() {
  if (gesture && gesture.revert && previewBase) {
    Object.assign(view, gesture.revert);
    commitView();
  }
  gesture = touches.size ? { type: 'blocked' } : null;
}

function touchDown(e) {
  touches.set(e.pointerId, stagePoint(e));
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* なくても動く */ }
  if (current || erasing || Date.now() - lastPenTime < PALM_GUARD_MS) {
    cancelGesture();
    return;
  }
  if (gesture && gesture.type === 'blocked') return;
  const revert = (gesture && gesture.revert) || { ...(previewBase || view) };
  if (touches.size === 1) {
    gesture = { type: 'one', id: e.pointerId, start: touches.get(e.pointerId), t: Date.now(),
      base: { ...view }, moved: false, revert };
  } else if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    gesture = { type: 'pinch', d0: Math.max(10, dist(a, b)), m0: mid(a, b), base: { ...view }, revert };
  } else {
    cancelGesture();
  }
}

function touchMove(e) {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, stagePoint(e));
  if (!gesture) return;
  if (gesture.type === 'one' && e.pointerId === gesture.id) {
    const p = touches.get(e.pointerId);
    const dx = p.x - gesture.start.x;
    const dy = p.y - gesture.start.y;
    if (Math.hypot(dx, dy) > 10) gesture.moved = true;
    if (gesture.base.z > 1.01) {   // 拡大中は1本指でページを動かす
      view.x = gesture.base.x + dx;
      view.y = gesture.base.y + dy;
      clampView();
      previewView();
    }
  } else if (gesture.type === 'pinch' && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    zoomAround(gesture.m0, mid(a, b), gesture.base.z * dist(a, b) / gesture.d0, gesture.base);
    previewView();
  }
}

function touchUp(e) {
  if (!touches.has(e.pointerId)) return;
  touches.delete(e.pointerId);
  const g = gesture;
  if (g && g.type === 'one' && e.pointerId === g.id && e.type === 'pointerup' && lastPenTime < g.t - 300) {
    const p = stagePoint(e);
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    const dt = Date.now() - g.t;
    if (g.base.z <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 900) {
      goWeek(dx < 0 ? 1 : -1);
    } else if (!g.moved && dt < 300) {
      handleTap(p);
    }
  }
  if (g && g.type === 'pinch') gesture = { type: 'blocked' };   // 残った指では何もしない
  if (touches.size === 0) {
    gesture = null;
    if (previewBase) commitView();
  }
}

function handleTap(p) {
  const now = Date.now();
  if (lastTap && now - lastTap.t < 350 && dist(p, lastTap) < 40) {
    lastTap = null;
    if (view.z > 1.01) {
      view.z = 1;
      clampView();
    } else {
      zoomAround(p, p, 2.5, { ...view });
    }
    commitView();
  } else {
    lastTap = { t: now, x: p.x, y: p.y };
  }
}

// iPad Safari の長押しメニュー・拡大鏡・ダブルタップ拡大・画面全体のピンチを止める
stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Mac で確認しやすいように：
// 矢印キー・トラックパッドの横スクロールで週を移動、ピンチ（または control + スクロール）で拡大、拡大中はスクロールで移動
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('textarea, input')) return;   // 貼り付け欄で文字を打っているとき
  if (e.key === 'ArrowLeft') goWeek(-1);
  if (e.key === 'ArrowRight') goWeek(1);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoRedo(!e.shiftKey);   // Mac: ⌘Z で元に戻す、⌘⇧Z でやり直し
  }
});

let wheelAcc = 0;
let wheelLock = 0;
let commitTimer = null;
function commitSoon() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => { if (previewBase) commitView(); }, 150);
}
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (current || erasing) return;
  if (e.ctrlKey) {
    const p = stagePoint(e);
    zoomAround(p, p, view.z * Math.exp(-e.deltaY / 100), { ...view });
    previewView();
    commitSoon();
    return;
  }
  if (view.z > 1.01) {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    clampView();
    previewView();
    commitSoon();
    return;
  }
  if (Date.now() < wheelLock) return;
  wheelAcc += e.deltaX;
  if (Math.abs(wheelAcc) > 80) {
    goWeek(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
    wheelLock = Date.now() + 500;
  }
}, { passive: false });

// Mac の Safari はトラックパッドのピンチを gesture イベントで送ってくる（iPad の指は上の処理で扱う）
let macPinch = null;
document.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  macPinch = touches.size === 0 && !current && !erasing ? { ...view } : null;
});
document.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (!macPinch) return;
  const p = stagePoint(e);
  zoomAround(p, p, macPinch.z * e.scale, macPinch);
  previewView();
});
document.addEventListener('gestureend', (e) => {
  e.preventDefault();
  if (macPinch && previewBase) commitView();
  macPinch = null;
});

// ---------------------------------------------------------------- ツールバー

$('undoBtn').addEventListener('click', () => undoRedo(true));
$('redoBtn').addEventListener('click', () => undoRedo(false));

const toolButtons = document.querySelectorAll('.tool[data-tool]');
for (const btn of toolButtons) {
  btn.addEventListener('click', () => {
    // 選んでいるペン・マーカーをもう一度押すと、色と太さの画面を開く（Planner と同じ）
    if (btn.dataset.tool === state.tool && TOOL_OPTS[state.tool]) {
      menuTool = state.tool;
      renderPenMenu();
      togglePopup($('penMenu'));
      return;
    }
    state.tool = btn.dataset.tool;
    for (const b of toolButtons) b.classList.toggle('active', b === btn);
    closePopups();
  });
}

// ツールバーの上に出る小さな画面。外側を触ると閉じる（ペンで書き始めたときも閉じる）
const popups = document.querySelectorAll('.popup');
function closePopups(except) {
  for (const p of popups) if (p !== except) p.hidden = true;
}
function togglePopup(p) {
  closePopups(p);
  p.hidden = !p.hidden;
  return !p.hidden;
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.popup, #toolbar')) closePopups();
});

// ---------------------------------------------------------------- カレンダーと「今週」

let calMonth = null;   // カレンダーに出している月の1日

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function renderCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $('calTitle').textContent = `${y}年${m + 1}月`;
  const todayKey = dateKey(new Date());
  const shownKey = currentKey();
  let html = '<div class="cal-head">' + WEEKDAYS_JA.map((w, i) =>
    `<span class="${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</span>`).join('') + '</div>';
  const last = new Date(y, m + 1, 0);
  for (let mon = mondayOf(calMonth); mon <= last; mon = addDays(mon, 7)) {
    const key = dateKey(mon);
    html += `<div class="cal-week${key === shownKey ? ' shown' : ''}${inkWeeks.has(key) ? ' ink' : ''}" data-monday="${key}">`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const hol = holidayName(d);
      const cls = [d.getMonth() !== m ? 'out' : '', i === 5 ? 'sat' : '', i === 6 ? 'sun' : '',
        hol ? 'hol' : '', dateKey(d) === todayKey ? 'today' : ''].join(' ');
      html += `<span class="${cls}"${hol ? ` title="${hol}"` : ''}>${d.getDate()}</span>`;
    }
    html += '</div>';
  }
  $('calGrid').innerHTML = html;
}

$('calBtn').addEventListener('click', () => {
  const ws = state.weekStart;
  calMonth = new Date(ws.getFullYear(), ws.getMonth(), 1);
  renderCalendar();
  togglePopup($('calMenu'));
});
$('calPrev').addEventListener('click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('calNext').addEventListener('click', () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('calGrid').addEventListener('click', (e) => {
  const row = e.target.closest('.cal-week');
  if (!row) return;
  closePopups();
  goToWeek(keyToDate(row.dataset.monday));
});

$('importEvents').addEventListener('click', async () => {
  let text = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
  } catch (err) { text = ''; }
  if (text && importEventsText(text)) { closePopups(); return; }
  if (text) return;   // 読めたが予定の形ではなかった（メッセージは出した）
  // コピーした内容を読めなかったときは、貼り付ける欄を出す
  $('pasteBox').value = '';
  closePopups($('pasteMenu'));
  $('pasteMenu').hidden = false;
});
$('pasteOk').addEventListener('click', () => {
  if (importEventsText($('pasteBox').value)) closePopups();
});
$('clearEvents').addEventListener('click', () => {
  if (!confirm('取り込んだ予定の表示をすべて消しますか？（iPad のカレンダーの予定は消えません）')) return;
  events = { days: {}, imported: 0 };
  try { localStorage.removeItem('events'); } catch (err) { /* なし */ }
  renderTemplate();
  updateEventsNote();
});
updateEventsNote();

$('thisWeekBtn').addEventListener('click', () => {
  closePopups();
  goToWeek(mondayOf(new Date()));
});

function updateThisWeekButton() {
  $('thisWeekBtn').disabled = currentKey() === dateKey(mondayOf(new Date()));
}

// ---------------------------------------------------------------- ペン・マーカーの色と太さ

const TOOL_OPTS = {
  pen: {
    title: 'ペン',
    colors: [
      ['#1f2328', '黒'], ['#7a7f87', 'グレー'], ['#d64545', '赤'], ['#2f6fd6', '青'],
      ['#2e9e5b', '緑'], ['#e8862a', 'オレンジ'], ['#8e5bd6', '紫'], ['#d65a9c', 'ピンク'],
    ],
    sizes: [[1.4, '細'], [2.4, 'ふつう'], [3.6, '太'], [5.2, '極太']],
    preview: (w) => Math.max(1.5, w * 1.2),
    alpha: 1,
  },
  marker: {
    title: 'マーカー',
    colors: [
      ['#ffd60a', '黄'], ['#ff5c9a', 'ピンク'], ['#33b5ff', '水色'],
      ['#3ddc84', '緑'], ['#ff9f1a', 'オレンジ'], ['#a66bff', '紫'],
    ],
    sizes: [[8, '細'], [14, 'ふつう'], [22, '太']],
    preview: (w) => w * 0.75,
    alpha: MARKER_ALPHA + 0.15,   // 見本は少し濃いめに
  },
};
let menuTool = 'pen';   // 色と太さの画面がどちらの道具用か

function translucent(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >> 16}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

function loadToolOpts() {
  for (const [tool, o] of Object.entries(TOOL_OPTS)) {
    try {
      const saved = JSON.parse(localStorage.getItem(tool) || 'null');
      if (saved && o.colors.some(([c]) => c === saved.color)) state[tool].color = saved.color;
      if (saved && o.sizes.some(([w]) => w === saved.size)) state[tool].size = saved.size;
    } catch (err) { /* 初期の色・太さのまま */ }
  }
}

function saveToolOpts(tool) {
  try { localStorage.setItem(tool, JSON.stringify(state[tool])); } catch (err) { /* 覚えられなくても書ける */ }
}

function renderPenMenu() {
  $('penColor').style.background = state.pen.color;
  $('markerColor').style.background = translucent(state.marker.color, TOOL_OPTS.marker.alpha);
  const o = TOOL_OPTS[menuTool];
  const cur = state[menuTool];
  $('penMenuTitle').textContent = o.title;
  $('swatches').innerHTML = o.colors.map(([c, name]) =>
    `<button class="swatch${c === cur.color ? ' on' : ''}" data-color="${c}" ` +
    `style="background:${translucent(c, o.alpha)}" aria-label="${name}"></button>`).join('');
  $('sizes').style.gridTemplateColumns = `repeat(${o.sizes.length}, 1fr)`;
  $('sizes').innerHTML = o.sizes.map(([w, name]) =>
    `<button class="size${w === cur.size ? ' on' : ''}" data-size="${w}">` +
    `<span class="line" style="height:${o.preview(w)}px;background:${translucent(cur.color, o.alpha)}"></span>${name}</button>`).join('');
}

$('penMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.color) state[menuTool].color = b.dataset.color;
  if (b.dataset.size) state[menuTool].size = Number(b.dataset.size);
  saveToolOpts(menuTool);
  renderPenMenu();
});

loadToolOpts();
renderPenMenu();

// ---------------------------------------------------------------- バックアップと復元
// 全部の週を1つの JSON ファイルにする。iPad では共有シートの「"ファイル"に保存」で残す。

const BACKUP_REMIND_DAYS = 7;
const menu = $('backupMenu');
let hasInk = false;   // どこかの週に何か書いてあるか

function lastBackupTime() {
  try { return Number(localStorage.getItem('lastBackup')) || 0; } catch (err) { return 0; }
}

function updateBackupInfo() {
  const t = lastBackupTime();
  $('lastBackup').textContent = t
    ? `前回のバックアップ: ${new Date(t).toLocaleDateString('ja-JP')}`
    : 'まだバックアップしていません';
  // 書いた内容があって、しばらくバックアップしていなければ赤い点で知らせる
  if (!hasInk) hasInk = [...weeks.values()].some((s) => s.length);
  $('backupBadge').hidden = !(hasInk && Date.now() - t > BACKUP_REMIND_DAYS * 864e5);
}

$('backupBtn').addEventListener('click', () => {
  if (togglePopup(menu)) updateBackupInfo();
});

let preparedBackup = null;   // 共有画面を開けなかったときに、もう一度押してもらう用

async function makeBackupFile() {
  await flush();
  const all = await store.getAllWeeks();
  const data = { app: 'techo', format: 1, exportedAt: new Date().toISOString(), weeks: all };
  // 名前を固定にして、同じ場所に保存するたび上書きできるようにする（古いバックアップがたまらない）。
  // いつのバックアップかは中の exportedAt に入っていて、戻すときの確認に出る。
  const name = 'techo-backup.json';
  return { file: new File([JSON.stringify(data)], name, { type: 'application/json' }), count: Object.keys(all).length };
}

$('doBackup').addEventListener('click', async () => {
  try {
    const { file, count } = preparedBackup || await makeBackupFile();
    preparedBackup = null;
    $('doBackup').textContent = 'バックアップを保存';
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
      } catch (err) {
        if (err.name === 'AbortError') return;   // 共有画面を閉じただけ
        if (err.name === 'NotAllowedError') {
          // 準備に時間がかかると Safari が共有画面を出さないことがある。準備済みにしてもう一度押してもらう
          preparedBackup = { file, count };
          $('doBackup').textContent = '準備できました。もう一度押してください';
          return;
        }
        throw err;
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    try { localStorage.setItem('lastBackup', String(Date.now())); } catch (err) { /* 記録できなくても保存はできている */ }
    menu.hidden = true;
    updateBackupInfo();
    toast(`${count}週分をバックアップしました`);
  } catch (err) {
    toast('バックアップに失敗しました');
  }
});

$('doRestore').addEventListener('click', () => $('restoreFile').click());

$('restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    toast('このファイルは読めませんでした');
    return;
  }
  if (!data || data.app !== 'techo' || typeof data.weeks !== 'object') {
    toast('手帳のバックアップファイルではありません');
    return;
  }
  const count = Object.keys(data.weeks).length;
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('ja-JP') : '';
  if (!confirm(`${when} のバックアップ（${count}週分）に戻します。\n今書いてある内容は、このバックアップの内容に置き換わります。よろしいですか？`)) return;
  try {
    endStroke();
    clearTimeout(saveTimer);
    dirty.clear();
    await store.replaceAllWeeks(data.weeks);
    weeks.clear();
    histories.clear();
    inkWeeks.clear();
    for (const [key, v] of Object.entries(data.weeks)) if (v && v.strokes && v.strokes.length) inkWeeks.add(key);
    menu.hidden = true;
    await showWeek();
    toast(`${count}週分を戻しました`);
  } catch (err) {
    toast('戻すのに失敗しました');
  }
});

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---------------------------------------------------------------- 起動

$('version').textContent = 'v' + APP_VERSION;
// 表示の大きさが変わったら合わせ直す。iPad（とくに iPadOS 26 のウインドウやメニューバー）は
// window の resize を出さずに表示の大きさを変えることがあるので、ページの入れ物そのものを見張る。
let layoutQueued = false;
function relayoutSoon() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    const r = stage.getBoundingClientRect();
    if (Math.abs(r.width - stageW) > 0.5 || Math.abs(r.height - stageH) > 0.5) {
      if (current || erasing) relayoutSoon();   // 書いている途中は、書き終わってから
      else layout();
    }
  });
}
window.addEventListener('resize', relayoutSoon);
window.addEventListener('scroll', relayoutSoon);
window.addEventListener('pageshow', relayoutSoon);
if (window.visualViewport) window.visualViewport.addEventListener('resize', relayoutSoon);
if (window.ResizeObserver) new ResizeObserver(relayoutSoon).observe(stage);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') relayoutSoon();
});
layout();
showWeek();
store.getAllWeeks().then((all) => {
  for (const [key, v] of Object.entries(all)) if (v.strokes && v.strokes.length) inkWeeks.add(key);
  hasInk = inkWeeks.size > 0;
  updateBackupInfo();
}).catch(() => {});

// 日付が変わったら「今日」の色を更新
setInterval(() => {
  const el = template.querySelector('.today');
  const todayIdx = Math.round((new Date(new Date().toDateString()) - state.weekStart) / 864e5);
  const shown = el ? [...template.querySelectorAll('.day')].indexOf(el) : -1;
  if (shown !== todayIdx && (shown >= 0 || (todayIdx >= 0 && todayIdx < 7))) renderTemplate();
  updateThisWeekButton();
}, 60000);

// 保存領域を「消されにくい」扱いにしてもらう
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// オフライン対応と、新しい版への自動切り替え
// iPad のホーム画面アプリは閉じても裏で動き続けるので、画面に戻ってくるたびに新しい版がないか確かめる。
// 新しい版が入ったら、書いている途中でなければ保存してから読み込み直す。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;   // 初めて入ったときは読み込み直さない
    reloading = true;
    const go = async () => {
      if (current || erasing) {
        setTimeout(go, 500);
        return;
      }
      await flush();
      try { sessionStorage.setItem('updated', '1'); } catch (err) { /* お知らせが出ないだけ */ }
      location.reload();
    };
    go();
  });

  try {
    if (sessionStorage.getItem('updated')) {
      sessionStorage.removeItem('updated');
      toast(`新しい版（v${APP_VERSION}）になりました`);
    }
  } catch (err) { /* お知らせが出ないだけ */ }
}
