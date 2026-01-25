/* ========= 設定 ========= */
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

// 既存の連打抑制（残す）
const SAME_CODE_COOLDOWN_MS = 900;   // 同一コードは0.9秒は無視（旧）
const ANY_CODE_COOLDOWN_MS  = 180;   // 全体も少し抑制（旧）

// 仕様：確定条件（2回一致）＋確定後停止
const CONFIRM_HITS_REQUIRED = 2;
const CONFIRM_WINDOW_MS     = 1200; // 2回一致を待つ猶予
const CONFIRM_COOLDOWN_MS   = 1000; // 確定後は1秒停止

// OCRの頻度（バーコードが来ない時だけ動かす）
const OCR_INTERVAL_MS = 700;           // 0.7秒毎
const OCR_MIN_GAP_AFTER_HIT_MS = 1200; // 直近でHITしたらOCRしない

/* ========= 状態 ========= */
const el = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
let STORE = (qs.get("store") || "").trim();

const st = {
  all: [],
  rows: [],
  byCode: new Map(),

  // 履歴（OK/DUPのみ保存）
  scanned: [],   // { code, row, ok:true, dup:boolean, ts }
  okSet: new Set(),

  // INVALIDは記録しない（カウンタのみ）
  ngCount: 0
};

/* ========= 画面切替 ========= */
function setMode(m){
  el("storeSelect").style.display = (m==="store") ? "" : "none";
  el("homeStatus").style.display  = (m==="home")  ? "" : "none";
  el("scanScreen").style.display  = (m==="scan")  ? "" : "none";
}

function goStoreSelect(){
  setMode("store");
  el("title").textContent = "棚卸スキャナ（店舗選択）";
  updateBadges();
}

function goHome(){
  setMode("home");
  el("title").textContent = "棚卸スキャナ（ホーム）";
  el("msg").textContent = "ホーム：状況確認／読み取り開始";
  updateBadges();
  renderPanels();
}

function goScanScreen({ autoStartCamera = false } = {}){
  if(!STORE){
    alert("先に店舗を選択してください");
    goStoreSelect();
    return;
  }
  setMode("scan");
  el("title").textContent = "棚卸スキャナ（読み取り）";
  try{ el("scanInput").focus(); }catch(_e){}
  updateBadges();

  if(autoStartCamera){
    startCamera();
  }
}

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

// iOSは振動がほぼ無理 → 代替の音/フラッシュ
function vibrateOk(){
  try{ if(navigator.vibrate) navigator.vibrate([60,30,60]); }catch(_e){}
}
function vibrateDone(){
  try{ if(navigator.vibrate) navigator.vibrate([120,60,120,60,220]); }catch(_e){}
}

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

    const pt = el("progressText");
    if(pt) pt.textContent="progress: -";
    const pf = el("progressFill");
    if(pf) pf.style.width="0%";
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

  const pt = el("progressText");
  if(pt) pt.textContent = `progress: ${done}/${total} (${pct(p)}%)  remain:${remain}`;
  const pf = el("progressFill");
  if(pf) pf.style.width = `${Math.min(100, Math.max(0,p))}%`;
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

function renderStoreSelect(){
  goStoreSelect();

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

function renderPanels(){
  updateBadges();

  const last = st.scanned[0];
  if(!last){
    el("current").innerHTML = "";
  }else{
    el("current").innerHTML = renderHitRow(last.row);
  }

  // 履歴はOK/DUPのみ
  el("history").innerHTML = st.scanned.slice(0, 60).map(x=>{
    const key = normalize(x.row.code);
    const done = st.okSet.has(key);
    const cls = `hitRow okRow ${done ? "done" : ""}`;
    const prefix = x.dup ? "⚠️（重複）" : "✅";
    return `
      <div class="${cls}">
        <div class="meta">
          <span class="code">${prefix} ${escapeHtml(x.row.code)}</span>
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

/* ========= スキャン確定（OK/DUPのみ記録。INVALIDは記録しない） ========= */
function addScan(v, { source = "unknown" } = {}){
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

  const ok = !!hitRow;

  if(ok){
    const before = st.okSet.size;
    st.okSet.add(hitKey);

    const isDup = !(st.okSet.size > before);

    if(!isDup){
      vibrateOk();
      beep();
      flash();
      showToast(`✅ ${hitRow.code} ／ ${hitRow.machine_name || "-"}`);
    }else{
      // 重複：強め警告（履歴には残す）
      try{ if(navigator.vibrate) navigator.vibrate([120,40,120]); }catch(_e){}
      showToast(`⚠️ 重複：${hitRow.code}`);
    }

    st.scanned.unshift({ code: variants[0], row: hitRow, ok: true, dup: isDup, ts: Date.now(), source });
    el("msg").textContent = "一致しました（連続スキャン中）";

    renderPanels();
    showDoneIfComplete();
  }else{
    // INVALID：記録しない（カウンタだけ）
    st.ngCount++;
    el("msg").textContent = "一致なし（リストにありません）";
    showToast("❌ 一致なし");
    updateBadges();
  }
}

/* ========= カメラ（ZXing + OCR） ========= */
let camRunning = false;
let stream = null;

// debounce（旧）
let lastAnyTs = 0;
let lastText = "";
let lastTextTs = 0;
let lastHitTs = 0;

// 2回一致用
let candText = "";
let candCount = 0;
let candTs = 0;
let confirmCooldownUntil = 0;

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

/* 2回一致判定（バーコード用） */
function ingestBarcodeText(raw){
  const now = Date.now();

  // 確定後クールダウン
  if(now < confirmCooldownUntil) return;

  // 旧：全体連打抑制
  if(now - lastAnyTs < ANY_CODE_COOLDOWN_MS) return;

  const n = normalize(raw);
  if(!n) return;

  // 旧：同一コード連続抑制（過剰連打を落とす）
  if(n === lastText && (now - lastTextTs) < SAME_CODE_COOLDOWN_MS) return;

  lastAnyTs = now;
  lastText = n;
  lastTextTs = now;

  // 2回一致ロジック
  if(n !== candText || (now - candTs) > CONFIRM_WINDOW_MS){
    candText = n;
    candCount = 1;
    candTs = now;
    // UIヒント（軽く）
    setCamStatus("camera: ON / ZXing: ON / OCR: ON（フォールバック）");
    return;
  }

  candCount++;
  candTs = now;

  if(candCount >= CONFIRM_HITS_REQUIRED){
    // 確定
    candText = "";
    candCount = 0;
    confirmCooldownUntil = now + CONFIRM_COOLDOWN_MS;

    addScan(raw, { source: "zxing" });
    lastHitTs = Date.now();
  }
}

/* OCR: 画面中央の“帯”だけ切り出して、番号候補を拾う */
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
        // OCRはフォールバックなので、ここは1回で確定してOK（運用優先）
        addScan(row.code, { source: "ocr" });
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
  ocrWorker = await Tesseract.createWorker("eng", 1, { logger: (_m) => {} });

  await ocrWorker.setParameters({
    tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    preserve_interword_spaces: "1",
  });

  setOcrBadge(false);
}

/* OCRループ */
function startOcrLoop(){
  stopOcrLoop();
  ocrTimer = setInterval(async ()=>{
    if(!camRunning) return;
    if(ocrBusy) return;

    const now = Date.now();
    if(now - lastHitTs < OCR_MIN_GAP_AFTER_HIT_MS) return;

    const v = videoEl();
    if(!v || !v.videoWidth) return;

    // 確定後クールダウン中は走らせない
    if(now < confirmCooldownUntil) return;

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
        if(hit){
          lastHitTs = Date.now();
          confirmCooldownUntil = Date.now() + CONFIRM_COOLDOWN_MS;
        }
      }
    }catch(_e){
      // OCRは落ちても継続
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

/* ZXing：連続読取 */
function startZxingLoop(){
  if(!window.ZXingBrowser){
    setCamStatus("ZXing: NG（ライブラリ読込失敗）");
    return;
  }

  // @ts-ignore
  zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();

  // @ts-ignore
  const controls = zxingReader.decodeFromVideoElement(videoEl(), (result, _err) => {
    if(result && result.getText){
      const text = result.getText();
      ingestBarcodeText(text);
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
  }catch(_e){
    closeCamModal();
    alert("カメラ起動に失敗しました（権限/HTTPS/端末）");
    return;
  }

  const v = videoEl();
  v.srcObject = stream;
  try{ await v.play(); }catch(_e){}

  camRunning = true;

  // 初期値リセット
  candText = ""; candCount = 0; candTs = 0;
  confirmCooldownUntil = 0;

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
  try{ zxingReader?.reset?.(); }catch(_e){}
  zxingReader = null;

  try{ stream?.getTracks?.().forEach(t => t.stop()); }catch(_e){}
  stream = null;

  closeCamModal();

  // 読み取り画面に戻したい → scanScreen の入力へ
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

  // 画面操作
  el("btnToStoreList").onclick = () => location.href = "./";
  el("btnBackHome").onclick = () => goHome();

  el("btnStartScan").onclick = () => goScanScreen({ autoStartCamera: true });

  // リセット（ホームのみ）
  el("btnReset").onclick = () => {
    if(!STORE){ return; }
    const a = confirm("今回分をリセットします。よろしいですか？");
    if(!a) return;
    const b = confirm("最終確認：今回分の履歴を消します。実行しますか？");
    if(!b) return;

    // カメラが動いていたら止める
    try{ stopCamera(); }catch(_e){}

    st.scanned = [];
    st.okSet.clear();
    st.ngCount = 0;

    el("remainCard").style.display = "none";
    el("msg").textContent = "リセットしました";
    hideDone();
    renderPanels();
  };

  // 未スキャン一覧
  el("btnShowRemain").onclick = () => renderRemainGrid();

  // 手入力/スキャナ入力（読み取り画面のみ）
  el("scanInput").addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      e.preventDefault();
      const v = el("scanInput").value;
      addScan(v, { source: "manual" });
      el("scanInput").value = "";
      try{ el("scanInput").focus(); }catch(_e){}
    }
  });

  // iOSでフォーカスが外れやすい対策（軽め）
  document.addEventListener("touchstart", () => {
    const inp = el("scanInput");
    if(document.activeElement !== inp && !camRunning && el("scanScreen").style.display !== "none"){
      try{ inp.focus(); }catch(_e){}
    }
  }, { passive: true });

  // DATAロード
  const csv = await fetch(DATA_CSV_URL, {cache:"no-store"}).then(r=>r.text());
  st.all = parseCSV(csv);

  STORE = ((new URLSearchParams(location.search)).get("store")||"").trim();

  // 店舗未選択なら店舗選択へ
  if(!STORE){
    renderStoreSelect();
    return;
  }

  // 店舗選択済み：ホームへ
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

  goHome();
})();
