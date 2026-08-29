#!/usr/bin/env node
// stk-fetch.mjs — 取K线写入 dsh-stock-chart 的 SQLite 库（数据不经过模型上下文）。
// 随插件发布；配置读取 ~/.dsh/stkdata/config.json（env STK_DATA_DIR 可覆盖）：
//   { pythonPath, skillPath, mcpServerName, dataDir }
// 用法: node stk-fetch.mjs <symbol> <mootdx|mcp> [offset]
//   mootdx（A股，默认 750 交易日≈3 年）| mcp（港股5位/美股字母，get_long_kline≈500天≈2年）
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function defaultDataDir() {
  return process["env"].STK_DATA_DIR || path.join(os.homedir(), ".dsh", "stkdata");
}
function configPath() {
  return path.join(defaultDataDir(), "config.json");
}
function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8").replace(/^\uFEFF/, "")); } catch (e) { return {}; }
}
function dataDir() {
  return process["env"].STK_DATA_DIR || readConfig().dataDir || defaultDataDir();
}
const DB_PATH = path.join(dataDir(), "stock-chart.sqlite");
const PYTHON = process["env"].STK_PYTHON || readConfig().pythonPath || "python";

function findMCPUrl(serverName) {
  const home = process["env"].DSH_HOME || path.join(os.homedir(), ".dsh");
  const files = [
    path.join(home, "profiles", "web", "cordis.patch.yml"),
    path.join(home, "profiles", "web", "cordis.yml"),
  ];
  const re = new RegExp("id:\\s*mcp-" + serverName + "[\\s\\S]*?url:\\s*['\"]([^'\"]+)");
  for (const f of files) {
    try {
      const m = readFileSync(f, "utf8").match(re);
      if (m && m[1]) return m[1];
    } catch (e) {}
  }
  return undefined;
}

function execSql(d, sql) { return d["exec"](sql); }
function openDb() {
  const dir = path.dirname(DB_PATH);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  execSql(db,
    "CREATE TABLE IF NOT EXISTS klines (symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL, PRIMARY KEY (symbol, date));" +
    "CREATE TABLE IF NOT EXISTS meta (symbol TEXT PRIMARY KEY, name TEXT, quote TEXT, updatedAt INTEGER);"
  );
  return db;
}

function num(v) { if (typeof v === "number" && Number.isFinite(v)) return v; const n = Number(v); return Number.isFinite(n) ? n : null; }
function field(row, keys) { for (const k of keys) { if (row && k in row) { const n = num(row[k]); if (n !== null) return n; } } return null; }
function day(t) { if (typeof t !== "string") return String(t); const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[1] + "-" + m[2] + "-" + m[3] : t; }

function normalizeRows(rows) {
  const out = [];
  for (const r of rows) {
    const time = day(r && (r.date ?? r.time ?? r.datetime));
    const open = field(r, ["open", "Open", "开盘"]);
    const high = field(r, ["high", "High", "最高"]);
    const low = field(r, ["low", "Low", "最低"]);
    const close = field(r, ["close", "Close", "收盘"]);
    if (!time || open === null || high === null || low === null || close === null) continue;
    out.push({ date: time, open, high, low, close, volume: field(r, ["volume", "vol", "Volume", "成交量"]) });
  }
  return out;
}

async function fetchMootdx(symbol, offset) {
  const py = `
import json, sys
from mootdx.quotes import Quotes
_TDX = [('119.97.185.59',7709),('124.70.133.119',7709),('116.205.183.150',7709),('123.60.73.44',7709),('116.205.163.254',7709),('121.36.225.169',7709)]
OFFSET = ${offset}
c = None
bars = None
try:
    c = Quotes.factory(market='std')
    bars = c.bars(symbol=sys.argv[1], frequency=9, offset=OFFSET)
except Exception:
    pass
if bars is None or len(bars) == 0:
    for ip,port in _TDX:
        try:
            c = Quotes.factory(market='std', server=(ip,port))
            bars = c.bars(symbol=sys.argv[1], frequency=9, offset=OFFSET)
            if len(bars) > 0:
                break
        except Exception:
            pass
rows = []
if bars is not None:
    for b in bars.to_dict('records'):
        rows.append({'date': str(b.get('datetime'))[:10], 'open': float(b['open']), 'high': float(b['high']), 'low': float(b['low']), 'close': float(b['close']), 'volume': float(b.get('volume') or b.get('vol') or 0)})
print(json.dumps(rows, ensure_ascii=False))
`;
  const tmp = path.join(os.tmpdir(), `stk-mootdx-${Date.now()}.py`);
  writeFileSync(tmp, py);
  try {
    const out = execFileSync(PYTHON, [tmp, symbol], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    return JSON.parse(out.trim());
  } finally {
    try { rmSync(tmp); } catch (e) {}
  }
}

async function fetchMcp(symbol) {
  const url = process["env"].STK_MCP_URL || findMCPUrl(readConfig().mcpServerName || "stock");
  if (!url) throw new Error("未找到股票 MCP 配置（请确认 dsh 的 cordis.patch.yml 配置了 mcp-" + (readConfig().mcpServerName || "stock") + "，或设置 STK_MCP_URL）");
  const post = async (body, sid) => {
    const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sid) h["Mcp-Session-Id"] = sid;
    const opts = { method: "POST", headers: h, body: JSON.stringify(body) };
    const r = await fetch(url, opts);
    return { st: r.status, sid: r.headers.get("mcp-session-id"), txt: await r.text() };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stk-fetch", version: "1" } } });
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_long_kline", arguments: { stock: symbol } } }, init.sid);
  const m = call.txt.match(/data: (.*)/s);
  if (!m) throw new Error("MCP tools/call 无 SSE 响应: " + call.txt.slice(0, 300));
  const data = JSON.parse(m[1]);
  if (data.error) throw new Error("MCP error: " + JSON.stringify(data.error));
  const content = (data.result && data.result.content) || [];
  const text = content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error("MCP 结果非 JSON: " + text.slice(0, 300)); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of ["klines", "data", "rows", "list", "items"]) {
      if (Array.isArray(parsed[k]) && parsed[k].length) return parsed[k];
    }
  }
  throw new Error("MCP 结果结构无法识别: " + text.slice(0, 300));
}

function writeKlines(db, symbol, rows) {
  const ins = db.prepare("INSERT OR REPLACE INTO klines (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)");
  execSql(db, "BEGIN");
  try {
    for (const r of rows) ins.run(symbol, r.date, r.open, r.high, r.low, r.close, r.volume ?? null);
    execSql(db, "COMMIT");
  } catch (e) { execSql(db, "ROLLBACK"); throw e; }
}

async function main() {
  const symbol = String(process.argv[2] || "").trim().toUpperCase();
  const source = String(process.argv[3] || "").trim().toLowerCase();
  const offset = Number(process.argv[4]) || 750;
  if (!symbol || !["mootdx", "mcp"].includes(source)) {
    console.error("用法: node stk-fetch.mjs <symbol> <mootdx|mcp> [offset]");
    process.exit(1);
  }
  let rows;
  if (source === "mootdx") rows = await fetchMootdx(symbol, offset);
  else rows = await fetchMcp(symbol);
  rows = normalizeRows(rows);
  if (!rows.length) { console.error("[stk-fetch] " + symbol + ": 未取到K线"); process.exit(1); }
  const db = openDb();
  writeKlines(db, symbol, rows);
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const chg = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;
  console.log("[stk-fetch] " + symbol + " 入库完成：" + rows.length + " 根日K（" + rows[0].date + " ~ " + last.date + "），最新收盘 " + last.close +
    (chg === null ? "" : "（" + (chg >= 0 ? "+" : "") + Math.round(chg * 100) / 100 + "%）") + "，库：" + DB_PATH);
}

main().catch((e) => { console.error("[stk-fetch] 失败: " + (e instanceof Error ? e.message : String(e))); process.exit(1); });
