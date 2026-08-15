/**
 * @local/dsh-llm-codegraph — LLM 代码知识图谱（静态插件版）host 半。
 *
 * 由 DSH-llmCodegraph 仓库的 host.js（动态插件版）迁移而来：
 * - harness.defineTool / harness.registerTool → '@deepseek-ai/dsh-tools' 的
 *   defineTool + ctx.tools.register（模型工具 codegraph_query/analyze/dump）；
 * - harness.handle RPC → ctx.webServer 前缀路由 /llmg/api，方法名与动态版一致
 *   （get-state / set-root / set-watch / analyze / set-model / get-graph /
 *   get-symbol / get-model-options / query），client 半经 fetch POST 调用；
 * - 其余（目录扫描、LLM 分块分析、符号/调用边解析、逻辑图生成、3s 监听轮询）
 *   与动态版完全一致。
 *
 * 该能力横跨所有会话（工具注册在全局 tools 层、RPC 路由在 host 平面），
 * 因此属于 host 组合，而非某个 agent preset。
 * @module @local/dsh-llm-codegraph
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '@local/dsh-llm-codegraph'

export const inject = ['timer', 'llm', 'fs', 'tools', 'webServer', 'subprocess']

const MAX_BODY_BYTES = 1024 * 1024

/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res, error) {
  const code = error && error.code ? String(error.code) : 'internal'
  const status = code === 'bad-request' ? 400 : code === 'not-found' ? 404 : code === 'forbidden' ? 403 : 500
  const message = String(error && error.message || error || 'internal error')
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      const err = new Error('request body too large')
      err.code = 'bad-request'
      throw err
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('request body is not valid JSON')
    err.code = 'bad-request'
    throw err
  }
}

export async function apply(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const subprocess = ctx.get('subprocess') // optional: line-aware editor open
  const timeout = (...args) => ctx.timer.timeout(...args)
  const interval = (...args) => ctx.timer.interval(...args)

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
    cache: { path: null, loaded: false, restored: 0, changed: 0, savedAt: 0, error: null },
    logicCache: new Map(), // rootsKey -> {rev, nodes, edges, note, generatedAt}
    logicPromises: new Map(), // rootsKey -> Promise<payload>
    entryCache: new Map(), // graphRev -> {rev, ids}
    entryPromise: null,   // in-flight detectMainEntries()
  }
  let seq = 0
  let pumping = false
  let cacheSaveToken = 0

  function log(msg) {
    S.log.push(new Date().toLocaleTimeString() + ' ' + msg)
    if (S.log.length > 60) S.log.splice(0, S.log.length - 60)
  }
  log('静态插件 host 半已启动（v2：多主入口逻辑图 + md5 增量缓存）')
  const int = (v) => {
    const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10)
    return Number.isFinite(n) ? n : 0
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

  // ================= incremental cache (md5 per source file) =================
  const CACHE_NAME = '.llm-codegraph-cache.json'
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296))
  function md5(text) {
    const bytes = new TextEncoder().encode(String(text))
    const len = bytes.length
    const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64)
    padded.set(bytes)
    padded[len] = 0x80
    const view = new DataView(padded.buffer)
    view.setUint32(padded.length - 8, (len * 8) >>> 0, true)
    view.setUint32(padded.length - 4, Math.floor(len / 536870912) >>> 0, true)
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476
    const add = (a, b) => ((a + b) >>> 0)
    const rot = (x, c) => (x << c) | (x >>> (32 - c))
    for (let off = 0; off < padded.length; off += 64) {
      const M = []
      for (let i = 0; i < 16; i++) M.push(view.getUint32(off + i * 4, true))
      let a = h0, b = h1, c = h2, d = h3
      for (let i = 0; i < 64; i++) {
        let f, g
        if (i < 16) { f = (b & c) | ((~b) & d); g = i }
        else if (i < 32) { f = (d & b) | ((~d) & c); g = (5 * i + 1) % 16 }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
        else { f = c ^ (b | (~d)); g = (7 * i) % 16 }
        const tmp = d
        d = c
        c = b
        b = add(b, rot(add(a, add(f, add(MD5_K[i], M[g]))), MD5_S[i]))
        a = tmp
      }
      h0 = add(h0, a); h1 = add(h1, b); h2 = add(h2, c); h3 = add(h3, d)
    }
    const hex = (n) => {
      let s = ''
      for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 255).toString(16).padStart(2, '0')
      return s
    }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3)
  }
  function cachePathOf(rootPath) { return rootPath.replace(/[\\/]+$/, '') + '/' + CACHE_NAME }
  function sandboxWorkspaceRoot() {
    try {
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot) return policy.workspaceRoot
    } catch (err) { /* ignore */ }
    return null
  }
  // 项目目录优先（便于随项目携带）；项目目录不在沙箱可写范围时回退到会话工作区。
  function cachePathCandidates() {
    const rootPath = String(S.root || '').replace(/[\\/]+$/, '')
    const paths = []
    if (rootPath) paths.push(rootPath + '/' + CACHE_NAME)
    const ws = sandboxWorkspaceRoot()
    if (ws) {
      const key = md5(rootPath.toLowerCase())
      const p = ws.replace(/[\\/]+$/, '') + '/.dsh-llm-codegraph-' + key + '.json'
      if (!paths.includes(p)) paths.push(p)
    }
    return paths
  }

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
                out.push({ rel, target: e.target, version: info.version, size: info.size, lines: 0, md5: null })
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

  // ---- cache load / save ----
  function addSymbol(sym) {
    S.symbols.set(sym.id, sym)
    const key = sym.name.toLowerCase()
    const arr = S.byName.get(key) || []
    arr.push(sym)
    S.byName.set(key, arr)
  }

  async function md5OfFile(f) {
    const text = await fs.readText(f.target)
    const hash = md5(text)
    f.md5 = hash
    return hash
  }

  function symbolToCache(sym) {
    return {
      id: sym.id, name: sym.name, cls: sym.cls, kind: sym.kind, rel: sym.rel,
      startLine: sym.startLine, endLine: sym.endLine, sig: sym.sig, summary: sym.summary,
      calls: (sym.calls || []).map((c) => ({ target: c.target, line: c.line, receiver: c.receiver })),
    }
  }

  function symbolFromCache(obj) {
    if (!obj || typeof obj !== 'object' || !obj.id || !obj.rel || !obj.name) return null
    const kinds = new Set(['function', 'method', 'class', 'constructor', 'const', 'module'])
    let kind = String(obj.kind || 'function').toLowerCase()
    if (!kinds.has(kind)) kind = 'function'
    return {
      id: String(obj.id), name: String(obj.name), cls: obj.cls ? String(obj.cls) : null, kind,
      rel: String(obj.rel), startLine: int(obj.startLine) || 1, endLine: int(obj.endLine) || int(obj.startLine) || 1,
      sig: String(obj.sig || obj.name), summary: String(obj.summary || ''),
      calls: Array.isArray(obj.calls) ? obj.calls.map((c) => ({
        target: String(c && c.target || '').trim(),
        line: int(c && c.line) || null,
        receiver: c && c.receiver != null ? String(c.receiver) : null,
      })).filter((c) => c.target) : [],
    }
  }

  function buildCachePayload() {
    const files = {}
    for (const [rel, f] of S.filesByRel) {
      const st = S.fileState.get(rel)
      files[rel] = {
        md5: f.md5 || null,
        size: f.size || 0,
        version: f.version,
        state: st ? { status: st.status, version: st.version || null, lines: st.lines || 0, error: st.error || null, summary: st.summary || '', analyzedAt: st.analyzedAt || null } : null,
      }
    }
    return {
      format: 2,
      savedAt: Date.now(),
      root: S.root,
      model: S.model,
      files,
      symbols: Array.from(S.symbols.values()).map(symbolToCache),
      edges: S.edges.map((e) => ({ from: e.from, to: e.to, atFile: e.atFile, atLine: e.atLine })),
      logic: Array.from(S.logicCache.entries()).map(([key, payload]) => ({ key, payload })),
    }
  }

  async function saveCacheNow() {
    if (!S.root) return
    const payload = buildCachePayload()
    const candidates = cachePathCandidates()
    const errors = []
    for (const p of candidates) {
      try {
        const target = await fs.resolve(p)
        await fs.writeText(target, JSON.stringify(payload))
        S.cache.path = p
        S.cache.savedAt = Date.now()
        S.cache.error = null
        log('缓存已写入 ' + p + '（' + S.symbols.size + ' 符号 / ' + S.edges.length + ' 边）')
        return
      } catch (err) {
        errors.push(String(err && err.message || err))
      }
    }
    S.cache.path = candidates[0] || null
    S.cache.savedAt = 0
    S.cache.error = '缓存写入失败: ' + (errors[0] || 'no candidate paths')
    log(S.cache.error)
  }

  function scheduleCacheSave(delay) {
    const token = ++cacheSaveToken
    ;(async () => {
      await timeout(delay || 900)
      if (token !== cacheSaveToken || !S.root) return
      await saveCacheNow()
    })()
  }

  // Compare current files against the cache file in the target folder and
  // restore every source whose md5 still matches. Changed/new files are left
  // idle so the normal queue only sends them to the LLM.
  async function restoreFromCache(files) {
    let cache = null
    let cachePath = null
    for (const p of cachePathCandidates()) {
      try {
        const target = await fs.resolve(p)
        const text = await fs.readText(target)
        const parsed = JSON.parse(text)
        if (parsed && parsed.root && parsed.root !== S.root) continue
        cache = parsed
        cachePath = p
        break
      } catch (err) { /* try next candidate */ }
    }
    const cachedFiles = cache && cache.files && typeof cache.files === 'object' ? cache.files : {}
    const symbolsByRel = new Map()
    if (Array.isArray(cache && cache.symbols)) {
      for (const item of cache.symbols) {
        const sym = symbolFromCache(item)
        if (!sym) continue
        const arr = symbolsByRel.get(sym.rel) || []
        arr.push(sym)
        symbolsByRel.set(sym.rel, arr)
      }
    }
    let restored = 0
    for (const f of files) {
      const c = cachedFiles[f.rel]
      let loaded = false
      if (c && typeof c.md5 === 'string') {
        try {
          const hash = await md5OfFile(f)
          if (hash === c.md5) {
            const st = c.state && c.state.status === 'ok' ? c.state : null
            if (st) {
              for (const sym of symbolsByRel.get(f.rel) || []) addSymbol(sym)
              S.fileState.set(f.rel, { status: 'ok', version: f.version, lines: int(st.lines) || 0, error: null, summary: String(st.summary || ''), analyzedAt: int(st.analyzedAt) || Date.now() })
              restored++
            } else {
              S.fileState.set(f.rel, { status: c.state && c.state.status === 'error' ? 'error' : 'idle', version: f.version, lines: 0, error: c.state && c.state.error || null })
            }
            loaded = true
          }
        } catch (err) { /* unreadable file: leave idle */ }
      }
      if (!loaded) S.fileState.set(f.rel, { status: 'idle', version: f.version, lines: 0 })
    }
    if (cache && Array.isArray(cache.logic)) {
      for (const item of cache.logic) {
        if (item && item.key && item.payload && typeof item.payload === 'object') {
          S.logicCache.set(String(item.key), item.payload)
        }
      }
    }
    S.cache = {
      path: cachePath || (cachePathCandidates()[0] || cachePathOf(S.root)),
      loaded: !!cache,
      restored,
      changed: files.length - restored,
      savedAt: cache && cache.savedAt ? int(cache.savedAt) : 0,
      error: null,
    }
    log('缓存增量恢复: ' + restored + '/' + files.length + ' 个文件命中（md5 一致）')
    return S.cache
  }

  // Resolve + scan + cache-restore for a directory; shared by UI set-root and codegraph_analyze.
  async function setupRoot(p) {
    const t = await fs.resolve(p)
    const info = await fs.stat(t)
    if (!info || info.type !== 'directory') throw new Error('not a directory: ' + p)
    S.root = t.displayPath || p
    S.filesByRel.clear()
    S.fileState.clear()
    S.queue = []
    S.symbols.clear()
    S.byName.clear()
    S.edges = []
    S.logicCache.clear()
    S.logicPromises.clear()
    S.lastError = null
    cacheSaveToken++
    const files = await collectFiles()
    const cache = await restoreFromCache(files)
    rebuildGraph()
    log('root = ' + S.root + ' (' + S.filesByRel.size + ' 个代码文件)')
    if (S.watch) for (const f of S.filesByRel.values()) enqueue(f.rel, false)
    return { root: S.root, files: files.length, cache }
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
  const LOGIC_SYSTEM_PROMPT = 'You are a precise business-logic diagram generator. You read source code snippets and always answer with exactly one valid JSON object. No markdown fences, no commentary.'
  const LOGIC_RULES = [
    'You are a business-logic tracer. Starting from the given main entry or entries, trace the project business paths through the provided source snippets.',
    'Return ONLY one valid JSON object, no markdown fences, no commentary.',
    'The JSON shape is: {"nodes": [{"id": "n1", "type": "start|process|decision|end", "label": "short Chinese label", "detail": "one-line explanation or file:line context", "file": "relative file", "line": 12}], "edges": [{"from": "n1", "to": "n2", "label": "branch/condition label"}]}',
    'RULES:',
    '1. One "start" node for EACH main entry, and one or more "end" nodes for terminal outcomes (return / error / exit).',
    '2. Every meaningful project step/function call becomes a "process" node; keep labels concise Chinese.',
    '3. Every if/else/switch/guard/loop/exception branch becomes a "decision" node; its outgoing edges must be labeled with the condition (e.g. "库存不足", "是", "否", "成功", "失败", "重试").',
    '4. Use ONLY ids that exist in nodes. Ids must be simple strings like n1, n2, ...',
    '5. Include file and line references from the numbered source snippets whenever possible.',
    '6. Focus on project business logic, not standard-library calls. Max 80 nodes; avoid duplicating the same step.',
    'RETURN ONLY the JSON object.',
  ].join('\n')
  const ENTRY_SYSTEM_PROMPT = 'You are a precise main-entry-point detector for software projects. You read a symbol inventory and always answer with exactly one valid JSON object. No markdown fences, no commentary.'
  const ENTRY_RULES = [
    'You are given a codebase inventory: project files (with one-line summaries) and every analyzed symbol with name/class, kind, file:line range, one-line summary, and call-degree (degIn/degOut).',
    'For a business-logic diagram, choose the FEW top-level entry points that real business flows start from (typically 1-8, often 1-5): user-facing commands/actions, main/boot/bootstrap/run/start functions, and handlers explicitly registered with the host framework (e.g. addCommand, route registration, event listeners, decorators, plugin hooks).',
    'Do NOT add low-level process/DLL/container hooks (e.g. DllMain) or registration-only initialization helpers unless they branch directly into the business flows themselves.',
    'The call graph may be incomplete: DO NOT select utility/helper methods just because they have degIn=0. A helper that is (or should be) called by an entry is NOT an entry.',
    'An entry MAY have degOut=0 (for example a lifecycle callback that only calls framework APIs).',
    'Prefer the implementation definition over duplicate header/declaration entries; choose the file:line with a real body.',
    'Return ONLY the JSON object in this shape: {"entries": [{"name": "exact symbol name", "class": "optional enclosing class", "file": "exact relative file", "line": 123, "reason": "short Chinese reason"}]}',
    'Use EXACT name/file/line values from the inventory. At most 12 entries; typically 1-8.',
    'RETURN ONLY the JSON object.',
  ].join('\n')

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

  async function llmJson(prompt, system) {
    const sys = system || SYSTEM_PROMPT
    const sel = await pickModel()
    let text = await llmText(sel, sys, prompt)
    let obj = extractJson(text)
    if (obj !== null) return obj
    text = await llmText(sel, sys, prompt + '\n\n' + RETRY_PROMPT)
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
      f.md5 = md5(text)
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
      st.summary = result.summary || ''
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
      scheduleCacheSave(700)
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
      scheduleCacheSave(400)
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

  // ================= main-entry detection (LLM decides; graph heuristic is fallback only) =================
  const ENTRY_SOURCE_MAX = 16000

  function buildEntryInventory() {
    const lines = ['### PROJECT FILES']
    const rels = Array.from(S.filesByRel.keys()).sort()
    for (const rel of rels) {
      const st = S.fileState.get(rel)
      lines.push(rel + (st && st.summary ? ' — ' + st.summary : ''))
    }
    lines.push('', '### SYMBOLS')
    const syms = Array.from(S.symbols.values()).filter((s) => s.kind !== 'class' && s.kind !== 'module')
    // degIn=0 symbols first (they are the heuristic candidates), but the LLM is
    // free to choose any symbol, including lifecycle callbacks with degOut=0.
    syms.sort((a, b) => {
      const ea = (a.degIn || 0) === 0 ? 0 : 1
      const eb = (b.degIn || 0) === 0 ? 0 : 1
      if (ea !== eb) return ea - eb
      return a.rel.localeCompare(b.rel) || a.startLine - b.startLine
    })
    for (const s of syms) {
      lines.push(s.name + (s.cls ? ' (class ' + s.cls + ')' : '') + ' ' + s.kind + ' @ ' + s.rel + ':' + s.startLine + '-' + s.endLine + (s.summary ? ' — ' + s.summary : '') + ' [degIn ' + (s.degIn || 0) + ', degOut ' + (s.degOut || 0) + ']')
    }
    let t = lines.join('\n')
    if (t.length > ENTRY_SOURCE_MAX) t = t.slice(0, ENTRY_SOURCE_MAX) + '\n...(truncated)'
    return t
  }

  function resolveEntryRef(ref) {
    const name = String(ref && ref.name || '').trim()
    if (!name) return null
    const file = String(ref && ref.file || '').replace(/\\/g, '/').trim()
    const cls = ref && ref.class ? String(ref.class).trim() : null
    const line = int(ref && ref.line) || null
    const matches = Array.from(S.symbols.values()).filter((s) => {
      if (s.name !== name) return false
      if (cls && s.cls !== cls) return false
      if (file) {
        const rel = s.rel.replace(/\\/g, '/')
        if (rel !== file && !rel.endsWith('/' + file) && !file.endsWith('/' + rel)) return false
      }
      return true
    })
    if (!matches.length) return null
    if (line) {
      const inRange = matches.filter((s) => line >= s.startLine && line <= s.endLine)
      if (inRange.length) {
        // among file:line matches prefer the implementation (longer body) over a declaration
        inRange.sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
        return inRange[0].id
      }
    }
    matches.sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
    return matches[0].id
  }

  async function detectMainEntries() {
    const rev = S.graphRev
    const cached = S.entryCache.get(rev)
    if (cached) return cached.ids.slice()
    if (S.entryPromise) return S.entryPromise
    const promise = (async () => {
      const obj = await llmJson(ENTRY_RULES + '\n\n' + buildEntryInventory(), ENTRY_SYSTEM_PROMPT)
      const ids = []
      for (const ref of Array.isArray(obj && obj.entries) ? obj.entries : []) {
        const id = resolveEntryRef(ref)
        if (id && !ids.includes(id)) ids.push(id)
      }
      if (!ids.length) throw new Error('LLM entry detection returned no resolvable entries')
      S.entryCache.set(rev, { rev, ids })
      if (S.entryCache.size > 8) S.entryCache.delete(S.entryCache.keys().next().value)
      log('LLM 主入口识别: ' + ids.map((id) => {
        const s = S.symbols.get(id)
        return s ? s.name + '@' + s.rel + ':' + s.startLine : id
      }).join(', '))
      return ids.slice()
    })()
    S.entryPromise = promise
    try {
      return await promise
    } finally {
      S.entryPromise = null
    }
  }

  // BFS from one or more entry ids; dedupes edges; assigns each node its nearest-entry layer
  function collectReachable(entryIds, byId) {
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

  // ================= logic diagram (LLM from main entry) =================
  const LOGIC_SOURCE_MAX = 24000

  async function buildLogicContext(entryIds, byId) {
    const flow = collectReachable(entryIds, byId)
    const byRel = new Map()
    for (const id of flow.reached.keys()) {
      const s = byId.get(id)
      if (!s) continue
      const arr = byRel.get(s.rel) || []
      arr.push(s)
      byRel.set(s.rel, arr)
    }
    const rootRels = new Set()
    for (const id of entryIds) {
      const s = byId.get(id)
      if (s) rootRels.add(s.rel)
    }
    const parts = []
    let total = 0
    for (const [rel, syms] of byRel) {
      const f = S.filesByRel.get(rel)
      if (!f) continue
      let text = ''
      try { text = await fs.readText(f.target) } catch (err) { continue }
      const lines = text.split('\n')
      let block = '\n### ' + rel + '\n'
      if (rootRels.has(rel)) {
        // 主入口所在文件整文件注入：调用边可能漏提取，不能让逻辑图下游因此空白
        for (let i = 0; i < lines.length; i++) block += (i + 1) + '|' + lines[i] + '\n'
      } else {
        const sorted = syms.slice().sort((a, b) => a.startLine - b.startLine)
        for (const s of sorted) {
          const a = Math.max(0, (s.startLine || 1) - 1)
          const b = Math.min(lines.length, s.endLine || s.startLine || 1)
          if (a >= b) continue
          block += '\n-- ' + s.name + ' (' + (s.sig || '') + ') [' + s.startLine + '-' + s.endLine + '] --\n'
          for (let i = a; i < b; i++) block += (i + 1) + '|' + lines[i] + '\n'
          if (block.length > LOGIC_SOURCE_MAX) { block = block.slice(0, LOGIC_SOURCE_MAX) + '\n...(truncated)'; break }
        }
      }
      if (block.length > LOGIC_SOURCE_MAX) block = block.slice(0, LOGIC_SOURCE_MAX) + '\n...(truncated)'
      if (!block.trim()) continue
      parts.push(block)
      total += block.length
      if (total > LOGIC_SOURCE_MAX) break
    }
    return parts.join('\n').slice(0, LOGIC_SOURCE_MAX)
  }

  function normalizeLogicDiagram(obj, rootEntries, byId) {
    const types = new Set(['start', 'process', 'decision', 'end'])
    const nodes = []
    const nodeMap = new Map()
    const rawNodes = Array.isArray(obj && obj.nodes) ? obj.nodes : []
    rawNodes.forEach((n, i) => {
      const id = String(n && n.id || 'n' + (i + 1)).trim() || ('n' + (i + 1))
      let type = String(n && n.type || 'process').toLowerCase()
      if (!types.has(type)) type = 'process'
      const label = String(n && (n.label || n.name) || '').trim() || ('步骤' + (i + 1))
      const detail = String(n && n.detail || '').trim()
      const file = String(n && n.file || (rootEntries[0] && rootEntries[0].rel) || '').trim()
      const line = int(n && n.line) || (type === 'start' && rootEntries[0] ? rootEntries[0].startLine : null)
      nodes.push({ id, type, label, detail, file, line, entry: type === 'start' })
      nodeMap.set(id, nodes[nodes.length - 1])
    })
    if (!nodes.some((n) => n.type === 'start')) {
      rootEntries.forEach((entry, i) => {
        const id = 'start' + (i ? '_' + i : '')
        nodes.push({ id, type: 'start', label: entry.name + ' 入口', detail: entry.summary || '', file: entry.rel, line: entry.startLine, entry: true })
        nodeMap.set(id, nodes[nodes.length - 1])
      })
    }
    const edges = []
    const seenEdge = new Set()
    for (const e of Array.isArray(obj && obj.edges) ? obj.edges : []) {
      const from = String(e && e.from || '').trim()
      const to = String(e && e.to || '').trim()
      if (!from || !to || !nodeMap.has(from) || !nodeMap.has(to)) continue
      const k = from + '\u0000' + to
      if (seenEdge.has(k)) continue
      seenEdge.add(k)
      edges.push({ from, to, label: String(e && e.label || '').trim() })
    }
    // BFS layer from start node(s)
    const layer = new Map()
    let frontier = []
    for (const n of nodes) {
      if (n.type === 'start') {
        layer.set(n.id, 0)
        frontier.push(n.id)
      }
    }
    if (!frontier.length && nodes.length) {
      layer.set(nodes[0].id, 0)
      frontier.push(nodes[0].id)
    }
    while (frontier.length) {
      const next = []
      for (const id of frontier) {
        const l = layer.get(id)
        for (const e of edges) {
          if (e.from !== id || layer.has(e.to)) continue
          layer.set(e.to, l + 1)
          next.push(e.to)
        }
      }
      frontier = next
    }
    for (const n of nodes) n.layer = layer.has(n.id) ? layer.get(n.id) : nodes.length + 1
    return { nodes, edges }
  }

  async function generateLogicPayload(_entryId, force) {
    const all = entries()
    const byId = new Map()
    for (const s of S.symbols.values()) byId.set(s.id, s)
    // Business rule: no per-entry dropdown. Main entries are decided by an LLM
    // pass over the symbol inventory (framework/language aware). The degIn=0
    // graph heuristic is only a fallback when that LLM pass fails.
    let roots = []
    let entryMode = 'llm'
    try {
      roots = await detectMainEntries()
      roots = roots.filter((id) => byId.has(id))
    } catch (err) {
      log('LLM 主入口识别失败，回退 degIn=0 启发式: ' + String(err && err.message || err))
    }
    if (!roots.length) {
      roots = all.map((e) => e.id)
      entryMode = 'heuristic'
    }
    if (!roots.length) {
      return { rev: S.graphRev, mode: 'logic', root: S.root, nodes: [], edges: [], entries: all, roots: [], targets: [], target: null, note: 'no entry points' }
    }
    const cacheKey = 'roots:' + roots.join('\u0000')
    const cached = S.logicCache.get(cacheKey)
    if (cached && !force) {
      const stale = cached.rev !== S.graphRev
      return Object.assign({}, cached, {
        rev: S.graphRev,
        mode: 'logic',
        root: S.root,
        entries: all,
        roots,
        targets: roots,
        target: roots[0],
        note: stale ? (cached.note + '（图谱已更新，可点“重新生成逻辑图”刷新）') : cached.note,
      })
    }
    if (S.logicPromises.has(cacheKey)) return S.logicPromises.get(cacheKey)
    const promise = (async () => {
      const rootEntries = roots.map((id) => byId.get(id)).filter(Boolean)
      const context = await buildLogicContext(roots, byId)
      if (!context.trim()) {
        return { rev: S.graphRev, mode: 'logic', root: S.root, nodes: [], edges: [], entries: all, roots, targets: roots, target: roots[0], note: '入口无可达源码上下文' }
      }
      const entryDesc = rootEntries.map((en, i) => (i + 1) + '. ' + en.name + ' @ ' + en.rel + ':' + en.startLine + (en.summary ? ' — ' + en.summary : '')).join('\n')
      const prompt = LOGIC_RULES + '\n\nMAIN ENTRIES:\n' + entryDesc + '\n\nSOURCE:\n' + context
      const obj = await llmJson(prompt, LOGIC_SYSTEM_PROMPT)
      const norm = normalizeLogicDiagram(obj, rootEntries, byId)
      const payload = {
        rev: S.graphRev,
        mode: 'logic',
        root: S.root,
        nodes: norm.nodes,
        edges: norm.edges,
        entries: all,
        roots,
        targets: roots,
        target: roots[0],
        note: (entryMode === 'heuristic' ? 'LLM 主入口识别失败，已回退调用图启发式。' : '') +
          (roots.length === 1
          ? '逻辑图由 LLM 从主入口「' + rootEntries[0].name + '」生成'
          : '逻辑图由 LLM 从 ' + roots.length + ' 个主入口生成并逐层分裂'),
        generatedAt: Date.now(),
      }
      S.logicCache.set(cacheKey, payload)
      return payload
    })()
    S.logicPromises.set(cacheKey, promise)
    try {
      return await promise
    } finally {
      S.logicPromises.delete(cacheKey)
    }
  }

  function buildGraphPayload(mode, entryId) {
    // call mode (logic mode is handled separately in generateLogicPayload)
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

  // ================= line-aware native editor open =================
  const psLiteral = (s) => "'" + String(s).replace(/'/g, "''") + "'"

  function editorCandidates(abs, line) {
    const goto = abs + ':' + line + ':1'
    if (process.platform === 'win32') {
      const ps = (script) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
      return [
        { name: 'vscode', argv: ps('& code --goto ' + psLiteral(goto)) },
        { name: 'cursor', argv: ps('& cursor --goto ' + psLiteral(goto)) },
        { name: 'notepad++', argv: ps('& notepad++ -n' + int(line) + ' ' + psLiteral(abs)) },
        { name: 'sublime', argv: ps('& subl ' + psLiteral(abs + ':' + line)) },
      ]
    }
    return [
      { name: 'vscode', argv: ['code', '--goto', goto] },
      { name: 'cursor', argv: ['cursor', '--goto', goto] },
      { name: 'sublime', argv: ['subl', abs + ':' + line] },
      { name: 'nvim', argv: ['nvim', '+' + line, abs] },
      { name: 'vim', argv: ['vim', '+' + line, abs] },
    ]
  }

  async function tryRunEditor(name, argv) {
    if (!subprocess) return false
    const opts = {
      argv,
      stdio: {
        stdin: { data: '' },
        stdout: { maxBytes: 4096, spill: { maxBytes: 65536 } },
        stderr: { maxBytes: 4096, spill: { maxBytes: 65536 } },
      },
      graceMs: 4000,
    }
    try {
      const handle = subprocess.spawn(opts)
      const outcome = await handle.done
      return outcome.exitCode === 0
    } catch (err) {
      log('编辑器启动失败 ' + name + ': ' + String(err && err.message || err))
      return false
    }
  }

  // ================= RPC surface (same method names as the dynamic version) =================
  const api = {
    'get-state': async () => {
      const ok = Array.from(S.fileState.values()).filter((s) => s.status === 'ok').length
      const fail = Array.from(S.fileState.values()).filter((s) => s.status === 'error').length
      let defaultModel = null
      try { defaultModel = await pickModel() } catch (err) { /* keep null */ }
      return {
        root: S.root, watch: S.watch, model: S.model, defaultModel, analyzing: S.analyzing,
        queueLen: S.queue.length, total: S.filesByRel.size, ok, fail,
        graphRev: S.graphRev, lastScanAt: S.lastScanAt, lastError: S.lastError,
        cache: S.cache,
        log: S.log.slice(-12),
      }
    },
    'set-root': async (args) => {
      try {
        const p = String(args && args.path || '').trim()
        if (!p) return { ok: false, error: 'empty path' }
        const setup = await setupRoot(p)
        return Object.assign({ ok: true }, setup)
      } catch (err) {
        S.lastError = String(err && err.message || err)
        return { ok: false, error: S.lastError }
      }
    },
    'set-watch': async (args) => {
      S.watch = !!(args && args.watch)
      log(S.watch ? '已开启监听' : '已关闭监听')
      return { ok: true, watch: S.watch }
    },
    analyze: async (args) => {
      if (!S.root) return { ok: false, error: 'no root set' }
      const force = !!(args && args.force)
      const list = Array.from(S.filesByRel.values())
      for (const f of list) enqueue(f.rel, force)
      log('入队 ' + S.queue.length + ' 个文件' + (force ? ' (强制全量)' : ''))
      pumpLoop()
      return { ok: true, queued: S.queue.length }
    },
    'set-model': async (args) => {
      const provider = String(args && args.provider || '').trim()
      const model = String(args && args.model || '').trim()
      if (!provider || !model) return { ok: false, error: 'provider and model required' }
      S.model = { provider, model }
      log('model = ' + provider + ' / ' + model)
      return { ok: true, model: S.model }
    },
    'get-graph': async (args) => {
      const mode = args && args.mode === 'logic' ? 'logic' : 'call'
      const entry = args && args.entry ? String(args.entry) : null
      const force = !!(args && args.force)
      if (mode === 'logic') return await generateLogicPayload(entry, force)
      return buildGraphPayload(mode, entry)
    },
    'get-symbol': async (args) => {
      const id = String(args && args.id || '')
      return { detail: symbolDetail(id) }
    },
    'open-file': async (args) => {
      const file = String(args && args.file || '').trim()
      const line = int(args && args.line) || null
      if (!file || !line) return { ok: false, error: 'file and line are required' }
      const abs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(file) ? file : (S.root ? S.root.replace(/[\\/]+$/, '') + '/' + file : file)
      for (const cand of editorCandidates(abs, line)) {
        if (await tryRunEditor(cand.name, cand.argv)) {
          log('已用 ' + cand.name + ' 打开 ' + abs + ':' + line)
          return { ok: true, editor: cand.name, file: abs, line }
        }
      }
      return { ok: false, error: 'no line-aware editor CLI found (tried vscode/cursor/notepad++/sublime)' }
    },
    'get-model-options': async () => {
      const provs = ctx.llm.listProviders()
      const out = []
      for (const p of provs) {
        try {
          const ms = await ctx.llm.listModels(p.id)
          out.push({ provider: p.id, name: p.name, models: ms.map((m) => m.id) })
        } catch (err) { /* skip */ }
      }
      return { options: out }
    },
    query: async (args) => {
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
    },
  }

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

  // ================= model tools =================
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codegraph_query',
    description: '对已用 LLM 分析过的代码知识图谱提问（每个符号绑定 文件+精确行号，含调用关系边）。回答基于图谱中已分析的符号，若要未分析文件的细节需先触发分析。',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: '关于代码库结构、调用链、业务路径的自然语言问题',
      },
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
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codegraph_analyze',
    description: '让插件用 LLM 分析代码目录（path 可选：先设置目录；force=true 强制全量重分析）。分析异步进行，可随后用 codegraph_dump 查看结果、codegraph_query 提问。',
    parameters: {
      path: { type: 'string', description: '可选：代码目录绝对路径；提供时先切换目录' },
      force: { type: 'boolean', description: 'true 时强制重新分析所有文件（默认 false：只分析未成功的）' },
      watch: { type: 'boolean', description: 'true 时开启文件修改监听（自动重分析变更文件），false 关闭' },
      provider: { type: 'string', description: '可选：指定分析用的 LLM provider（需同时给 model），不传则用当前默认模型' },
      model: { type: 'string', description: '可选：指定分析用的模型 id（需同时给 provider），不传则用当前默认模型' },
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
          await setupRoot(p)
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
      const cacheInfo = S.cache && S.cache.loaded ? '（md5 缓存恢复 ' + S.cache.restored + '/' + (S.cache.restored + S.cache.changed) + '）' : ''
      return { ok: true, queued: S.queue.length, message: '已入队 ' + S.queue.length + ' 个文件，LLM 分析进行中' + cacheInfo }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codegraph_dump',
    description: '导出当前 LLM 分析的知识图谱原始数据（符号列表含 文件+精确行号，调用边列表），用于检查分析质量。',
    parameters: {
      verbose: {
        type: 'boolean',
        description: 'true 时输出完整 JSON 文本（符号+边+状态），用于精确核对',
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
        cache: S.cache,
      }
      let msg = null
      if (syms.length > 300) { msg = '符号数超过 300 已截断'; syms.length = 300 }
      if (es.length > 500) { msg = (msg ? msg + '；' : '') + '边数超过 500 已截断'; es.length = 500 }
      return { ok: true, message: msg || '', root: S.root || '', status, symbols: syms, edges: es }
    },
  })))

  // ================= RPC route =================
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/llmg/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/llmg/api/') ? pathname.slice('/llmg/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown llm-codegraph API method' } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          const err = new Error('unknown llm-codegraph API method "' + method + '"')
          err.code = 'not-found'
          throw err
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), '@local/dsh-llm-codegraph: /llmg/api routes')

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
        } else if ((st.status === 'ok' || st.status === 'error') && st.version !== f.version) {
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
      scheduleCacheSave(900)
    } catch (err) {
      S.lastError = 'watch: ' + String(err && err.message || err)
    }
  }, 3000))
}
