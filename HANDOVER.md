# DSH-llmCodegraph 插件交接文档

> 项目：`@local/dsh-llm-codegraph`
> 源码根目录：`C:\Users\15766\Documents\DSH全局文件夹\DSH-llmCodegraph`
> 版本：`0.1.0`
> 本文档替代原 README，记录对本插件已知的一切信息，供后续维护者快速接手。

---

## 1. 项目定位

LLM 代码知识图谱（静态插件版，本仓库即静态版源码）：

- 逐文件用 LLM 分析符号与调用关系（符号带 文件 + 精确行号）
- 提供 **调用图** 与 **业务逻辑图** 双视图
- 支持 3 秒监听目录变化、增量缓存
- 注册三个模型工具：`codegraph_analyze` / `codegraph_query` / `codegraph_dump`

## 2. 文件结构

```
C:\Users\15766\Documents\DSH全局文件夹\DSH-llmCodegraph
├── package.json          插件包描述与入口
├── cordis.patch.yml      profile 组合补丁（挂载插件 id）
├── HANDOVER.md           本交接文档
├── render-test.html      独立 SVG 渲染测试页（不参与插件加载）
└── lib
    ├── index.js          host 半：扫描/LLM 分析/图构建/RPC/模型工具/缓存
    └── client.js         client 半：React 界面、布局、交互、样式
```

### 2.1 源码与部署位置

- **本仓库是源码**；本机部署目录为 `C:\Users\15766\.dsh\plugins\llm-codegraph`。
- `C:\Users\15766\.dsh\profiles\web\package.json` 中：
  `"@local/dsh-llm-codegraph": "link:C:/Users/15766/.dsh/plugins/llm-codegraph"`
- `profiles\web\node_modules\@local\dsh-llm-codegraph` 是 **Junction**，
  指向部署目录 `C:\Users\15766\.dsh\plugins\llm-codegraph`。
- 改完源码后，把 `lib/`、`package.json`、`cordis.patch.yml`、`HANDOVER.md` 同步到部署目录
  （Junction 那边会立即跟随）。
- **host 半修改后必须重启 DSH 才生效**；client bundle 变更通常刷新页面即可（HMR 需在 profile 配置，当前未确认已启用）。

## 3. host 半：`lib/index.js`

### 3.1 依赖注入

```js
export const inject = ['timer', 'llm', 'fs', 'tools', 'webServer', 'subprocess']
```

- `fs`：文件系统服务（带沙箱约束）
- `llm`：LLM 服务
- `tools`：注册模型工具
- `webServer`：注册 `/llmg/api/*` RPC
- `subprocess`：行号跳转编辑器启动（新增）
- `timer`：超时/轮询

### 3.2 全局状态 S

`root`（扫描目录）、`watch`、`model`、`queue`、`filesByRel`、`fileState`、
`symbols`（Map，key 为符号 id）、`byName`（小写函数名索引）、`edges`、
`graphRev`（图谱版本号）、`cache`、`log`、`logicCache`、`logicPromises`、
`entryCache`（LLM 入口识别缓存，按 graphRev）、`entryPromise`（去重并发）。

### 3.3 RPC 接口（POST `/llmg/api/<method>`）

| 方法 | 作用 |
|---|---|
| `get-state` | 返回分析状态/缓存/日志/model |
| `set-root` | 设置代码目录并扫描、恢复缓存 |
| `set-watch` | 开关 3s 文件监听 |
| `analyze` | 入队并开始 LLM 分析 |
| `set-model` | 指定 LLM provider/model |
| `get-graph` | `mode=call` 返回调用图；`mode=logic` 生成/返回逻辑图 |
| `get-symbol` | 符号详情（调用者/被调用/未解析调用） |
| `open-file` | 行号跳转（新增，见第 8 节） |
| `get-model-options` | 列出可用模型 |
| `query` | 基于图谱的 LLM 问答 |

### 3.4 文件收集

- `collectFiles()`：从 `S.root` 递归扫描；忽略 `IGNORE_DIRS`（node_modules/.git/dist/…）
- 只收集 `CODE_EXT` 白名单后缀（js/ts/py/c/cpp/java/cs/go/vue/…）
- `rel` 为相对项目根路径；文件对象含 `target/version/size/md5`

### 3.5 缓存（本轮已改造）

- 缓存名：`.llm-codegraph-cache.json`，内容 `format:2`：
  项目根、model、每个文件的 md5/state、全部符号（含 raw calls）、边、逻辑图缓存。
- **候选路径（按顺序尝试，写/读都如此）**：
  1. `<项目根>/.llm-codegraph-cache.json`（项目在可写工作区时随项目携带）
  2. `<sandboxPolicy.workspaceRoot>/.dsh-llm-codegraph-<md5(项目绝对路径小写)>.json`
     （E: 盘等沙箱不可写位置的兜底）
- 读取时校验 `cache.root === S.root`，防止串项目。
- 全部失败时 `S.cache.error` 会显示在 UI 状态栏。
- 背景：当前会话审批策略为 `never`，插件不能写工作区外（如 `E:\...\.llm-codegraph-cache.json`），
  因此加了工作区根目录兜底。

### 3.6 LLM 符号分析

- `CHUNK=500` 行、`OVERLAP=50` 行、`MAX_FILE_BYTES=400KB`。
- `RULES` 提示词要求 LLM 输出 JSON：
  `{summary, symbols:[{name,kind,class,startLine,endLine,sig,summary,calls:[{target,line,receiver}]}]}`
- `normalizeSymbol()` 生成符号 id：`rel::Class.name`。
- 分块结果按 `name@class` 合并（同函数跨块合并 calls）。
- `resolveCallee()`：
  - 支持 `Class.method` 限定名 → 按 `method 小写` + `class` 精确匹配
  - 未限定时用小写名索引 `byName`
  - 同文件唯一候选优先，多候选按 receiver 的 class 匹配，否则取第一个
- `rebuildGraph()`：解析全部 calls 生成边，并计算每个符号 `degIn/degOut`。
- `entries()`：**旧启发式**，`degIn==0 && degOut>0` 即入口（现在仅作兜底与调用图字段）。

### 3.7 LLM 主入口识别（本轮新增，核心修复）

背景：逐文件 LLM 抽边会漏边/错边（见第 9 节案例），`degIn=0` 启发式会把大量工具函数误判为“主入口”，
导致逻辑图第一层几十个入口。

实现：

- `ENTRY_RULES`：把「项目文件摘要 + 全部符号清单（含 degIn/degOut）」交给 LLM，
  让它识别真正的业务主入口（命令处理、main/boot、注册 handler 等）。
  明确要求：不选低层进程钩子（如 DllMain）、不选纯工具函数、允许 `degOut=0` 的生命周期回调、
  优先实现而非头文件声明。
- `buildEntryInventory()`：构建最多 16000 字符的符号清单，`degIn=0` 的候选排前。
- `resolveEntryRef()`：把 LLM 返回的 `{name,class,file,line}` 匹配回符号 id；
  同名候选优先函数体更长的实现。
- `detectMainEntries()`：调 `llmJson`，结果按 `graphRev` 缓存（最多 8 个版本），并发去重。
- `generateLogicPayload()`：
  - `roots` 先取 LLM 识别结果；
  - LLM 失败或无有效 id 时回退 `entries()` 启发式，并在 note 标注“已回退调用图启发式”。

### 3.8 逻辑图生成

- `collectReachable()`：从多个入口 BFS 遍历调用边，分配最近入口层号。
- `buildLogicContext()`：
  - 收集可达符号所在文件；
  - **主入口所在文件整文件注入**（本轮新增），其他文件只注入可达符号的行范围；
  - 总量上限 `LOGIC_SOURCE_MAX=24000` 字符。
- `LOGIC_RULES`：LLM 输出 `{nodes:[{id,type,label,detail,file,line}],edges:[{from,to,label}]}`，
  type ∈ `start|process|decision|end`。
- `normalizeLogicDiagram()`：清洗类型/id/边，缺 start 时按 rootEntries 补，
  BFS 计算每节点 layer。
- 结果按 `roots` key 缓存于 `logicCache`；图谱 rev 变化时提示“可点重新生成逻辑图刷新”。

### 3.9 模型工具

- `codegraph_query`：把 `compactGraphText()`（符号清单 + 边，最多 12000 字符）交给 LLM 回答。
- `codegraph_analyze`：可选 path/force/watch/provider/model；异步入队分析。
- `codegraph_dump`：导出 root/status/symbols/edges；符号>300、边>500 会截断。

### 3.10 文件监听

- 每 3 秒 `collectFiles()` 对比文件 version：
  - 新文件入队；变更文件强制重析；删除文件清理符号/索引并 rebuildGraph。

## 4. client 半：`lib/client.js`

- 打包格式：`window.__ModuleLoader__.load({id:'@local/dsh-llm-codegraph', factory:(require)=>…})`。
- React 通过 `require('react')` 获取。
- `installStyles()` 手动注入 `<style id="llmg-css">`（静态 client 无 styles 服务）。
- `hostCall(m, a)`：`fetch('/llmg/api/'+m, POST)`。

### 4.1 主要状态

`st`（插件状态）、`graph`（当前图）、`detail`、`rootInput`、`mode`（call/logic）、
`rootId`（逻辑图当前根节点）、`logicHistory`（点击历史栈，新增）、
`depth`、`search`、`selected`、`vb`（viewBox）、`layout` 等。

### 4.2 布局

- 调用图：`forceLayout`（力导向 + 碰撞避让 `resolveNodeCollisions`，重叠严重时 `gridPack` 兜底）。
- 逻辑图：`layeredLayout`（按 layer 分列）。
- `boxSize`/`truncateText` 按 CJK≈11px、拉丁≈6px 估算文本宽度。
- 视口：滚轮缩放、左键平移、节点拖拽。

### 4.3 逻辑图交互（本轮新增返回栈）

- 点击逻辑图节点（画布或右侧层级树）→ 记录点击顺序：把**当前 rootId** 压入 `logicHistory`，
  再以该节点为新根重新分层。
- 点击“↺ 自动（主入口）”同样先入栈再回自动根。
- 画布**左上角**新增「← 返回上次层级」按钮：
  - 逻辑图模式常驻，无历史时置灰；
  - 每点一次弹出一层，可连续点击逐层返回。
- 切换模式 / 图谱重新生成 / 根节点失效时清空历史栈。
- 右侧层级树：`treeLayersOf(graph)` 按 layer 分组，`第 N 层（M 个）`。

### 4.4 源码跳转（本轮新增行号）

- `openFile(rel, line)`：
  - 有行号时先调 host RPC `open-file`；
  - 失败/不支持时回退 `workspaces.openPath(abs)`（只打开文件，不带行）。
- 所有入口已接行号：
  - 逻辑图详情按钮 → 逻辑节点 `line`
  - 调用图详情按钮 → `startLine`
  - 画布/树节点右键 → 对应节点行号
  - “未解析调用”列表项 → `atLine`

## 5. host 行号跳转实现（`open-file`）

DSH 的 `workspaces.openPath(path)` 底层只做 `Invoke-Item -LiteralPath`（Windows），**不支持行号**，
所以行号跳转走 host 侧 subprocess 服务：

- Windows 候选顺序（PowerShell `& cmd` 方式调用）：
  1. `code --goto "<abs>:<line>:1"`（VS Code）
  2. `cursor --goto "<abs>:<line>:1"`
  3. `notepad++ -n<line> "<abs>"`
  4. `subl "<abs>:<line>"`
- 非 Windows 候选：`code/cursor --goto`、`subl file:line`、`nvim +line file`、`vim +line file`。
- 任一命令退出码 0 即成功并返回 `{ok:true, editor}`；全部失败返回
  `{ok:false, error:'no line-aware editor CLI found …'}`，client 回退普通打开。
- 本机已验证 `code` 在 PATH 中：
  `D:\Programs\Microsoft VS Code\bin\code.cmd`。

## 6. 已验证的现场案例（重要背景）

测试目录：`E:\CaxaPlugin\CaxaPlugin\CaxaPlugin`（C++ CAXA 插件，24 个代码文件）。

- 全量分析结果：241 符号 / 224 边。
- 旧启发式算出 **48 个入口候选**，真实命令入口只有 4 个：
  `CRXCreatTriangle`、`CRXMoveToHiddenLayer`、`MoveToOrigin`、`CncTurningDimensionsCommand`。
- 根因：
  - `CrxEntryPoint.cpp` 中大量 `CaxaCmd::xxx` 调用没有被 LLM 提取成边；
  - `cm->execute(pt, lines)` 被错误解析为 `CaxaCmd.Execute`；
  - `On_kInitAppMsg` 这类真实生命周期入口反而 `degOut=0` 被启发式排除。
- 同一份图谱用 `codegraph_query` 问“真正主入口是谁”，LLM 能正确回答
  `DllMain`、`On_kInitAppMsg` + 4 个命令处理函数，证明“LLM 判定入口”方向正确。

## 7. 已知问题与风险

1. **逐文件 LLM 抽边不完整/会错配**：跨文件调用、函数指针、`obj->method()` 容易漏或错。
   当前缓解：入口用 LLM 判定 + 主入口文件整文件注入；但逻辑图第二层往下仍可能因漏边变稀。
   后续方向：强化 `RULES` 提示词（静态类方法/函数指针/成员调用），或对候选调用补一次校验。
2. **`entries()` 启发式仅作兜底**：LLM 入口识别失败时仍会回到 `degIn=0` 误判。
3. **行号跳转依赖本机编辑器 CLI**：没有 code/cursor/notepad++/subl 时只能回退“只打开文件”。
4. **缓存沙箱**：项目目录不可写时依赖 `sandboxPolicy.workspaceRoot`；若该服务/字段缺失，
   只有项目目录一个候选。审批策略为 `never` 时不能申请提权写 E: 盘。
5. **host 半不热加载**：改 `lib/index.js` 后必须重启 DSH；改 `lib/client.js` 刷新页面。
6. `codegraph_dump` 有 300 符号 / 500 边截断，大项目核对数据要注意。

## 8. 本轮改动摘要

`lib/index.js`：

- 新增 `ENTRY_SYSTEM_PROMPT` / `ENTRY_RULES`、`buildEntryInventory`、`resolveEntryRef`、`detectMainEntries`。
- `generateLogicPayload` roots 改为 LLM 识别结果，失败回退 `entries()`；note 标明回退。
- `buildLogicContext`：主入口所在文件整文件注入。
- 缓存：`cachePathCandidates` 项目根 + 工作区兜底；save/restore 依次尝试；root 校验。
- 新增 `open-file` RPC + `editorCandidates` / `tryRunEditor`；inject 增加 `subprocess`。

`lib/client.js`：

- `openFile(rel, line)` 行号跳转；所有“转至源码”/右键/未解析调用入口接行号。
- 新增 `logicHistory` 栈、`logicNodeClick` / `logicRootClick` / `logicBack`、左上角返回按钮。
- 状态栏显示缓存错误。
- `package.json` `files` 中 `README.md` 改为 `HANDOVER.md`（README 已从仓库删除）。

## 9. 维护速查

```powershell
# 语法检查（无需重启）
node --check "C:\Users\15766\Documents\DSH全局文件夹\DSH-llmCodegraph\lib\index.js"
node --check "C:\Users\15766\Documents\DSH全局文件夹\DSH-llmCodegraph\lib\client.js"

# 改 host 半后重启 DSH；改 client 半后刷新页面
```

验证流程：

1. 重启 DSH → 打开「代码图谱」标签。
2. 载入 `E:\CaxaPlugin\CaxaPlugin\CaxaPlugin` → 点「LLM 分析」。
3. 看逻辑图第一层应为 4 个命令入口；状态栏 note 显示“LLM 从 N 个主入口生成”。
4. 详情点「转至源码」→ VS Code 跳到对应行。
5. 连续点击逻辑图节点 → 左上角「← 返回上次层级」逐层回退。
6. 缓存：项目根不可写时状态栏不再报错，缓存文件落在
   `C:\Users\15766\Documents\DSH全局文件夹\.dsh-llm-codegraph-<md5>.json`。

## 10. 相关外部知识（踩坑记录）

- DSH client `workspaces` 服务只有 `openPath(path: string): Promise<void>`，无行号参数；
  其 Windows 原生打开是 `Invoke-Item -LiteralPath <path>`。
- DSH host 插件可用 `ctx.get('sandboxPolicy').workspaceRoot` 拿当前会话工作区根目录
  （参考 `image-bridge` 插件同样用法）。
- 沙箱 `workspace-write` 模式：允许写会话工作区，写工作区外会得到
  `file access denied under workspace-write mode`；审批策略 `never` 时无法就地提权。
- 插件包在 `profiles\web\node_modules` 下是 Junction，不要在那边改文件。
