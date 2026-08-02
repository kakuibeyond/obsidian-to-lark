# Obsidian 转飞书文档

这是一个 Obsidian 桌面端插件，也附带一个可直接调用的命令行入口，用来把 Markdown 笔记及其图片附件上传为飞书云文档。底层统一调用 `lark-cli`，不依赖 Python 运行时。

## 已实现能力

- 支持在 Obsidian 中通过 Ribbon 图标或命令面板一键上传当前笔记
- 支持图文混排顺序上传：
  - 正文
  - Markdown 图片
  - Obsidian 图片语法 `![[...]]`
  - Mermaid 代码块
- 支持常用格式转换：
  - `==高亮==` 转飞书行内高亮，颜色可配置
  - `<highlight>...</highlight>` 转飞书 Callout，支持开关、图标、背景色配置
  - Mermaid 代码块由 `lark-cli` 原生转换为飞书文档内嵌画板
- 支持可选忽略引用块
- 支持 SVG 转 PNG 后上传
- 支持同名飞书文档检测，并可配置：
  - 未命中同名文档时拒绝上传或自动创建
  - 命中同名文档时覆盖或新建后缀文档
- 支持上传位置历史：设置页下拉切换常用文件夹，上传确认弹窗里也能临时改目标目录
- 支持上传进度、日志和最终飞书文档链接展示

## 设置页

当前设置页支持：

- `lark-cli` 路径检测与保存
- 飞书授权检测、授权、取消授权
- 默认上传位置：
  - 下拉选择「我的空间（根目录）」或任意历史文件夹，切换即生效
  - 「＋ 新增」粘贴文件夹 token 或云空间文件夹 URL，自动调用 `lark-cli drive +inspect` 解析出文件夹名称后存入历史；无权限或 token 无效会直接拦下
  - 历史条目可改备注名、重新同步名称、删除；删除当前位置会自动回落到根目录
  - 最多保留 20 条，按最近使用时间排序；暂不支持 Wiki 链接
- 最低授权 scopes
- 是否忽略引用块
- 是否将 SVG 转为 PNG
- `==高亮==` 背景色
- `<highlight>` 转 Callout 的开关、图标、背景色
- 无同名文档时是否自动创建
- 命中同名文档时覆盖还是新建

## 上传确认弹窗

点击上传后会先弹出确认框，可以在这里：

- 用下拉临时切换本次上传的目标位置（默认选中设置里的默认上传位置）
- 勾选「同时设为默认上传位置」把这次选择固化下来

不勾选时，选择只对本次上传生效，只会把该位置的「最近使用时间」提前。

## 命令行入口

仓库里现在有两层入口：

- `cli.js`：真实的命令行入口，负责参数解析、读取本地 `data.json`、执行上传
- `upload-to-lark.sh`：很薄的 shell 包装层，只是转发到 `cli.js`

常用示例：

```bash
./upload-to-lark.sh /absolute/path/to/note.md
./upload-to-lark.sh ./docs/plans/测试文档.md --auto-create --duplicate-strategy create_new
./upload-to-lark.sh ./docs/plans/测试文档.md --ignore-blockquotes
node cli.js ./docs/plans/测试文档.md --help
```

命令行会自动复用本地 `data.json` 中的默认配置；显式传入的参数会覆盖本地默认值。

## 本地配置

`data.json` 是本地运行时配置文件，插件首次启动时会按代码默认值自动生成。这个文件可能包含本机路径、授权状态等个人信息，不应提交到 Git。

## 适用场景

适合把课程笔记、项目文档、研究记录、带图片或 Mermaid 图表的知识库页面，快速同步为可协作的飞书文档。

## 开发与校验

```bash
node tests/cli-entry.test.js
node tests/defaults-and-auth.test.js
node tests/parse-markdown-blocks.test.js
node tests/mermaid-whiteboard.test.js
node tests/upload-target-selection.test.js
node tests/upload-target-resolution.test.js
node tests/svg-image-sizing.test.js
node tests/image-fallback.test.js
node tests/lark-cli-env.test.js
node tests/folder-history.test.js
node tests/folder-picker-ui.test.js
node --check main.js
node --check cli.js
```
