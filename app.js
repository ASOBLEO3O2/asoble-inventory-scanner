// ★ここだけあなたの公開CSVに差し替え
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";

const qs = new URLSearchParams(location.search);

// URLSearchParams は基本デコードされますが、念のため二重エンコード系も吸収
const STORE = safeDecode_(qs.get("store") || "").trim(); // 空なら全店舗

const el = (id) => document.getElementById(id);

const st = {
  rows: [],
  byCode: new Map(), // code -> row
  scanned: [],       // {ts, code, ok, row?}
};

/**
 * 最低限のCSVパーサ（RFC4180寄り）
 * - ダブルクォート、カンマ、改行を考慮
 * - Googleのoutput=csv で十分に動くレベル
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;

  const s = text.replace(/\r/g, "");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inQ) {
      if (ch === '"') {
        // "" はエスケープされた "
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      cur = "";
      // 空行はスキップ
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }

  // 最終行
  row.push(cur);
  if (row.some(v => v !== "")) rows.push(row);

  if (!rows.length) return [];

  const header = rows.shift();
  const idx = {};
  header.forEach((h, i) => idx[String(h || "").trim()] = i);

  const pick = (cols, key) => {
    const j = idx[key];
    return (j == null) ? "" : (cols[j] ?? "");
  };

  return rows.map(cols => ({
    store_key: pick(cols, "store_key"),
    store_name: pick(cols, "store_name"),
    code: pick(cols, "code"),
    machine_name: pick(cols, "machine_name"),
    actual_stock: pick(cols, "actual_stock"),
    source_file: pick(cols, "source_file"),
    updated_at: pick(cols, "updated_at"),
  }));
}

function safeDecode_(s) {
  try {
    // すでにデコード済みの場合はそのまま
    // 変な%が混じると例外になるのでtryで吸収
    return decodeURIComponent(String(s));
  } catch {
    return String(s);
  }
}

function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ja-JP");
}

function render() {
  el("storeBadge").textContent = "store: " + (STORE || "ALL");
  el("countBadge").textContent = "rows: " + st.rows.length;

  const u = st.rows[0]?.updated_at || "-";
  el("updatedBadge").textContent = "updated: " + (u ? String(u).slice(0, 19) : "-");

  el("historyBadge").textContent = String(st.scanned.length);

  const last = st.scanned[0];
  if (!last) {
    el("current").textContent = "";
    el("hitBadge").textContent = "-";
  } else if (last.ok) {
    const r = last.row;
    el("hitBadge").textContent = "HIT";
    el("current").innerHTML =
      `<div class="ok">✅ ${escapeHtml_(last.code)}</div>` +
      `<div>店舗: ${escapeHtml_(r.store_name)} (${escapeHtml_(r.store_key)})</div>` +
      `<div>マシン: ${escapeHtml_(r.machine_name)}</div>` +
      `<div>実在庫: ${escapeHtml_(r.actual_stock)}</div>`;
  } else {
    el("hitBadge").textContent = "NO HIT";
    el("current").innerHTML = `<div class="ng">❌ ${escapeHtml_(last.code)}</div>`;
  }

  el("history").innerHTML = st.scanned.map(x => {
    const head = x.ok ? `<span class="ok">✅</span>` : `<span class="ng">❌</span>`;
    const tail = x.ok ? ` ${escapeHtml_(x.row.machine_name)}` : "";
    return `${head} ${escapeHtml_(x.code)}  <span class="muted">${fmt(x.ts)}</span>${tail}`;
  }).join("\n");
}

// 画面表示のXSS予防（念のため）
function escapeHtml_(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function addScan(code) {
  const c = String(code || "").trim();
  if (!c) return;

  const row = st.byCode.get(c);
  const ok = !!row;

  st.scanned.unshift({ ts: Date.now(), code: c, ok, row });
  el("msg").textContent = ok ? "一致しました" : "一致なし（リストにありません）";
  render();
}

async function boot() {
  el("msg").textContent = "データ読込中…";

  const res = await fetch(DATA_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("CSV取得に失敗: " + res.status);

  const text = await res.text();
  const all = parseCSV(text);

  // store で絞る（空なら全部）
  const filtered = STORE ? all.filter(r => r.store_key === STORE) : all;

  st.rows = filtered;

  st.byCode.clear();
  for (const r of filtered) {
    if (r.code) st.byCode.set(String(r.code).trim(), r);
  }

  el("msg").textContent = "読込完了。入力欄にフォーカスしてスキャンしてください。";
  render();

  const input = el("scanInput");
  input.focus();

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addScan(input.value);
      input.value = "";
    }
  });

  el("btnClear").addEventListener("click", () => {
    st.scanned = [];
    el("msg").textContent = "今回分をクリアしました";
    render();
    input.focus();
  });
}

boot().catch(err => {
  el("msg").textContent = "エラー: " + err.message;
});
