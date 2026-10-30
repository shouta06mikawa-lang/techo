'use strict';

// ページの中身は「論理座標」1000 x 690（横向き iPad の画面比）で記録する。画面の大きさが変わっても線がずれない。
const APP_VERSION = '0.3.0';
const PAGE_W = 1000;
const PAGE_H = 690;
const WEEKDAYS_JA = ['月', '火', '水', '木', '金', '土', '日'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const ERASER_R = 9;          // 消しゴムの半径（論理座標）
const PALM_GUARD_MS = 800;   // ペンを使った直後は指のスワイプを無視する

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
  color: '#1f2328',
  size: 2.4,
  strokes: null,   // 表示中の週の線。読み込み中は null
};

let scale = 1;     // 1論理単位あたりのCSSピクセル
let pageRect = null;
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
      await store.put(key, { strokes: weeks.get(key) || [], updated: Date.now() });
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

// ---------------------------------------------------------------- 週の表示

function renderTemplate() {
  const ws = state.weekStart;   // 見出しの月は Planner と同じく月曜日の月
  const todayKey = dateKey(new Date());
  let html = '<div class="left"><div class="head">' +
    `<span class="m">${ws.getMonth() + 1}月</span>` +
    `<span class="en"><span>${MONTHS_EN[ws.getMonth()]}</span><span>${ws.getFullYear()}</span></span></div>`;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const cls = ['day', i === 5 ? 'sat' : '', i === 6 ? 'sun' : '',
      dateKey(d) === todayKey ? 'today' : ''].join(' ');
    const num = d.getDate() === 1 ? `${d.getMonth() + 1}/1` : d.getDate();
    html += `<div class="${cls}"><span class="num">${num}</span><span class="wd">${WEEKDAYS_JA[i]}</span></div>`;
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
}

function goWeek(delta) {
  endStroke();
  flush();
  state.weekStart = addDays(state.weekStart, delta * 7);
  showWeek();
  page.animate(
    [{ transform: `translateX(${delta * 36}px)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }],
    { duration: 180, easing: 'ease-out' }
  );
}

// ---------------------------------------------------------------- 画面サイズ

function layout() {
  const r = stage.getBoundingClientRect();
  const pad = 0;
  scale = Math.max(0.1, Math.min((r.width - pad * 2) / PAGE_W, (r.height - pad * 2) / PAGE_H));
  const w = PAGE_W * scale;
  const h = PAGE_H * scale;
  page.style.width = w + 'px';
  page.style.height = h + 'px';
  const dpr = window.devicePixelRatio || 1;
  const k = scale * dpr;
  for (const [c, ctx] of [[inkCanvas, ink], [liveCanvas, live]]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  redrawAll();
}

function clearCtx(ctx) {
  ctx.clearRect(0, 0, PAGE_W, PAGE_H);
}

// ---------------------------------------------------------------- 線の描画
// 線は [x, y, 筆圧, x, y, 筆圧, ...] で持つ。点と点の中点をつなぐ2次曲線で滑らかにする。

function widthAt(s, p) {
  return s.size * (0.35 + 1.3 * p);
}

// 点 i が追加された時点で確定する区間を描く
function drawStep(ctx, s, i) {
  const P = s.pts;
  const x1 = P[i * 3 - 3], y1 = P[i * 3 - 2], p1 = P[i * 3 - 1];
  const x2 = P[i * 3], y2 = P[i * 3 + 1], p2 = P[i * 3 + 2];
  ctx.lineWidth = widthAt(s, (p1 + p2) / 2);
  ctx.beginPath();
  if (i === 1) {
    ctx.moveTo(x1, y1);
  } else {
    ctx.moveTo((P[i * 3 - 6] + x1) / 2, (P[i * 3 - 5] + y1) / 2);
  }
  ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  ctx.stroke();
}

// 最後の中点から最後の点まで（まだ確定していない端っこ）
function drawTail(ctx, s, extra) {
  const P = s.pts;
  const n = P.length / 3;
  const lx = P[n * 3 - 3], ly = P[n * 3 - 2], lp = P[n * 3 - 1];
  if (n === 1 && !(extra && extra.length)) {
    ctx.beginPath();
    ctx.arc(lx, ly, widthAt(s, lp) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = widthAt(s, lp);
  ctx.beginPath();
  if (n === 1) ctx.moveTo(lx, ly);
  else ctx.moveTo((P[n * 3 - 6] + lx) / 2, (P[n * 3 - 5] + ly) / 2);
  ctx.lineTo(lx, ly);
  if (extra) for (const [x, y] of extra) ctx.lineTo(x, y);
  ctx.stroke();
}

function drawStroke(ctx, s) {
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  const n = s.pts.length / 3;
  for (let i = 1; i < n; i++) drawStep(ctx, s, i);
  drawTail(ctx, s);
}

function redrawAll() {
  clearCtx(ink);
  if (state.strokes) for (const s of state.strokes) drawStroke(ink, s);
}

// ---------------------------------------------------------------- 入力

function toPage(e) {
  return [(e.clientX - pageRect.left) / scale, (e.clientY - pageRect.top) / scale];
}

let current = null;   // 書いている途中の線
let erasing = null;   // 消しゴム中の情報
let swipe = null;     // 指スワイプ中の情報

function isDrawingPointer(e) {
  // iPad では Apple Pencil = 'pen'、指や手のひら = 'touch'。Mac での確認用にマウスも書ける。
  return e.pointerType === 'pen' || e.pointerType === 'mouse';
}

page.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    startSwipe(e);
    return;
  }
  if (!isDrawingPointer(e) || e.button !== 0 || !state.strokes) return;
  e.preventDefault();
  lastPenTime = Date.now();
  if (swipe) swipe.cancelled = true;
  for (const a of page.getAnimations()) a.finish();
  pageRect = page.getBoundingClientRect();
  try { page.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても描ける */ }

  const [x, y] = toPage(e);
  if (state.tool === 'eraser') {
    erasing = { id: e.pointerId, x, y };
    eraseAlong(x, y, x, y);
    drawEraserCursor(x, y);
  } else {
    const p = pressureOf(e, null);
    current = {
      id: e.pointerId,
      stroke: { color: state.color, size: state.size, pts: [round1(x), round1(y), p] },
      lastP: p,
    };
    drawLive(e);
  }
});

page.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    moveSwipe(e);
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
    endSwipe(e);
    return;
  }
  if ((current && e.pointerId === current.id) || (erasing && e.pointerId === erasing.id)) endStroke();
};
page.addEventListener('pointerup', finishPointer);
page.addEventListener('pointercancel', finishPointer);

function round1(v) {
  return Math.round(v * 10) / 10;
}

function pressureOf(e, prev) {
  // マウスは筆圧が無いので中間の値。ペンは少しなめらかにして震えを抑える。
  let p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
  p = Math.min(1, Math.max(0.05, p));
  if (prev != null) p = prev * 0.6 + p * 0.4;
  return Math.round(p * 100) / 100;
}

function addPoint(e) {
  const s = current.stroke;
  const [x, y] = toPage(e);
  const n = s.pts.length / 3;
  const dx = x - s.pts[n * 3 - 3];
  const dy = y - s.pts[n * 3 - 2];
  if (dx * dx + dy * dy < 0.09) return;   // 近すぎる点は省く
  const p = pressureOf(e, current.lastP);
  current.lastP = p;
  s.pts.push(round1(x), round1(y), p);
  ink.strokeStyle = s.color;
  drawStep(ink, s, n);
}

// 確定前の端っこと、ブラウザが予測した先の点を上のキャンバスに描いて遅れを小さく見せる
let liveDirty = false;
function drawLive(e) {
  clearCtx(live);
  const s = current.stroke;
  let predicted = [];
  if (e.getPredictedEvents) {
    try { predicted = e.getPredictedEvents().map(toPage); } catch (err) { predicted = []; }
  }
  live.strokeStyle = s.color;
  live.fillStyle = s.color;
  drawTail(live, s, predicted);
  liveDirty = true;
}

function drawEraserCursor(x, y) {
  clearCtx(live);
  live.lineWidth = 1 / scale;
  live.strokeStyle = 'rgba(0,0,0,0.35)';
  live.beginPath();
  live.arc(x, y, ERASER_R, 0, Math.PI * 2);
  live.stroke();
  liveDirty = true;
}

function endStroke() {
  if (current) {
    const s = current.stroke;
    ink.strokeStyle = s.color;
    ink.fillStyle = s.color;
    drawTail(ink, s);
    state.strokes.push(s);
    current = null;
    markDirty();
  }
  erasing = null;
  if (liveDirty) {
    clearCtx(live);
    liveDirty = false;
  }
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

function hits(s, x, y) {
  const b = bboxOf(s);
  const r = ERASER_R + s.size * 1.7;
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
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (ERASER_R / 2)));
  let removed = false;
  for (let k = 0; k <= steps; k++) {
    const x = x0 + (x1 - x0) * (k / steps);
    const y = y0 + (y1 - y0) * (k / steps);
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (hits(strokes[i], x, y)) {
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

// ---------------------------------------------------------------- 指スワイプで週を移動

function startSwipe(e) {
  if (swipe) {
    swipe.cancelled = true;   // 2本目の指や手のひらが触れたらスワイプしない
    return;
  }
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(),
    cancelled: Date.now() - lastPenTime < PALM_GUARD_MS };
}
function moveSwipe(e) {
  if (swipe && e.pointerId === swipe.id && (current || erasing)) swipe.cancelled = true;
}
function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const s = swipe;
  swipe = null;
  if (s.cancelled || e.type === 'pointercancel') return;
  if (lastPenTime > s.t - 300) return;   // スワイプ中にペンが使われた＝手のひら
  const dx = e.clientX - s.x;
  const dy = e.clientY - s.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 900) {
    goWeek(dx < 0 ? 1 : -1);
  }
}

// iPad Safari の長押しメニュー・拡大鏡・ダブルタップ拡大・ピンチを止める
page.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
page.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Mac で確認しやすいように：矢印キーとトラックパッドの横スクロールでも週を移動
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') goWeek(-1);
  if (e.key === 'ArrowRight') goWeek(1);
});
let wheelAcc = 0;
let wheelLock = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Date.now() < wheelLock) return;
  wheelAcc += e.deltaX;
  if (Math.abs(wheelAcc) > 80) {
    goWeek(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
    wheelLock = Date.now() + 500;
  }
}, { passive: false });

// ---------------------------------------------------------------- ツールバー

const toolButtons = document.querySelectorAll('.tool[data-tool]');
for (const btn of toolButtons) {
  btn.addEventListener('click', () => {
    state.tool = btn.dataset.tool;
    for (const b of toolButtons) b.classList.toggle('active', b === btn);
  });
}

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

$('backupBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
  if (!menu.hidden) updateBackupInfo();
});
document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !$('backupBtn').contains(e.target)) menu.hidden = true;
});

let preparedBackup = null;   // 共有画面を開けなかったときに、もう一度押してもらう用

async function makeBackupFile() {
  await flush();
  const all = await store.getAllWeeks();
  const data = { app: 'techo', format: 1, exportedAt: new Date().toISOString(), weeks: all };
  const name = `techo-backup-${dateKey(new Date())}.json`;
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
window.addEventListener('resize', layout);
layout();
showWeek();
store.getAllWeeks().then((all) => {
  hasInk = Object.values(all).some((v) => v.strokes && v.strokes.length);
  updateBackupInfo();
}).catch(() => {});

// 日付が変わったら「今日」の色を更新
setInterval(() => {
  const el = template.querySelector('.today');
  const todayIdx = Math.round((new Date(new Date().toDateString()) - state.weekStart) / 864e5);
  const shown = el ? [...template.querySelectorAll('.day')].indexOf(el) : -1;
  if (shown !== todayIdx && (shown >= 0 || (todayIdx >= 0 && todayIdx < 7))) renderTemplate();
}, 60000);

// 保存領域を「消されにくい」扱いにしてもらう
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// オフライン対応
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
