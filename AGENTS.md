## 开发约定

- 所有复杂实现，先写计划，再按计划实现；简单修改可直接处理。
- 代码修改优先复用 `main.js` 里的现有上传逻辑、设置归一化和测试辅助函数。
- 新功能或行为修复默认补 Node `assert` 测试，测试目录在 `tests/`。

## 项目定位

本项目是一个 Obsidian 桌面端插件，用于把当前 Markdown 笔记及其图片附件上传为飞书云文档；底层统一调用 `lark-cli`，不依赖 Python 运行时。

## 当前已实现能力

### 插件入口

- Ribbon 图标
- 命令面板命令 `上传当前笔记到飞书云文档`
- 设置页

### 设置页能力

- 检测并记录本机 `lark-cli` 路径
- 发起飞书授权、展示当前授权状态、取消授权
- 配置默认上传位置（`folderToken`）：下拉选择「我的空间（根目录）」或历史文件夹；「＋ 新增」可填写文件夹 token 或飞书云空间文件夹 URL（形如 `https://xxx.feishu.cn/drive/folder/fldcnXXXX`）；暂不支持 Wiki 链接
- 维护历史上传位置（`folderHistory`）：新增时自动解析文件夹名称，可改备注、重新同步名称、删除；删除当前位置时回落到根目录
- 配置最低授权 scopes（`requiredAuthScopes`）
- 配置以下上传行为：
  - 无同名飞书文档时是否自动创建
  - 命中同名飞书文档时覆盖或新建
  - 是否忽略引用块
  - 是否将 SVG 转为 PNG 后上传
  - `==高亮==` 的飞书行内高亮颜色
  - `<highlight>...</highlight>` 转 Callout 的开关、图标、背景色

### 上传能力

- 读取当前 Markdown 文件绝对路径
- 解析文本、Markdown 图片、Obsidian 图片、Mermaid 代码块，并按原始顺序拆分内容块
- 自动定位图片文件：
  - Obsidian wikilink 路径是相对于 vault 根的；`findImagePath` 优先以 vault 根为基准解析带路径的链接（`path.resolve(vaultRoot, normalized)`），其次是当前目录
  - `attachments` / `images` / `assets` / `附件`
  - vault 根目录下的同名资源子目录
  - 精确匹配失败时，按图源中缀剥离兜底（如 `xxx.drawio.png` → `xxx.png`），覆盖 drawio/excalidraw/puml/plantuml/mmd/mermaid
  - 纯文件名（无路径）链接失配时，在 vault 内按文件名做全局递归搜索兜底（`findFileByNameInTree`，跳过 `.obsidian`/`.git`/`node_modules`/隐藏目录、限制最大深度）；**带目录路径的链接不触发全局搜索**，避免同名不同路径的图片混淆
- 支持图文混排顺序写入飞书文档
- 支持 Mermaid 代码块转飞书文档内嵌画板，并按顺序插入
- 支持 SVG 转 PNG 后上传
- 上传过程中展示进度、日志、最终文档链接

### 上传位置切换

- 设置项 `folderToken` 仍是「当前生效位置」，`folderHistory` 是快捷切换来源（`[{ token, name, lastUsedAt }]`，按最近使用倒序，上限 20 条）
- `normalizeSettings` 会把 URL 形式的 `folderToken` 收敛成裸 token，并把存量位置补进历史（迁移逻辑）
- 名称解析走 `drive +inspect`；无效 token 时 lark-cli 仍返回 `ok:true` 但 `title` 为空，因此再用 `drive files list` 兜底校验可访问性
- 上传确认弹窗（`UploadConfirmModal`）可临时切换本次目标位置，勾选后才会写回默认设置；不勾选只刷新 `lastUsedAt`
- `UploadLogModal` 优先使用 `options.folderToken`，未传时回落到设置里的默认位置

### 文本转换规则

- `==text==` 转飞书行内高亮
  - 整行只有高亮时（如 `==text==` 独占一行）输出 `<p><text background-color="...">text</text></p>`，飞书按块级解析，正常
  - 高亮落在**行首**时（如 `==text==：后续说明`），转换出的 `<text>` 会成为整行开头，飞书会把它当 HTML 块级元素解析，导致该行标签之后乃至后续所有内容被吞掉
  - 因此 `shieldLeadingInlineTextTag` 会在行首（可含空格/制表符缩进）的 `<text` 前插入一个零宽空格 `U+200B` 打破块级判定；实测高亮样式不受影响，内容不再截断
  - 代码块内容已被 `protectCodeBlocks` 占位，不受该规则影响
- `<highlight>...</highlight>` 转飞书 Callout
- 可选忽略 Markdown 引用块（`>` 开头）

### 同名文档处理

- 同名检测通过 `lark-cli drive files list` 完成
- 配置了上传位置时，只在该目录下查重
- 未配置上传位置时，只检查云盘根目录
- 上传位置接受文件夹 token 或飞书云空间文件夹 URL；URL 在构造 `LarkMarkdownUploader` 时由纯函数 `resolveFolderToken` 抽取 `fldcnXXXX`；Wiki 链接会抛错拦截
- 命中同名文档时：
  - 可覆盖已有文档
  - 可新建后缀文档，如 `文档名 (1)`
- 未命中同名文档时：
  - 可拒绝上传并提示手动创建
  - 或按设置自动创建新文档

### 命令行入口

- `cli.js` 是真实的命令行入口，负责：
  - 参数解析
  - 读取本地 `data.json`
  - 合并命令行覆盖项
  - 复用现有上传逻辑执行上传
- `upload-to-lark.sh` 是 shell 包装层，仅转发到 `cli.js`

## 当前实现说明

- 插件仅支持桌面端 Obsidian。
- `lark-cli` 若是 Node shebang 脚本，插件会自动补 `node` 解释器调用。
- 文档内容写入使用临时 Markdown 文件，并以相对路径传给 `lark-cli`，兼容其 `@file` 限制。
- Mermaid 代码块直接通过 Docs API v2 的 Markdown 写入，由 `lark-cli` 原生转换为 `type="mermaid"` 的飞书画板。
- `data.json` 是本地运行时配置文件，首次运行会由代码默认值自动生成；它包含本机路径、授权状态等个人信息，不应提交到 Git。
- `runCommand` 为 lark-cli 子进程注入 `GODEBUG=x509usebrokenkeyscerts=1`（由纯函数 `buildLarkCliEnv` 构建），规避 Go 1.24+ 拒绝飞书小密钥 RSA 证书（`certificate is using a broken key size`）导致的 TLS 中断；用户已显式设置 `GODEBUG` 时追加、已含则不重复。

## 发布前注意

- 确保 `data.json` 已被 Git 忽略
- 优先同步 README、AGENTS、测试用例中的功能描述
- 若调整上传行为，至少回归以下测试：
  - `node tests/defaults-and-auth.test.js`
  - `node tests/parse-markdown-blocks.test.js`
  - `node tests/mermaid-whiteboard.test.js`
  - `node tests/upload-target-selection.test.js`
  - `node tests/upload-target-resolution.test.js`
  - `node tests/svg-image-sizing.test.js`
  - `node tests/cli-entry.test.js`
  - `node tests/image-fallback.test.js`
  - `node tests/lark-cli-env.test.js`
  - `node tests/folder-history.test.js`
  - `node tests/folder-picker-ui.test.js`
  - `node tests/inline-highlight.test.js`
- 版本号更新原则
  - 修复 bug 或小功能点优化时，小版本号递增（如 `1.0.0` -> `1.0.1`）
  - 新增功能板块实现时，中版本号递增（如 `1.0.0` -> `1.1.0`）
  - 重大架构调整时，大版本号递增（如 `1.0.0` -> `2.0.0`）
  - 每一次更新版本号，都需要记录一次 `CHANGELOG.md`
