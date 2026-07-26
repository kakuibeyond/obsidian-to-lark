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
- 配置默认上传位置（`folder_token`）：可填写文件夹 token 或飞书云空间文件夹 URL（形如 `https://xxx.feishu.cn/drive/folder/fldcnXXXX`）；留空走飞书根目录；暂不支持 Wiki 链接
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
  - 当前目录
  - `attachments` / `images` / `assets` / `附件`
  - vault 根目录下的同名资源子目录
- 支持图文混排顺序写入飞书文档
- 支持 Mermaid 代码块转飞书文档内嵌画板，并按顺序插入
- 支持 SVG 转 PNG 后上传
- 上传过程中展示进度、日志、最终文档链接

### 文本转换规则

- `==text==` 转飞书行内高亮
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
