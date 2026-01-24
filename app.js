/* ========= 設定 ========= */
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

// 連続検出の誤連打抑制
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
  scanned: [],
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

// iOSは振動がほぼ無理（Chromeでも中身WebKit）→ 代替の音/フラッシュを強める
function vibrateOk(){
  try{ if(navigator.vibrate) navigator.vibrate([60,30,60]); }catch(_e){}
}
function vibrateDone(){
  try{ if(navigator.vibrate) navigator.vibrate([120,60,120,60,220]); }catch(_e){}
}

// 成功時：音（iOSでも鳴りやすいよう、最初のユーザー操作後に使う）
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
  if(!last){
    el("current").innerHTML = "";
  }else if(last.ok){
    el("current").innerHTML = renderHitRow(last.row);
  }else{
    el("current").innerHTML = `<div class="ng">❌ ${escapeHtml(last.code)}</div>`;
  }

  el("history").innerHTML = st.scanned.slice(0, 60).map(x=>{
    if(!x.ok){
      return `<div class="ng">❌ ${escapeHtml(x.code)}</div>`;
    }
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

  const ok = !!hitRow;

  if(ok){
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
  }else{
    st.ngCount++;
    showToast(`❌ 一致なし`);
  }

  st.scanned.unshift({ code: variants[0], row: hitRow, ok, ts: Date.now() });
  el("msg").textContent = ok ? "一致しました（連続スキャン中）" : "一致なし（リストにありません）";

  renderPanels();
  showDoneIfComplete();
}

/* ========= カメラ（ZXing + OCR） ========= */
let camRunning = false;
let stream = null;

// debounce
let lastAnyTs = 0;
let lastText = "";
let lastTextTs = 0;
let lastHitTs = 0;

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

  // zoomは対応端末のみ
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

/* OCR: 画面中央の“帯”だけ切り出して、番号候補を拾う */
function createOcrCanvasFromVideo(){
  const v = videoEl();
  const vw = v.videoWidth || 0;
  const vh = v.videoHeight || 0;
  if(!vw || !vh) return null;

  // 中央帯（バーコード帯＋番号が入りやすい範囲）
  const bandH = Math.floor(vh * 0.28);
  const sy = Math.floor((vh - bandH) / 2);
  const sx = Math.floor(vw * 0.10);
  const sw = Math.floor(vw * 0.80);
  const sh = bandH;

  const canvas = document.createElement("canvas");
  // OCR用に少し拡大して精度UP（重すぎない範囲）
  canvas.width = 900;
  canvas.height = Math.floor(900 * (sh / sw));

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // ちょいコントラスト（簡易）
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    const r=d[i], g=d[i+1], b=d[i+2];
    // グレースケール
    let y = (0.2126*r + 0.7152*g + 0.0722*b);
    // コントラスト
    y = (y - 128) * 1.25 + 128;
    y = Math.max(0, Math.min(255, y));
    d[i]=d[i+1]=d[i+2]=y;
  }
  ctx.putImageData(img,0,0);

  return canvas;
}

function extractCandidatesFromText(text){
  const raw = String(text || "").toUpperCase();

  // よくある誤読補正（最低限）
  const fixed = raw
    .replaceAll("O","0")
    .replaceAll("I","1")
    .replaceAll("L","1")
    .replaceAll("S","5");

  // 英数の塊を抽出（長さ4以上）
  const parts = fixed.split(/[^A-Z0-9]+/g).filter(Boolean);
  const cand = [];

  for(const p of parts){
    if(p.length < 4) continue;
    cand.push(p);

    // 数字だけも候補に
    const digits = p.replace(/\D/g,"");
    if(digits.length >= 4) cand.push(digits);
  }

  // 重複除去
  return [...new Set(cand)];
}

function tryHitByCandidates(cands){
  for(const c of cands){
    // codeVariantsで照合を強化
    const vars = codeVariants(c);
    for(const v of vars){
      const row = st.byCode.get(v);
      if(row){
        addScan(row.code); // “正規のcode”を確定として入れる
        return true;
      }
    }
  }
  return false;
}

/* OCRワーカーを起動（初回は重いのでバッジ表示） */
async function ensureOcrWorker(){
  if(ocrWorker) return;

  setOcrBadge(true, "OCR準備中…（初回だけ数秒）");

  // @ts-ignore
  ocrWorker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      // 必要ならログ表示も可能（普段は黙らせる）
      // console.log(m);
    }
  });

  // 文字セットを絞って高速化＆精度UP
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
    if(now - lastHitTs < OCR_MIN_GAP_AFTER_HIT_MS) return; // 直近HITなら走らせない

    // なるべく軽く：videoが生きているか
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
      // console.log("[OCR]", text, cands);

      if(cands.length){
        const hit = tryHitByCandidates(cands);
        if(hit){
          lastHitTs = Date.now();
        }
      }
    }catch(_e){
      // OCRは落ちても運用は継続
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

  // decodeFromVideoElementContinuously がUMDにあるが、環境差を避けて safe に実装
  // @ts-ignore
  const controls = zxingReader.decodeFromVideoElement(videoEl(), (result, err) => {
    const now = Date.now();

    // 連打抑制
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
    // err は無視（NotFoundなど常時出る）
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

  // getUserMedia
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

  // video attach
  const v = videoEl();
  v.srcObject = stream;
  try{ await v.play(); }catch(_e){}

  camRunning = true;

  // 初期ズーム適用（対応端末のみ）
  await applyZoomFromUI();

  // ZXing開始
  startZxingLoop();

  // OCR開始
  startOcrLoop();
}

/* stop camera */
async function stopCamera(){
  if(!camRunning){
    closeCamModal();
    return;
  }

  camRunning = false;

  // stop loops
  stopOcrLoop();
  if(zxingStopFn){
    try{ zxingStopFn(); }catch(_e){}
    zxingStopFn = null;
  }
  try{
    zxingReader?.reset?.();
  }catch(_e){}
  zxingReader = null;

  // stop stream
  try{
    stream?.getTracks?.().forEach(t => t.stop());
  }catch(_e){}
  stream = null;

  // OCR workerは保持（次回起動を高速化）
  // ※メモリ厳しい端末なら stop 時に terminate してもOK
  // if(ocrWorker){ await ocrWorker.terminate(); ocrWorker=null; }

  closeCamModal();
  el("scanInput").focus();
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

  // UI
  el("btnHome").onclick = () => location.href="./";
  el("btnClear").onclick = () => {
    st.scanned = [];
    st.okSet.clear();
    st.ngCount = 0;
    el("remainCard").style.display = "none";
    el("msg").textContent = "今回分をクリアしました";
    renderPanels();
    hideDone();
    el("scanInput").focus();
  };
  el("btnShowRemain").onclick = () => renderRemainGrid();

  // 手入力/スキャナ入力
  el("scanInput").addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      e.preventDefault();
      addScan(el("scanInput").value);
      el("scanInput").value = "";
      el("scanInput").focus();
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
    renderHome();
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

  renderScan();
  renderPanels();
})();
