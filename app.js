const $ = (id) => document.getElementById(id);

let workbook = null;
let ws = null;

let sheetName = null;

// AOA（表示・検索用）
let rows = [];                // 2次元配列
let idxByCode = new Map();    // 管理No(code) -> rowIndex(0-based in rows)

// ヘッダ位置・列位置
let headerRowIdx = -1;        // 0-based
let col = {
  code: 0,    // 管理No
  name: 1,    // マシン名
  actual: -1, // 実在庫
};

let storeName = "";           // A6
let session = new Map();      // code -> {count, lastAt}

const ui = {
  file: $("file"),
  scanBox: $("scanBox"),
  status: $("status"),
  current: $("current"),
  history: $("history"),
  btnFinish: $("btnFinish"),
  btnClear: $("btnClear"),
};

function safe(v) {
  return (v == null) ? "" : String(v).trim();
}

function setStatus(msg) {
  ui.status.textContent = msg;
}

// A1 -> {r,c}
function decodeA1(a1) {
  return XLSX.utils.decode_cell(a1);
}
// {r,c} -> A1
function encodeRC(r, c) {
  return XLSX.utils.encode_cell({ r, c });
}

function getCellValue(a1) {
  if (!ws) return "";
  const cell = ws[a1];
  return cell ? safe(cell.v) : "";
}

function setCellNumber(a1, n) {
  // 見た目/他セルを壊さず、このセルだけ上書き
  ws[a1] = ws[a1] || {};
  ws[a1].t = "n";
  ws[a1].v = Number(n);
}

function findHeaderRowAndColumns(aoa) {
  // どこかの行に「管理No」「マシン名」がある前提で探す
  let h = -1;
  for (let r = 0; r < aoa.length; r++) {
    const line = (aoa[r] || []).map(safe);
    const hasCode = line.some(x => x === "管理No" || x.includes("管理No"));
    const hasName = line.some(x => x === "マシン名" || x.includes("マシン名"));
    if (hasCode && hasName) { h = r; break; }
  }
  if (h < 0) return { headerRowIdx: -1, cols: { code: 0, name: 1, actual: -1 } };

  const header = (aoa[h] || []).map(safe);

  const findCol = (pred) => {
    for (let c = 0; c < header.length; c++) {
      if (pred(header[c])) return c;
    }
    return -1;
  };

  const codeCol = findCol(x => x === "管理No" || x.includes("管理No"));
  const nameCol = findCol(x => x === "マシン名" || x.includes("マシン名"));
  const actualCol = findCol(x => x.startsWith("実在庫") || x.includes("実在庫"));

  return {
    headerRowIdx: h,
    cols: {
      code: codeCol >= 0 ? codeCol : 0,
      name: nameCol >= 0 ? nameCol : 1,
      actual: actualCol, // 無い場合は -1
    }
  };
}

function buildIndex(aoa) {
  idxByCode.clear();

  // データ開始行は「ヘッダの次行」から最後まで
  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const code = safe((aoa[r] || [])[col.code]);
    if (!code) continue;
    // 先勝ち
    if (!idxByCode.has(code)) idxByCode.set(code, r);
  }
}

function formatRowBrief(row) {
  const code = safe(row[col.code]);
  const name = safe(row[col.name]);

  const lines = [];
  lines.push(`店舗: ${storeName || "（不明）"}`);
  lines.push(`管理No: ${code}`);
  if (name) lines.push(`マシン名: ${name}`);

  if (col.actual >= 0) {
    const v = safe(row[col.actual]);
    lines.push(`実在庫: ${v === "" ? "（未入力）" : v}`);
  }

  return lines.join("\n");
}

function renderHistory() {
  if (session.size === 0) {
    ui.history.textContent = "—";
    return;
  }

  const items = Array.from(session.entries())
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.lastAt - a.lastAt);

  ui.history.textContent = items.map(x => {
    const r = idxByCode.get(x.code);
    const row = (r != null) ? rows[r] : null;
    const brief = row ? formatRowBrief(row) : `店舗: ${storeName || "（不明）"}\n管理No: ${x.code}\n（マスタに存在しません）`;
    return `${brief}\n回数: ${x.count}\n---`;
  }).join("\n");
}

function showCurrent(code) {
  const r = idxByCode.get(code);
  if (r == null) {
    ui.current.textContent = `店舗: ${storeName || "（不明）"}\n管理No: ${code}\n（マスタに存在しません）`;
    return;
  }
  ui.current.textContent = formatRowBrief(rows[r]);
}

function onScan(codeRaw) {
  const code = safe(codeRaw);
  if (!code) return;

  showCurrent(code);

  const now = Date.now();
  const prev = session.get(code);
  if (prev) {
    prev.count += 1;
    prev.lastAt = now;
  } else {
    session.set(code, { count: 1, lastAt: now });
  }

  renderHistory();
  ui.scanBox.value = "";
}

function chooseSheetName(wb) {
  // まず画像の想定シート名を優先
  if (wb.SheetNames.includes("マシン棚卸リスト")) return "マシン棚卸リスト";
  return wb.SheetNames[0];
}

async function readExcel(file) {
  const buf = await file.arrayBuffer();
  workbook = XLSX.read(buf, { type: "array" });

  sheetName = chooseSheetName(workbook);
  ws = workbook.Sheets[sheetName];

  // 表示・検索用の2次元配列
  rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

  // 店舗名：A6
  storeName = getCellValue("A6");

  // ヘッダ行＆列検出
  const found = findHeaderRowAndColumns(rows);
  headerRowIdx = found.headerRowIdx;
  col = found.cols;

  if (headerRowIdx < 0) {
    setStatus("読込NG：ヘッダ行（管理No/マシン名）が見つかりません。シート構成を確認してください。");
    ui.scanBox.disabled = true;
    ui.btnFinish.disabled = true;
    ui.btnClear.disabled = true;
    return;
  }

  if (col.actual < 0) {
    setStatus("注意：『実在庫』列が見つかりません（書き込みできません）。列名を確認してください。");
  }

  buildIndex(rows);

  setStatus(`読込OK: シート「${sheetName}」 / 店舗「${storeName || "（A6空）"}」 / コード件数 ${idxByCode.size}`);
  ui.scanBox.disabled = false;
  ui.btnFinish.disabled = false;
  ui.btnClear.disabled = false;

  ui.scanBox.focus();
}

function writeActualStockOnFinish() {
  if (col.actual < 0) {
    throw new Error("『実在庫』列が見つからないため書き込みできません。");
  }

  // スキャン済みの管理Noだけ、実在庫=1 を書く
  for (const [code] of session.entries()) {
    const r = idxByCode.get(code);
    if (r == null) continue;

    // rows上の値も更新（画面表示整合）
    rows[r][col.actual] = 1;

    // Excelセル番地を特定（r,c は 0-based）
    const a1 = encodeRC(r, col.actual);
    setCellNumber(a1, 1);
  }
}

function downloadWorkbook() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const sn = storeName ? storeName.replace(/[\\/:*?"<>|]+/g, "_") : "店舗不明";
  const outName = `棚卸結果_${sn}_${stamp}.xlsx`;
  XLSX.writeFile(workbook, outName);
}

ui.file.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  readExcel(file).catch((err) => {
    console.error(err);
    setStatus("読込失敗: " + err.message);
  });
});

// スキャナは末尾Enter想定
ui.scanBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onScan(ui.scanBox.value);
});

// フォーカス事故防止
document.addEventListener("click", () => {
  if (!ui.scanBox.disabled) ui.scanBox.focus();
});

ui.btnClear.addEventListener("click", () => {
  session.clear();
  ui.current.textContent = "—";
  ui.history.textContent = "—";
  setStatus("今回分をクリアしました（Excelは未排出）");
  ui.scanBox.focus();
});

ui.btnFinish.addEventListener("click", () => {
  if (!workbook) return;
  if (session.size === 0) {
    setStatus("スキャンがありません（排出せず）");
    ui.scanBox.focus();
    return;
  }

  try {
    writeActualStockOnFinish();
    downloadWorkbook();
    setStatus(`排出しました：店舗「${storeName || "（A6空）"}」 / スキャン件数 ${session.size}`);
  } catch (err) {
    console.error(err);
    setStatus("排出エラー: " + err.message);
  }

  ui.scanBox.focus();
});
