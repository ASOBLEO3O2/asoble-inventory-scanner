// app.js

/* ========= 設定 ========= */
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

// 連続検出の誤連打抑制
const SAME_CODE_COOLDOWN_MS = 650;
const ANY_CODE_COOLDOWN_MS  = 90;

// OCRの頻度（バーコードが来ない時だけ動かす）
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
  scanned: [],     // OKのみ（表示用）
  okSet: new Set(),
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

// iOSは振動が弱いことがある
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

/* ========= スキャン確定 ========= */
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

  if(!hitRow){
    // ❌は記録しない（カウンタのみ）
    st.ngCount++;
    persist();
    updateBadges();
    showToast("❌ 一致なし");
    el("msg").textContent = "一致なし（リストにありません）";
    return;
  }

  const before = st.okSet.size;
  st.okSet.add(hitKey);

  if(st.okSet.size > before){
    vibrateOk();
    beep();
    flash();
    showToast(`✅ ${hitRow.code} ／ ${hitRow.machine_name || "-"}`);
    lastHitTs = Date.now();
  }else{
    // 再スキャン（弱め）
    try{ if(navigator.vibrate) navigator.vibrate(30); }catch(_e){}
    showToast(`✅（再）${hitRow.code}`);
    lastHitTs = Date.now();
  }

  st.scanned.unshift({ row: hitRow, ok: true, ts: Date.now() });
  el("msg").textContent = "一致しました（連続スキャン中）";

  persist();
  renderPanels();
  showDoneIfComplete();
}

/* ========= カメラ（preflight + Quagga2 + OCR） ========= */
let camRunning = false;
let stream = null;

// debounce
let lastAnyTs = 0;
let lastText = "";
let lastTextTs = 0;
let lastHitTs = 0;

// OCR
let ocrWorker = null;
let ocrTimer = null;
let ocrBusy = false;

// video element
const videoEl = () => el("camVideo");

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

/* ズーム/トーチ（getUserMediaトラックへ） */
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

/* ✅ preflight: まず権限を取り、UI video に stream を流す */
async function startCameraPreflight(){
  if(location.protocol === "file:"){
    setCamStatus("camera: blocked (file://)");
    showToast("file://ではカメラ不可。HTTPS or localhostで開いてください");
    return false;
  }

  setCamStatus("camera: requesting permission...");

  if(stream && stream.getTracks().some(t => t.readyState === "live")){
    setCamStatus("camera: permission ok (cached)");
    return true;
  }

  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    // ✅ UIに見えるように流す（iOSも安定）
    const v = videoEl();
    if(v){
      v.srcObject = stream;
      await v.play().catch(()=>{});
    }

    setCamStatus("camera: permission ok");
    showToast("📷 カメラ起動OK");
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

/* OCR: 中央帯切り出し */
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
        addScan(row.code);
        return true;
      }
    }
  }
  return false;
}

/* OCRワーカー */
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

/* ✅ Quagga2 起動（preflight後） */
let quaggaOnDetected = null;

async function startQuaggaWithStream(){
  if(!window.Quagga){
    setCamStatus("camera: Quagga NG");
    showToast("Quagga 読み込み失敗");
    return false;
  }
  if(!stream){
    setCamStatus("camera: no stream");
    showToast("streamがありません（権限取得失敗）");
    return false;
  }

  // display:none の状態で init すると失敗しがち
  await new Promise(r => requestAnimationFrame(r));

  const targetEl = el("videoWrap"); // ✅ divコンテナ
  if(!targetEl){
    setCamStatus("camera: target missing");
    showToast("#videoWrap が見つかりません");
    return false;
  }

  setCamStatus("camera: starting quagga...");

  const config = {
    inputStream: {
      type: "LiveStream",
      target: targetEl,
      constraints: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height:{ ideal: 720 }
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
        setCamStatus("camera: quagga init error");
        showToast("Quagga init error（console確認）");
        resolve(false);
        return;
      }

      Quagga.start();
      camRunning = true;
      setCamStatus("camera: running");

      // Quagga側trackが取れれば更新（ズーム/トーチ用）
      try{
        const ca = Quagga?.CameraAccess;
        if(ca?.getActiveTrack){
          const track = ca.getActiveTrack();
          if(track) stream = new MediaStream([track]);
        }
      }catch(_e){}

      await applyZoomFromUI();

      // OCR併用
      startOcrLoop();

      // onDetected
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

async function stopQuagga(){
  try{
    stopOcrLoop();
    camRunning = false;

    if(window.Quagga){
      if(quaggaOnDetected){
        Quagga.offDetected(quaggaOnDetected);
        quaggaOnDetected = null;
      }
      await new Promise((r)=>Quagga.stop(()=>r()));
    }
  }catch(_e){}

  // preflightで取った stream を必ず止める
  try{ stream?.getTracks?.().forEach(t=>t.stop()); }catch(_e){}
  stream = null;

  // UI video もクリア
  try{ const v = videoEl(); if(v) v.srcObject = null; }catch(_e){}

  setCamStatus("camera: stopped");
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

  st.byCode.clear();
  for(const r of st.all){
    const vars = codeVariants(r.code);
    for(const v of vars){
      if(!st.byCode.has(v)) st.byCode.set(v, r);
    }
  }

  if(STORE){
    st.rows = st.all.filter(r => String(r.store_key||"").trim() === STORE);
  }else{
    st.rows = [];
  }
}

/* ========= UIバインド ========= */
function bindUi(){
  el("btnHome").addEventListener("click", ()=>{
    // HOMEに戻る（storeクエリを外す）
    location.href = location.pathname;
  });

  el("btnClear").addEventListener("click", ()=>{
    // 「今回だけ」クリア（履歴だけ消す）
    st.scanned = [];
    el("current").innerHTML = "";
    el("history").innerHTML = "";
    showToast("🧹 今回の履歴をクリア");
  });

  el("btnShowRemain").addEventListener("click", ()=>{
    if(el("remainCard").style.display === "none" || !el("remainCard").style.display){
      renderRemainGrid();
    }else{
      el("remainCard").style.display = "none";
    }
  });

  el("btnCamera").addEventListener("click", async ()=>{
    openCamModal();
    const ok = await startCameraPreflight();
    if(!ok) return;
    await startQuaggaWithStream();
  });

  el("camClose").addEventListener("click", async ()=>{
    await stopQuagga();
    closeCamModal();
  });

  el("btnTorch").addEventListener("click", toggleTorch);
  el("zoomRange").addEventListener("input", applyZoomFromUI);

  el("btnDoneClose").addEventListener("click", hideDone);

  wireScanInput();
}

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

  restore();
  renderScan();
  renderPanels();
  showDoneIfComplete();
}

boot();
