// Browser half of dsh-stock-chart (fixed bundle): renders the same-origin
// chart iframe inside the stock_chart_push tool call card, and a configuration
// card inside the plugin settings page. The iframe has a "放大" button that
// opens the chart full-window in a new tab.
window.__ModuleLoader__.load({
  id: 'dsh-stock-chart',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        // ── 图表卡片（stock_chart_push 工具结果）──────────────────────────────
        try {
          scope.slots.inject('tool.call.toolview', function* () {
            yield scope.slots.register({
              name: 'tool.call.toolview',
              key: 'stock_chart_push',
            }, function ToolCard(props) {
              var react
              try { react = require('react') } catch (e) { return null }
              var h = react.createElement
              var symbol = ''
              try {
                var block = props && props.block
                var raw = block
                  ? (typeof block.argsRaw === 'string' ? block.argsRaw : (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : ''))
                  : ''
                if (raw) {
                  var parsed = JSON.parse(raw)
                  if (parsed && typeof parsed.symbol === 'string' && parsed.symbol.trim()) symbol = parsed.symbol.trim()
                }
              } catch (e) {}
              if (!symbol) {
                return h('div', { style: { padding: '12px', color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px' } },
                  '暂无股票数据（图表会在调用 stock_chart_push 后显示）')
              }
              var src = '/api/stkchart/?symbol=' + encodeURIComponent(symbol)
              return h('div', { style: { width: '100%' } },
                h('div', { style: { padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)' } },
                  h('span', null, symbol + ' · 技术图表（可绘制标注）'),
                  h('a', { href: src + '&full=1', target: '_blank', rel: 'noopener noreferrer', style: { color: '#1f6feb', textDecoration: 'none' } }, '放大 ↗'),
                ),
                h('iframe', {
                  src: src,
                  title: symbol + ' 股票图表',
                  style: { width: '100%', height: '720px', border: '0', display: 'block', background: '#fff' },
                }),
              )
            })
          })
        } catch (error) {
          console.error('[dsh-stock-chart] toolview skipped: ' + error)
        }

        // ── 配置卡片（插件设置页）──────────────────────────────────────────────
        try {
          scope.slots.inject('settings.plugin.item', function* () {
            yield scope.slots.register({
              name: 'settings.plugin.item',
              key: 'stock-chart',
              order: 50,
              label: function () { return 'stock-chart' },
            }, function StockChartConfigCard() {
              var react
              try { react = require('react') } catch (e) { return null }
              var h = react.createElement
              var useState = react.useState, useEffect = react.useEffect
              var [cfg, setCfg] = useState(null)
              var [msg, setMsg] = useState('')
              var [saving, setSaving] = useState(false)
              useEffect(function () {
                fetch('/api/stkchart/config').then(function (r) { return r.json() }).then(function (res) {
                  if (res && res.ok) setCfg(res.config || {})
                }).catch(function () {})
              }, [])
              if (!cfg) return h('div', { style: { padding: '12px', fontSize: '13px', color: '#888' } }, '加载配置…')
              var FIELDS = [
                ['pythonPath', 'Python 路径', 'D:/miniconda3/envs/stock_data/python.exe'],
                ['mcpServerName', '股票 MCP 服务器名（读取 dsh 已配置的 MCP）', 'stock'],
                ['dataDir', '数据目录（SQLite 存放处）', '~/.dsh/stkdata'],
              ]
              function patch(k, v) {
                var next = {}
                for (var kk in cfg) next[kk] = cfg[kk]
                next[k] = v
                setCfg(next)
              }
              function save() {
                setSaving(true); setMsg('')
                fetch('/api/stkchart/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
                  .then(function (r) { return r.json() })
                  .then(function (res) { setSaving(false); setMsg(res && res.ok ? '已保存' : '保存失败：' + (res && res.error || '')) })
                  .catch(function (e) { setSaving(false); setMsg('保存失败：' + e.message) })
              }
              var inputStyle = { width: '100%', boxSizing: 'border-box', padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4, fontFamily: 'inherit', fontSize: '13px' }
              var areaStyle = { width: '100%', boxSizing: 'border-box', padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4, fontFamily: 'inherit', fontSize: '13px', minHeight: 72, whiteSpace: 'pre' }
              return h('div', { style: { padding: '12px', fontSize: '13px' } },
                h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'dsh-stock-chart 配置'),
                FIELDS.map(function (f) {
                  return h('div', { key: f[0], style: { marginBottom: 8 } },
                    h('label', { style: { display: 'block', marginBottom: 2, color: '#666' } }, f[1]),
                    h('input', { style: inputStyle, value: cfg[f[0]] || '', placeholder: f[2], onChange: function (e) { patch(f[0], e.target.value) } }),
                  )
                }),
                h('div', { key: 'skillPaths', style: { marginBottom: 8 } },
                  h('label', { style: { display: 'block', marginBottom: 2, color: '#666' } }, 'Skill（可选）'),
                  h('textarea', { style: areaStyle, value: (cfg.skillPaths || []).join('\n'), placeholder: '每行一个技能目录路径（含 SKILL.md），例如：\nE:\\DS-stock\\.reasonix\\skills\\a_stock_data', onChange: function (e) { patch('skillPaths', e.target.value.split('\n').map(function (s) { return s.trim() }).filter(Boolean)) } }),
                ),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                  h('button', { style: { padding: '4px 14px', border: '1px solid #1f6feb', background: '#1f6feb', color: '#fff', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }, onClick: save }, saving ? '保存中…' : '保存'),
                  msg ? h('span', { style: { color: msg.indexOf('失败') >= 0 ? '#c00' : '#0a0' } }, msg) : null,
                ),
              )
            })
          })
        } catch (error) {
          console.error('[dsh-stock-chart] settings card skipped: ' + error)
        }
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
