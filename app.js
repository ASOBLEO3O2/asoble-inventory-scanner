// ★ここだけあなたの公開CSVに差し替え
const DATA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRWOsLuIiIAdMPSlO896mqWtV6wwPdnRtofYq11XqKWwKeg1rauOgt0_mMOxbvP3smksrXMCV5ZROaG/pub?gid=2104427305&single=true&output=csv";


const qs = new URLSearchParams(location.search);
const STORE = (qs.get("store") || "").trim(); // 空なら全店舗
const el = (id) => document.getElementById(id);

const st = {
  rows: [],
  byCode: new Map(), // code -> row
  scanned: [],       // {ts, code, ok, row?}
};

function parseCSV(text) {
  // シンプルCSV（今回のDATAはカンマや改行が入らない想定）
  // もし景品名などでカンマが入り得る運用になったら、CSVパーサに差し替えます。
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  const header = lines.shift().split(",");
  const idx = {};
  header.forEach((h, i) => idx[h] = i);

  return lines.map(line => {
    const cols = line.split(",").map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"'));
    return {
      store_key: cols[idx.store_key] ?? "",
      store_name: cols[idx.store_name] ?? "",
      code: cols[idx.code] ?? "",
      machine_name: cols[idx.machine_name] ?? "",
      actual_stock: cols[idx.actual_stock] ?? "",
      source_file: cols[idx.source_file] ?? "",
      updated_at: cols[idx.updated_at] ?? "",
    };
  });
}

function fmt(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ja-JP");
}

function render() {
  el("storeBadge").textContent = "store: " + (STORE || "ALL");
  el("countBadge").textContent = "rows: " + st.rows.length;

  // updated はDATAの先頭から取る（全部同じtsで入れてる想定）
  const u = st.rows[0]?.updated_at || "-";
  el("updatedBadge").textContent = "updated: " + (u ? String(u).slice(0, 19) : "-");

  el("historyBadge").textContent = String(st.scanned.length);

  // current
  const last = st.scanned[0];
  if (!last) {
    el("current").textContent = "";
    el("hitBadge").textContent = "-";
  } else if (last.ok) {
    const r = last.row;
    el("hitBadge").textContent = "HIT";
    el("current").innerHTML =
      `<div class="ok">✅ ${last.code}</div>` +
      `<div>店舗: ${r.store_name} (${r.store_key})</div>` +
      `<div>マシン: ${r.machine_name}</div>` +
      `<div>実在庫: ${r.actual_stock}</div>`;
  } else {
    el("hitBadge").textContent = "NO HIT";
    el("current").innerHTML = `<div class="ng">❌ ${last.code}</div>`;
  }

  // history
  el("history").innerHTML = st.scanned.map(x => {
    const head = x.ok ? `<span class="ok">✅</span>` : `<span class="ng">❌</span>`;
    const tail = x.ok ? ` ${x.row.machine_name}` : "";
    return `${head} ${x.code}  <span class="muted">${fmt(x.ts)}</span>${tail}`;
  }).join("\n");
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
    if (r.code) st.byCode.set(r.code, r);
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

