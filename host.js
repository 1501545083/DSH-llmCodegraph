return {
  inject: ['timer', 'llm'],
  apply(ctx) {
    const fs = ctx.get('fs')
    if (fs === undefined) return
    const { timeout, interval } = ctx.timer

    // ================= state =================
    const S = {
      root: null,            // absolute path string (displayPath)
      watch: false,
      model: null,           // {provider, model}
      analyzing: false,
      queue: [],             // [{rel}]
      filesByRel: new Map(), // rel -> {rel, target, version, size, lines}
      fileState: new Map(),  // rel -> {status:'idle'|'queued'|'ok'|'error', error?, lines, analyzedAt}
      symbols: new Map(),    // id -> sym
      byName: new Map(),     // lower(name) -> sym[]
      edges: [],             // resolved edges {from, to, atFile, atLine}
      graphRev: 0,
      lastScanAt: 0,
      lastError: null,
      log: [],
    }
    let seq = 0
    let pumping = false

    function log(msg) {
      S.log.push(new Date().toLocaleTimeString() + ' ' + msg)
      if (S.log.length > 60) S.log.splice(0, S.log.length - 60)
    }
    const int = (v) => {
      const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10)
      return Number.isFinite(n) ? n : 0
    }
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

    // ================= file collection =================
    const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '.cache', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.dsh', '.tmp', 'temp', 'logs', '.tox', '.pytest_cache', '.mypy_cache', '.gradle', 'bin', 'obj', '.terraform'])
    const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.java', '.cs', '.kt', '.kts', '.swift', '.php', '.lua', '.vue', '.svelte', '.sql', '.sh', '.ps1', '.zig', '.scala', '.dart', '.ex', '.exs', '.erl', '.hs', '.ml', '.clj', '.fs', '.tsv', '.purs'])
    const isCodeExt = (rel) => {
      const i = rel.lastIndexOf('.')
      return i >= 0 && CODE_EXT.has(rel.slice(i).toLowerCase())
    }

    function relOf(target, rootPath) {
      let p = target.displayPath || target.path || ''
      p = p.replace(/[\\/]+$/, '')
      const r = rootPath.replace(/[\\/]+$/, '')
      if (p === r) return ''
      if (p.startsWith(r + '\\') || p.startsWith(r + '/')) return p.slice(r.length + 1)
      return p.split(/[\\/]/).slice(-1)[0]
    }

    async function collectFiles() {
      S.filesByRel.clear()
      if (!S.root) return []
      const rootTarget = await fs.resolve(S.root)
      const rootInfo = await fs.stat(rootTarget)
      if (!rootInfo || rootInfo.type !== 'directory') throw new Error('not a directory: ' + S.root)
      const rootPath = rootTarget.displayPath || S.root
      const dirQueue = [rootTarget]
      const out = []
      let active = 0
      const worker = async () => {
        for (;;) {
          if (dirQueue.length === 0) {
            if (active <= 1) return
            await timeout(5)
            continue
          }
          const dir = dirQueue.shift()
          active++
          try {
            const entries = await fs.listDir(dir)
            for (const e of entries) {
              if (e.type === 'directory') {
                if (IGNORE_DIRS.has(e.name)) continue
                dirQueue.push(e.target)
              } else {
                const rel = relOf(e.target, rootPath)
                if (!rel || !isCodeExt(rel)) continue
                try {
                  const info = await fs.stat(e.target)
                  if (!info || !info.size) continue
                  out.push({ rel, target: e.target, version: info.version, size: info.size, lines: 0 })
                } catch (err) { /* skip unreadable */ }
              }
            }
          } catch (err) { /* skip unreadable dir */ }
          active--
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
      out.sort((a, b) => a.rel.localeCompare(b.rel))
      for (const f of out) S.filesByRel.set(f.rel, f)
      S.lastScanAt = Date.now()
      return out
    }

    function enqueue(rel, force) {
      const st = S.fileState.get(rel)
      if (force || !st || st.status !== 'ok') {
        if (st) st.status = 'queued'
        else S.fileState.set(rel, { status: 'queued', lines: 0 })
        if (!S.queue.some((q) => q.rel === rel)) S.queue.push({ rel })
      }
    }

    // ================= LLM =================
    const SYSTEM_PROMPT = 'You are a precise code-analysis engine. You read source code and always answer with exactly one valid JSON object. No markdown fences, no commentary.'

    const RULES = [
      'Analyze the source code file below and return a JSON report of its symbols and the calls between them.',
      'RULES:',
      '1. Every line of code is prefixed with its 1-based line number and a pipe ("N|"). Report ALL line numbers exactly as written in those prefixes.',
      '2. List EVERY function, method, constructor, and class. Also list const arrow functions that contain real logic (not trivial callbacks) with kind "const".',
      '3. startLine = line where the definition begins; endLine = line of its closing brace (or the definition\'s last line).',
      '4. For classes: list the class as a symbol AND each method as a separate symbol (kind "method", name = method name only, "class" field = enclosing class name). Constructors have kind "constructor".',
      '5. "calls": calls made BY this symbol TO OTHER project symbols (defined in this file or plausibly defined in another file of the same project/package). Each call: target = exact callee name, line = line of the call, receiver = the object expression before "." (e.g. "this", "self", "paymentService") or null when there is no receiver.',
      '6. Do NOT list calls to standard-library or framework functions (console.log, print, len, range, str, fmt.Println, JSON.stringify, ...) unless that callee is a project symbol.',
      '7. When a call receiver is an object variable, prefer the qualified target form "ClassName.methodName" so it can be resolved.',
      '8. kind must be one of: "function" | "method" | "class" | "constructor" | "const" | "module".',
      '9. sig: the signature exactly as written, e.g. "createOrder(userId, items)".',
      '10. summary: one short Chinese sentence describing what it does.',
      '11. If the file is not code (data/config/documentation), return {"summary": "...", "symbols": []}.',
      'RETURN ONLY the JSON object in this shape:',
      '{"summary": "one-line file purpose", "symbols": [{"name": "...", "kind": "...", "class": "optional", "startLine": N, "endLine": N, "sig": "...", "summary": "...", "calls": [{"target": "...", "line": N, "receiver": "..."}]}]}',
    ].join('\n')
    const RETRY_PROMPT = 'Your previous answer was not valid JSON. Return ONLY the JSON object itself — no markdown fences, no commentary, nothing else.'

    async function pickModel() {
      if (S.model) return S.model
      const adm = ctx.get('agentDefaultModel')
      if (adm) {
        try {
          const sel = adm.currentSelection()
          if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
        } catch (err) { /* fall through */ }
      }
      const provs = ctx.llm.listProviders()
      for (const p of provs) {
        try {
          const ms = await ctx.llm.listModels(p.id)
          if (ms.length) return { provider: p.id, model: ms[0].id }
        } catch (err) { /* next */ }
      }
      throw new Error('no LLM provider/model available')
    }

    async function llmText(sel, system, user) {
      const stream = ctx.llm.stream({
        provider: sel.provider,
        model: sel.model,
        system: system,
        messages: [{
          id: 'm' + (++seq) + '-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: user }],
          source: { kind: 'user' },
        }],
        temperature: 0,
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text
        else if (chunk.type === 'error') throw new Error(chunk.failure.message)
        else if (chunk.type === 'aborted') throw new Error(chunk.failure.message || 'aborted')
      }
      return out
    }

    function extractJson(text) {
      if (!text) return null
      let t = String(text).replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '')
      const a = t.indexOf('{')
      const b = t.lastIndexOf('}')
      if (a < 0 || b <= a) return null
      const body = t.slice(a, b + 1)
      try { return JSON.parse(body) } catch (e) {
        try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')) } catch (e2) { return null }
      }
    }

    async function llmJson(prompt) {
      const sel = await pickModel()
      let text = await llmText(sel, SYSTEM_PROMPT, prompt)
      let obj = extractJson(text)
      if (obj !== null) return obj
      text = await llmText(sel, SYSTEM_PROMPT, prompt + '\n\n' + RETRY_PROMPT)
      obj = extractJson(text)
      if (obj === null) throw new Error('LLM returned no valid JSON')
      return obj
    }

    // ================= analysis =================
    const CHUNK = 500
    const OVERLAP = 50
    const MAX_FILE_BYTES = 400 * 1024

    function normalizeSymbol(o, rel, lineCount) {
      const name = String(o && o.name || '').trim()
      if (!name) return null
      const kinds = new Set(['function', 'method', 'class', 'constructor', 'const', 'module'])
      let kind = String(o.kind || 'function').toLowerCase()
      if (!kinds.has(kind)) kind = 'function'
      const cls = o.class ? String(o.class).trim() : null
      let startLine = clamp(int(o.startLine) || 1, 1, lineCount)
      let endLine = clamp(int(o.endLine) || startLine, startLine, lineCount)
      if (endLine < startLine) endLine = startLine
      const calls = Array.isArray(o.calls) ? o.calls.map((c) => ({
        target: String(c && c.target || '').trim(),
        line: int(c && c.line) || null,
        receiver: c && c.receiver != null ? String(c.receiver) : null,
      })).filter((c) => c.target) : []
      return {
        id: rel + '::' + (cls ? cls + '.' : '') + name,
        name, cls, kind, rel,
        startLine, endLine,
        sig: String(o.sig || name).trim() || name,
        summary: String(o.summary || '').trim(),
        calls,
      }
    }

    async function analyzeFile(f, text) {
      const allLines = text.split('\n')
      const lineCount = allLines.length
      const chunks = []
      if (lineCount <= CHUNK) chunks.push({ start: 1, lines: allLines })
      else {
        let s = 0
        while (s < lineCount) {
          const e = Math.min(lineCount, s + CHUNK)
          chunks.push({ start: s + 1, lines: allLines.slice(s, e) })
          if (e >= lineCount) break
          s = e - OVERLAP
        }
      }
      const byKey = new Map()
      let summary = ''
      for (const chunk of chunks) {
        const numbered = chunk.lines.map((l, i) => (chunk.start + i) + '|' + l).join('\n')
        const prompt = RULES + '\n\nFILE: ' + f.rel + '\n\nFILE CONTENT:\n' + numbered
        const obj = await llmJson(prompt)
        if (!obj || typeof obj !== 'object') continue
        if (typeof obj.summary === 'string' && obj.summary) summary = obj.summary
        const arr = Array.isArray(obj.symbols) ? obj.symbols : []
        for (const s of arr) {
          const sym = normalizeSymbol(s, f.rel, lineCount)
          if (!sym) continue
          const key = sym.name + (sym.cls ? '@' + sym.cls : '')
          const prev = byKey.get(key)
          if (!prev) byKey.set(key, sym)
          else {
            prev.endLine = Math.max(prev.endLine, sym.endLine)
            prev.calls = prev.calls.concat(sym.calls)
            if (sym.summary && !prev.summary) prev.summary = sym.summary
          }
        }
      }
      return { symbols: Array.from(byKey.values()), summary }
    }

    async function analyzeOne(f) {
      S.analyzing = true
      const st = S.fileState.get(f.rel) || { status: 'queued', lines: 0 }
      S.fileState.set(f.rel, st)
      try {
        log('LLM 分析 ' + f.rel + ' ...')
        const text = await fs.readText(f.target)
        if (text.length > MAX_FILE_BYTES) throw new Error('file too large (' + Math.round(text.length / 1024) + 'KB)')
        const result = await analyzeFile(f, text)
        // remove old symbols of this rel
        for (const sym of Array.from(S.symbols.values())) {
          if (sym.rel === f.rel) S.symbols.delete(sym.id)
        }
        for (const sym of result.symbols) S.symbols.set(sym.id, sym)
        // rebuild byName entries for this rel
        for (const key of Array.from(S.byName.keys())) {
          const arr = S.byName.get(key).filter((s) => s.rel !== f.rel)
          if (arr.length) S.byName.set(key, arr)
          else S.byName.delete(key)
        }
        for (const sym of result.symbols) {
          const key = sym.name.toLowerCase()
          const arr = S.byName.get(key) || []
          arr.push(sym)
          S.byName.set(key, arr)
        }
        st.status = 'ok'
        st.lines = result.symbols.length
        st.error = null
        st.version = f.version
        st.analyzedAt = Date.now()
        log('✓ ' + f.rel + ' → ' + result.symbols.length + ' 符号')
      } catch (err) {
        st.status = 'error'
        st.error = String(err && err.message || err)
        S.lastError = f.rel + ': ' + st.error
        log('✗ ' + f.rel + ' → ' + st.error)
      } finally {
        S.analyzing = false
        rebuildGraph()
      }
    }

    async function pumpLoop() {
      if (pumping) return
      pumping = true
      try {
        while (S.queue.length) {
          const item = S.queue.shift()
          const f = S.filesByRel.get(item.rel)
          if (!f) continue
          const st = S.fileState.get(f.rel)
          if (st) st.status = 'queued'
          await analyzeOne(f)
        }
      } finally {
        pumping = false
      }
    }

    function rebuildGraph() {
      const edges = []
      for (const sym of S.symbols.values()) {
        for (const c of sym.calls) {
          const resolved = resolveCallee(sym, c)
          if (resolved) edges.push({ from: sym.id, to: resolved.id, atFile: sym.rel, atLine: c.line })
        }
      }
      S.edges = edges
      const deg = new Map()
      for (const e of edges) {
        deg.set(e.from, (deg.get(e.from) || 0) + 1)
        deg.set(e.to, (deg.get(e.to) || 0) - 1)
      }
      for (const sym of S.symbols.values()) {
        const d = deg.get(sym.id) || 0
        sym.degOut = d > 0 ? d : 0
        sym.degIn = d < 0 ? -d : 0
      }
      S.graphRev++
    }

    function resolveCallee(sym, c) {
      const name = c.target
      const lower = name.toLowerCase()
      let cands = []
      const dot = name.lastIndexOf('.')
      if (dot > 0) {
        const cls = name.slice(0, dot)
        const meth = name.slice(dot + 1)
        cands = (S.byName.get(meth.toLowerCase()) || []).filter((s) => s.cls === cls)
        if (!cands.length) cands = (S.byName.get(meth.toLowerCase()) || []).filter((s) => s.name === meth)
      }
      if (!cands.length) cands = S.byName.get(lower) || []
      if (!cands.length) return null
      const sameFile = cands.filter((s) => s.rel === sym.rel)
      if (sameFile.length === 1) return sameFile[0]
      if (sameFile.length > 1) return sameFile[0]
      if (cands.length === 1) return cands[0]
      // prefer symbol whose class matches receiver
      if (c.receiver && cands.some((s) => s.cls === c.receiver)) return cands.find((s) => s.cls === c.receiver)
      return cands[0]
    }

    // ================= payload builders =================
    function nodeJson(sym) {
      return {
        id: sym.id,
        name: sym.name,
        cls: sym.cls,
        kind: sym.kind,
        rel: sym.rel,
        startLine: sym.startLine,
        endLine: sym.endLine,
        sig: sym.sig,
        summary: sym.summary,
        degIn: sym.degIn || 0,
        degOut: sym.degOut || 0,
      }
    }

    function entries() {
      const arr = []
      for (const sym of S.symbols.values()) {
        if ((sym.degIn || 0) === 0 && (sym.degOut || 0) > 0) {
          arr.push({ id: sym.id, name: sym.name, cls: sym.cls, rel: sym.rel, startLine: sym.startLine, summary: sym.summary })
        }
      }
      arr.sort((a, b) => {
        const isMainA = /main|bootstrap|start|run|handle|listen|init|serve/i.test(a.name) ? 0 : 1
        const isMainB = /main|bootstrap|start|run|handle|listen|init|serve/i.test(b.name) ? 0 : 1
        if (isMainA !== isMainB) return isMainA - isMainB
        return a.rel.localeCompare(b.rel) || a.startLine - b.startLine
      })
      return arr
    }

    // BFS from one or more entry ids; dedupes edges; assigns each node its nearest-entry layer
    function buildBusinessFlow(entryIds, byId) {
      const reached = new Map() // id -> layer
      const edgeList = []
      const seenEdge = new Set()
      let frontier = []
      for (const id of entryIds) {
        if (!reached.has(id)) {
          reached.set(id, 0)
          frontier.push(id)
        }
      }
      while (frontier.length) {
        const next = []
        for (const id of frontier) {
          const sym = byId.get(id)
          if (!sym) continue
          for (const e of S.edges) {
            if (e.from !== id) continue
            const k = e.from + '\u0000' + e.to
            if (!seenEdge.has(k)) {
              seenEdge.add(k)
              edgeList.push(e)
            }
            if (!reached.has(e.to)) {
              reached.set(e.to, reached.get(id) + 1)
              next.push(e.to)
            }
          }
        }
        frontier = next
      }
      return { reached, edges: edgeList }
    }

    function buildGraphPayload(mode, entryId) {
      if (mode === 'business') {
        const all = entries()
        const byId = new Map()
        for (const s of S.symbols.values()) byId.set(s.id, s)
        const entrySet = new Set(all.map((x) => x.id))
        let reached = null
        let edgeList = []
        let target = null
        let note = null
        if (entryId) {
          // single entry flow
          if (!byId.has(entryId)) return { rev: S.graphRev, mode, root: S.root, nodes: [], edges: [], entries: all, target: null, note: 'entry not found' }
          const r = buildBusinessFlow([entryId], byId)
          reached = r.reached
          edgeList = r.edges
          target = entryId
        } else if (all.length) {
          // merged: ALL business flows in one graph
          const r = buildBusinessFlow(all.map((x) => x.id), byId)
          reached = r.reached
          edgeList = r.edges
          note = '合并展示 ' + all.length + ' 个业务入口（下拉可单选）'
        } else {
          return { rev: S.graphRev, mode, root: S.root, nodes: [], edges: [], entries: all, target: null, note: 'no entry points' }
        }
        const nodes = []
        for (const [id, layer] of reached) {
          const s = byId.get(id)
          if (!s) continue
          nodes.push(Object.assign(nodeJson(s), { layer, entry: entrySet.has(id) }))
        }
        const edges = edgeList.map((e) => ({ from: e.from, to: e.to, atFile: e.atFile, atLine: e.atLine }))
        return { rev: S.graphRev, mode, root: S.root, nodes, edges, entries: all, target, note }
      }
      // call mode
      const nodes = []
      for (const s of S.symbols.values()) nodes.push(nodeJson(s))
      const edges = S.edges.map((e) => ({ from: e.from, to: e.to, atFile: e.atFile, atLine: e.atLine }))
      return { rev: S.graphRev, mode, root: S.root, nodes, edges, entries: entries(), target: null, note: null }
    }

    function symbolDetail(id) {
      const sym = S.symbols.get(id)
      if (!sym) return null
      const callers = []
      for (const e of S.edges) if (e.to === id) {
        const s = S.symbols.get(e.from)
        if (s) callers.push({ id: s.id, name: s.name, cls: s.cls, rel: s.rel, atLine: e.atLine })
      }
      const callees = []
      const unresolved = []
      for (const c of sym.calls) {
        const r = resolveCallee(sym, c)
        if (r) callees.push({ id: r.id, name: r.name, cls: r.cls, rel: r.rel, atLine: c.line })
        else unresolved.push({ target: c.target, atLine: c.line })
      }
      return { node: nodeJson(sym), callers, callees, unresolved }
    }

    // ================= RPC =================
    harness.handle('get-state', async () => {
      const ok = Array.from(S.fileState.values()).filter((s) => s.status === 'ok').length
      const fail = Array.from(S.fileState.values()).filter((s) => s.status === 'error').length
      let defaultModel = null
      try { defaultModel = await pickModel() } catch (err) { /* keep null */ }
      return {
        root: S.root, watch: S.watch, model: S.model, defaultModel, analyzing: S.analyzing,
        queueLen: S.queue.length, total: S.filesByRel.size, ok, fail,
        graphRev: S.graphRev, lastScanAt: S.lastScanAt, lastError: S.lastError,
        log: S.log.slice(-12),
      }
    })

    harness.handle('set-root', async (args) => {
      try {
        const p = String(args && args.path || '').trim()
        if (!p) return { ok: false, error: 'empty path' }
        const t = await fs.resolve(p)
        const info = await fs.stat(t)
        if (!info || info.type !== 'directory') return { ok: false, error: 'not a directory: ' + p }
        S.root = t.displayPath || p
        S.filesByRel.clear()
        S.fileState.clear()
        S.queue = []
        S.symbols.clear()
        S.byName.clear()
        S.edges = []
        S.lastError = null
        await collectFiles()
        for (const f of S.filesByRel.values()) {
          S.fileState.set(f.rel, { status: 'idle', version: f.version, lines: 0 })
        }
        rebuildGraph()
        log('root = ' + S.root + ' (' + S.filesByRel.size + ' 个代码文件)')
        if (S.watch) for (const f of S.filesByRel.values()) enqueue(f.rel, false)
        return { ok: true, root: S.root, files: S.filesByRel.size }
      } catch (err) {
        S.lastError = String(err && err.message || err)
        return { ok: false, error: S.lastError }
      }
    })

    harness.handle('set-watch', async (args) => {
      S.watch = !!(args && args.watch)
      log(S.watch ? '已开启监听' : '已关闭监听')
      return { ok: true, watch: S.watch }
    })

    harness.handle('analyze', async (args) => {
      if (!S.root) return { ok: false, error: 'no root set' }
      const force = !!(args && args.force)
      const list = Array.from(S.filesByRel.values())
      for (const f of list) enqueue(f.rel, force)
      log('入队 ' + S.queue.length + ' 个文件' + (force ? ' (强制全量)' : ''))
      pumpLoop()
      return { ok: true, queued: S.queue.length }
    })

    harness.handle('set-model', async (args) => {
      const provider = String(args && args.provider || '').trim()
      const model = String(args && args.model || '').trim()
      if (!provider || !model) return { ok: false, error: 'provider and model required' }
      S.model = { provider, model }
      log('model = ' + provider + ' / ' + model)
      return { ok: true, model: S.model }
    })

    harness.handle('get-graph', async (args) => {
      const mode = args && args.mode === 'business' ? 'business' : 'call'
      const entry = args && args.entry ? String(args.entry) : null
      return buildGraphPayload(mode, entry)
    })

    harness.handle('get-symbol', async (args) => {
      const id = String(args && args.id || '')
      return { detail: symbolDetail(id) }
    })

    harness.handle('get-model-options', async () => {
      const provs = ctx.llm.listProviders()
      const out = []
      for (const p of provs) {
        try {
          const ms = await ctx.llm.listModels(p.id)
          out.push({ provider: p.id, name: p.name, models: ms.map((m) => m.id) })
        } catch (err) { /* skip */ }
      }
      return { options: out }
    })

    harness.handle('query', async (args) => {
      try {
        const question = String(args && args.question || '').trim()
        if (!question) return { ok: false, error: 'empty question' }
        const sel = await pickModel()
        const text = await llmText(sel,
          'You are a code comprehension assistant. Answer questions about a codebase using its knowledge graph. Answer in Chinese, concise, with file:line references.',
          'Knowledge graph of the analyzed codebase (name @ file:start-end; edge: caller -> callee @ line):\n' + compactGraphText() + '\n\nQUESTION: ' + question)
        return { ok: true, answer: text }
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) }
      }
    })

    function compactGraphText() {
      const lines = []
      for (const s of S.symbols.values()) {
        lines.push(s.name + (s.cls ? ' (class ' + s.cls + ')' : '') + ' @ ' + s.rel + ':' + s.startLine + '-' + s.endLine + (s.summary ? ' — ' + s.summary : ''))
      }
      for (const e of S.edges) {
        const from = S.symbols.get(e.from)
        const to = S.symbols.get(e.to)
        if (!from || !to) continue
        lines.push(from.name + ' -> ' + to.name + ' @ ' + e.atFile + ':' + (e.atLine || '?'))
      }
      let t = lines.join('\n')
      if (t.length > 12000) t = t.slice(0, 12000) + '\n...'
      return t
    }

    // ================= tools =================
    const qTool = harness.defineTool({
      name: 'codegraph_query',
      description: '对已用 LLM 分析过的代码知识图谱提问（每个符号绑定 文件+精确行号，含调用关系边）。回答基于图谱中已分析的符号，若要未分析文件的细节需先触发分析。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '关于代码库结构、调用链、业务路径的自然语言问题' },
        },
        required: ['question'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answer: { type: 'string', required: true },
            symbols: { type: 'number' },
            edges: { type: 'number' },
            root: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: value.answer + '\n（图谱: ' + value.symbols + ' 符号 / ' + value.edges + ' 边）' }],
      },
      execute: async (args) => {
        const question = String(args && args.question || '').trim()
        if (!question) return { answer: 'question 不能为空', symbols: S.symbols.size, edges: S.edges.length, root: S.root || '' }
        try {
          const sel = await pickModel()
          const text = await llmText(sel,
            'You are a code comprehension assistant. Answer questions about a codebase using its knowledge graph. Answer in Chinese, concise, with file:line references.',
            'Knowledge graph of the analyzed codebase (name @ file:start-end; edge: caller -> callee @ line):\n' + compactGraphText() + '\n\nQUESTION: ' + question)
          return { answer: text, symbols: S.symbols.size, edges: S.edges.length, root: S.root || '' }
        } catch (err) {
          return { answer: '查询失败: ' + String(err && err.message || err), symbols: S.symbols.size, edges: S.edges.length, root: S.root || '' }
        }
      },
    })
    harness.registerTool(ctx, qTool)

    const aTool = harness.defineTool({
      name: 'codegraph_analyze',
      description: '让插件用 LLM 分析代码目录（path 可选：先设置目录；force=true 强制全量重分析）。分析异步进行，可随后用 codegraph_dump 查看结果、codegraph_query 提问。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选：代码目录绝对路径；提供时先切换目录' },
          force: { type: 'boolean', description: 'true 时强制重新分析所有文件（默认 false：只分析未成功的）' },
          watch: { type: 'boolean', description: 'true 时开启文件修改监听（自动重分析变更文件），false 关闭' },
          provider: { type: 'string', description: '可选：指定分析用的 LLM provider（需同时给 model），不传则用当前默认模型' },
          model: { type: 'string', description: '可选：指定分析用的模型 id（需同时给 provider），不传则用当前默认模型' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            queued: { type: 'number', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const p = String(args && args.path || '').trim()
        if (p) {
          try {
            const t = await fs.resolve(p)
            const info = await fs.stat(t)
            if (!info || info.type !== 'directory') return { ok: false, queued: 0, message: '路径不是目录: ' + p }
            S.root = t.displayPath || p
            S.filesByRel.clear()
            S.fileState.clear()
            S.queue = []
            S.symbols.clear()
            S.byName.clear()
            S.edges = []
            S.lastError = null
            await collectFiles()
            for (const f of S.filesByRel.values()) {
              S.fileState.set(f.rel, { status: 'idle', version: f.version, lines: 0 })
            }
            rebuildGraph()
            log('root = ' + S.root + ' (' + S.filesByRel.size + ' 个代码文件)')
          } catch (err) {
            return { ok: false, queued: 0, message: '设置目录失败: ' + String(err && err.message || err) }
          }
        }
        if (!S.root) return { ok: false, queued: 0, message: '尚未设置代码目录（用 path 参数指定，或在图谱界面输入目录并载入）' }
        if (args && typeof args.watch === 'boolean') {
          S.watch = args.watch
          log(S.watch ? '已开启监听' : '已关闭监听')
        }
        const pv = String(args && args.provider || '').trim()
        const md = String(args && args.model || '').trim()
        if (pv || md) {
          if (!pv || !md) return { ok: false, queued: 0, message: 'provider 和 model 需同时提供' }
          S.model = { provider: pv, model: md }
          log('model = ' + pv + ' / ' + md)
        }
        const force = !!(args && args.force)
        for (const f of S.filesByRel.values()) enqueue(f.rel, force)
        pumpLoop()
        return { ok: true, queued: S.queue.length, message: '已入队 ' + S.queue.length + ' 个文件，LLM 分析进行中' }
      },
    })
    harness.registerTool(ctx, aTool)

    const dTool = harness.defineTool({
      name: 'codegraph_dump',
      description: '导出当前 LLM 分析的知识图谱原始数据（符号列表含 文件+精确行号，调用边列表），用于检查分析质量。',
      parameters: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean', description: 'true 时输出完整 JSON 文本（符号+边+状态），用于精确核对' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            root: { type: 'string' },
            status: { type: 'json' },
            symbols: { type: 'array', items: { type: 'json' } },
            edges: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (args, value) => {
          if (args && args.verbose) {
            return [{ type: 'text', text: JSON.stringify({ root: value.root, status: value.status, symbols: value.symbols, edges: value.edges }, null, 1) }]
          }
          return [{ type: 'text', text: (value.ok ? '已分析 ' + value.status.ok + '/' + value.status.total + ' 文件，导出 ' + value.symbols.length + ' 符号 / ' + value.edges.length + ' 边' + (value.message ? '\n' + value.message : '') : value.message) }]
        },
      },
      execute: async () => {
        const syms = []
        for (const s of S.symbols.values()) {
          syms.push({ name: s.name, cls: s.cls, kind: s.kind, rel: s.rel, startLine: s.startLine, endLine: s.endLine, sig: s.sig, summary: s.summary, degIn: s.degIn || 0, degOut: s.degOut || 0 })
        }
        syms.sort((a, b) => a.rel.localeCompare(b.rel) || a.startLine - b.startLine)
        const es = S.edges.map((e) => ({ from: e.from, to: e.to, atFile: e.atFile, atLine: e.atLine }))
        const status = {
          ok: Array.from(S.fileState.values()).filter((s) => s.status === 'ok').length,
          total: S.filesByRel.size,
          analyzing: S.analyzing,
          queueLen: S.queue.length,
          watch: S.watch,
          root: S.root,
          lastError: S.lastError,
        }
        let msg = null
        if (syms.length > 300) { msg = '符号数超过 300 已截断'; syms.length = 300 }
        if (es.length > 500) { msg = (msg ? msg + '；' : '') + '边数超过 500 已截断'; es.length = 500 }
        return { ok: true, message: msg || '', root: S.root || '', status, symbols: syms, edges: es }
      },
    })
    harness.registerTool(ctx, dTool)

    // ================= watch poll =================
    ctx.effect(() => interval(async () => {
      if (!S.watch || !S.root) return
      try {
        const files = await collectFiles()
        const seen = new Set()
        for (const f of files) {
          seen.add(f.rel)
          const st = S.fileState.get(f.rel)
          if (!st) {
            // brand-new file: register and enqueue once
            S.fileState.set(f.rel, { status: 'idle', version: f.version, lines: 0 })
            enqueue(f.rel, false)
          } else if (st.status === 'ok' && st.version !== f.version) {
            // changed file: re-analyze (in-place status mutation, entry kept)
            enqueue(f.rel, true)
            log('文件已修改: ' + f.rel)
          }
        }
        // removed files
        let removedAny = false
        for (const rel of Array.from(S.fileState.keys())) {
          if (!seen.has(rel)) {
            S.fileState.delete(rel)
            for (const sym of Array.from(S.symbols.values())) {
              if (sym.rel === rel) S.symbols.delete(sym.id)
            }
            for (const key of Array.from(S.byName.keys())) {
              const arr = S.byName.get(key).filter((s) => s.rel !== rel)
              if (arr.length) S.byName.set(key, arr)
              else S.byName.delete(key)
            }
            removedAny = true
            log('文件已删除: ' + rel)
          }
        }
        if (removedAny) rebuildGraph()
        pumpLoop()
      } catch (err) {
        S.lastError = 'watch: ' + String(err && err.message || err)
      }
    }, 3000))
  },
}
