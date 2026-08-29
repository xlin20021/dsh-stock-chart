# dsh-stock-chart

dsh（DeepSeek Harness）内置股票技术分析图表插件 —— 用 TradingView **Lightweight Charts** 渲染 K 线图，带绘制标注工具栏，自动计算 MA/BOLL/MACD/KDJ 指标。

- 数据经 **SQLite 持久化**（默认 `~/.dsh/stkdata`），历史图表重启/跨浏览器都能复现
- 取数脚本 **stk-fetch.mjs** 把数据直接写入 SQLite，**不经过模型上下文**（省 token）
- 在**插件设置页**配置 Python 路径、技能目录、MCP 服务器名、数据目录

---

## 1. 特性

- **K 线图**：日线 / 周线一键切换（周线由日线自动聚合，含周线指标）
- **技术指标**：MA5/10/20/60/120、BOLL、MACD、KDJ、成交量（由插件按 K 线自动计算）
- **绘制标注**：基于 `lightweight-charts-drawing`，支持线条/矩形/文字等工具；`Delete`/`Backspace` 删除选中
- **SQLite 持久化**：数据存 `~/.dsh/stkdata/stock-chart.sqlite`，会话/浏览器只是"查看窗口"
- **省 token 取数**：`stk-fetch.mjs` 从数据源取 K 线直接入库，agent 只传 `{symbol}` 出图
- **配置页**：在 dsh 的「设置 → 插件」里配置（见下）

## 2. 安装

### 方式 1：本地 file 依赖（本机/开发）

在 web profile 的 `package.json` 加：

```json
"dependencies": { "dsh-stock-chart": "file:E:/dsh/dsh-stock-chart" }
```

`dsh.profile.bundles` 加 `"dsh-stock-chart"`，然后重启 `dsh web`。

> 插件依赖 `@deepseek-ai/dsh-settings` 与 `@deepseek-ai/schemastery`（已在插件目录内安装，随包发布）。

### 方式 2：发布后安装（GitHub / npm）

```bat
dsh plugin --profile web add github:<repo>#vX.Y.Z
```

（发布时替换为实际仓库地址。）

## 3. 使用

```bat
:: 1) 取数入库（数据写 SQLite，不占模型上下文）
node E:\dsh\dsh-stock-chart\stk-fetch.mjs <symbol> mootdx|mcp

::    A股 用 mootdx（约 750 交易日 ≈ 3 年）
::    港股(5位)/美股(字母) 用 mcp（读配置的股票 MCP，约 500 交易日 ≈ 2 年）
```

```jsonc
// 2) 在会话里让 agent 调用工具出图：
//    stock_chart_push({ symbol: "600519", name?, quote? })
//    —— K 线从 SQLite 读，只传代码（+ 可选名称/实时行情）
```

插件注册的 `stock-technical-analysis` skill 会自动引导这条流程；`stock_chart_push` 在库中无数据时会返回取数脚本的绝对路径。

> 兼容旧流程：也可直接把 `klines` 数组传给 `stock_chart_push`（会同时写入 SQLite）。

## 4. 配置

在 dsh「设置 → 插件 → dsh-stock-chart」里配置，保存到 `~/.dsh/stkdata/config.json`：

| 字段 | 说明 | 默认 |
|---|---|---|
| **Python 路径** | mootdx 取数用 Python 可执行文件 | `python`（PATH）|
| **Skill（可选）** | 技能目录，textarea **每行一个**（含 `SKILL.md` 的目录）| 空 |
| **股票 MCP 服务器名** | 插件读取 dsh 已配置的 MCP 服务器名 | `stock` |
| **数据目录** | SQLite 存放处 | `~/.dsh/stkdata` |

`config.json` 格式示例：

```json
{
  "pythonPath": "D:/miniconda3/envs/stock_data/python.exe",
  "mcpServerName": "stock",
  "skillPaths": [
    "E:\\DS-stock\\.reasonix\\skills\\a_stock_data",
    "C:\\Users\\Administrator\\.config\\opencode\\skills\\a_stock_data"
  ]
}
```

### 环境变量覆盖

| 变量 | 作用 |
|---|---|
| `STK_DATA_DIR` | 数据目录（config.json 也在此）|
| `STK_PYTHON` | mootdx 用 Python（优先于 config.pythonPath）|
| `STK_MCP_URL` | 股票 MCP 的 URL（优先于从 dsh 配置读取）|
| `DSH_HOME` | dsh home（用于定位 cordis.patch.yml）|

### MCP 配置

插件**不单独配置 MCP URL**，而是直接读取 dsh 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`），按 `mcpServerName`（默认 `stock`）找到对应 MCP 服务器并取其 `url`。没有配置则 stk-fetch 的 `mcp` 源会提示你配置。

## 5. 架构 / 数据流

```
stk-fetch.mjs（agent 侧运行）        浏览器
   │  mootdx / MCP 取数                   │
   ▼                                     ▼
SQLite (~/.dsh/stkdata) ──/api/stkchart/data──▶ 图表 iframe (chart.html)
   │  stock_chart_push({symbol})         （日/周、指标、绘制）
   └── 插件读取 + normalize + 计算指标
```

同源 HTTP 端点（`/api/stkchart`）：
| 端点 | 说明 |
|---|---|
| `/` | 图表页（chart.html）|
| `/data?symbol=X` | 返回某股票数据（内存 store，缺则从 SQLite 兜底）|
| `/config` | 读/写插件配置（GET/PUT）|
| `/list` | 已入库股票列表 |

## 6. 目录结构

```
dsh-stock-chart/
├── dsh/
│   ├── index.js        # 宿主：工具 stock_chart_push、skill、HTTP 路由、SQLite、配置
│   ├── client.js       # 浏览器：图表卡片 + 插件设置页配置卡片
│   └── chart.html      # 图表页（Lightweight Charts + drawing）
├── stk-fetch.mjs       # 取数脚本（随包发布）
├── cordis.patch.yml    # bundle 补丁
├── package.json
├── LICENSE             # MIT
├── NOTICE              # 三方依赖声明
└── README.md
```

## 7. 许可证 / 三方依赖

- 插件本体：**MIT**（见 `LICENSE`）
- [Lightweight Charts](https://www.tradingview.com/lightweight-charts/)（TradingView）：**Apache-2.0**（CDN 加载）
- [lightweight-charts-drawing](https://github.com/ismailhamadouche/lightweight-charts-drawing)：**MIT**（CDN 加载）
- [mootdx](https://github.com/mootdx/mootdx)（可选取数源）：**MIT**（经用户配置的 Python 环境使用）

详见 `NOTICE`。

## 8. 回滚

```bat
:: 1) 从 web profile 的 dsh.profile.bundles 移除 "dsh-stock-chart"
::    （及 package.json dependencies 里的 dsh-stock-chart）
:: 2) 重启 dsh web
:: 3) （可选）删除数据目录 ~/.dsh/stkdata
```

## 9. 常见问题

- **设置页看不到配置卡片**：确认插件已加载（boot manifest 含 dsh-stock-chart），Ctrl+F5 硬刷新。
- **`stock_chart_push` 报"本地 SQLite 无该股票K线"**：先运行 `stk-fetch.mjs` 取数入库。
- **mootdx 取不到数**：确认 `Python 路径` 指向装有 mootdx 的环境（如 conda `stock_data`）；海外网络可能连不通通达信 TCP 7709，改用 `mcp`。
- **mcp 源报"未找到股票 MCP"**：确认 `cordis.patch.yml` 里配置了 `mcp-<服务器名>`，且服务器名与设置页一致。
- **历史图表空白**：重启后内存 store 清空，但 `/api/stkchart/data` 会从 SQLite 兜底；跨浏览器/设备同样可复现（优于旧版 localStorage）。
