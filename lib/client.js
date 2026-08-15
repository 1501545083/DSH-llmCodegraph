/**
 * @local/dsh-llm-codegraph — LLM 代码知识图谱（静态插件版）client 半。
 *
 * 由 DSH-llmCodegraph 仓库的 client.js（动态插件版）迁移而来：
 * - host.call(m, a) → fetch('/llmg/api/' + m)（host 半 webServer 路由，信封 {ok,value}）；
 * - styles.insert(css) → installStyles()（手动 <style> 注入，静态 client 无 styles 内建）；
 * - React 经 require('react') 获取（静态 client bundle 由 ModuleLoader 加载）；
 * - 其余（力导向/分层布局、碰撞避让、拖拽缩放、搜索、详情、逻辑图渲染）与动态版一致。
 *
 * 打包格式与 dsh-better-sidebar 等静态插件一致：window.__ModuleLoader__.load(...)，
 * 由 web 前端 /plugins 路由按包名直接伺服本文件。
 * @module @local/dsh-llm-codegraph/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-llm-codegraph',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    const KIND_COLORS = { function: '#5b8def', method: '#2fbfa3', class: '#b07ce8', constructor: '#b07ce8', const: '#e8a04c', module: '#8a94a6' }
    const KIND_LABEL = { function: '函数', method: '方法', class: '类', constructor: '构造', const: '常量函数', module: '模块' }
    const LOGIC_COLORS = { start: '#2fbfa3', process: '#5b8def', decision: '#e8a04c', end: '#ff6b6b' }
    const LOGIC_LABEL = { start: '入口', process: '步骤', decision: '判断', end: '结束' }

    const LLMG_CSS = `
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
      .llmg-body.logic .llmg-detail { width: 240px; }
      .llmg-tree { width: 210px; flex: none; border: 1px solid #3a4254; border-radius: 8px; padding: 8px; background: #1e2430; font-size: 12px; color: #e6e9f0; max-height: 560px; overflow-y: auto; }
      .llmg-tree h4 { margin: 0 0 6px; font-size: 13px; }
      .llmg-tree .llmg-tree-auto { padding: 5px 8px; border: 1px dashed #3a4254; border-radius: 6px; color: #7ab3ff; cursor: pointer; margin-bottom: 6px; }
      .llmg-tree .llmg-tree-layer { margin: 8px 0 4px; color: #9aa4b8; font-size: 11px; border-bottom: 1px solid #2a3242; padding-bottom: 2px; }
      .llmg-tree .llmg-tree-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; word-break: break-all; }
      .llmg-tree .llmg-tree-item:hover { background: #232a38; }
      .llmg-tree .llmg-tree-item.on { background: #23344d; color: #7ab3ff; }
      .llmg-tree .llmg-tree-item .dot { width: 8px; height: 8px; border-radius: 4px; flex: none; display: inline-block; }
      .llmg-tree .llmg-tree-item .dim { color: #9aa4b8; margin-left: auto; flex: none; font-size: 10px; }
      .llmg-depth { width: 70px !important; flex: none !important; min-width: 0 !important; }
      .llmg-canvas-wrap { position: relative; width: 100%; height: 520px; border: 1px solid #3a4254; border-radius: 8px; overflow: hidden; background: #14181f; }
      .llmg-canvas-wrap svg { display: block; width: 100%; height: 100%; user-select: none; -webkit-user-select: none; }
      .llmg-canvas-wrap .llmg-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa4b8; pointer-events: none; font-size: 13px; }
      .llmg-canvas-wrap .llmg-back { position: absolute; left: 8px; top: 8px; z-index: 3; padding: 4px 10px; border-radius: 6px; border: 1px solid #3a4254; background: rgba(30, 36, 48, 0.94); color: #7ab3ff; cursor: pointer; font-size: 12px; }
      .llmg-canvas-wrap .llmg-back:hover:not(:disabled) { border-color: #4c9aff; }
      .llmg-canvas-wrap .llmg-back:disabled { opacity: 0.45; cursor: default; }
      .llmg-detail { width: 290px; flex: none; border: 1px solid #3a4254; border-radius: 8px; padding: 10px; overflow-y: auto; background: #1e2430; font-size: 12px; max-height: 560px; color: #e6e9f0; }
      .llmg-detail h3 { margin: 0 0 4px; font-size: 14px; }
      .llmg-detail .row { margin: 3px 0; word-break: break-all; }
      .llmg-detail .dim { color: #9aa4b8; }
      .llmg-detail ul { margin: 4px 0; padding-left: 16px; }
      .llmg-detail li { cursor: pointer; }
      .llmg-detail li:hover { color: #4c9aff; }
      .llmg-status { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #9aa4b8; align-items: center; }
      .llmg-status .dim { color: #9aa4b8; }
      .llmg-status .err { color: #ff6b6b; }
      .llmg-legend { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; font-size: 10px; color: #9aa4b8; background: #161b26; padding: 3px 8px; border-radius: 6px; border: 1px solid #3a4254; pointer-events: none; z-index: 2; }
      .llmg-node-label { fill: #e6e9f0; font-size: 10px; pointer-events: none; }
      .llmg-node-name { fill: #e6e9f0; font-size: 11px; font-weight: 600; pointer-events: none; }
      .llmg-node-sum { fill: #9aa4b8; font-size: 9px; pointer-events: none; }
      .llmg-edge { stroke: #4a5368; stroke-width: 1; }
      .llmg-edge.logic { stroke: #4c9aff; opacity: 0.55; }
      .llmg-edge-label { fill: #7ab3ff; font-size: 9px; pointer-events: none; paint-order: stroke; stroke: #14181f; stroke-width: 2px; }
      .llmg-searchbox { width: 130px !important; flex: none !important; min-width: 0 !important; }
      .llmg-progress { display: inline-flex; align-items: center; gap: 6px; }
      .llmg-spin { width: 10px; height: 10px; border: 2px solid #4a5368; border-top-color: #4c9aff; border-radius: 50%; animation: llmg-rot 0.8s linear infinite; display: inline-block; }
      .llmg-model { font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid #3a4254; background: #232a38; color: #eef2f9; max-width: 170px; }
      @keyframes llmg-rot { to { transform: rotate(360deg); } }
    `
    /** 静态 client 无 styles 内建：手动注入插件样式（与 dsh-vision-toolkit 同款做法）。 */
    function installStyles() {
      if (typeof document === 'undefined' || document.getElementById('llmg-css')) return
      const style = document.createElement('style')
      style.id = 'llmg-css'
      style.dataset.plugin = '@local/dsh-llm-codegraph'
      style.textContent = LLMG_CSS
      document.head.appendChild(style)
    }

    /** host 半 /llmg/api RPC（信封 {ok,value}）。 */
    async function hostCall(m, a) {
      const res = await fetch('/llmg/api/' + m, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a || {}),
      })
      const data = await res.json().catch(() => null)
      if (!data || data.ok !== true) {
        throw new Error((data && data.error && (data.error.message || data.error.code)) || ('RPC ' + m + ' failed'))
      }
      return data.value
    }

    // ---- layout constants: minimum breathing room between node boxes ----
    const NODE_GAP_X = 20
    const NODE_GAP_Y = 12

    // layout virtual space is sized from real box geometry + gap so boxes have room to breathe
    function layoutSize(mode, nodes) {
      if (mode === 'logic') {
        const perLayer = new Map()
        const layerWidth = new Map()
        let maxL = 0
        for (const nd of nodes) {
          const l = nd.layer || 0
          if (!perLayer.has(l)) perLayer.set(l, [])
          perLayer.get(l).push(nd)
          layerWidth.set(l, Math.max(layerWidth.get(l) || 0, nd.w || 90))
          maxL = Math.max(maxL, l)
        }
        let totalW = 0
        for (let l = 0; l <= maxL; l++) totalW += (layerWidth.get(l) || 90) + (l < maxL ? 96 : 0)
        let totalH = 0
        for (const arr of perLayer.values()) {
          let h = 24
          for (const nd of arr) h += (nd.h || 40) + NODE_GAP_Y
          totalH = Math.max(totalH, h)
        }
        return { W: Math.max(1100, totalW + 100), H: Math.max(520, totalH + 80) }
      }
      let area = 0
      for (const nd of nodes) area += ((nd.w || 90) + NODE_GAP_X) * ((nd.h || 40) + NODE_GAP_Y)
      const n = nodes.length
      const aspect = 1.45
      const base = Math.sqrt(Math.max(area, 700 * 520))
      return {
        W: Math.max(1100, Math.ceil(Math.sqrt(n) * 250 + 360), Math.ceil(base * Math.sqrt(aspect))),
        H: Math.max(520, Math.ceil(n / 5) * 82 + 190, Math.ceil(base / Math.sqrt(aspect))),
      }
    }

    // ---------- layout helpers ----------
    function forceLayout(nodes, edges, W, H) {
      const N = nodes.length
      if (!N) return []
      const pos = new Array(N)
      const radius = Math.max(90, Math.min(W, H) * 0.38)
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + (i % 2 ? 0.13 : 0)
        pos[i] = { x: W / 2 + Math.cos(a) * radius, y: H / 2 + Math.sin(a) * radius, vx: 0, vy: 0 }
      }
      const idx = new Map()
      nodes.forEach((n, i) => idx.set(n.id, i))
      const links = []
      for (const e of edges) {
        const a = idx.get(e.from), b = idx.get(e.to)
        if (a !== undefined && b !== undefined) links.push([a, b])
      }
      // size-aware repulsion: boxes repel as boxes, not as points
      const REP = 9000, SPRING = 0.06, REST = 140, GRAV = 0.004, DAMP = 0.8
      const iterations = Math.min(300, 160 + Math.ceil(N / 2))
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < N; i++) pos[i].vx *= DAMP, pos[i].vy *= DAMP
        for (let i = 0; i < N; i++) {
          const wi = nodes[i].w || 90
          for (let j = i + 1; j < N; j++) {
            const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y
            const d2 = Math.max(16, dx * dx + dy * dy)
            const d = Math.sqrt(d2)
            const minD = (wi + (nodes[j].w || 90)) / 2 + NODE_GAP_X
            const scale = 0.35 + 0.65 * (minD * minD) / (130 * 130)
            const f = Math.min(12000, REP * scale / d2)
            const fx = (dx / d) * f, fy = (dy / d) * f
            pos[i].vx -= fx; pos[i].vy -= fy; pos[j].vx += fx; pos[j].vy += fy
          }
        }
        for (const [a, b] of links) {
          const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          const minD = ((nodes[a].w || 90) + (nodes[b].w || 90)) / 2 + NODE_GAP_X
          const rest = Math.max(REST, minD + 22)
          const f = (d - rest) * SPRING
          const fx = (dx / d) * f, fy = (dy / d) * f
          pos[a].vx += fx; pos[a].vy += fy; pos[b].vx -= fx; pos[b].vy -= fy
        }
        for (let i = 0; i < N; i++) {
          pos[i].vx -= (pos[i].x - W / 2) * GRAV
          pos[i].vy -= (pos[i].y - H / 2) * GRAV
          pos[i].x += pos[i].vx
          pos[i].y += pos[i].vy
          const mw = (nodes[i].w || 90) / 2 + 30
          const mh = (nodes[i].h || 40) / 2 + 24
          if (pos[i].x < mw) { pos[i].x = mw; pos[i].vx = Math.abs(pos[i].vx) * 0.4 }
          else if (pos[i].x > W - mw) { pos[i].x = W - mw; pos[i].vx = -Math.abs(pos[i].vx) * 0.4 }
          if (pos[i].y < mh) { pos[i].y = mh; pos[i].vy = Math.abs(pos[i].vy) * 0.4 }
          else if (pos[i].y > H - mh) { pos[i].y = H - mh; pos[i].vy = -Math.abs(pos[i].vy) * 0.4 }
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
      const pos = new Array(nodes.length)
      const idx = new Map()
      nodes.forEach((n, i) => { idx.set(n.id, i); pos[i] = { x: 0, y: 0 } })
      const layerWidth = new Map()
      for (const l of layers) {
        let m = 0
        for (const n of byLayer.get(l)) m = Math.max(m, n.w || 90)
        layerWidth.set(l, m)
      }
      // each layer gets an x band wide enough for its widest box; bands never touch
      let cursor = 40
      const centers = new Map()
      for (const l of layers) {
        const w = layerWidth.get(l)
        centers.set(l, cursor + w / 2)
        cursor += w + 96
      }
      let minX = Infinity, maxX = -Infinity
      for (const l of layers) {
        minX = Math.min(minX, centers.get(l) - layerWidth.get(l) / 2)
        maxX = Math.max(maxX, centers.get(l) + layerWidth.get(l) / 2)
      }
      const shift = (W - (maxX - minX)) / 2 - minX
      for (const l of layers) {
        const arr = byLayer.get(l).sort((a, b) => (a.rel || a.file || '').localeCompare(b.rel || b.file || '') || ((a.startLine || a.line || 0) - (b.startLine || b.line || 0)))
        const cx = centers.get(l) + shift
        let totalH = 0
        for (const n of arr) totalH += (n.h || 40) + NODE_GAP_Y
        let y = Math.max(46, (H - totalH) / 2)
        for (const n of arr) {
          const p = pos[idx.get(n.id)]
          p.x = cx
          p.y = y + (n.h || 40) / 2
          y += (n.h || 40) + NODE_GAP_Y
        }
      }
      return pos
    }

    // ---- collision solver: broad-phase sweep + averaged push along the smaller overlap axis ----
    function overlapPairs(nodes) {
      const order = nodes.map((n, i) => ({ n, i })).sort((a, b) => (a.n.x - a.n.w / 2) - (b.n.x - b.n.w / 2))
      const active = []
      const pairs = []
      for (const item of order) {
        const left = item.n.x - item.n.w / 2 - NODE_GAP_X
        while (active.length && active[0].n.x + active[0].n.w / 2 < left) active.shift()
        for (const other of active) pairs.push([item.i, other.i])
        active.push(item)
      }
      return pairs
    }

    function gridPack(nodes, W, H) {
      const order = nodes.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y))
      const margin = 26
      let x = margin, y = margin, rowH = 0
      for (const n of order) {
        if (x + n.w > W - margin && x > margin) { x = margin; y += rowH + NODE_GAP_Y; rowH = 0 }
        if (x + n.w > W - margin) { x = margin; y += rowH + NODE_GAP_Y; rowH = 0 }
        n.x = x + n.w / 2
        n.y = y + n.h / 2
        x += n.w + NODE_GAP_X
        rowH = Math.max(rowH, n.h)
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of nodes) {
        minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2)
        minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2)
      }
      const sx = (W - (maxX - minX)) / 2 - minX
      const sy = (H - (maxY - minY)) / 2 - minY
      for (const n of nodes) { n.x += sx; n.y += sy }
    }

    function resolveNodeCollisions(nodes, W, H) {
      const N = nodes.length
      if (N < 2) return
      const maxPass = N < 300 ? 900 : 450
      const pairs = overlapPairs(nodes)
      if (pairs.length === 0) return
      if (pairs.length > N * N * 0.25) { gridPack(nodes, W, H); return }
      for (let pass = 0; pass < maxPass; pass++) {
        const dx = new Array(N).fill(0), dy = new Array(N).fill(0)
        let maxOverlap = 0
        for (const [i, j] of overlapPairs(nodes)) {
          const a = nodes[i], b = nodes[j]
          const oxd = b.x - a.x, oyd = b.y - a.y
          const minDx = (a.w + b.w) / 2 + NODE_GAP_X, minDy = (a.h + b.h) / 2 + NODE_GAP_Y
          const ox = minDx - Math.abs(oxd), oy = minDy - Math.abs(oyd)
          if (ox <= 0 || oy <= 0) continue
          maxOverlap = Math.max(maxOverlap, Math.min(ox, oy))
          let sx = 0, sy = 0, amount = 0
          if (ox <= oy) {
            amount = ox
            if (Math.abs(oxd) > 1e-6) sx = oxd >= 0 ? -1 : 1
            else sx = ((i * 31 + j * 17) & 1) ? 1 : -1
          } else {
            amount = oy
            if (Math.abs(oyd) > 1e-6) sy = oyd >= 0 ? -1 : 1
            else sy = ((i * 7 + j * 13) & 1) ? 1 : -1
          }
          const push = amount * 0.6 + 0.2
          dx[i] += sx * push / 2; dx[j] -= sx * push / 2
          dy[i] += sy * push / 2; dy[j] -= sy * push / 2
        }
        if (maxOverlap < 0.5) break
        for (let i = 0; i < N; i++) {
          nodes[i].x += dx[i]
          nodes[i].y += dy[i]
          nodes[i].x = Math.max(nodes[i].w / 2 + 14, Math.min(W - nodes[i].w / 2 - 14, nodes[i].x))
          nodes[i].y = Math.max(nodes[i].h / 2 + 12, Math.min(H - nodes[i].h / 2 - 12, nodes[i].y))
        }
      }
      // sub-pixel leftovers are invisible; real leftovers get a guaranteed packed fallback
      let visible = false
      for (const [i, j] of overlapPairs(nodes)) {
        const a = nodes[i], b = nodes[j]
        const ox = (a.w + b.w) / 2 + NODE_GAP_X - Math.abs(b.x - a.x)
        const oy = (a.h + b.h) / 2 + NODE_GAP_Y - Math.abs(b.y - a.y)
        if (ox > 0 && oy > 0 && Math.min(ox, oy) > 0.75) { visible = true; break }
      }
      if (visible) gridPack(nodes, W, H)
      for (const n of nodes) {
        n.x = Math.max(n.w / 2 + 14, Math.min(W - n.w / 2 - 14, n.x))
        n.y = Math.max(n.h / 2 + 12, Math.min(H - n.h / 2 - 12, n.y))
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
      const nameText = truncateText(n.label || n.name || '', MAXW - 12)
      const sumText = truncateText(n.detail || n.summary || '', MAXW - 12)
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

    // ---- logic re-root + depth slicing (client-side, instant) ----
    function recomputeLogicGraph(graph, rootId, depth) {
      if (!graph) return null
      const allNodes = graph.nodes || []
      const allEdges = graph.edges || []
      const layer = new Map()
      let frontier = []
      if (rootId) {
        if (allNodes.some((n) => n.id === rootId)) { layer.set(rootId, 0); frontier.push(rootId) }
      } else {
        for (const n of allNodes) {
          if (n.entry || n.type === 'start') { layer.set(n.id, 0); frontier.push(n.id) }
        }
        if (!frontier.length && allNodes.length) { layer.set(allNodes[0].id, 0); frontier.push(allNodes[0].id) }
      }
      while (frontier.length) {
        const next = []
        for (const id of frontier) {
          const l = layer.get(id)
          for (const e of allEdges) {
            if (e.from !== id || layer.has(e.to)) continue
            layer.set(e.to, l + 1)
            next.push(e.to)
          }
        }
        frontier = next
      }
      const d = Math.max(1, Math.min(20, parseInt(String(depth), 10) || 8))
      const nodes = allNodes
        .map((n) => Object.assign({}, n, { layer: layer.has(n.id) ? layer.get(n.id) : 999 }))
        .filter((n) => n.layer <= d)
      const ids = new Set(nodes.map((n) => n.id))
      const edges = allEdges.filter((e) => ids.has(e.from) && ids.has(e.to))
      return { nodes, edges }
    }

    function treeLayersOf(graph) {
      const by = new Map()
      for (const n of (graph && graph.nodes) || []) {
        const l = n.layer || 0
        const arr = by.get(l) || []
        arr.push(n)
        by.set(l, arr)
      }
      return Array.from(by.entries()).sort((a, b) => a[0] - b[0])
    }

    // ---------- main view ----------
    function CodeGraphView({ ctx }) {
      const [st, setSt] = React.useState(null)
      const [graph, setGraph] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [rootInput, setRootInput] = React.useState('')
      const [mode, setMode] = React.useState('call')
      const [rootId, setRootId] = React.useState(null)
      const [logicHistory, setLogicHistory] = React.useState([]) // 逻辑图点击历史（可逐层返回）
      const [depth, setDepth] = React.useState(8)
      const [search, setSearch] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [vb, setVb] = React.useState({ x: 0, y: 0, w: 900, h: 520 })
      const [fitTick, setFitTick] = React.useState(0)
      const [refreshTick, setRefreshTick] = React.useState(0)
      const [modelOpts, setModelOpts] = React.useState([])
      const [prov, setProv] = React.useState('')
      const [mdl, setMdl] = React.useState('')
      const [callErr, setCallErr] = React.useState('')
      const [logicLoading, setLogicLoading] = React.useState(false)
      const [logicForceTick, setLogicForceTick] = React.useState(0)
      const forceLogicRef = React.useRef(0)

      const safeCall = async (m, a) => {
        try { return await hostCall(m, a) } catch (e) {
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

      // graph fetch on rev / mode / manual refresh change (logic mode has no entry dropdown)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          if (mode === 'logic') setLogicLoading(true)
          try {
            const force = mode === 'logic' && logicForceTick !== forceLogicRef.current
            if (force) forceLogicRef.current = logicForceTick
            const args = { mode }
            if (force) args.force = true
            const g = await safeCall('get-graph', args)
            if (!alive) return
            if (g) setGraph(g)
            else setCallErr('get-graph 返回空')
            setFitTick((t) => t + 1)
          } finally {
            if (alive && mode === 'logic') setLogicLoading(false)
          }
        }
        load()
        return () => { alive = false }
      }, [mode, st ? st.graphRev : 0, refreshTick, logicForceTick])

      // 图谱或模式切换后，旧的点击历史/根节点可能失效，重置返回栈
      React.useEffect(() => {
        setRootId(null)
        setLogicHistory([])
      }, [graph, mode])

      // detail fetch
      React.useEffect(() => {
        if (mode === 'logic') return
        if (!selected) { setDetail(null); return }
        let alive = true
        safeCall('get-symbol', { id: selected }).then((r) => { if (alive && r) setDetail(r.detail) })
        return () => { alive = false }
      }, [selected, mode])

      // layout (state so nodes can be dragged; rebuilt on graph/mode change)
      const [layout, setLayout] = React.useState(null)

      React.useEffect(() => {
        if (!graph || !graph.nodes.length) { setLayout(null); return }
        if (mode === 'logic' && rootId && !graph.nodes.some((n) => n.id === rootId)) { setRootId(null); setLogicHistory([]) }
        const viewGraph = mode === 'logic' ? recomputeLogicGraph(graph, rootId, depth) : graph
        if (!viewGraph || !viewGraph.nodes.length) { setLayout(null); return }
        // measure boxes first so both the virtual space and the forces know real sizes
        const sized = viewGraph.nodes.map((n) => Object.assign({}, n, boxSize(n)))
        const { W, H } = layoutSize(mode, sized)
        const pos = mode === 'logic'
          ? layeredLayout(sized, viewGraph.edges, W, H)
          : forceLayout(sized, viewGraph.edges, W, H)
        const nodes = sized.map((n, i) => Object.assign({}, n, { x: pos[i].x, y: pos[i].y }))
        if (mode !== 'logic') resolveNodeCollisions(nodes, W, H)
        setLayout({ nodes, edges: viewGraph.edges })
        setVb(fitViewbox(nodes))
      }, [graph, mode, rootId, depth])

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
        if (e.button !== 0) return
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
        if (e.button !== 0) return
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

      const openFile = async (rel, line) => {
        if (!rel) return
        // 直接走 DSH 的“转至文件”通道（workspaces.openPath）
        const abs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(rel) ? rel : ((st && st.root ? st.root.replace(/[\\/]+$/, '') + '/' : '') + rel)
        if (line) {
          try {
            const r = await hostCall('open-file', { file: abs, line })
            if (r && r.ok) return
          } catch (err) { /* fall back to plain open */ }
        }
        const ws = ctx.get('workspaces')
        if (!ws) return
        ws.openPath(abs).catch(() => {})
      }

      const logicNodeClick = (n) => {
        if (!n) return
        if (rootId !== n.id) setLogicHistory((h) => h.concat([rootId]))
        setRootId(n.id)
        setSelected(n.id)
        setDetail({ logicNode: n })
      }
      const logicRootClick = (next) => {
        if (rootId !== next) setLogicHistory((h) => h.concat([rootId]))
        setRootId(next)
        setSelected(null)
        setDetail(null)
      }
      const logicBack = () => {
        if (!logicHistory.length) return
        const prev = logicHistory[logicHistory.length - 1]
        setLogicHistory(logicHistory.slice(0, -1))
        setRootId(prev)
        setSelected(null)
        setDetail(null)
      }

      const onModelChange = (np, nm) => {
        if (np) {
          setProv(np)
          const target = modelOpts.find((p) => p.provider === np)
          if (target && target.models.length) {
            const first = target.models[0]
            setMdl(first)
            hostCall('set-model', { provider: np, model: first })
          }
        } else if (nm) {
          setMdl(nm)
          hostCall('set-model', { provider: prov, model: nm })
        }
      }

      const usedModel = (st && (st.model || st.defaultModel)) || null

      // ---------- render ----------
      const els = []
      els.push(React.createElement('div', { className: 'llmg-toolbar', key: 'tb' },
        React.createElement('input', { type: 'text', value: rootInput, placeholder: '代码目录绝对路径', onChange: (e) => setRootInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { hostCall('set-root', { path: rootInput }); setFitTick(t => t + 1) } } }),
        React.createElement('button', { className: 'llmg-btn', onClick: () => { hostCall('set-root', { path: rootInput }); setRefreshTick((t) => t + 1) } }, '载入'),
        React.createElement('button', { className: 'llmg-btn', onClick: async () => {
          const ws = ctx.get('workspaces')
          if (!ws) return
          const p = await ws.pickDirectory()
          if (p) { setRootInput(p); hostCall('set-root', { path: p }); setRefreshTick((t) => t + 1) }
        } }, '浏览目录'),
        React.createElement('button', { className: 'llmg-btn primary', onClick: () => hostCall('analyze', { force: true }) }, st && st.analyzing ? '分析中…' : 'LLM 分析'),
        React.createElement('button', { className: 'llmg-btn' + (st && st.watch ? ' active' : ''), onClick: () => hostCall('set-watch', { watch: !(st && st.watch) }) }, '监听修改'),
        React.createElement('button', { className: 'llmg-tab' + (mode === 'call' ? ' on' : ''), onClick: () => { setMode('call'); setSelected(null); setDetail(null); setRootId(null); setLogicHistory([]) } }, '调用图'),
        React.createElement('button', { className: 'llmg-tab' + (mode === 'logic' ? ' on' : ''), onClick: () => { setMode('logic'); setSelected(null); setDetail(null); setRootId(null); setLogicHistory([]) } }, '逻辑图'),
        mode === 'logic' && React.createElement('span', { key: 'depth-wrap', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#9aa4b8' } },
          '深度',
          React.createElement('input', { key: 'depth', type: 'number', className: 'llmg-depth', min: 1, max: 20, value: depth, title: '逻辑图最多展示的层数', onChange: (e) => setDepth(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1))) })),
        mode === 'logic' && React.createElement('button', { className: 'llmg-btn', disabled: logicLoading, onClick: () => setLogicForceTick((t) => t + 1) }, logicLoading ? '生成中…' : '重新生成逻辑图'),
        React.createElement('input', { type: 'text', className: 'llmg-searchbox', placeholder: mode === 'logic' ? '搜索步骤/判断' : '搜索符号', value: search, onChange: (e) => setSearch(e.target.value) }),
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
          React.createElement('marker', { id: 'llmg-arrow-logic', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
            React.createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#4c9aff' })),
        ))
        canvasChildren.push(React.createElement('g', { key: 'edges' },
          layout.edges.map((e, i) => {
            const a = layout.nodes.find((n) => n.id === e.from)
            const b = layout.nodes.find((n) => n.id === e.to)
            if (!a || !b) return null
            const s = shrinkBox(a.x, a.y, b.x, b.y, a.w, a.h)
            const t = shrinkBox(b.x, b.y, a.x, a.y, b.w, b.h)
            const line = React.createElement('line', { key: 'l' + i, x1: s.x, y1: s.y, x2: t.x, y2: t.y, className: 'llmg-edge' + (mode === 'logic' ? ' logic' : ''), strokeWidth: mode === 'logic' ? 1.6 : 1, markerEnd: 'url(#llmg-arrow' + (mode === 'logic' ? '-logic' : '') + ')' })
            if (mode !== 'logic' || !e.label) return line
            return React.createElement('g', { key: 'e' + i },
              line,
              React.createElement('text', { className: 'llmg-edge-label', x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 - 4, textAnchor: 'middle' }, truncateText(e.label, 80)),
            )
          }),
        ))
        canvasChildren.push(React.createElement('g', { key: 'nodes' },
          layout.nodes.map((n) => {
            const labelText = n.label || n.name || ''
            const hit = q && labelText.toLowerCase().indexOf(q) >= 0
            const dim = q && !hit
            const isLogic = mode === 'logic'
            const color = isLogic ? (LOGIC_COLORS[n.type] || '#8a94a6') : (KIND_COLORS[n.kind] || '#8a94a6')
            const isEntry = n.entry
            const isSel = selected === n.id
            const isDecision = isLogic && n.type === 'decision'
            const rx = isLogic && (n.type === 'start' || n.type === 'end') ? 14 : 5
            const shape = isDecision
              ? React.createElement('polygon', { points: (n.x) + ',' + (n.y - n.h / 2) + ' ' + (n.x + n.w / 2) + ',' + n.y + ' ' + n.x + ',' + (n.y + n.h / 2) + ' ' + (n.x - n.w / 2) + ',' + n.y, fill: color, fillOpacity: 0.16, stroke: isSel ? '#fff' : (isEntry ? '#ff6b6b' : color), strokeWidth: isSel ? 2.5 : (isEntry ? 2 : 1.2) })
              : React.createElement('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: rx, fill: color, fillOpacity: 0.16, stroke: isSel ? '#fff' : (isEntry ? '#ff6b6b' : color), strokeWidth: isSel ? 2.5 : (isEntry ? 2 : 1.2) })
            return React.createElement('g', { key: n.id, opacity: dim ? 0.25 : 1, style: { cursor: 'pointer' },
              onMouseDown: (e) => onNodeDown(e, n),
              onClick: (e) => { e.stopPropagation(); if (mode === 'logic') logicNodeClick(n); else setSelected(n.id) },
              onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); openFile(mode === 'logic' ? n.file : n.rel, mode === 'logic' ? n.line : n.startLine) } },
              shape,
              React.createElement('text', { className: 'llmg-node-name', x: n.x, y: n.y - 4, textAnchor: 'middle' }, n.nameText),
              React.createElement('text', { className: 'llmg-node-sum', x: n.x, y: n.y + 13, textAnchor: 'middle' }, n.sumText),
            )
          }),
        ))
        canvasChildren.push(React.createElement('div', { className: 'llmg-legend', key: 'legend' },
          mode === 'logic'
            ? Object.keys(LOGIC_COLORS).map((k) => React.createElement('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                React.createElement('span', { style: { width: 8, height: 8, borderRadius: k === 'decision' ? 0 : 4, background: LOGIC_COLORS[k], display: 'inline-block' } }), LOGIC_LABEL[k]))
            : Object.keys(KIND_COLORS).map((k) => React.createElement('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: KIND_COLORS[k], display: 'inline-block' } }), KIND_LABEL[k]))),
        )
      } else {
        canvasChildren.push(React.createElement('div', { className: 'llmg-hint', key: 'hint' },
          (logicLoading && mode === 'logic') ? '逻辑图生成中…' : '输入目录并「载入」，然后点「LLM 分析」', st ? '（rev ' + st.graphRev + '，文件 ' + st.ok + '/' + st.total + '）' : ''))
      }
      const vbStr = vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h
      const wrapChildren = []
      if (mode === 'logic') {
        wrapChildren.push(React.createElement('button', {
          key: 'back', className: 'llmg-back', disabled: !logicHistory.length,
          title: '返回上次层级（可连续点击逐层返回）', onClick: logicBack,
        }, '← 返回上次层级'))
      }
      wrapChildren.push(React.createElement('svg', { viewBox: vbStr, preserveAspectRatio: 'xMidYMid meet', width: '100%', height: '100%' }, canvasChildren))
      body.push(React.createElement('div', { className: 'llmg-canvas-wrap', key: 'canvas',
        onWheel: onWheel, onMouseDown: onPanStart },
        wrapChildren,
      ))

      // 逻辑图右侧层级树：展示所有层；单击任意块可把它设为根层重新分叉
      if (mode === 'logic' && graph && graph.nodes.length) {
        const layers = treeLayersOf(graph)
        const treeItems = []
        treeItems.push(React.createElement('div', {
          key: '__auto__', className: 'llmg-tree-auto' + (rootId === null ? ' on' : ''),
          onClick: () => logicRootClick(null),
        }, '↺ 自动（主入口）'))
        layers.forEach(([l, arr]) => {
          treeItems.push(React.createElement('div', { key: 'l' + l, className: 'llmg-tree-layer' },
            '第 ' + (l + 1) + ' 层（' + arr.length + ' 个）'))
          arr.forEach((n) => {
            treeItems.push(React.createElement('div', {
              key: n.id,
              className: 'llmg-tree-item' + (rootId === n.id ? ' on' : ''),
              title: (n.detail || n.file || ''),
              onClick: () => logicNodeClick(n),
              onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); openFile(n.file, n.line) },
            },
              React.createElement('span', { className: 'dot', style: { background: LOGIC_COLORS[n.type] || '#8a94a6', borderRadius: n.type === 'decision' ? 0 : 4 } }),
              React.createElement('span', null, n.label || n.name || n.id),
              React.createElement('span', { className: 'dim' }, LOGIC_LABEL[n.type] || n.type),
            ))
          })
        })
        body.push(React.createElement('div', { className: 'llmg-tree', key: 'tree' },
          React.createElement('h4', null, '层级树（点击设为根层）'),
          treeItems,
        ))
      }

      if (detail) {
        const d = detail
        const rows = []
        if (d.logicNode) {
          const n = d.logicNode
          rows.push(React.createElement('div', { className: 'row', key: 'n' }, React.createElement('b', null, n.label || n.name),
            ' ', React.createElement('span', { className: 'dim' }, LOGIC_LABEL[n.type] || n.type)))
          rows.push(React.createElement('div', { className: 'row dim', key: 'f' }, n.file, n.line ? ' : ' + n.line : ''))
          if (n.detail) rows.push(React.createElement('div', { className: 'row', key: 'd' }, React.createElement('span', { className: 'dim' }, '说明: '), n.detail))
          if (n.file) rows.push(React.createElement('div', { className: 'row', key: 'b' },
            React.createElement('button', { className: 'llmg-btn', onClick: () => openFile(n.file, n.line) }, '转至源码')))
          body.push(React.createElement('div', { className: 'llmg-detail', key: 'detail' },
            React.createElement('h3', null, n.label || n.name),
            rows,
          ))
        } else {
          rows.push(React.createElement('div', { className: 'row', key: 'n' }, React.createElement('b', null, d.node.name),
            ' ', React.createElement('span', { className: 'dim' }, KIND_LABEL[d.node.kind] || d.node.kind)))
          rows.push(React.createElement('div', { className: 'row dim', key: 'f' },
            d.node.cls ? d.node.cls + '.' : '', d.node.rel, ' : ', d.node.startLine, '-', d.node.endLine))
          rows.push(React.createElement('div', { className: 'row', key: 'b' },
            React.createElement('button', { className: 'llmg-btn', onClick: () => openFile(d.node.rel, d.node.startLine) }, '转至源码'),
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
            rows.push(React.createElement('ul', { key: 'c3l' }, d.unresolved.map((c, i) => React.createElement('li', { key: i, onClick: () => openFile(d.node.rel, c.atLine) }, c.target, ' @ ', c.atLine))))
          }
          body.push(React.createElement('div', { className: 'llmg-detail', key: 'detail' },
            React.createElement('h3', null, d.node.cls ? d.node.cls + '.' + d.node.name : d.node.name),
            rows,
          ))
        }
      }

      const status = []
      if (st) {
        if (st.analyzing || st.queueLen > 0) status.push(React.createElement('span', { className: 'llmg-progress', key: 'p' },
          React.createElement('span', { className: 'llmg-spin' }), 'LLM 分析中 ' + st.ok + '/' + st.total))
        else status.push(React.createElement('span', { key: 'p' }, '已分析 ', st.ok, '/', st.total, ' 文件'))
        if (logicLoading && mode === 'logic') status.push(React.createElement('span', { key: 'll', style: { color: '#7ab3ff' } }, '逻辑图生成中…'))
        if (st.lastScanAt) status.push(React.createElement('span', { key: 't' }, '扫描于 ', new Date(st.lastScanAt).toLocaleTimeString()))
        if (st.cache && st.cache.loaded) status.push(React.createElement('span', { key: 'cache', style: { color: '#2fbfa3' } }, '缓存恢复 ', st.cache.restored, '/', st.cache.changed + st.cache.restored))
        if (st.cache && st.cache.savedAt) status.push(React.createElement('span', { key: 'cs', className: 'dim' }, '缓存写入于 ', new Date(st.cache.savedAt).toLocaleTimeString()))
        if (st.cache && st.cache.error) status.push(React.createElement('span', { key: 'cerr', className: 'err' }, '缓存: ', st.cache.error))
        if (mode === 'logic' && graph && graph.nodes.length) status.push(React.createElement('span', { key: 'dr', className: 'dim' }, rootId ? '以选中块为根 · 深' + depth : '主入口为根 · 深' + depth))
        if (usedModel) status.push(React.createElement('span', { key: 'm' }, '模型: ', usedModel.provider, '/', usedModel.model))
        if (graph) status.push(React.createElement('span', { key: 'g' }, '图: ', graph.nodes.length, ' 节点 / ', graph.edges.length, ' 边 rev', graph.rev))
        if (graph && graph.note) status.push(React.createElement('span', { key: 'gn', style: { color: '#7ab3ff' } }, graph.note))
        if (st.watch) status.push(React.createElement('span', { key: 'w', style: { color: '#7ab3ff' } }, '● 监听中'))
        if (st.lastError) status.push(React.createElement('span', { className: 'err', key: 'e' }, st.lastError))
        if (callErr) status.push(React.createElement('span', { className: 'err', key: 'ce' }, 'RPC: ', callErr))
        if (st.log && st.log.length) status.push(React.createElement('span', { key: 'l', style: { flex: 1, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st.log[st.log.length - 1]))
      }
      els.push(React.createElement('div', { className: 'llmg-body' + (mode === 'logic' ? ' logic' : ''), key: 'body' }, body))
      els.push(React.createElement('div', { className: 'llmg-status', key: 'st' }, status))

      return React.createElement('div', { className: 'llmg-root' }, els)
    }

    function apply(ctx) {
      installStyles()
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'codegraph', order: 20, label: () => '代码图谱' },
        () => React.createElement(CodeGraphView, { ctx }),
      ))
    }

    exports.inject = ['slots', 'timer', 'workspaces']
    exports.apply = apply

    return module.exports
  },
})
