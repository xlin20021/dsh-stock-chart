// dsh-stock-chart — host plane (fixed bundle, loads with DSH startup).
// Serves the same-origin chart page + data API under /api/stkchart and
// registers the stock_chart_push dynamic tool. Browser half: dsh/client.js.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-stock-chart";
export const inject = ["webServer", "tools", "skills", "settings"];

const here = path.dirname(fileURLToPath(import.meta.url));
const CHART_HTML = readFileSync(path.join(here, "chart.html"), "utf8");

const PREFIX = "/api/stkchart";
const STK_FETCH_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "stk-fetch.mjs");

// ── 配置（config.json 于数据目录；env STK_DATA_DIR 可覆盖）────────────────────
function defaultDataDir() {
  return process["env"].STK_DATA_DIR || path.join(os.homedir(), ".dsh", "stkdata");
}
function configPath() {
  return path.join(defaultDataDir(), "config.json");
}
function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8").replace(/^\uFEFF/, "")); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  const dir = defaultDataDir();
  mkdirSync(dir, { recursive: true });
  const clean = {};
  for (const k of ["pythonPath", "mcpServerName", "dataDir"]) {
    if (typeof cfg[k] === "string") clean[k] = cfg[k].trim();
  }
  writeFileSync(configPath(), JSON.stringify(clean, null, 2) + "\n");
  return clean;
}
function getDataDir() {
  return process["env"].STK_DATA_DIR || readConfig().dataDir || defaultDataDir();
}

// ── SQLite 持久化（数据目录可由 config.dataDir 覆盖）─────────────────────────
let db = null;
function getDb() {
  if (db) return db;
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "stock-chart.sqlite"));
  execSql(db,
    "CREATE TABLE IF NOT EXISTS klines (symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL, PRIMARY KEY (symbol, date));" +
    "CREATE TABLE IF NOT EXISTS meta (symbol TEXT PRIMARY KEY, name TEXT, quote TEXT, updatedAt INTEGER);"
  );
  return db;
}
function execSql(d, sql) { return d["exec"](sql); }
function queryKlines(symbol) {
  return getDb().prepare("SELECT date, open, high, low, close, volume FROM klines WHERE symbol=? ORDER BY date").all(symbol);
}
function queryMeta(symbol) {
  return getDb().prepare("SELECT name, quote FROM meta WHERE symbol=?").get(symbol);
}
function upsertKlines(symbol, candles, meta) {
  const d = getDb();
  execSql(d, "BEGIN");
  try {
    const ins = d.prepare("INSERT OR REPLACE INTO klines (symbol, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)");
    for (const c of candles) ins.run(symbol, c.time, c.open, c.high, c.low, c.close, c.volume ?? null);
    if (meta) d.prepare("INSERT OR REPLACE INTO meta (symbol, name, quote, updatedAt) VALUES (?,?,?,?)").run(symbol, meta.name ?? null, meta.quote ? JSON.stringify(meta.quote) : null, Date.now());
    execSql(d, "COMMIT");
  } catch (e) {
    execSql(d, "ROLLBACK");
    throw e;
  }
}

// ── MCP 配置：直接读 dsh 的 cordis.patch.yml（按 serverName 找 url）──────────
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

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function pick(row, keys) {
  if (!row || typeof row !== "object") return null;
  for (const k of keys) {
    if (k in row) {
      const v = num(row[k]);
      if (v !== null) return v;
    }
  }
  return null;
}
function day(t) {
  if (typeof t !== "string") return String(t);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : t;
}
function klineRow(row) {
  const time = day(row && (row.date ?? row.time));
  const open = pick(row, ["open", "Open", "开盘"]);
  const high = pick(row, ["high", "High", "最高"]);
  const low = pick(row, ["low", "Low", "最低"]);
  const close = pick(row, ["close", "Close", "收盘"]);
  if (!time || open === null || high === null || low === null || close === null) return null;
  return { time, open, high, low, close, volume: pick(row, ["volume", "vol", "Volume", "成交量"]) };
}
function toSeries(rows, keys) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const time = day(row && (row.date ?? row.time));
    if (!time || !row || typeof row !== "object") continue;
    for (const k of keys) {
      const v = pick(row, [k]);
      if (v === null) continue;
      (out[k] = out[k] || []).push({ time, value: v });
    }
  }
  return out;
}
function seriesFrom(ind, name, keys) {
  const v = ind && ind[name];
  if (!v) return {};
  if (Array.isArray(v)) return toSeries(v, keys);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      const arr = v[k];
      if (!Array.isArray(arr)) continue;
      const s = [];
      for (const r of arr) {
        const time = day(r && (r.time ?? r.date));
        const value = pick(r, ["value", "Value", "val"]);
        if (time && value !== null) s.push({ time, value });
      }
      if (s.length) out[k] = s;
    }
    return out;
  }
  return {};
}

function computeSeries(candles) {
  const series = {};
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const times = candles.map((c) => c.time);
  if (n < 5) return series;
  const ma = {};
  [5, 10, 20, 60, 120].forEach((p) => {
    if (n < p) return;
    const arr = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += closes[i];
      if (i >= p) sum -= closes[i - p];
      if (i >= p - 1) arr.push({ time: times[i], value: Math.round((sum / p) * 100) / 100 });
    }
    ma["MA" + p] = arr;
  });
  if (Object.keys(ma).length) series.ma = ma;
  if (n >= 20) {
    const boll = { UPPER: [], MID: [], LOWER: [] };
    for (let i = 19; i < n; i++) {
      let s = 0;
      for (let j = i - 19; j <= i; j++) s += closes[j];
      const mid = s / 20;
      let v = 0;
      for (let j = i - 19; j <= i; j++) v += (closes[j] - mid) * (closes[j] - mid);
      const sd = Math.sqrt(v / 20);
      boll.UPPER.push({ time: times[i], value: Math.round((mid + 2 * sd) * 100) / 100 });
      boll.MID.push({ time: times[i], value: Math.round(mid * 100) / 100 });
      boll.LOWER.push({ time: times[i], value: Math.round((mid - 2 * sd) * 100) / 100 });
    }
    series.boll = boll;
  }
  if (n >= 26) {
    const ema = (data, period) => {
      const k = 2 / (period + 1);
      const out = [];
      let prev = data[0];
      for (let i = 0; i < data.length; i++) {
        prev = i === 0 ? data[i] : data[i] * k + prev * (1 - k);
        out.push(prev);
      }
      return out;
    };
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = ema(dif, 9);
    const macdArr = { DIF: [], DEA: [], MACD: [] };
    for (let i = 0; i < n; i++) {
      macdArr.DIF.push({ time: times[i], value: Math.round(dif[i] * 100) / 100 });
      macdArr.DEA.push({ time: times[i], value: Math.round(dea[i] * 100) / 100 });
      macdArr.MACD.push({ time: times[i], value: Math.round(2 * (dif[i] - dea[i]) * 100) / 100 });
    }
    series.macd = macdArr;
  }
  if (n >= 9) {
    const kdjArr = { K: [], D: [], J: [] };
    let k = 50;
    let d = 50;
    for (let i = 0; i < n; i++) {
      const from = Math.max(0, i - 8);
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = from; j <= i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low < lo) lo = candles[j].low;
      }
      const rsv = hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100;
      k = (2 / 3) * k + (1 / 3) * rsv;
      d = (2 / 3) * d + (1 / 3) * k;
      const j = 3 * k - 2 * d;
      kdjArr.K.push({ time: times[i], value: Math.round(k * 100) / 100 });
      kdjArr.D.push({ time: times[i], value: Math.round(d * 100) / 100 });
      kdjArr.J.push({ time: times[i], value: Math.round(j * 100) / 100 });
    }
    series.kdj = kdjArr;
  }
  return series;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}
function toWeekly(candles) {
  const out = [];
  let cur = null;
  let curKey = "";
  for (const c of candles) {
    let key;
    try {
      const d = new Date(String(c.time).slice(0, 10) + "T00:00:00");
      if (isNaN(d.getTime())) {
        key = String(c.time).slice(0, 10);
      } else {
        const day = d.getDay();
        const diff = day === 0 ? -6 : -(day - 1);
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
        key = fmtDate(monday);
      }
    } catch (e) {
      key = String(c.time).slice(0, 10);
    }
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
      curKey = key;
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function normalize(ds) {
  const symbol = String(ds.symbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("symbol 不能为空");
  const candles = Array.isArray(ds.klines) ? ds.klines.map(klineRow).filter(Boolean) : [];
  if (!candles.length) throw new Error("klines 为空或缺少 open/high/low/close 字段");
  const ind = ds.indicators && typeof ds.indicators === "object" ? ds.indicators : {};
  let series = {};
  const ma = seriesFrom(ind, "ma", ["MA5", "MA10", "MA20", "MA60", "MA120", "ma5", "ma10", "ma20", "ma60", "ma120"]);
  if (Object.keys(ma).length) series.ma = ma;
  const boll = seriesFrom(ind, "boll", ["UPPER", "MID", "LOWER", "upper", "mid", "lower", "UP", "MB", "DN", "上轨", "中轨", "下轨"]);
  if (Object.keys(boll).length) series.boll = boll;
  const macd = seriesFrom(ind, "macd", ["DIF", "DEA", "MACD", "dif", "dea", "macd"]);
  if (Object.keys(macd).length) series.macd = macd;
  const kdj = seriesFrom(ind, "kdj", ["K", "D", "J", "k", "d", "j"]);
  if (Object.keys(kdj).length) series.kdj = kdj;
  const volume = seriesFrom(ind, "volume", ["volume", "vol", "Volume", "成交量", "VOL"]);
  if (Object.keys(volume).length) series.volume = volume;
  if (Object.keys(series).length < 4 && candles.length >= 9) {
    const computed = computeSeries(candles);
    Object.keys(computed).forEach((k) => { if (!series[k]) series[k] = computed[k]; });
  }
  const quote = ds.quote && typeof ds.quote === "object" ? ds.quote : null;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : null;
  const changePct = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;
  const weeklyCandles = toWeekly(candles);
  const weekly = { candles: weeklyCandles, series: computeSeries(weeklyCandles) };
  return { symbol, name: ds.name || (quote && (quote["公司名称"] || quote.name)) || symbol, candles, series, weekly, quote, last, changePct, updatedAt: Date.now() };
}

function parseUrl(raw) {
  const s = String(raw || "/");
  const q = s.indexOf("?");
  const pathname = q >= 0 ? s.slice(0, q) : s;
  const query = {};
  if (q >= 0) {
    const pairs = s.slice(q + 1).split("&");
    for (const pair of pairs) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : "";
      try { query[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { query[k] = v; }
    }
  }
  return { pathname, query };
}

export function apply(ctx) {
  const store = new Map();
  try { getDb(); } catch (e) { console.warn("[dsh-stock-chart] sqlite init failed: " + (e instanceof Error ? e.message : String(e))); }
  // 注册设置命名空间：让插件设置页出现配置卡片（卡片经 /api/stkchart/config 读写）
  try {
    ctx.settings.register(settingsNamespace("stock-chart"), z.object({
      pythonPath: z.string().default(""),
      mcpServerName: z.string().default("stock"),
      dataDir: z.string().default(""),
    }));
  } catch (e) {
    console.warn("[dsh-stock-chart] settings register failed: " + (e instanceof Error ? e.message : String(e)));
  }

  const tool = {
    name: "stock_chart_push",
    description: "把一只股票的K线推送到 dsh 内置图表（同源 iframe，Lightweight Charts + 绘制工具栏），Host 自动按K线计算 MA/BOLL/MACD/KDJ（横轴对齐）。K线来源二选一：1) 已入库（先运行本插件自带的取数脚本 stk-fetch.mjs，路径见返回的错误提示；A股用 mootdx、港股/美股用配置的股票 MCP）→ 只传 symbol；2) 直接传 klines 数组（兼容旧流程）。返回摘要与图表地址。",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "股票代码，如 600519（A股）/ 00700（港股）/ AAPL（美股）" },
        name: { type: "string", description: "股票名称；省略时从库中 meta 或 quote 取" },
        klines: { type: "array", items: {}, description: "可选：直接推送K线数组 {date, open, high, low, close, volume}；不传则从本地 SQLite 读取（需先用 stk-fetch.mjs 取数入库）" },
        indicators: { type: "object", additionalProperties: true, description: "可选指标对象；不传时由K线自动计算" },
        quote: { type: "object", additionalProperties: true, description: "可选实时行情对象" },
      },
      required: ["symbol"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const symbol = String(args.symbol || "").trim().toUpperCase() || null;
      let data;
      try {
        if (Array.isArray(args.klines) && args.klines.length) {
          data = normalize(args);
          try { upsertKlines(data.symbol, data.candles, { name: data.name, quote: args.quote }); } catch (e) {}
        } else {
          if (!symbol) return { ok: false, symbol, error: "symbol 不能为空" };
          const rows = queryKlines(symbol);
          if (!rows.length) {
            return { ok: false, symbol, error: "本地 SQLite 无该股票K线，请先取数入库：node " + STK_FETCH_SCRIPT + " " + symbol + " mootdx|mcp" };
          }
          const meta = queryMeta(symbol);
          let quote = args.quote;
          if (!quote && meta && meta.quote) { try { quote = JSON.parse(meta.quote); } catch (e) {} }
          data = normalize({ symbol, name: args.name || meta?.name, klines: rows, quote });
        }
      } catch (e) {
        return { ok: false, symbol, error: e instanceof Error ? e.message : String(e) };
      }
      store.set(data.symbol, data);
      const chartUrl = PREFIX + "/?symbol=" + encodeURIComponent(data.symbol);
      const last = data.last;
      return {
        ok: true,
        symbol: data.symbol,
        name: data.name,
        bars: data.candles.length,
        lastClose: last.close,
        lastVolume: last.volume,
        changePct: data.changePct === null ? null : Math.round(data.changePct * 100) / 100,
        lastDate: last.time,
        series: Object.keys(data.series),
        indicatorPoints: Object.keys(data.series).reduce((acc, k) => { acc[k] = Object.keys(data.series[k] || {}).reduce((a2, f) => a2 + (data.series[k][f] ? data.series[k][f].length : 0), 0); return acc; }, {}),
        chartUrl,
        summary: data.symbol + "（" + data.name + "）" + data.candles.length + " 根K线，最新收盘 " + last.close +
          (data.changePct === null ? "" : "（" + (data.changePct >= 0 ? "+" : "") + Math.round(data.changePct * 100) / 100 + "%）") +
          "，图表：" + chartUrl,
      };
    },
  };
  ctx.effect(() => ctx.tools.register(tool), "dsh-stock-chart: stock_chart_push tool");

  const stockSkillMarkdown = [
    "# 股票技术分析工作流",
      "",
      "1. 取数入库（数据不经过模型上下文，直接跑插件自带的取数脚本）：",
      "   脚本为本插件的 stk-fetch.mjs（绝对路径见 stock_chart_push 返回的取数指引，或插件设置页），用法：node <脚本路径> <symbol> mootdx|mcp",
      "   - A股用 mootdx（约 750 交易日≈3 年日K）；港股(5位)/美股(字母)用 mcp（读取 dsh 配置的股票 MCP，约 500 交易日≈2 年）",
      "   - 脚本取数 → 写入本地 SQLite（默认 ~/.dsh/stkdata）→ 打印摘要（最新收盘/根数/区间）",
      "2. 调用工具 stock_chart_push 出图：",
      "   { symbol, name?, quote? }  ← 只传代码（+可选名称/实时行情），K线从 SQLite 读",
      "   工具会按K线自动计算完整的 MA/BOLL/MACD/KDJ，返回 chartUrl 与摘要；图表卡片随会话显示。",
      "   需要实时行情时先用 mcp__stock__get_realtime_quote 取，再作为 quote 传入。",
      "3. 基于同一份数据撰写分析报告，至少覆盖：",
      "   - 趋势：MA5/MA10/MA20/MA60 排列与金叉/死叉",
      "   - 动量：MACD 柱(DIF-DEA)方向与零轴位置、KDJ 超买超卖",
      "   - 位置：BOLL 上/中/下轨与股价所处区间",
      "   - 量能：成交量配合、背离",
      "   - 结论与风险提示，标注数据截至日期",
      "4. 图表卡片的 iframe 可直接在会话内交互（含绘制工具栏，Delete 键删除选中）。",
  ].join("\n");
  ctx.effect(() => ctx.skills.register({
    name: "stock-technical-analysis",
    description: "用 a_stock_data（A股）/ MCP 股票工具取约 3 年日K与技术指标，推送到 dsh 内置图表并生成技术分析报告。",
    whenToUse: "当用户要求分析某只股票的K线/技术指标、查看图表或生成分析报告时。",
    source: stockSkillMarkdown,
    content: stockSkillMarkdown,
  }), "dsh-stock-chart: stock-technical-analysis skill");

  const route = {
    kind: "prefix",
    path: PREFIX,
    handler: async (req, res) => {
      try {
        const hostname = String(req.headers.host || "").split(":")[0].replace(/^\[|\]$/g, "");
        if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const { pathname, query } = parseUrl(req.url);
        if (pathname === PREFIX || pathname === PREFIX + "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(CHART_HTML);
          return;
        }
        if (pathname === PREFIX + "/data") {
          const symbol = String(query.symbol || "").trim().toUpperCase();
          let data = symbol ? store.get(symbol) : undefined;
          if (!data && symbol) {
            try {
              const rows = queryKlines(symbol);
              if (rows.length) {
                const meta = queryMeta(symbol);
                let quote;
                try { quote = meta && meta.quote ? JSON.parse(meta.quote) : undefined; } catch (e) {}
                data = normalize({ symbol, name: meta?.name, klines: rows, quote });
                store.set(symbol, data);
              }
            } catch (e) {}
          }
          if (!data) {
            res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "no data for " + (symbol || "(empty)") }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, data }));
          return;
        }
        if (pathname === PREFIX + "/config") {
          if (req.method === "GET" || req.method === "HEAD" || req.method === undefined) {
            const cfg = readConfig();
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, config: cfg, mcpUrl: findMCPUrl(cfg.mcpServerName || "stock"), stkFetchScript: STK_FETCH_SCRIPT }));
            return;
          }
          if (req.method === "PUT" || req.method === "POST") {
            let body = "";
            try { for await (const chunk of req) body += chunk; } catch (e) {}
            let parsed;
            try { parsed = JSON.parse(body || "{}"); } catch (e) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: "invalid json" }));
              return;
            }
            const clean = writeConfig(parsed);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, config: clean }));
            return;
          }
          res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        if (pathname === PREFIX + "/list") {
          const symbols = new Set(Array.from(store.keys()));
          try {
            const rows = getDb().prepare("SELECT DISTINCT symbol FROM klines").all();
            for (const r of rows) symbols.add(r.symbol);
          } catch (e) {}
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, symbols: Array.from(symbols) }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e && e.message ? e.message : e));
      }
    },
  };
  ctx.effect(() => ctx.webServer.register(route), "dsh-stock-chart: " + PREFIX + " route");
}
