# 更新日志

## 0.1.0 - 2026-11-20

### 新增

- Mermaid 代码块遇到飞书画板不支持的类型（`journey`、`journal` 及无法识别的语法）时，不再让整篇上传失败，而是跳过画板、直接写成飞书文档原生的「文本绘图」块（插入菜单里的那一种），视图预置为「仅显示图表」
  - 写入走 docx 原生接口 `POST /open-apis/docx/v1/documents/{doc}/blocks/{doc}/children`，块为 `block_type=40`（`add_ons`，`component_type_id=blk_631fefbbae02400430b8f9f4`）
  - `record.data` 必须带 `--- title ---` 前端头：实测只有带前端头的才渲染成图，`view` 取值 `chart`＝仅显示图表、`codeChart`＝图表和代码
- 设置页新增「Mermaid 写入方式」三选一下拉：
  - 不支持的降级为文本绘图（默认）：画板支持的类型仍生成可编辑画板，`journey` 等不支持的类型改写为文本绘图块
  - 不支持的 Mermaid 中止报错：支持的类型走画板，不支持的类型直接报错中断上传
  - 所有 Mermaid 均使用文本绘图：不走画板，全部写文本绘图块
  - 命令行对应 `--mermaid-mode fallback|strict|diagram`，并保留 `--mermaid-diagram-fallback`（=fallback）、`--no-mermaid-diagram-fallback`（=strict）作为别名
- 上传日志会说明该图走的是文本绘图块以及原因（例如「journey 不在飞书画板支持的类型内」）

### 变更

- 类型判断有偏差时（画板直传或本地转换器报 `parse Mermaid failed, type: xxx not supported`）也会先回收占位空白画板，再降级写文本绘图块，而不是中断上传
- 识别 Mermaid 图类型时跳过 BOM、空行、`%%` 注释、`%%{init}%%` 指令与 `---` 前端头，避免误判
- 设置项由布尔开关 `mermaidUnsupportedToDiagram` 改为字符串 `mermaidMode`；`normalizeSettings` 会自动迁移旧值（`true`→`fallback`、`false`→`strict`）并删除旧字段

### 测试

- 新增 `tests/mermaid-diagram-fallback.test.js`，覆盖图类型识别、白名单判定、前端头与 `add_ons` record 构造、`mermaidMode` 归一化与旧字段迁移、三种写入模式，以及假 `lark-cli` 驱动的链路：白名单外直接降级、strict 报错、diagram 全部文本绘图、白名单内仍走画板、画板报类型不支持后回收画板再降级

## 0.0.8 - 2026-10-11

### 修复

- 修复从桌面启动 Obsidian 时 Mermaid fallback 已找到 `npx`、但 `whiteboard-cli` 的二级 Node shebang 报 `env: node: No such file or directory`：子进程环境会把实际解释器目录补到 `PATH` 最前面

### 测试

- `tests/mermaid-whiteboard-upload.test.js` 的相邻 `npx` 用例会在受限 `PATH` 中再次启动 `node`，真实覆盖本次二级子进程失败

## 0.0.7 - 2026-10-11

### 修复

- Mermaid 画板仍优先走 `lark-cli whiteboard +update --input_format mermaid` 直传；当飞书服务端转换偶发失败时，自动调用官方 `@larksuite/whiteboard-cli@0.2.13` 在本地把原始 Mermaid 转成 OpenAPI 节点，再以 `raw` 格式写回同一个画板
- fallback 默认优先解析与 `lark-cli` 同目录的 `npx`（兼容 Obsidian 启动时 `PATH` 不完整的场景），找不到时再使用环境中的 `npx`
- 直传和 fallback 都失败时，错误信息会同时保留两段失败原因，并回收已插入的空白画板；转换结果无节点时也会拦截写入，Mermaid 与 OpenAPI 临时文件始终清理

### 测试

- 扩展 `tests/mermaid-whiteboard-upload.test.js`，覆盖直传成功、直传失败后 raw fallback 成功、相邻 `npx` 解析、无效转换结果、双路径失败报错以及占位画板和临时文件清理

## 0.0.6 - 2026-10-09

### 修复

- 改进设置页“前往授权”的失败提示：根据 `lark-cli` 的 stdout、stderr 与错误信息，区分代理异常、DNS 解析失败、TLS/证书问题、连接超时和连接被拒绝/重置，不再只显示笼统的“授权失败”
- 网络类错误会附带对应排查方向和精简后的原始错误，便于判断代理软件、DNS、防火墙或证书链问题

### 测试

- `tests/defaults-and-auth.test.js` 新增授权网络错误分类与普通业务错误回退测试

## 0.0.5 - 2026-09-19

### 修复

- 修复「部分 Mermaid 图无法上传成功」：飞书的 markdown 导入管道会把代码块内的源码当 HTML/Markdown 处理，文中带 `<br/>` 的 mermaid 会被改写成真实换行，**时序图、甘特图**这类行语法随即被破坏
  - `+update append` 路径：飞书直接返回失败（`degrade_code=2107 Whiteboard content parse failed`），上传中断
  - `+create` 路径：返回 `ok: true` + warnings，**静默丢块**，文档里只剩空白
  - 边界实测：`<br/>`（小写、无空格）必现；`<br />`、`<br>`、`<BR/>` 不会报错，但会被画板渲染器当成字面文本显示出来；同一份 `<br/>` 在 flowchart/stateDiagram/classDiagram/erDiagram/mindmap 里可正常解析，只在时序图、甘特图里翻车
- 改为「先 append 一个空白画板占位，再用 `lark-cli whiteboard +update --input_format mermaid` 灌入源码」：源码不经过 markdown 导入管道，`<br/>` 被正确渲染成换行，实测两张时序图均正常（用户报告的文档第二个图已复现并验证修复）
- 新增纯函数 `extractWhiteboardBlockId`：从 append 返回里取画板块 `block_id`（区别于 `block_token`）
- 灌入失败时用 `docs +update --command block_delete` 回收占位空白画板，并抛出带 `Mermaid 画板写入失败：` 前缀的错误，不再在文档里留下空画板块
- 明确不再向 mermaid 源码注入主题色：`classDef` / `linkStyle` 在时序图里直接导致 parse error（`applyDefaultMermaidTheme` 及 `mermaidColorTheme` 为历史遗留、已不在上传链路里，本次未改动）

### 新增

- 上传确认弹窗除「当前文件」外，新增显示「插件版本」，版本号读取 `manifest.json` 的 `version` 字段
  - 新增纯函数 `resolvePluginVersion(plugin)`：优先用 Obsidian 已加载的 `plugin.manifest.version`，缺失时直接读插件目录下的 `manifest.json` 兜底（CLI / 测试环境）
  - 新增样式 `.obsidian-to-lark-plugin-version`（弱化的小字号，与弹窗其它提示一致）
  - `tests/folder-picker-ui.test.js` 补充断言：版本号优先级、回落、空白裁剪，以及弹窗里确实渲染出「插件版本：x.y.z」

### 测试

- 新增 `tests/mermaid-whiteboard-upload.test.js`：用 Node shebang 假 lark-cli 捕获真实子进程参数与临时文件内容，断言「append 空白占位 → 画板 API 灌入」的调用顺序、源码逐字透传（含 `<br/>`、不注入 `classDef`/`linkStyle`/色值）、失败时回收画板块并抛出可读错误

### 文档

- `AGENTS.md`：上传能力与「当前实现说明」改写 mermaid 上传机制，补充「不要改回 markdown 导入」的原因与 `<br/>` 各写法的实测结论，回归清单加入新用例；上传确认弹窗说明补充版本号展示
- `README.md`：同步 mermaid 上传说明与开发校验清单

## 0.0.4 - 2026-09-06

### 修复

- 修复「行首高亮导致飞书文档后续内容全部丢失」：飞书 markdown 会把**行首的行内 `<text>` 标签**当成 HTML 块级元素解析，且块未正确终止，导致该行标签之后乃至后续所有内容被吞掉（`==高亮==：后续说明` 这种写法必现）
- 新增纯函数 `shieldLeadingInlineTextTag`：行首（可含空格/制表符缩进）的 `<text` 前插入零宽空格 `U+200B` 打破块级判定，实测高亮样式保留、视觉无痕迹
- 整行高亮（`<p><text>...</text></p>`）与行内非行首高亮不受影响；代码块内容已被 `protectCodeBlocks` 占位，同样不受影响

### 测试

- 新增 `tests/inline-highlight.test.js`：覆盖行首/行内/缩进/独立成行/手写标签/多行/代码块保护，以及用户报告场景的端到端内容完整性

### 文档

- `AGENTS.md`：文本转换规则补充行首标签陷阱与规避机制，回归测试清单加入新用例
- `README.md`：同步高亮能力说明与开发校验清单

## 0.0.3 - 2026-08-09

### 修复

- 图片定位三连修：
  - 纯文件名链接精确匹配失败时，在 vault 内按文件名做全局递归搜索兜底
  - 全局搜索仅对纯文件名链接启用，带目录路径的链接不触发，避免同名不同路径图片混淆
  - 同名冲突检测：唯一匹配直接返回，多个匹配抛错并列出全部路径，引导改用带路径的链接
- 修复飞书文档标题被正文首个 `# 一级标题` 顶替：覆盖写入改为把文件名以 `<title>` 标记前置到正文

### 优化

- 上传性能：相邻文本块合并后再写入，命令调用解析结果加缓存

### 新增

- 上传位置历史与切换 UI：设置页下拉切换常用文件夹，上传确认弹窗可临时改目标目录

## 0.0.2 - 2026-07-30

### 新增

- 图片定位兜底：按图源中缀剥离（`xxx.drawio.png` → `xxx.png`），覆盖 drawio/excalidraw/puml/plantuml/mmd/mermaid
- 支持上传位置配置：接受飞书文件夹 token 或云空间文件夹 URL，由纯函数 `resolveFolderToken` 解析
- `runCommand` 为 lark-cli 子进程注入 `GODEBUG=x509usebrokenkeyscerts=1`，规避 Go 1.24+ 拒绝飞书小密钥 RSA 证书导致的 TLS 中断

## 0.0.1 - 2026-07-26

- 首个可用版本：Ribbon 图标与命令面板上传、图文混排顺序写入、`==高亮==` 与 `<highlight>` 转换、Mermaid 转飞书画板、同名文档检测
