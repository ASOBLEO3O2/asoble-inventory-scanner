// app.js

/* ========= 設定 ========= */
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTiwtxITkdkbft_o3_Nf13lhEKTwj-9Ue3OBU3lDf4Um3DMOAfvatc_4kpUNvMjh4UwfNJjuKDD9GJy/pub?gid=1631694178&single=true&output=csv";

// ✅ SCAN_LOG 受け口（GAS Webアプリ）
const GAS_SCAN_LOG_URL =
  "https://script.google.com/macros/s/AKfycbyGhi9YtFyWDyBYFInOK4ZvAXp5pwzNHSPDaL8bmaH0CsZxQjHCBMllLjmw044NI0_P/exec";


// 連続検出の誤連打抑制
const SAME_CODE_COOLDOWN_MS = 1500;
const ANY_CODE_COOLDOWN_MS  = 140;

// OCR
const OCR_INTERVAL_MS = 700;
const OCR_MIN_GAP_AFTER_HIT_MS = 900;

/* ========= 状態 ========= */
const el = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let STORE = (qs.get("store") || "").trim();

const st = {
  all: [],
  rows: [],
  byCode: new Map(),
  scanned: [],      // 今回の履歴（表示用）
  okSet: new Set(), // 取得済み（永続）
  ngCount: 0,

  // ✅ 追加：store_key -> store_name
  storeNameByKey: new Map(),
};

/* ========= 正規化 ========= */
const normalize = (s) => String(s ?? "")
  .trim()
  .replace(/\r?\n/g, "")
  .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[ー−―‐\- ]/g, "")
  .toUpperCase();

function codeVariants(raw){
  const c = normalize(raw);
  if(!c) return [];
  const out = new Set();
  out.add(c);
  out.add(c.replace(/^0+/, ""));

  const digits = c.replace(/\D/g, "");
  if(digits){
    out.add(digits);
    out.add(digits.replace(/^0+/, ""));
  }
  return [...out].filter(Boolean);
}

/* ========= CSV ========= */
function parseCSV(t){
  const lines = t.replace(/\r/g,"").split("\n").filter(Boolean);
  if(!lines.length) return [];
  const header = lines.shift().split(",").map(x=>x.trim());
  const idx = {};
  header.forEach((h,i)=>idx[h]=i);
  const pick = (cols, key) => (idx[key] == null) ? "" : (cols[idx[key]] ?? "");
  return lines.map(line=>{
    const cols = line.split(",").map(x => x.replace(/^"|"$/g,"").replace(/""/g,'"'));
    return {
      store_key: pick(cols,"store_key"),
      store_name: pick(cols,"store_name"),
      code: pick(cols,"code"),
      machine_name: pick(cols,"machine_name"),
      actual_stock: pick(cols,"actual_stock"),
      updated_at: pick(cols,"updated_at"),
    };
  });
}

/* ========= UI helpers ========= */
function setMode(m){
  el("home").style.display = (m==="home") ? "" : "none";
  el("scanner").style.display = (m==="scan") ? "" : "none";
}
function pct(n){
  if(!isFinite(n)) return "0.0";
  return (Math.round(n*10)/10).toFixed(1);
}
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function vibrateOk(){ try{ if(navigator.vibrate) navigator.vibrate([60,30,60]); }catch(_e){} }
function vibrateDone(){ try{ if(navigator.vibrate) navigator.vibrate([120,60,120,60,220]); }catch(_e){} }
function vibrateWeak(){ try{ if(navigator.vibrate) navigator.vibrate(25); }catch(_e){} }

// 成功時：音
let audioCtx = null;
function beep(){
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.04;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); }, 90);
  }catch(_e){}
}

let toastTimer = null;
function showToast(text){
  const t = el("toast");
  if(!t) return;
  t.textContent = text;
  t.classList.add("show");
  t.setAttribute("aria-hidden","false");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    t.classList.remove("show");
    t.setAttribute("aria-hidden","true");
  }, 900);
}

function flash(){
  const f = el("flash");
  if(!f) return;
  f.classList.add("on");
  setTimeout(()=>f.classList.remove("on"), 70);
}

/* ========= session_id（①方式） ========= */
function sessionKey(){
  return STORE ? `inv_session_${STORE}` : "inv_session__";
}
function newSessionId(){
  const d = new Date();
  const pad = (n)=>String(n).padStart(2,"0");
  // ✅ GAS側が見やすいように「YYYYMMDD_HHMMSS」
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function getSessionId(){
  if(!STORE) return "";
  try{
    let v = localStorage.getItem(sessionKey());
    if(!v){
      v = newSessionId();
      localStorage.setItem(sessionKey(), v);
    }
    return v;
  }catch(_e){
    return "";
  }
}
function rotateSession(){
  if(!STORE) return "";
  const sid = newSessionId();
  try{ localStorage.setItem(sessionKey(), sid); }catch(_e){}
  return sid;
}

/* ========= 永続化（自動保存） ========= */
function storageKey(){
  return STORE ? `inv_scan_ok_${STORE}` : "inv_scan_ok__";
}
function persist(){
  if(!STORE) return;
  try{
    localStorage.setItem(storageKey(), JSON.stringify({
      v: 1,
      store: STORE,
      ok: [...st.okSet.values()],
      ng: st.ngCount,
      saved_at: Date.now()
    }));
  }catch(_e){}
}
function restore(){
  if(!STORE) return;
  try{
    const raw = localStorage.getItem(storageKey());
    if(!raw) return;
    const obj = JSON.parse(raw);
    const ok = Array.isArray(obj?.ok) ? obj.ok : [];
    st.okSet = new Set(ok.map(normalize));
    st.ngCount = Number(obj?.ng || 0);
  }catch(_e){}
}
function clearProgress(){
  if(!STORE) return;
  st.okSet = new Set();
  st.ngCount = 0;
  st.scanned = [];
  try{ localStorage.removeItem(storageKey()); }catch(_e){}
}

/* ========= ✅ 店舗名取得（STORE固定で使う） ========= */
function currentStoreName(){
  if(!STORE) return "";
  return String(st.storeNameByKey.get(STORE) || STORE).trim();
}

/* ========= ✅ SCAN_LOG 送信（store_key/store_name は常に STORE に固定） ========= */
async function postScanLog({ code, machine_name="", result="OK" }){
  if(!GAS_SCAN_LOG_URL) return false;

  const body = {
    ts: new Date().toISOString(),
    session_id: getSessionId(),

    // ✅ ここが重要：混ざる原因を完全排除
    store_key: (STORE || "").trim(),
    store_name: currentStoreName(),

    code: String(code || "").trim(),
    machine_name: String(machine_name || "").trim(),
    result: String(result || "OK").trim(), // OK/NG/RESCAN/RESET
    source: "github-scan",
    ua: navigator.userAgent || ""
  };

  // ✅ RESET は code 空でも送る（それ以外は code 必須）
  if(!body.code && body.result !== "RESET") return false;

  try{
    const res = await fetch(GAS_SCAN_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // プリフライト回避
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const txt = await res.text().catch(()=> "");
    let obj = null;
    try{ obj = JSON.parse(txt); }catch(_e){}

    if(obj && obj.ok === false){
      showToast("⚠️ LOG失敗: " + (obj.error || "unknown"));
      return false;
    }
    if(obj?.dup){
      showToast("⚠️ 重複検知（同一コード）");
    }
    if(obj?.warn){
      showToast("⚠️ " + String(obj.warn));
    }
    return true;

  }catch(_e){
    showToast("⚠️ LOG送信失敗（通信）");
    return false;
  }
}

/* ========= バッジ/進捗 ========= */
function showDoneIfComplete(){
  if(!STORE) return;
  const total = st.rows.length;
  const done = st.okSet.size;
  if(total > 0 && done >= total){
    el("doneOverlay").style.display = "flex";
    vibrateDone();
    beep();
  }
}
function hideDone(){ el("doneOverlay").style.display = "none"; }

function updateBadges(){
  el("storeBadge").textContent = "store: " + (STORE || "HOME");
  el("countBadge").textContent = "rows: " + (STORE ? st.rows.length : "-");

  if(!STORE){
    el("progressBadge").textContent="progress: -";
    el("remainBadge").textContent="remain: -";
    el("ngBadge").textContent="ng: 0";
    el("updatedBadge").textContent="updated: " + String(st.all[0]?.updated_at || "-").slice(0,10);
    el("progressText").textContent="progress: -";
    el("progressFill").style.width="0%";
    return;
  }

  const total = st.rows.length;
  const done = st.okSet.size;
  const remain = Math.max(0, total - done);
  const p = total ? (done * 100 / total) : 0;

  el("progressBadge").textContent = `progress: ${done}/${total} (${pct(p)}%)`;
  el("remainBadge").textContent = `remain: ${remain}`;
  el("ngBadge").textContent = `ng: ${st.ngCount}`;
  el("updatedBadge").textContent = "updated: " + String(st.rows[0]?.updated_at || st.all[0]?.updated_at || "-").slice(0,10);

  el("progressText").textContent = `progress: ${done}/${total} (${pct(p)}%)  remain:${remain}`;
  el("progressFill").style.width = `${Math.min(100, Math.max(0,p))}%`;
}

/* ========= 描画 ========= */
function renderHitRow(row){
  const codeKey = normalize(row.code);
  const done = st.okSet.has(codeKey);
  const cls = `hitRow okRow ${done ? "done" : ""}`;
  return `
    <div class="${cls}">
      <div class="meta">
        <span class="code">${escapeHtml(row.code)}</span>
        <span class="tag">${done ? "済" : "未"}</span>
      </div>
      <div class="machine">マシン: ${escapeHtml(row.machine_name || "-")}</div>
    </div>
  `;
}

function renderHome(){
  setMode("home");
  el("title").textContent = "棚卸スキャナ（店舗選択）";

  const map = new Map();
  for(const r of st.all){
    if(r.store_key && !map.has(r.store_key)) map.set(r.store_key, r.store_name || r.store_key);
  }

  el("storeGrid").innerHTML = [...map.entries()]
    .sort((a,b)=>String(a[1]).localeCompare(String(b[1]),"ja"))
    .map(([k,n]) => `
      <a class="storeCard" href="?store=${encodeURIComponent(k)}">
        <b>${escapeHtml(n)}</b><div class="muted small">${escapeHtml(k)}</div>
      </a>
    `).join("");

  updateBadges();
}

function renderScan(){
  setMode("scan");
  el("title").textContent = "棚卸スキャナ";
  el("msg").textContent = "読込完了。入力欄にフォーカスしてスキャンしてください。";
  el("remainCard").style.display = "none";
  el("okCard").style.display = "none";
  updateBadges();
  el("scanInput").focus();
}

function renderPanels(){
  updateBadges();
  const last = st.scanned[0];
  el("current").innerHTML = last ? renderHitRow(last.row) : "";

  el("history").innerHTML = st.scanned.slice(0, 60).map(x=>{
    const key = normalize(x.row.code);
    const done = st.okSet.has(key);
    const cls = `hitRow okRow ${done ? "done" : ""}`;
    return `
      <div class="${cls}">
        <div class="meta">
          <span class="code">✅ ${escapeHtml(x.row.code)}</span>
          <span class="tag">${done ? "済" : "未"}</span>
        </div>
        <div class="machine">${escapeHtml(x.row.machine_name || "-")}</div>
      </div>
    `;
  }).join("");
}

function renderRemainGrid(){
  if(!STORE) return;
  const remainRows = st.rows.filter(r => !st.okSet.has(normalize(r.code)));
  const shown = remainRows.slice(0, 240);

  el("remainList").innerHTML = shown.map(r=>`
    <div class="remainItem">
      <div class="c">${escapeHtml(r.code)}</div>
      <div class="m">${escapeHtml(r.machine_name || "-")}</div>
    </div>
  `).join("") + (remainRows.length > shown.length
      ? `<div class="remainItem"><div class="c">…</div><div class="m">残り ${remainRows.length - shown.length} 件省略</div></div>`
      : "");

  el("remainCard").style.display = "";
  el("remainCard").scrollIntoView({ behavior:"smooth", block:"start" });
}

function renderOkGrid(){
  if(!STORE) return;
  const okRows = st.rows.filter(r => st.okSet.has(normalize(r.code)));
  const shown = okRows.slice(0, 240);

  el("okList").innerHTML = shown.map(r=>`
    <div class="remainItem">
      <div class="c">${escapeHtml(r.code)}</div>
      <div class="m">${escapeHtml(r.machine_name || "-")}</div>
    </div>
  `).join("") + (okRows.length > shown.length
      ? `<div class="remainItem"><div class="c">…</div><div class="m">取得済み ${okRows.length - shown.length} 件省略</div></div>`
      : "");

  el("okCard").style.display = "";
  el("okCard").scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ========= スキャン確定 ========= */
let lastAnyTs = 0;
let lastText = "";
let lastTextTs = 0;
let lastHitTs = 0;

function addScan(v){
  const variants = codeVariants(v);
  if(!variants.length) return;

  // 1) まず行に当たるか
  let hitRow = null;
  let hitKey = null;

  for(const c of variants){
    const row = st.byCode.get(c);
    if(row){
      hitRow = row;
      hitKey = normalize(row.code);
      break;
    }
  }

  const now = Date.now();

  // 2) 行に当たらないが、既にOKセットにあるなら「再スキャン」
  if(!hitRow){
    const isRescan = variants.some(x => st.okSet.has(normalize(x)));
    if(isRescan){
      lastHitTs = now;
      vibrateWeak();
      showToast(`✅（再）取得済み`);
      el("msg").textContent = "再スキャン（取得済み）";

      // ✅ SCAN_LOG（RESCAN） store固定
      postScanLog({ code: variants[0] || "", result: "RESCAN" });
      return;
    }

    // 完全に一致なし
    st.ngCount++;
    persist();
    updateBadges();
    showToast("❌ 一致なし");
    el("msg").textContent = "一致なし（リストにありません）";

    // ✅ SCAN_LOG（NG） store固定
    postScanLog({ code: variants[0] || "", result: "NG" });
    return;
  }

  // 3) 行に当たったが既にOK → 再スキャン
  if(st.okSet.has(hitKey)){
    lastHitTs = now;
    vibrateWeak();
    showToast(`✅（再）${hitRow.code}`);
    el("msg").textContent = "再スキャン（取得済み）";

    // ✅ SCAN_LOG（RESCAN） store固定
    postScanLog({
      code: hitRow.code,
      machine_name: hitRow.machine_name || "",
      result: "RESCAN"
    });
    return;
  }

  // 4) 初回OK
  st.okSet.add(hitKey);

  vibrateOk();
  beep();
  flash();
  showToast(`✅ ${hitRow.code} ／ ${hitRow.machine_name || "-"}`);
  lastHitTs = now;

  st.scanned.unshift({ row: hitRow, ok: true, ts: now });
  el("msg").textContent = "一致しました（連続スキャン中）";

  persist();
  renderPanels();
  showDoneIfComplete();

  // ✅ SCAN_LOG（OK） store固定
  postScanLog({
    code: hitRow.code,
    machine_name: hitRow.machine_name || "",
    result: "OK"
  });
}

/* ========= カメラ（Quagga2 + OCR） ========= */
let camRunning = false;
let stream = null;
let quaggaStarted = false;

// OCR
let ocrWorker = null;
let ocrTimer = null;
let ocrBusy = false;

const videoEl = () => el("camVideo");

function openCamModal(){
  el("camModal").style.display = "block";
  el("camModal").setAttribute("aria-hidden","false");
  showToast("← 戻る で終了");
}
function closeCamModal(){
  el("camModal").style.display = "none";
  el("camModal").setAttribute("aria-hidden","true");
}

function setCamStatus(text){
  const s = el("camStatus");
  if(s) s.textContent = text;
}

function setOcrBadge(on, text){
  const b = el("ocrBadge");
  if(!b) return;
  if(on){
    b.classList.add("on");
    b.setAttribute("aria-hidden","false");
    b.textContent = text || "OCR準備中…";
  }else{
    b.classList.remove("on");
    b.setAttribute("aria-hidden","true");
  }
}

/* ズーム/トーチ */
async function applyTrackConstraints(advanced){
  try{
    const tr = stream?.getVideoTracks?.()[0];
    if(!tr) return false;
    await tr.applyConstraints({ advanced: [advanced] });
    return true;
  }catch(_e){
    return false;
  }
}

async function applyZoomFromUI(){
  const zr = el("zoomRange");
  const zv = el("zoomVal");
  if(!zr || !zv) return;
  const z = Number(zr.value || 1);
  zv.textContent = `${z.toFixed(1)}x`;
  await applyTrackConstraints({ zoom: z });
}

let torchOn = false;
async function toggleTorch(){
  torchOn = !torchOn;
  const ok = await applyTrackConstraints({ torch: torchOn });
  if(!ok){
    torchOn = false;
    showToast("🔦 この端末はトーチ非対応");
  }else{
    showToast(torchOn ? "🔦 ON" : "🔦 OFF");
  }
}

/* preflight */
async function startCameraPreflight(){
  if(location.protocol === "file:"){
    setCamStatus("camera: blocked (file://)");
    showToast("file://ではカメラ不可。HTTPS or localhostで開いてください");
    return false;
  }

  setCamStatus("camera: requesting permission...");

  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    const v = videoEl();
    if(v){
      v.srcObject = stream;
      await v.play().catch(()=>{});
    }

    setCamStatus("camera: permission ok");
    return true;

  }catch(e){
    console.error(e);
    const name = String(e?.name || "");
    if(name.includes("NotAllowedError")){
      setCamStatus("camera: permission denied");
      showToast("📷 カメラ権限が拒否されています（🔒で許可）");
    }else if(name.includes("NotFoundError")){
      setCamStatus("camera: no camera");
      showToast("📷 カメラが見つかりません");
    }else if(name.includes("NotReadableError")){
      setCamStatus("camera: busy");
      showToast("📷 他アプリがカメラ使用中の可能性");
    }else{
      setCamStatus("camera: getUserMedia error");
      showToast("📷 カメラ起動エラー（console確認）");
    }
    try{ stream?.getTracks?.().forEach(t=>t.stop()); }catch(_){}
    stream = null;
    return false;
  }
}

/* OCR */
function createOcrCanvasFromVideo(){
  const v = videoEl();
  const vw = v.videoWidth || 0;
  const vh = v.videoHeight || 0;
  if(!vw || !vh) return null;

  const bandH = Math.floor(vh * 0.28);
  const sy = Math.floor((vh - bandH) / 2);
  const sx = Math.floor(vw * 0.10);
  const sw = Math.floor(vw * 0.80);
  const sh = bandH;

  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = Math.floor(900 * (sh / sw));

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    const r=d[i], g=d[i+1], b=d[i+2];
    let y = (0.2126*r + 0.7152*g + 0.0722*b);
    y = (y - 128) * 1.25 + 128;
    y = Math.max(0, Math.min(255, y));
    d[i]=d[i+1]=d[i+2]=y;
  }
  ctx.putImageData(img,0,0);

  return canvas;
}

function extractCandidatesFromText(text){
  const raw = String(text || "").toUpperCase();
  const fixed = raw
    .replaceAll("O","0")
    .replaceAll("I","1")
    .replaceAll("L","1")
    .replaceAll("S","5");

  const parts = fixed.split(/[^A-Z0-9]+/g).filter(Boolean);
  const cand = [];
  for(const p of parts){
    if(p.length < 4) continue;
    cand.push(p);
    const digits = p.replace(/\D/g,"");
    if(digits.length >= 4) cand.push(digits);
  }
  return [...new Set(cand)];
}

function tryHitByCandidates(cands){
  for(const c of cands){
    for(const v of codeVariants(c)){
      const row = st.byCode.get(v);
      if(row){
        addScan(row.code);
        return true;
      }
    }
  }
  return false;
}

async function ensureOcrWorker(){
  if(ocrWorker) return;
  setOcrBadge(true, "OCR準備中…（初回だけ数秒）");
  // @ts-ignore
  ocrWorker = await Tesseract.createWorker("eng", 1, { logger: (_m)=>{} });
  await ocrWorker.setParameters({
    tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    preserve_interword_spaces: "1",
  });
  setOcrBadge(false);
}

function startOcrLoop(){
  stopOcrLoop();
  ocrTimer = setInterval(async ()=>{
    if(!camRunning) return;
    if(ocrBusy) return;

    const now = Date.now();
    if(now - lastHitTs < OCR_MIN_GAP_AFTER_HIT_MS) return;

    const v = videoEl();
    if(!v || !v.videoWidth) return;

    ocrBusy = true;
    try{
      await ensureOcrWorker();
      const canvas = createOcrCanvasFromVideo();
      if(!canvas){ ocrBusy=false; return; }

      setOcrBadge(true, "OCR中…（番号でもOK）");
      const res = await ocrWorker.recognize(canvas);
      const text = res?.data?.text || "";

      const cands = extractCandidatesFromText(text);
      if(cands.length){
        const hit = tryHitByCandidates(cands);
        if(hit) lastHitTs = Date.now();
      }
    }catch(_e){
    }finally{
      setOcrBadge(false);
      ocrBusy = false;
    }
  }, OCR_INTERVAL_MS);
}

function stopOcrLoop(){
  if(ocrTimer){
    clearInterval(ocrTimer);
    ocrTimer = null;
  }
  setOcrBadge(false);
}

/* ✅ 強制停止（LED消えない対策） */
function stopTracksFromStream(s){
  try{
    s?.getTracks?.().forEach(t=>{
      try{ t.stop(); }catch(_e){}
    });
  }catch(_e){}
}

function forceStopCamera(){
  try{ stopOcrLoop(); }catch(_e){}
  camRunning = false;

  try{
    if(window.Quagga?.CameraAccess){
      const ca = Quagga.CameraAccess;

      if(typeof ca.getActiveStream === "function"){
        const qs = ca.getActiveStream();
        stopTracksFromStream(qs);
      }

      if(typeof ca.getActiveTrack === "function"){
        const tr = ca.getActiveTrack();
        try{ tr?.stop?.(); }catch(_e){}
      }

      if(typeof ca.release === "function"){
        try{ ca.release(); }catch(_e){}
      }
    }
  }catch(_e){}

  stopTracksFromStream(stream);
  stream = null;

  try{
    const v = videoEl();
    if(v) v.srcObject = null;
  }catch(_e){}

  try{
    if(window.Quagga && quaggaStarted){
      if(quaggaOnDetected){
        try{ Quagga.offDetected(quaggaOnDetected); }catch(_e){}
        quaggaOnDetected = null;
      }
      Quagga.stop(()=>{});
    }
  }catch(_e){}
  quaggaStarted = false;

  setCamStatus("camera: stopped");
}

/* Quagga */
let quaggaOnDetected = null;

async function startQuagga(){
  if(!window.Quagga){
    setCamStatus("camera: Quagga NG");
    showToast("Quagga 読み込み失敗");
    return false;
  }

  setCamStatus("camera: starting...");
  quaggaStarted = false;

  const targetEl = el("videoWrap");
  if(!targetEl){
    setCamStatus("camera: target missing");
    showToast("#videoWrap が見つかりません");
    return false;
  }

  const config = {
    inputStream: {
      type: "LiveStream",
      target: targetEl,
      constraints: {
        facingMode: "environment",
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    },
    locator: { patchSize: "medium", halfSample: true },
    numOfWorkers: navigator.hardwareConcurrency ? Math.max(2, Math.min(6, navigator.hardwareConcurrency - 1)) : 4,
    frequency: 8,
    decoder: {
      readers: [
        "code_128_reader",
        "ean_reader",
        "ean_8_reader",
        "upc_reader",
        "upc_e_reader",
        "code_39_reader",
        "codabar_reader",
        "i2of5_reader",
      ]
    },
    locate: true
  };

  return new Promise((resolve)=>{
    Quagga.init(config, async (err)=>{
      if(err){
        console.error(err);
        setCamStatus("camera: init error");
        showToast("camera init error（console確認）");
        resolve(false);
        return;
      }

      Quagga.start();
      quaggaStarted = true;
      camRunning = true;
      setCamStatus("camera: running");

      try{
        const ca = Quagga?.CameraAccess;
        if(ca?.getActiveTrack){
          const track = ca.getActiveTrack();
          if(track) stream = new MediaStream([track]);
        }
      }catch(_e){}

      await applyZoomFromUI();
      startOcrLoop();

      if(quaggaOnDetected) Quagga.offDetected(quaggaOnDetected);
      quaggaOnDetected = (res)=>{
        const now = Date.now();
        if(now - lastAnyTs < ANY_CODE_COOLDOWN_MS) return;

        const code = res?.codeResult?.code || "";
        const txt = normalize(code);
        if(!txt) return;

        if(txt === lastText && (now - lastTextTs) < SAME_CODE_COOLDOWN_MS) return;

        lastAnyTs = now;
        lastText = txt;
        lastTextTs = now;

        addScan(code);
      };
      Quagga.onDetected(quaggaOnDetected);

      resolve(true);
    });
  });
}

/* ========= 入力欄（物理スキャナ） ========= */
let inputBufTimer = null;
function wireScanInput(){
  const inp = el("scanInput");
  inp.addEventListener("input", ()=>{
    clearTimeout(inputBufTimer);
    inputBufTimer = setTimeout(()=>{
      const v = inp.value;
      inp.value = "";
      addScan(v);
    }, 30);
  });

  inp.addEventListener("keydown", (e)=>{
    if(e.key === "Enter"){
      e.preventDefault();
      const v = inp.value;
      inp.value = "";
      addScan(v);
    }
  });
}

/* ========= データ読込 ========= */
async function loadCsv(){
  const res = await fetch(DATA_CSV_URL, { cache:"no-store" });
  const text = await res.text();
  st.all = parseCSV(text);

  // ✅ storeNameByKey を作る（最初に1回）
  st.storeNameByKey.clear();
  for(const r of st.all){
    const sk = String(r.store_key || "").trim();
    if(!sk) continue;
    if(!st.storeNameByKey.has(sk)){
      st.storeNameByKey.set(sk, String(r.store_name || sk).trim());
    }
  }

  st.byCode.clear();
  for(const r of st.all){
    for(const v of codeVariants(r.code)){
      if(!st.byCode.has(v)) st.byCode.set(v, r);
    }
  }

  if(STORE){
    st.rows = st.all.filter(r => String(r.store_key||"").trim() === STORE);
  }else{
    st.rows = [];
  }
}

/* ========= UI ========= */
function bindUi(){
  el("btnHome").addEventListener("click", ()=>{
    location.href = location.pathname;
  });

  el("btnShowOk").addEventListener("click", ()=>{
    const card = el("okCard");
    const showing = card.style.display !== "none" && card.style.display !== "";
    if(showing){
      card.style.display = "none";
    }else{
      renderOkGrid();
    }
  });

  el("btnClear").addEventListener("click", ()=>{
    st.scanned = [];
    el("current").innerHTML = "";
    el("history").innerHTML = "";
    showToast("🧹 今回（履歴）をクリア");
  });

  // 進捗リセット（永続も消す）＋ session_id切替 ＋ RESETログ
  el("btnResetProgress").addEventListener("click", async ()=>{
    if(!STORE) return;
    const ok = confirm("この店舗の進捗（取得済み/NG/保存）をリセットします。よろしいですか？");
    if(!ok) return;

    clearProgress();
    hideDone();
    updateBadges();
    renderPanels();
    el("remainCard").style.display = "none";
    el("okCard").style.display = "none";

    rotateSession(); // ✅ 先に新セッション
    showToast("🧾 RESET記録中…");

    const sent = await postScanLog({
      code: "",
      machine_name: "",
      result: "RESET"
    });

    showToast(sent ? "🧨 リセット完了（新セッション）" : "⚠️ RESETログが残せていません");
  });

  el("btnShowRemain").addEventListener("click", ()=>{
    const card = el("remainCard");
    const showing = card.style.display !== "none" && card.style.display !== "";
    if(showing){
      card.style.display = "none";
    }else{
      renderRemainGrid();
    }
  });

  el("btnCamera").addEventListener("click", async ()=>{
    openCamModal();
    const ok = await startCameraPreflight();
    if(!ok) return;
    await startQuagga();
  });

  el("camClose").addEventListener("click", ()=>{
    closeCamModal();
    showToast("⬅ 戻りました");
    forceStopCamera();
  });

  el("btnTorch")?.addEventListener("click", toggleTorch);
  el("btnTorch2")?.addEventListener("click", toggleTorch);
  el("zoomRange").addEventListener("input", applyZoomFromUI);

  el("btnDoneClose").addEventListener("click", hideDone);

  wireScanInput();
}

document.addEventListener("visibilitychange", ()=>{
  if(document.hidden){
    if(el("camModal")?.style?.display === "block"){
      closeCamModal();
      forceStopCamera();
    }
  }
});

/* ========= 起動 ========= */
async function boot(){
  bindUi();

  try{
    await loadCsv();
  }catch(e){
    console.error(e);
    showToast("CSV読込に失敗");
    el("title").textContent = "棚卸スキャナ（エラー）";
    return;
  }

  if(!STORE){
    renderHome();
    return;
  }

  // ✅ 店舗に入った瞬間に session_id を確保
  getSessionId();

  restore();
  renderScan();
  renderPanels();
  showDoneIfComplete();
}

boot();
