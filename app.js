/* ========= 設定 ========= */
const DATA_CSV_URL =
 "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

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
function vibrateOk(){ try{ if(navigator.vibrate) navigator.vibrate([60,30,60]); }catch(_e){} }
function vibrateDone(){ try{ if(navigator.vibrate) navigator.vibrate([120,60,120,60,220]); }catch(_e){} }

/* ========= バッジ/進捗 ========= */
function showDoneIfComplete(){
  if(!STORE) return;
  const total = st.rows.length;
  const done = st.okSet.size;
  if(total > 0 && done >= total){
    el("doneOverlay").style.display = "flex";
    vibrateDone();
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

  el("history").innerHTML = st.scanned.slice(0, 80).map(x=>{
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

function renderRemainList(){
  if(!STORE) return;
  const remainRows = st.rows.filter(r => !st.okSet.has(normalize(r.code)));
  const shown = remainRows.slice(0, 200);
  el("remainList").textContent =
    shown.map(r => `${r.code} ／ ${r.machine_name || "-"}`).join("\n") +
    (remainRows.length > shown.length ? `\n...（残り ${remainRows.length - shown.length} 件省略）` : "");
  el("remainCard").style.display = "";
  el("remainCard").scrollIntoView({ behavior:"smooth", block:"start" });
}

/* ========= スキャン ========= */
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
    if(st.okSet.size > before) vibrateOk();
    else { try{ if(navigator.vibrate) navigator.vibrate(40); }catch(_e){} }
  }else{
    st.ngCount++;
  }

  st.scanned.unshift({ code: variants[0], row: hitRow, ok, ts: Date.now(), hitKey });

  el("msg").textContent = ok ? "一致しました（済はグレー表示）" : "一致なし（リストにありません）";
  renderPanels();
  showDoneIfComplete();
  el("scanInput").focus();
}

/* ========= カメラ（全画面） ========= */
let qr = null, camRunning = false;

function openCamModal(){
  el("camModal").style.display = "block";
  el("camModal").setAttribute("aria-hidden","false");
}
function closeCamModal(){
  el("camModal").style.display = "none";
  el("camModal").setAttribute("aria-hidden","true");
}

function makeQrbox(){
  // シール比率 1.43 に近い 1.5
  const vw = Math.min(window.innerWidth, 700);
  const w = Math.round(vw * 0.82);
  const h = Math.round(w / 1.5);
  const ww = Math.max(260, Math.min(w, 520));
  const hh = Math.max(180, Math.min(h, 360));
  return { width: ww, height: hh };
}

async function startCamera(){
  if(!STORE){ alert("先に店舗を選択してください"); return; }
  if(camRunning) return;

  openCamModal();
  if(!qr) qr = new Html5Qrcode("qrReader");

  const config = {
    fps: 10,
    qrbox: makeQrbox(),
    disableFlip: true,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
    ],
  };

  const onOk = (text) => { stopCamera(); addScan(text); };
  const onErr = (_) => {};

  camRunning = true;

  try{
    await qr.start({facingMode:"environment"}, config, onOk, onErr);
  }catch(e1){
    try{
      const cams = await Html5Qrcode.getCameras();
      const camId = cams[cams.length-1]?.id;
      await qr.start({deviceId:{exact:camId}}, config, onOk, onErr);
    }catch(e2){
      camRunning = false;
      closeCamModal();
      alert("カメラ起動に失敗しました（権限/HTTPS/再読み込みを確認）");
    }
  }
}

async function stopCamera(){
  if(!qr || !camRunning){
    closeCamModal();
    return;
  }
  try{ await qr.stop(); }catch(_){}
  camRunning = false;
  closeCamModal();
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
  el("camModal").addEventListener("click", (e) => {
    if(e.target === el("camModal")) stopCamera();
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
  el("btnShowRemain").onclick = () => renderRemainList();

  el("scanInput").addEventListener("keydown", (e) => {
    if(e.key === "Enter"){
      e.preventDefault();
      addScan(el("scanInput").value);
      el("scanInput").value = "";
    }
  });

  // iOSでフォーカスが外れやすい対策（軽め）
  document.addEventListener("touchstart", () => {
    const inp = el("scanInput");
    if(document.activeElement !== inp) inp.focus();
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
