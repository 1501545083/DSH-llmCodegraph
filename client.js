return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const KIND_COLORS = { function: '#5b8def', method: '#2fbfa3', class: '#b07ce8', constructor: '#b07ce8', const: '#e8a04c', module: '#8a94a6' }
    const KIND_LABEL = { function: '函数', method: '方法', class: '类', constructor: '构造', const: '常量函数', module: '模块' }

    styles.insert(`
      .llmg-root { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid #3a4254; border-radius: 10px; background: #161b26; font-size: 13px; color: #e6e9f0; }
      .llmg-toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .llmg-toolbar input[type=text] { flex: 1 1 200px; min-width: 160px; padding: 4px 8px; border-radius: 6px; border: 1px solid #3a4254; background: #1e2430; color: #e6e9f0; font-size: 12px; }
      .llmg-btn { padding: 4px 10px; border-radius: 6px; border: 1px solid #3a4254; background: #232a38; color: #eef2f9; cursor: pointer; font-size: 12px; }
      .llmg-btn:hover { border-color: #4c9aff; }
      .llmg-btn.primary { background: #4c9aff; color: #fff; border-color: transparent; }
      .llmg-btn.active { border-color: #4c9aff; color: #7ab3ff; }
      .llmg-btn:disabled { opacity: 0.5; cursor: default; }
      .llmg-tab { padding: 4px 12px; border-radius: 6px; border: 1px solid #3a4254; background: transparent; color: #9aa4b8; cursor: pointer; font-size: 12px; }
      .llmg-tab.on { background: #4c9aff; color: #fff; border-color: transparent; }
      .llmg-body { display: flex; gap: 8px; }
      .llmg-canvas-wrap { position: relative; width: 100%; height: 520px; border: 1px solid #3a4254; border-radius: 8px; overflow: hidden; background: #14181f; }
      .llmg-canvas-wrap svg { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-select: none; }
      .llmg-canvas-wrap .llmg-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa4b8; pointer-events: none; font-size: 13px; }
      .llmg-detail { width: 290px; flex: none; border: 1px solid #3a4254; border-radius: 8px; padding: 10px; overflow-y: auto; background: #1e2430; font-size: 12px; max-height: 560px; color: #e6e9f0; }
      .llmg-detail h3 { margin: 0 0 4px; font-size: 14px; }
      .llmg-detail .row { margin: 3px 0; word-break: break-all; }
      .llmg-detail .dim { color: #9aa4b8; }
      .llmg-detail ul { margin: 4px 0; padding-left: 16px; }
      .llmg-detail li { cursor: pointer; }
      .llmg-detail li:hover { color: #4c9aff; }
      .llmg-status { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #9aa4b8; align-items: center; }
      .llmg-status .err { color: #ff6b6b; }
      .llmg-legend { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; font-size: 10px; color: #9aa4b8; background: #161b26; padding: 3px 8px; border-radius: 6px; border: 1px solid #3a4254; pointer-events: none; z-index: 2; }
      .llmg-node-label { fill: #e6e9f0; font-size: 10px; pointer-events: none; }
      .llmg-node-name { fill: #e6e9f0; font-size: 11px; font-weight: 600; pointer-events: none; }
      .llmg-node-sum { fill: #9aa4b8; font-size: 9px; pointer-events: none; }
      .llmg-edge { stroke: #4a5368; stroke-width: 1; }
      .llmg-edge.biz { stroke: #4c9aff; opacity: 0.55; }
      .llmg-searchbox { width: 130px !important; flex: none !important; min-width: 0 !important; }
      .llmg-progress { display: inline-flex; align-items: center; gap: 6px; }
      .llmg-spin { width: 10px; height: 10px; border: 2px solid #4a5368; border-top-color: #4c9aff; border-radius: 50%; animation: llmg-rot 0.8s linear infinite; display: inline-block; }
      .llmg-model { font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid #3a4254; background: #232a38; color: #eef2f9; max-width: 170px; }
      @keyframes llmg-rot { to { transform: rotate(360deg); } }
    `)

    // layout virtual space grows with the graph so boxes never have to overlap
    function layoutSize(mode, nodes) {
      if (mode === 'business') {
        let maxL = 0
        const perLayer = new Map()
        for (const nd of nodes) {
          const l = nd.layer || 0
          perLayer.set(l, (perLayer.get(l) || 0) + 1)
          maxL = Math.max(maxL, l)
        }
        let maxInLayer = 0
        for (const v of perLayer.values()) maxInLayer = Math.max(maxInLayer, v)
        return {
          W: Math.max(1100, (maxL + 1) * 220 + 120),
          H: Math.max(520, maxInLayer * 52 + 120),
        }
      }
      const n = nodes.length
      return {
        W: Math.max(1100, Math.ceil(Math.sqrt(n)) * 200 + 300),
        H: Math.max(520, Math.ceil(n / 6) * 70 + 160),
      }
    }

    // ---------- layout helpers ----------
    function forceLayout(nodes, edges, W, H) {
      const N = nodes.length
      if (!N) return []
      const pos = new Array(N)
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2
        pos[i] = { x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.36, y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.36, vx: 0, vy: 0 }
      }
      const idx = new Map()
      nodes.forEach((n, i) => idx.set(n.id, i))
      const links = []
      for (const e of edges) {
        const a = idx.get(e.from), b = idx.get(e.to)
        if (a !== undefined && b !== undefined) links.push([a, b])
      }
      const REP = 5200, SPRING = 0.055, REST = 130, GRAV = 0.005, DAMP = 0.82
      for (let it = 0; it < 170; it++) {
        for (let i = 0; i < N; i++) pos[i].vx *= DAMP, pos[i].vy *= DAMP
        for (let i = 0; i < N; i++) {
          for (let j = i + 1; j < N; j++) {
            const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y
            const d2 = Math.max(1, dx * dx + dy * dy)
            const f = REP / d2
            const d = Math.sqrt(d2)
            const fx = (dx / d) * f, fy = (dy / d) * f
            pos[i].vx -= fx; pos[i].vy -= fy; pos[j].vx += fx; pos[j].vy += fy
          }
        }
        for (const [a, b] of links) {
          const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          const f = (d - REST) * SPRING
          const fx = (dx / d) * f, fy = (dy / d) * f
          pos[a].vx += fx; pos[a].vy += fy; pos[b].vx -= fx; pos[b].vy -= fy
        }
        for (let i = 0; i < N; i++) {
          pos[i].vx -= (pos[i].x - W / 2) * GRAV
          pos[i].vy -= (pos[i].y - H / 2) * GRAV
          pos[i].x += pos[i].vx
          pos[i].y += pos[i].vy
        }
      }
      return pos
    }

    function layeredLayout(nodes, edges, W, H) {
      const byLayer = new Map()
      for (const n of nodes) {
        const l = n.layer || 0
        if (!byLayer.has(l)) byLayer.set(l, [])
        byLayer.get(l).push(n)
      }
      const layers = Array.from(byLayer.keys()).sort((a, b) => a - b)
      const pos = []
      const idx = new Map()
      nodes.forEach((n, i) => idx.set(n.id, i))
      const maxL = layers.length
      for (const n of nodes) pos.push({ x: 0, y: 0 })
      for (const l of layers) {
        const arr = byLayer.get(l).sort((a, b) => a.rel.localeCompare(b.rel) || a.startLine - b.startLine)
        const x = maxL > 1 ? (l / (maxL - 1)) * (W - 180) + 90 : W / 2
        const step = 48
        const totalH = (arr.length - 1) * step
        const y0 = Math.max(50, (H - totalH) / 2)
        arr.forEach((n, i) => {
          const p = pos[idx.get(n.id)]
          p.x = x
          p.y = y0 + i * step
        })
      }
      return pos
    }

    // collision avoidance: push overlapping boxes apart, then nudge toward center
    function separateNodes(nodes, W, H, iter) {
      for (let it = 0; it < iter; it++) {
        let overlap = false
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j]
            const dx = b.x - a.x, dy = b.y - a.y
            const minDx = (a.w + b.w) / 2 + 12, minDy = (a.h + b.h) / 2 + 6
            const ox = minDx - Math.abs(dx), oy = minDy - Math.abs(dy)
            if (ox > 0 && oy > 0) {
              overlap = true
              if (ox < oy) {
                const s = (dx >= 0 ? 1 : -1) * (ox / 2)
                a.x -= s; b.x += s
              } else {
                const s = (dy >= 0 ? 1 : -1) * (oy / 2)
                a.y -= s; b.y += s
              }
            }
          }
        }
        if (!overlap) break
        for (const n of nodes) {
          n.x += (W / 2 - n.x) * 0.006
          n.y += (H / 2 - n.y) * 0.006
        }
      }
      for (const n of nodes) {
        n.x = Math.max(40, Math.min(W - 40, n.x))
        n.y = Math.max(30, Math.min(H - 30, n.y))
      }
    }

    // text measuring: CJK ~11px, latin ~6px at node font sizes
    function textW(s) {
      let w = 0
      for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? 11 : 6
      return w
    }
    function truncateText(s, maxPx) {
      const t = String(s || '')
      if (textW(t) <= maxPx) return t
      let out = ''
      for (const ch of t) {
        if (textW(out) + (ch.charCodeAt(0) > 255 ? 11 : 6) > maxPx - 12) { out += '…'; break }
        out += ch
      }
      return out
    }
    // box geometry for a node: width/height + the two text lines to render
    function boxSize(n) {
      const MAXW = 170
      const nameText = truncateText(n.name, MAXW - 12)
      const sumText = truncateText(n.summary || '', MAXW - 12)
      const w = Math.min(MAXW, Math.max(textW(nameText), Math.max(textW(sumText), 40)) + 14)
      return { w, h: 40, nameText, sumText }
    }
    // shrink a line endpoint from a box center to the box border
    function shrinkBox(fx, fy, tx, ty, w, h) {
      const dx = tx - fx, dy = ty - fy
      const d = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy))
      const ux = dx / d, uy = dy / d
      let t = Infinity
      if (Math.abs(ux) > 1e-9) t = Math.min(t, (w / 2) / Math.abs(ux))
      if (Math.abs(uy) > 1e-9) t = Math.min(t, (h / 2) / Math.abs(uy))
      return { x: fx + t * ux, y: fy + t * uy }
    }

    function fitViewbox(nodes) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        const w = n.w || 70, h = n.h || 18
        minX = Math.min(minX, n.x - w / 2 - 6); maxX = Math.max(maxX, n.x + w / 2 + 6)
        minY = Math.min(minY, n.y - h / 2 - 6); maxY = Math.max(maxY, n.y + h / 2 + 6)
      }
      const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY)
      return { x: minX - 30, y: minY - 30, w: w + 60, h: h + 60 }
    }

    // ---------- main view ----------
    function CodeGraphView() {
      const [st, setSt] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [rootInput, setRootInput] = React.useState('')
      const [mode, setMode] = React.useState('call')
      const [entry, setEntry] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [vb, setVb] = React.useState({ x: 0, y: 0, w: 900, h: 520 })
      const [fitTick, setFitTick] = React.useState(0)
      const [refreshTick, setRefreshTick] = React.useState(0)
      const [modelOpts, setModelOpts] = React.useState([])
      const [prov, setProv] = React.useState('')
      const [mdl, setMdl] = React.useState('')
      const [callErr, setCallErr] = React.useState('')

      const safeCall = async (m, a) => {
        try { return await host.call(m, a) } catch (e) {
          console.error(m, e)
          setCallErr(String(e && e.message || e))
          return null
        }
      }

      // state poll
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const s = await safeCall('get-state')
          if (alive && s) {
            setSt(s)
            if (s.root && rootInput === '') setRootInput(s.root)
            if (!prov && s.defaultModel) {
              setProv(s.defaultModel.provider)
              setMdl(s.defaultModel.model)
            }
          }
        }
        load()
        const iv = ctx.interval(load, 2500)
        return () => { alive = false; iv() }
      }, [])

      // model options
      React.useEffect(() => {
        safeCall('get-model-options').then((r) => { if (r && r.options) setModelOpts(r.options) })
      }, [])

      // graph fetch on rev / mode / entry / manual refresh change
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const g = await safeCall('get-graph', entry ? { mode, entry } : { mode })
          if (!alive) return
          if (g) {
            setGraph(g)
            if (g.target && !entry) setEntry(g.target)
          } else {
            setCallErr('get-graph 返回空')
          }
          setFitTick((t) => t + 1)
        }
        load()
        return () => { alive = false }
      }, [mode, entry, st ? st.graphRev : 0, refreshTick])

      // detail fetch
      React.useEffect(() => {
        if (!selected) { setDetail(null); return }
        let alive = true
        safeCall('get-symbol', { id: selected }).then((r) => { if (alive && r) setDetail(r.detail) })
        return () => { alive = false }
      }, [selected])

      // layout (state so nodes can be dragged; rebuilt on graph/mode change)
      const [layout, setLayout] = React.useState(null)

      React.useEffect(() => {
        if (!graph || !graph.nodes.length) { setLayout(null); return }
        const { W, H } = layoutSize(mode, graph.nodes)
        const pos = mode === 'business' ? layeredLayout(graph.nodes, graph.edges, W, H) : forceLayout(graph.nodes, graph.edges, W, H)
        const nodes = graph.nodes.map((n, i) => {
          const b = boxSize(n)
          return Object.assign({}, n, { x: pos[i].x, y: pos[i].y, w: b.w, h: b.h, nameText: b.nameText, sumText: b.sumText })
        })
        separateNodes(nodes, W, H, 200)
        setLayout({ nodes, edges: graph.edges })
        setVb(fitViewbox(nodes))
      }, [graph, mode])

      // fit viewbox on manual 适配 button press (layout reads latest via ref)
      const layoutRef = React.useRef(null)
      layoutRef.current = layout
      React.useEffect(() => {
        if (layoutRef.current) setVb(fitViewbox(layoutRef.current.nodes))
      }, [fitTick])

      const onWheel = (e) => {
        const z = e.deltaY > 0 ? 1.18 : 0.85
        setVb((v) => {
          const nw = Math.max(60, Math.min(100000, v.w * z))
          const nh = nw * (v.h / v.w)
          const cx = v.x + v.w / 2, cy = v.y + v.h / 2
          return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }
        })
      }
      const onPanStart = (e) => {
        if (e.target !== e.currentTarget && e.target.tagName !== 'svg') return
        const sx = e.clientX, sy = e.clientY
        const v0 = vb
        const move = (ev) => {
          setVb({
            x: v0.x - (ev.clientX - sx) * (v0.w / 900),
            y: v0.y - (ev.clientY - sy) * (v0.h / 520),
            w: v0.w, h: v0.h,
          })
        }
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      // node drag: left-drag a node to move it; edges/arrows follow because they read layout.nodes
      const dragRef = React.useRef(null)
      const onNodeDown = (e, n) => {
        e.stopPropagation()
        e.preventDefault()
        dragRef.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y }
        const move = (ev) => {
          const d = dragRef.current
          if (!d) return
          const kx = vb.w / 900, ky = vb.h / 520
          const nx = d.ox + (ev.clientX - d.sx) * kx
          const ny = d.oy + (ev.clientY - d.sy) * ky
          setLayout((prev) => {
            if (!prev) return prev
            return {
              nodes: prev.nodes.map((nn) => nn.id === d.id ? Object.assign({}, nn, { x: nx, y: ny }) : nn),
              edges: prev.edges,
            }
          })
        }
        const up = () => {
          dragRef.current = null
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      const openFile = (rel) => {
        const ws = ctx.get('workspaces')
        if (!ws) return
        if (st && st.root) ws.openPath(st.root.replace(/[\\/]+$/, '') + '/' + rel)
      }

      const onModelChange = (np, nm) => {
        if (np) {
          setProv(np)
          const target = modelOpts.find((p) => p.provider === np)
          if (target && target.models.length) {
            const first = target.models[0]
            setMdl(first)
            host.call('set-model', { provider: np, model: first })
          }
        } else if (nm) {
          setMdl(nm)
          host.call('set-model', { provider: prov, model: nm })
        }
      }

      const entries = (graph && graph.entries) || []
      const usedModel = (st && (st.model || st.defaultModel)) || null

      // ---------- render ----------
      const els = []
      els.push(React.createElement('div', { className: 'llmg-toolbar', key: 'tb' },
        React.createElement('input', { type: 'text', value: rootInput, placeholder: '代码目录绝对路径', onChange: (e) => setRootInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { host.call('set-root', { path: rootInput }); setFitTick(t => t + 1) } } }),
        React.createElement('button', { className: 'llmg-btn', onClick: () => { host.call('set-root', { path: rootInput }); setRefreshTick((t) => t + 1) } }, '载入'),
        React.createElement('button', { className: 'llmg-btn', onClick: async () => {
          const ws = ctx.get('workspaces')
          if (!ws) return
          const p = await ws.pickDirectory()
          if (p) { setRootInput(p); host.call('set-root', { path: p }); setRefreshTick((t) => t + 1) }
        } }, '浏览目录'),
        React.createElement('button', { className: 'llmg-btn primary', onClick: () => host.call('analyze', { force: true }) }, st && st.analyzing ? '分析中…' : 'LLM 分析'),
        React.createElement('button', { className: 'llmg-btn' + (st && st.watch ? ' active' : ''), onClick: () => host.call('set-watch', { watch: !(st && st.watch) }) }, '监听修改'),
        React.createElement('button', { className: 'llmg-tab' + (mode === 'call' ? ' on' : ''), onClick: () => { setMode('call'); setSelected(null) } }, '调用图'),
        React.createElement('button', { className: 'llmg-tab' + (mode === 'business' ? ' on' : ''), onClick: () => { setMode('business'); setSelected(null) } }, '业务图'),
        mode === 'business' && React.createElement('select', { value: entry, onChange: (e) => setEntry(e.target.value), style: { fontSize: 12, padding: '3px 6px', background: '#232a38', color: '#eef2f9', border: '1px solid #3a4254' } },
          React.createElement('option', { key: '__all__', value: '' }, '全部业务流（' + entries.length + ' 个入口）'),
          entries.map((en) => React.createElement('option', { key: en.id, value: en.id }, en.summary || (en.rel.split('/').slice(-1)[0] + ' · ' + en.name + ' @' + en.startLine)))),
        React.createElement('input', { type: 'text', className: 'llmg-searchbox', placeholder: '搜索符号', value: search, onChange: (e) => setSearch(e.target.value) }),
        React.createElement('button', { className: 'llmg-btn', onClick: () => setFitTick(t => t + 1) }, '适配'),
        React.createElement('button', { className: 'llmg-btn', onClick: () => setRefreshTick((t) => t + 1) }, '刷新图'),
        modelOpts.length > 0 && React.createElement('select', { className: 'llmg-model', value: prov, onChange: (e) => onModelChange(e.target.value, null), title: '分析模型 provider' },
          modelOpts.map((p) => React.createElement('option', { key: p.provider, value: p.provider }, p.provider))),
        modelOpts.length > 0 && React.createElement('select', { className: 'llmg-model', value: mdl, onChange: (e) => onModelChange(null, e.target.value), title: '分析模型' },
          (modelOpts.find((p) => p.provider === prov) ? modelOpts.find((p) => p.provider === prov).models : []).map((m) => React.createElement('option', { key: m, value: m }, m))),
      ))

      const body = []
      const canvasChildren = []
      if (layout) {
        const q = search.trim().toLowerCase()
        canvasChildren.push(React.createElement('defs', { key: 'defs' },
          React.createElement('marker', { id: 'llmg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
            React.createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#4a5368' })),
          React.createElement('marker', { id: 'llmg-arrow-biz', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
            React.createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#4c9aff' })),
        ))
        canvasChildren.push(React.createElement('g', { key: 'edges' },
          layout.edges.map((e, i) => {
            const a = layout.nodes.find((n) => n.id === e.from)
            const b = layout.nodes.find((n) => n.id === e.to)
            if (!a || !b) return null
            const s = shrinkBox(a.x, a.y, b.x, b.y, a.w, a.h)
            const t = shrinkBox(b.x, b.y, a.x, a.y, b.w, b.h)
            return React.createElement('line', { key: 'e' + i, x1: s.x, y1: s.y, x2: t.x, y2: t.y, className: 'llmg-edge' + (mode === 'business' ? ' biz' : ''), strokeWidth: mode === 'business' ? 1.6 : 1, markerEnd: 'url(#llmg-arrow' + (mode === 'business' ? '-biz' : '') + ')' })
          }),
        ))
        canvasChildren.push(React.createElement('g', { key: 'nodes' },
          layout.nodes.map((n) => {
            const hit = q && n.name.toLowerCase().indexOf(q) >= 0
            const dim = q && !hit
            const color = KIND_COLORS[n.kind] || '#8a94a6'
            const isEntry = n.entry
            const isSel = selected === n.id
            return React.createElement('g', { key: n.id, opacity: dim ? 0.25 : 1, style: { cursor: 'pointer' }, onMouseDown: (e) => onNodeDown(e, n), onClick: (e) => { e.stopPropagation(); setSelected(n.id) } },
              React.createElement('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 5, fill: color, fillOpacity: 0.16, stroke: isSel ? '#fff' : (isEntry ? '#ff6b6b' : color), strokeWidth: isSel ? 2.5 : (isEntry ? 2 : 1.2) }),
              React.createElement('text', { className: 'llmg-node-name', x: n.x, y: n.y - 4, textAnchor: 'middle' }, n.nameText),
              React.createElement('text', { className: 'llmg-node-sum', x: n.x, y: n.y + 13, textAnchor: 'middle' }, n.sumText),
            )
          }),
        ))
        canvasChildren.push(React.createElement('div', { className: 'llmg-legend', key: 'legend' },
          Object.keys(KIND_COLORS).map((k) => React.createElement('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: KIND_COLORS[k], display: 'inline-block' } }), KIND_LABEL[k]))),
        )
      } else {
        canvasChildren.push(React.createElement('div', { className: 'llmg-hint', key: 'hint' },
          '输入目录并「载入」，然后点「LLM 分析」', st ? '（rev ' + st.graphRev + '，文件 ' + st.ok + '/' + st.total + '）' : ''))
      }
      const vbStr = vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h
      body.push(React.createElement('div', { className: 'llmg-canvas-wrap', key: 'canvas',
        onWheel: onWheel, onMouseDown: onPanStart },
        React.createElement('svg', { viewBox: vbStr, preserveAspectRatio: 'xMidYMid meet', width: '100%', height: '100%' }, canvasChildren),
      ))

      if (detail) {
        const d = detail
        const rows = []
        rows.push(React.createElement('div', { className: 'row', key: 'n' }, React.createElement('b', null, d.node.name),
          ' ', React.createElement('span', { className: 'dim' }, KIND_LABEL[d.node.kind] || d.node.kind)))
        rows.push(React.createElement('div', { className: 'row dim', key: 'f' },
          d.node.cls ? d.node.cls + '.' : '', d.node.rel, ' : ', d.node.startLine, '-', d.node.endLine))
        rows.push(React.createElement('div', { className: 'row', key: 'b' },
          React.createElement('button', { className: 'llmg-btn', onClick: () => openFile(d.node.rel) }, '打开文件'),
          ' ', React.createElement('span', { className: 'dim' }, '入度 ', d.node.degIn, ' 出度 ', d.node.degOut)))
        rows.push(React.createElement('div', { className: 'row', key: 's' }, React.createElement('span', { className: 'dim' }, '签名: '), d.node.sig))
        if (d.node.summary) rows.push(React.createElement('div', { className: 'row', key: 'u' }, React.createElement('span', { className: 'dim' }, '摘要: '), d.node.summary))
        if (d.callers.length) {
          rows.push(React.createElement('div', { className: 'row', key: 'c1' }, React.createElement('span', { className: 'dim' }, '被谁调用 (' + d.callers.length + '):')))
          rows.push(React.createElement('ul', { key: 'c1l' }, d.callers.map((c) => React.createElement('li', { key: c.id, onClick: () => setSelected(c.id) }, c.name, ' @ ', c.rel.split('/').slice(-1)[0], ':', c.atLine))))
        }
        if (d.callees.length) {
          rows.push(React.createElement('div', { className: 'row', key: 'c2' }, React.createElement('span', { className: 'dim' }, '调用了 (' + d.callees.length + '):')))
          rows.push(React.createElement('ul', { key: 'c2l' }, d.callees.map((c) => React.createElement('li', { key: c.id, onClick: () => setSelected(c.id) }, c.name, ' @ ', c.rel.split('/').slice(-1)[0], ':', c.atLine))))
        }
        if (d.unresolved.length) {
          rows.push(React.createElement('div', { className: 'row', key: 'c3' }, React.createElement('span', { className: 'dim' }, '未解析调用 (' + d.unresolved.length + '):')))
          rows.push(React.createElement('ul', { key: 'c3l' }, d.unresolved.map((c, i) => React.createElement('li', { key: i, onClick: () => openFile(d.node.rel) }, c.target, ' @ ', c.atLine))))
        }
        body.push(React.createElement('div', { className: 'llmg-detail', key: 'detail' },
          React.createElement('h3', null, d.node.cls ? d.node.cls + '.' + d.node.name : d.node.name),
          rows,
        ))
      }

      const status = []
      if (st) {
        if (st.analyzing || st.queueLen > 0) status.push(React.createElement('span', { className: 'llmg-progress', key: 'p' },
          React.createElement('span', { className: 'llmg-spin' }), 'LLM 分析中 ' + st.ok + '/' + st.total))
        else status.push(React.createElement('span', { key: 'p' }, '已分析 ', st.ok, '/', st.total, ' 文件'))
        if (st.lastScanAt) status.push(React.createElement('span', { key: 't' }, '扫描于 ', new Date(st.lastScanAt).toLocaleTimeString()))
        if (usedModel) status.push(React.createElement('span', { key: 'm' }, '模型: ', usedModel.provider, '/', usedModel.model))
        if (graph) status.push(React.createElement('span', { key: 'g' }, '图: ', graph.nodes.length, ' 节点 / ', graph.edges.length, ' 边 rev', graph.rev))
        if (graph && graph.note) status.push(React.createElement('span', { key: 'gn', style: { color: '#7ab3ff' } }, graph.note))
        if (st.watch) status.push(React.createElement('span', { key: 'w', style: { color: '#7ab3ff' } }, '● 监听中'))
        if (st.lastError) status.push(React.createElement('span', { className: 'err', key: 'e' }, st.lastError))
        if (callErr) status.push(React.createElement('span', { className: 'err', key: 'ce' }, 'RPC: ', callErr))
        if (st.log && st.log.length) status.push(React.createElement('span', { key: 'l', style: { flex: 1, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st.log[st.log.length - 1]))
      }
      els.push(React.createElement('div', { className: 'llmg-body', key: 'body' }, body))
      els.push(React.createElement('div', { className: 'llmg-status', key: 'st' }, status))

      return React.createElement('div', { className: 'llmg-root' }, els)
    }

    slots.inject('conversation.view', () => slots.register(
      { name: 'conversation.view', id: 'codegraph', order: 20, label: () => '代码图谱' },
      () => React.createElement(CodeGraphView, null),
    ))
  },
}
