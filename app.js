/* ========= 設定 ========= */
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

// 連続検出の誤連打抑制（元の仕様に戻す）
const SAME_CODE_COOLDOWN_MS = 900;   // 同一コードは0.9秒は無視
const ANY_CODE_COOLDOWN_MS  = 180;   // 全体も少し抑制

// OCRの頻度（バーコードが来ない時だけ動かす）
const OCR_INTERVAL_MS = 700;         // 0.7秒毎
const OCR_MIN_GAP_AFTER_HIT_MS = 1200; // 直近でHITしたらOCRしない

/* ========= 状態 ========= */
const el = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let STORE = (qs.get("store") || "").trim();

const st = {
  all: [],
  rows: [],
  byCode: new Map(),

  // OK/DUPのみ保存
  scanned: [], // { row, ts, dup:boolean }
  okSet: new Set(),

  // INVALIDは記録しない（カウンタのみ）
  ngCount: 0
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
  el("storeSelect").style.display = (m==="store") ? "" : "none";
  el("homeStatus").style.display  = (m==="home")  ? "" : "none";
  el("scanScreen").style.display  = (m==="scan")  ? "" : "none";
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

function vibrateOk(){
  try{ if(navigator.vibrate) navigator.vibrate([60,30,60]); }catch(_e){}
}
function vibrateDup(){
  try{ if(navigator.vibrate) navigator.vibrate([180,60,180]); }catch(_e){}
}
function vibrateDone(){
  try{ if(navigator.vibrate) navigator.vibrate([120,60,120,60,220]); }catch(_e){}
}

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
    const pt = el("progressText"); if(pt) pt.textContent="progress: -";
    const pf = el("progressFill"); if(pf) pf.style.width="0%";
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

  const pt = el("progressText"); if(pt) pt.textContent = `progress: ${done}/${total} (${pct(p)}%)  remain:${remain}`;
  const pf = el("progressFill"); if(pf) pf.style.width = `${Math.min(100, Math.max(0,p))}%`;
}

/* ========= 描画 ========= */
function renderHitRow(row, opt = {}){
  const codeKey = normalize(row.code);
  const done = st.okSet.has(codeKey);
  const dup = !!opt.dup;

  const cls = `hitRow okRow ${done ? "done" : ""} ${dup ? "dupRow" : ""}`;
  const tag = dup ? "重複" : (done ? "済" : "未");

  return `
    <div class="${cls}">
      <div class="meta">
        <span class="code">${escapeHtml(row.code)}</span>
        <span class="tag">${escapeHtml(tag)}</span>
      </div>
      <div class="machine">マシン: ${escapeHtml(row.machine_name || "-")}</div>
    </div>
  `;
}

function renderStoreSelect(){
  setMode("store");
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

function renderHomeStatus(){
  setMode("home");
  el("title").textContent = "棚卸スキャナ（ホーム）";
  updateBadges();

  const last = st.scanned[0];
  el("current").innerHTML = last ? renderHitRow(last.row, { dup: last.dup }) : "";

  el("history").innerHTML = st.scanned.slice(0, 60).map(x=>{
    return renderHitRow(x.row, { dup: x.dup });
  }).join("");

  const msgHome = el("msgHome");
  if(msgHome){
    msgHome.textContent = STORE
      ? "準備OK。読み取り開始を押してカメラを起動してください。"
      : "店舗を選択してください。";
  }

  showDoneIfComplete();
}

function renderScanScreen(){
  setMode("scan");
  el("title").textContent = "棚卸スキャナ（読み取り）";
  updateBadges();
  el("msg").textContent = "カメラでスキャンできます。必要なら入力欄にフォーカスしてスキャンしてください。";
  el("scanInput").focus();
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

/* ========= スキャン確定（元仕様：1回で確定） ========= */
let lastAnyTs = 0;
let lastText = "";
let lastTextTs = 0;
let lastHitTs = 0;

function addScan(v){
  const variants = codeVariants(v);
  if(!variants.length) return;

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

  // INVALID：記録しない（カウンタのみ）
  if(!hitRow){
    st.ngCount++;
    updateBadges();
    showToast("❌ 一致なし");
    el("msg").textContent = "一致なし（リストにありません）";
    return;
  }

  const already = st.okSet.has(hitKey);

  if(!already){
    st.okSet.add(hitKey);
    vibrateOk(); beep(); flash();
    showToast(`✅ ${hitRow.code} ／ ${hitRow.machine_name || "-"}`);
  }else{
    // 重複（強警告）
    vibrateDup(); beep(); flash();
    showToast(`⚠️ 重複 ${hitRow.code}`);
  }

  st.scanned.unshift({ row: hitRow, dup: already, ts: Date.now() });
  el("msg").textContent = already ? "重複スキャン（注意）" : "一致しました（連続スキャン中）";

  // 画面反映
  renderHomeStatus();
  showDoneIfComplete();

  // OCR抑制用
  lastHitTs = Date.now();
}

/* ========= カメラ（ZXing + OCR） ========= */
let camRunning = false;
let stream = null;

// video
const videoEl = () => el("camVideo");

// ZXing
let zxingReader = null;
let zxingStopFn = null;

// OCR
let ocrWorker = null;
let ocrTimer = null;
let ocrBusy = false;

function openCamModal(){
  el("camModal").style.display = "block";
  el("camModal").setAttribute("aria-hidden","false");
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

/* 端末が対応してればズーム/トーチを当てる */
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

/* OCR: 画面中央の“帯”だけ切り出して候補を拾う */
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
    const vars = codeVariants(c);
    for(const v of vars){
      const row = st.byCode.get(v);
      if(row){
        addScan(row.code); // 正規のcodeで確定
        return true;
      }
    }
  }
  return false;
}

/* OCRワーカーを起動 */
async function ensureOcrWorker(){
  if(ocrWorker) return;

  setOcrBadge(true, "OCR準備中…（初回だけ数秒）");

  // @ts-ignore
  ocrWorker = await Tesseract.createWorker("eng", 1, {
    logger: (_m) => {}
  });

  await ocrWorker.setParameters({
    tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    preserve_interword_spaces: "1",
  });

  setOcrBadge(false);
}

/* OCRループ：バーコードが来ない時だけ動かす */
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
      // OCRは落ちても運用継続
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

/* ZXing：連続読取（元仕様の抑制に戻す） */
function startZxingLoop(){
  if(!window.ZXingBrowser){
    setCamStatus("ZXing: NG（ライブラリ読込失敗）");
    return;
  }

  // @ts-ignore
  zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();

  // @ts-ignore
  const controls = zxingReader.decodeFromVideoElement(videoEl(), (result, err) => {
    const now = Date.now();

    // 全体抑制
    if(now - lastAnyTs < ANY_CODE_COOLDOWN_MS) return;

    if(result && result.getText){
      const text = result.getText();
      const n = normalize(text);
      if(!n) return;

      // 同一コード連続抑制
      if(n === lastText && (now - lastTextTs) < SAME_CODE_COOLDOWN_MS) return;

      lastAnyTs = now;
      lastText = n;
      lastTextTs = now;

      addScan(text);
      lastHitTs = Date.now();
    }
  });

  zxingStopFn = () => {
    try{ controls?.stop?.(); }catch(_e){}
  };

  setCamStatus("camera: ON / ZXing: ON / OCR: ON（フォールバック）");
}

/* start camera */
async function startCamera(){
  if(!STORE){ alert("先に店舗を選択してください"); return; }
  if(camRunning) return;

  openCamModal();

  // ユーザー操作後なので音声コンテキストを起こしておく
  try{
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === "suspended") await audioCtx.resume();
  }catch(_e){}

  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height:{ ideal: 720 }
      },
      audio: false
    });
  }catch(e){
    closeCamModal();
    alert("カメラ起動に失敗しました（権限/HTTPS/端末）");
    return;
  }

  const v = videoEl();
  v.srcObject = stream;
  try{ await v.play(); }catch(_e){}

  camRunning = true;

  await applyZoomFromUI();
  startZxingLoop();
  startOcrLoop();
}

/* stop camera */
async function stopCamera(){
  if(!camRunning){
    closeCamModal();
    return;
  }

  camRunning = false;

  stopOcrLoop();
  if(zxingStopFn){
    try{ zxingStopFn(); }catch(_e){}
    zxingStopFn = null;
  }
  try{
    zxingReader?.reset?.();
  }catch(_e){}
  zxingReader = null;

  try{
    stream?.getTracks?.().forEach(t => t.stop());
  }catch(_e){}
  stream = null;

  closeCamModal();
  try{ el("scanInput").focus(); }catch(_e){}
}

/* ========= 起動 ========= */
(async function main(){
  // 完了オーバーレイ
  el("btnDoneClose").onclick = hideDone;
  el("doneOverlay").addEventListener("click", (e) => {
    if(e.target === el("doneOverlay")) hideDone();
  });

  // カメラ操作
  el("btnCamera").onclick = () => startCamera();
  el("camClose").onclick = () => stopCamera();
  el("btnTorch").onclick = () => toggleTorch();
  el("camModal").addEventListener("click", (e) => {
    if(e.target === el("camModal")) stopCamera();
  });

  // ズーム
  el("zoomRange").addEventListener("input", () => {
    applyZoomFromUI();
  });

  // 画面遷移
  el("btnBackStores").onclick = () => location.href="./";
  el("btnGoScan").onclick = () => renderScanScreen();
  el("btnBackHome").onclick = () => renderHomeStatus();

  // リセット（ホームのみ）
  el("btnReset").onclick = () => {
    if(!STORE) return;
    const ok1 = confirm("リセットします。\n今回のスキャン履歴を消去します。よろしいですか？");
    if(!ok1) return;
    const ok2 = confirm("最終確認：本当にリセットしますか？");
    if(!ok2) return;

    st.scanned = [];
    st.okSet.clear();
    st.ngCount = 0;
    el("remainCard").style.display = "none";
    hideDone();
    updateBadges();
    renderHomeStatus();
    showToast("🔄 リセットしました");
  };

  // 未スキャン一覧（ホーム）
  el("btnShowRemainHome").onclick = () => renderRemainGrid();

  // 手入力/スキャナ入力（ENTERで確定：即 addScan）
  el("scanInput").addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      e.preventDefault();
      const v = el("scanInput").value;
      el("scanInput").value = "";
      el("scanInput").focus();
      addScan(v);
    }
  });

  // iOSでフォーカスが外れやすい対策（軽め）
  document.addEventListener("touchstart", () => {
    const inp = el("scanInput");
    if(document.activeElement !== inp && !camRunning) inp.focus();
  }, { passive: true });

  // DATA
  const csv = await fetch(DATA_CSV_URL, {cache:"no-store"}).then(r=>r.text());
  st.all = parseCSV(csv);

  STORE = ((new URLSearchParams(location.search)).get("store")||"").trim();
  if(!STORE){
    renderStoreSelect();
    return;
  }

  st.rows = st.all.filter(r => String(r.store_key).trim() === STORE);

  // 照合Map（ゆる判定）
  st.byCode.clear();
  for(const r of st.rows){
    const base = normalize(r.code);
    if(base) st.byCode.set(base, r);
    const v = codeVariants(r.code);
    for(const k of v){
      if(k) st.byCode.set(k, r);
    }
  }

  // 起動時は「状況確認ホーム」
  renderHomeStatus();
})();
