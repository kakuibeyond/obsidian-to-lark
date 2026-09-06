let Plugin, PluginSettingTab, Setting, Notice, Modal;
try {
	({ Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian'));
} catch (_ignored) {
	// CLI 环境下无需 obsidian 模块
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS = {
	larkCliPath: '',
	folderToken: '',
	folderHistory: [],
	lastCheckMessage: '',
	lastAuthMessage: '',
	autoCreateDocWhenMissing: false,
	duplicateDocStrategy: 'overwrite',
	ignoreBlockquotes: false,
	convertSvgToRaster: false,
	highlightToCallout: true,
	calloutEmoji: '💡',
	calloutBackgroundColor: 'light-blue',
	highlightBackgroundColor: 'light-purple',
	requiredAuthScopes: [
		'docx:document:create',
		'docx:document:write_only',
		'docs:document.media:upload',
		'space:document:retrieve'
	]
};

function normalizeSettings(rawSettings) {
	const merged = Object.assign({}, DEFAULT_SETTINGS, rawSettings || {});
	const scopes = Array.isArray(merged.requiredAuthScopes)
		? merged.requiredAuthScopes
		: DEFAULT_SETTINGS.requiredAuthScopes;

	merged.autoCreateDocWhenMissing = merged.autoCreateDocWhenMissing === true;
	merged.duplicateDocStrategy = merged.duplicateDocStrategy === 'create_new'
		? 'create_new'
		: 'overwrite';
	delete merged.mermaidColorTheme;

	merged.requiredAuthScopes = Array.from(new Set(
		scopes.map((item) => String(item || '').trim()).filter(Boolean)
	));

	if (merged.requiredAuthScopes.length === 0) {
		merged.requiredAuthScopes = [...DEFAULT_SETTINGS.requiredAuthScopes];
	}

	// 上传位置：URL 统一收敛成裸 token，历史列表去重排序；
	// 存量配置里已有的上传位置自动补进历史，避免升级后历史为空。
	const resolvedFolderToken = safeResolveFolderToken(merged.folderToken);
	if (resolvedFolderToken) {
		merged.folderToken = resolvedFolderToken;
	} else {
		merged.folderToken = String(merged.folderToken || '').trim();
	}

	merged.folderHistory = normalizeFolderHistory(merged.folderHistory);
	if (
		resolvedFolderToken &&
		!merged.folderHistory.some((item) => item.token === resolvedFolderToken)
	) {
		merged.folderHistory = upsertFolderHistoryEntry(merged.folderHistory, {
			token: resolvedFolderToken,
			name: '',
			lastUsedAt: 0
		});
	}

	return merged;
}

function shouldPersistSettings(loadedSettings, normalizedSettings) {
	if (!loadedSettings || typeof loadedSettings !== 'object' || Array.isArray(loadedSettings)) {
		return true;
	}

	try {
		return JSON.stringify(loadedSettings) !== JSON.stringify(normalizedSettings);
	} catch (_error) {
		return true;
	}
}

const HOME = os.homedir();
const COMMON_BINARY_PATHS = {
	default: [
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/bin'
	],
	node: [
		process.execPath ? path.dirname(process.execPath) : '',
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		path.join(HOME, '.nvm/versions/node/current/bin'),
		path.join(HOME, '.volta/bin')
	]
};

const OBSIDIAN_IMAGE_PATTERN = /!\[\[([^\|\]]+)(?:\|([^\]]*))?\]\]/g;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^\)]+)\)/g;
const MERMAID_FENCE_PATTERN = /```mermaid[^\n]*\r?\n([\s\S]*?)```/gi;
const SEARCHABLE_DOC_TYPES = new Set(['DOC', 'DOCX']);
const IMAGE_SEARCH_SUBDIRS = ['attachments', 'images', 'assets', '附件'];
// 图源工具导出图片时常见的文件名中缀，例如 diagram.drawio.png、sketch.excalidraw.png。
// 当 Markdown 引用了带这类中缀的文件名，但实际导出文件没有中缀（diagram.png）时，用于兜底匹配。
const KNOWN_IMAGE_SOURCE_EXTENSIONS = ['drawio', 'excalidraw', 'puml', 'plantuml', 'mmd', 'mermaid'];

// 针对"图源中缀"文件名生成兜底候选：xxx.drawio.png → xxx.png。
// 仅剥离紧邻最终扩展名、且属于已知图源工具的那一段中缀，避免误伤普通多扩展名文件。
function buildImageFallbackFilenames(pureFilename) {
	const name = String(pureFilename || '');
	const lastDot = name.lastIndexOf('.');
	if (lastDot <= 0) {
		return [];
	}
	const ext = name.slice(lastDot);
	const stem = name.slice(0, lastDot);
	const secondDot = stem.lastIndexOf('.');
	if (secondDot <= 0) {
		return [];
	}
	const middle = stem.slice(secondDot + 1).toLowerCase();
	if (!KNOWN_IMAGE_SOURCE_EXTENSIONS.includes(middle)) {
		return [];
	}
	return [`${stem.slice(0, secondDot)}${ext}`];
}

// vault 全局递归搜索时跳过的目录名（不参与图片查找），避免扫描 Obsidian 配置、版本库等无关内容。
const VAULT_SEARCH_SKIP_DIRS = new Set([
	'.obsidian', '.git', '.gitignore', '.trash', '.cache',
	'node_modules', '.DS_Store', '__pycache__'
]);

// 在目录树中按文件名递归查找匹配的文件，模拟 Obsidian 的「全局按名查找」行为。
// 作为 findImagePath 的最终兜底：当图片被移到固定搜索目录之外的任意位置时仍能定位。
// 跳过 .obsidian / .git / node_modules 等无关目录；限制最大深度避免极端嵌套。
// options.findAll 设为 true 时收集全部匹配（数组），否则命中第一个即返回（null 表示没找到）。
function findFileByNameInTree(rootDir, targetName, options) {
	const name = String(targetName || '');
	if (!name || !rootDir) {
		return null;
	}
	const maxDepth = (options && Number.isInteger(options.maxDepth) && options.maxDepth > 0)
		? options.maxDepth
		: 10;
	const skipDirs = (options && options.skipDirs instanceof Set)
		? options.skipDirs
		: VAULT_SEARCH_SKIP_DIRS;
	const findAll = !!(options && options.findAll);

	const results = [];
	let stack = [{ dir: rootDir, depth: 0 }];
	while (stack.length > 0) {
		const { dir, depth } = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (_error) {
			continue;
		}
		// 先扫当前层的文件（命中即返回），再把子目录压栈，保证同层文件优先命中。
		const subdirs = [];
		for (const entry of entries) {
			if (entry.isFile()) {
				if (entry.name === name) {
					if (!findAll) {
						return path.join(dir, entry.name);
					}
					results.push(path.join(dir, entry.name));
				}
			} else if (entry.isDirectory()) {
				if (depth + 1 < maxDepth && !skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
					subdirs.push(path.join(dir, entry.name));
				}
			}
		}
		for (const subdir of subdirs) {
			stack.push({ dir: subdir, depth: depth + 1 });
		}
	}
	return findAll ? results : null;
}
const DEFAULT_LARK_IMAGE_WIDTH = 1200;
const SVG_UPLOAD_RASTER_SCALE = 4;
const MIN_SVG_UPLOAD_WIDTH = 4800;
const MAX_SVG_UPLOAD_WIDTH = 8192;

const CALLOUT_EMOJI_OPTIONS = [
	{ value: '💡', label: '💡 提示' },
	{ value: '⚠️', label: '⚠️ 警告' },
	{ value: '❌', label: '❌ 危险' },
	{ value: '✅', label: '✅ 成功' },
	{ value: '📌', label: '📌 重要' },
	{ value: '📝', label: '📝 备注' },
	{ value: '🔔', label: '🔔 提醒' },
	{ value: '❓', label: '❓ 疑问' }
];

const CALLOUT_BACKGROUND_COLOR_OPTIONS = [
	{ value: 'light-blue', label: '浅蓝' },
	{ value: 'blue', label: '蓝色' },
	{ value: 'light-green', label: '浅绿' },
	{ value: 'green', label: '绿色' },
	{ value: 'light-yellow', label: '浅黄' },
	{ value: 'yellow', label: '黄色' },
	{ value: 'light-red', label: '浅红' },
	{ value: 'red', label: '红色' },
	{ value: 'light-orange', label: '浅橙' },
	{ value: 'orange', label: '橙色' },
	{ value: 'light-purple', label: '浅紫' },
	{ value: 'purple', label: '紫色' },
	{ value: 'pale-gray', label: '浅灰' },
	{ value: 'dark-gray', label: '深灰' }
];

const HIGHLIGHT_BACKGROUND_COLOR_OPTIONS = [
	{ value: 'yellow', label: '黄色' },
	{ value: 'light-yellow', label: '浅黄' },
	{ value: 'light-purple', label: '浅紫' },
	{ value: 'purple', label: '紫色' },
	{ value: 'light-blue', label: '浅蓝' },
	{ value: 'blue', label: '蓝色' },
	{ value: 'light-green', label: '浅绿' },
	{ value: 'green', label: '绿色' },
	{ value: 'light-red', label: '浅红' },
	{ value: 'red', label: '红色' },
	{ value: 'light-orange', label: '浅橙' },
	{ value: 'orange', label: '橙色' },
	{ value: 'pale-gray', label: '浅灰' },
	{ value: 'dark-gray', label: '深灰' }
];

const MERMAID_THEME_PRESETS = {
	default: {
		defaultNode: { fill: '#E9D5FF', stroke: '#8B5CF6' },
		lineStroke: '#7C3AED',
		nodePalettes: [
			{ fill: '#F3E8FF', stroke: '#A855F7' },
			{ fill: '#DDD6FE', stroke: '#7C3AED' },
			{ fill: '#F5D0FE', stroke: '#C026D3' },
			{ fill: '#EDE9FE', stroke: '#8B5CF6' },
			{ fill: '#E9D5FF', stroke: '#9333EA' }
		]
	},
	classic: {
		defaultNode: { fill: '#DBEAFE', stroke: '#3B82F6' },
		lineStroke: '#2563EB',
		nodePalettes: [
			{ fill: '#E0F2FE', stroke: '#0EA5E9' },
			{ fill: '#DBEAFE', stroke: '#2563EB' },
			{ fill: '#BFDBFE', stroke: '#1D4ED8' },
			{ fill: '#DCFCE7', stroke: '#10B981' },
			{ fill: '#E0E7FF', stroke: '#4F46E5' }
		]
	},
	vintage: {
		defaultNode: { fill: '#FDE68A', stroke: '#D97706' },
		lineStroke: '#B45309',
		nodePalettes: [
			{ fill: '#FFEDD5', stroke: '#EA580C' },
			{ fill: '#FED7AA', stroke: '#F97316' },
			{ fill: '#FDE68A', stroke: '#D97706' },
			{ fill: '#FCE7F3', stroke: '#DB2777' },
			{ fill: '#DCFCE7', stroke: '#16A34A' }
		]
	},
	'minimal-gray': {
		defaultNode: { fill: '#F3F4F6', stroke: '#6B7280' },
		lineStroke: '#4B5563',
		nodePalettes: [
			{ fill: '#F3F4F6', stroke: '#6B7280' },
			{ fill: '#E5E7EB', stroke: '#4B5563' },
			{ fill: '#E0E7FF', stroke: '#6366F1' },
			{ fill: '#E0F2FE', stroke: '#0284C7' },
			{ fill: '#DCFCE7', stroke: '#16A34A' }
		]
	}
};

const MERMAID_COLOR_THEME_OPTIONS = [
	{ value: 'default', label: '默认' },
	{ value: 'classic', label: '经典' },
	{ value: 'vintage', label: '复古' },
	{ value: 'minimal-gray', label: '简约灰' }
];

function normalizeMermaidColorTheme(value) {
	const theme = String(value || '').trim().toLowerCase();
	const legacyThemeMap = {
		purple: 'default',
		blue: 'classic',
		green: 'classic',
		yellow: 'vintage',
		orange: 'vintage',
		red: 'vintage',
		gray: 'minimal-gray'
	};

	return Object.prototype.hasOwnProperty.call(MERMAID_THEME_PRESETS, theme)
		? theme
		: (legacyThemeMap[theme] || DEFAULT_SETTINGS.mermaidColorTheme);
}

function convertHighlightToCallout(content, emoji, backgroundColor) {
	return content.replace(
		/<highlight(\s[^>]*)?>([\s\S]*?)<\/highlight>/g,
		(_, _attrs, body) => {
			const trimmedBody = body.replace(/^\n+/, '').replace(/\n+$/, '');
			return `<callout emoji="${emoji}" background-color="${backgroundColor}" border-color="${backgroundColor}">\n${trimmedBody}\n</callout>`;
		}
	);
}

function serializeMermaidBlock(source) {
	const content = String(source || '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
	return `\`\`\`mermaid\n${content}\n\`\`\``;
}

function applyDefaultMermaidTheme(source, themeKey) {
	const content = String(source || '').trim();
	if (!content) {
		return content;
	}

	if (/^\s*%%\{init:/m.test(content) || /^\s*(classDef|style|linkStyle)\b/m.test(content)) {
		return content;
	}

	const nodeIds = [];
	const seen = new Set();
	const nodePattern = /\b([A-Za-z][A-Za-z0-9_-]*)\s*(?=[\[\(\{])/g;
	let match = nodePattern.exec(content);
	while (match) {
		const id = match[1];
		if (!seen.has(id)) {
			seen.add(id);
			nodeIds.push(id);
		}
		match = nodePattern.exec(content);
	}

	const preset = MERMAID_THEME_PRESETS[normalizeMermaidColorTheme(themeKey)];

	const styleLines = [
		`  classDef default fill:${preset.defaultNode.fill},stroke:${preset.defaultNode.stroke},stroke-width:2px;`,
		`  linkStyle default stroke:${preset.lineStroke},stroke-width:2px;`
	];

	nodeIds.slice(1).forEach((id, index) => {
		const palette = preset.nodePalettes[index % preset.nodePalettes.length];
		styleLines.push(`  style ${id} fill:${palette.fill},stroke:${palette.stroke},stroke-width:2px;`);
	});

	return `${content}\n${styleLines.join('\n')}`;
}

// 零宽空格：飞书 markdown 会把「行首的 <text> 行内标签」当成 HTML 块级元素解析，结果是该标签
// 之后的内容（乃至后续所有文本）被吞掉 —— 实测 `==x==：yyy` 这种行会让文档在 x 处直接截断。
// 在行首的 <text 前插一个零宽空格即可打破块级判定，行内高亮样式不受影响，视觉上也没有痕迹。
const ZERO_WIDTH_SPACE = '\u200B';

function shieldLeadingInlineTextTag(line) {
	return String(line || '').replace(
		/^([ \t]*)<text\b/,
		(_match, indent) => `${indent}${ZERO_WIDTH_SPACE}<text`
	);
}

function convertObsidianHighlight(content, backgroundColor) {
	return String(content || '')
		.split(/\r?\n/)
		.map((line) => {
			const standaloneMatch = line.match(/^\s*==([^\r\n]+?)==\s*$/);
			if (standaloneMatch) {
				// 整行只有高亮时用 <p> 包裹：行首是块级 <p> 且同行闭合，飞书解析正常，无需遮挡。
				return `<p><text background-color="${backgroundColor}">${standaloneMatch[1]}</text></p>`;
			}

			const converted = line.replace(
				/(?<!\=)==([^\r\n]+?)==(?!=)/g,
				(_, text) => `<text background-color="${backgroundColor}">${text}</text>`
			);
			// 转换后（或用户手写的）<text> 若落在行首，必须遮挡，否则整段内容会被飞书截断。
			return shieldLeadingInlineTextTag(converted);
		})
		.join('\n');
}

function prepareTextBlockContent(content, options = {}) {
	const { result: shielded, placeholders } = protectCodeBlocks(content);
	let converted = convertObsidianHighlight(
		shielded,
		options.highlightBackgroundColor || DEFAULT_SETTINGS.highlightBackgroundColor
	);
	if (options.highlightToCallout !== false) {
		converted = convertHighlightToCallout(
			converted,
			options.calloutEmoji || DEFAULT_SETTINGS.calloutEmoji,
			options.calloutBackgroundColor || DEFAULT_SETTINGS.calloutBackgroundColor
		);
	}
	return restoreCodeBlocks(converted, placeholders);
}

function hasMeaningfulMarkdown(content) {
	return String(content || '').trim().length > 0;
}

// 把文档标题以 `<title>...</title>` 形式前置到 markdown 正文。lark-cli 在 +create / +update
// overwrite 时都会识别该标记并让它「优先于」正文里的一级标题，从而让飞书文档标题等于文件名，
// 而不是被正文首个 `# 一级标题` 顶替。注意 content 走的是 markdown 格式，标题文本需做基础 XML 转义。
function escapeXmlText(value) {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function withDocumentTitle(markdown, title) {
	return `<title>${escapeXmlText(title)}</title>\n${markdown}`;
}

// 把相邻（中间没有被图片/Mermaid 隔开）的文本块合并成一个，减少 appendText 子进程调用次数。
// 合并时直接拼接各块原文（它们原本就是被顺序 append 的，newline 已包含在块内容里），不额外插入分隔符，
// 以忠实还原原先逐块追加的渲染效果。空白文本块直接丢弃，等价于上传循环里 hasMeaningfulMarkdown 的跳过逻辑。
function mergeAdjacentTextBlocks(blocks) {
	const merged = [];
	for (const block of (blocks || [])) {
		if (block.type !== 'text') {
			merged.push({ ...block });
			continue;
		}
		if (!hasMeaningfulMarkdown(block.content)) {
			continue;
		}
		const last = merged[merged.length - 1];
		if (last && last.type === 'text') {
			last.content += block.content;
		} else {
			merged.push({ type: 'text', content: block.content });
		}
	}
	return merged;
}

function buildDuplicateDocumentTitle(title, existingTitles = []) {
	const normalizedTitle = String(title || '').trim();
	const titleSet = new Set(
		(existingTitles || [])
			.map((item) => String(item || '').trim())
			.filter(Boolean)
	);

	if (!normalizedTitle || !titleSet.has(normalizedTitle)) {
		return normalizedTitle;
	}

	for (let index = 1; index < 1000; index += 1) {
		const candidate = `${normalizedTitle} (${index})`;
		if (!titleSet.has(candidate)) {
			return candidate;
		}
	}

	throw new Error(`无法为文档“${normalizedTitle}”生成新的后缀名`);
}

function planUploadTarget(options = {}) {
	const title = String(options.title || '').trim();
	const duplicates = Array.isArray(options.duplicates) ? options.duplicates : [];
	const existingTitles = Array.isArray(options.existingTitles) && options.existingTitles.length > 0
		? options.existingTitles
		: duplicates.map((item) => item?.title);

	if (duplicates.length > 0) {
		if (options.duplicateStrategy === 'create_new') {
			return {
				mode: 'create',
				title: buildDuplicateDocumentTitle(title, existingTitles)
			};
		}

		return {
			mode: 'overwrite',
			title,
			target: duplicates[0]
		};
	}

	if (options.autoCreateIfMissing) {
		return {
			mode: 'create',
			title
		};
	}

	return {
		mode: 'missing',
		title
	};
}

function extractWhiteboardTokenFromMarkdown(markdown) {
	const content = String(markdown || '');
	const pattern = /<whiteboard\b[^>]*\btoken="([^"]+)"[^>]*\/?>/g;
	let lastToken = '';
	let match = pattern.exec(content);

	while (match) {
		lastToken = match[1] || '';
		match = pattern.exec(content);
	}

	return lastToken;
}

function extractFetchedDocumentContent(payload) {
	return payload?.data?.document?.content
		|| payload?.data?.markdown
		|| payload?.markdown
		|| '';
}

function protectCodeBlocks(content) {
	const placeholders = [];
	const result = String(content || '').replace(
		/(```[\s\S]*?```)/g,
		(match) => {
			const index = placeholders.length;
			placeholders.push(match);
			return `\x00CODEBLOCK_${index}\x00`;
		}
	);
	return { result, placeholders };
}

function isWithinRanges(index, ranges) {
	return ranges.some((range) => index >= range.start && index < range.end);
}

function restoreCodeBlocks(content, placeholders) {
	return String(content || '').replace(
		/\x00CODEBLOCK_(\d+)\x00/g,
		(_, index) => placeholders[Number(index)]
	);
}

function stripBlockquotes(content) {
	const { result: shielded, placeholders } = protectCodeBlocks(content);
	const stripped = shielded
		.split(/\r?\n/)
		.filter((line) => !/^\s*>/.test(line))
		.join('\n');
	return restoreCodeBlocks(stripped, placeholders);
}

function trimCodeBlockTrailingNewlines(content) {
	const lines = String(content || '').split(/\r?\n/);
	const result = [];
	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const isFence = /^\s*```/.test(line);

		if (isFence && !inCodeBlock) {
			inCodeBlock = true;
			result.push(line);
			continue;
		}

		if (isFence && inCodeBlock) {
			inCodeBlock = false;
			while (result.length > 0 && result[result.length - 1].trim() === '') {
				result.pop();
			}
			result.push(line);
			continue;
		}

		result.push(line);
	}

	return result.join('\n');
}

function parseSvgLengthToPx(value) {
	if (value == null) {
		return null;
	}

	const trimmed = String(value).trim();
	if (!trimmed || /%$/.test(trimmed)) {
		return null;
	}

	const match = trimmed.match(/^([0-9]*\.?[0-9]+)(px|pt|pc|mm|cm|in)?$/i);
	if (!match) {
		return null;
	}

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}

	const unit = (match[2] || 'px').toLowerCase();
	const multipliers = {
		px: 1,
		pt: 96 / 72,
		pc: 16,
		mm: 96 / 25.4,
		cm: 96 / 2.54,
		in: 96
	};

	return Math.round(amount * (multipliers[unit] || 1));
}

function parseSvgViewBox(value) {
	if (!value) {
		return null;
	}

	const parts = String(value)
		.trim()
		.split(/[\s,]+/)
		.map((item) => Number(item));

	if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
		return null;
	}

	const width = Math.round(parts[2]);
	const height = Math.round(parts[3]);
	if (width <= 0 || height <= 0) {
		return null;
	}

	return { width, height };
}

function extractSvgRootAttributes(svgContent) {
	const match = String(svgContent || '').match(/<svg\b([^>]*)>/i);
	if (!match) {
		return {};
	}

	const attrs = {};
	const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(['"])(.*?)\2/g;
	let attrMatch = attrPattern.exec(match[1]);

	while (attrMatch) {
		attrs[attrMatch[1]] = attrMatch[3];
		attrMatch = attrPattern.exec(match[1]);
	}

	return attrs;
}

function extractSvgDimensions(svgContent) {
	const attrs = extractSvgRootAttributes(svgContent);
	let width = parseSvgLengthToPx(attrs.width);
	let height = parseSvgLengthToPx(attrs.height);
	const viewBox = parseSvgViewBox(attrs.viewBox);

	if (!width && !height && viewBox) {
		return viewBox;
	}

	if (width && !height && viewBox) {
		height = Math.round(width * (viewBox.height / viewBox.width));
	}

	if (height && !width && viewBox) {
		width = Math.round(height * (viewBox.width / viewBox.height));
	}

	if (width || height) {
		return {
			...(width ? { width } : {}),
			...(height ? { height } : {})
		};
	}

	return null;
}

function isSvgFile(filePath) {
	return path.extname(filePath || '').toLowerCase() === '.svg';
}

function parseObsidianImageSizeHint(extra) {
	const trimmed = String(extra || '').trim();
	if (!trimmed) {
		return null;
	}

	const simpleWidth = trimmed.match(/^(\d+)$/);
	if (simpleWidth) {
		return { width: Number(simpleWidth[1]) };
	}

	const widthHeight = trimmed.match(/^(\d+)\s*x\s*(\d+)$/i);
	if (widthHeight) {
		return {
			width: Number(widthHeight[1]),
			height: Number(widthHeight[2])
		};
	}

	const widthOnly = trimmed.match(/^(\d+)\s*x\s*$/i);
	if (widthOnly) {
		return { width: Number(widthOnly[1]) };
	}

	return null;
}

function getSvgRasterUploadSize(displaySize = {}, intrinsicSize = null) {
	const displayWidth = Number(displaySize.width) || DEFAULT_LARK_IMAGE_WIDTH;
	const displayHeight = Number(displaySize.height) || null;
	const intrinsicWidth = Number(intrinsicSize?.width) || null;
	const intrinsicHeight = Number(intrinsicSize?.height) || null;
	const aspectRatio = intrinsicWidth && intrinsicHeight
		? intrinsicHeight / intrinsicWidth
		: (displayWidth && displayHeight ? displayHeight / displayWidth : null);

	const baseWidth = Math.max(
		displayWidth * SVG_UPLOAD_RASTER_SCALE,
		MIN_SVG_UPLOAD_WIDTH,
		intrinsicWidth || 0,
		displayWidth
	);

	const width = Math.min(Math.round(baseWidth), MAX_SVG_UPLOAD_WIDTH);
	const height = aspectRatio
		? Math.max(1, Math.round(width * aspectRatio))
		: Math.max(1, Math.round((displayHeight || displayWidth) * SVG_UPLOAD_RASTER_SCALE));

	return { width, height };
}

function buildSearchPaths(executable) {
	const key = executable === 'node' ? 'node' : 'default';
	const configured = process.env.PATH || '';
	const pathEntries = configured.split(process.platform === 'win32' ? ';' : ':');
	return [...COMMON_BINARY_PATHS[key], ...pathEntries].filter(Boolean);
}

async function exists(filePath) {
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
		return true;
	} catch (_error) {
		return false;
	}
}

async function findExecutableInPath(executable) {
	const paths = buildSearchPaths(executable);
	const executableNames = process.platform === 'win32'
		? [`${executable}.exe`, `${executable}.cmd`, `${executable}.bat`, executable]
		: [executable];

	for (const dir of paths) {
		for (const name of executableNames) {
			const candidate = path.join(dir, name);
			if (await exists(candidate)) {
				return candidate;
			}
		}
	}

	throw new Error(`Executable '${executable}' not found in PATH or common locations`);
}

async function getAbsolutePath(executable) {
	if (path.isAbsolute(executable) && await exists(executable)) {
		return executable;
	}

	try {
		return await findExecutableInPath(executable);
	} catch (_error) {
		return executable;
	}
}

function readFirstLine(filePath) {
	try {
		if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			return '';
		}

		const content = fs.readFileSync(filePath, 'utf8');
		return content.split(/\r?\n/, 1)[0] || '';
	} catch (_error) {
		return '';
	}
}

// 解析后的命令调用结果按命令字符串缓存：lark-cli 本质是个 Node 包装脚本，每次
// runCommand 若都重跑 PATH 扫描（getAbsolutePath）+ 同步读整个脚本首行（readFirstLine），
// 几十次上传调用会放大成几十次重复开销。cliPath / node 路径在运行期内稳定，缓存即可；
// 设置变更（cliPath 改变）会让命令字符串本身变化从而自动换 key，另有 clearInvocationCache 在保存设置时兜底清空。
const invocationCache = new Map();

async function resolveCommandInvocation(command) {
	const cached = invocationCache.get(command);
	if (cached) {
		return cached;
	}

	const resolvedCommand = await getAbsolutePath(command);
	const firstLine = readFirstLine(resolvedCommand);

	let invocation;
	if (/^#!.*\bnode\b/i.test(firstLine)) {
		const nodePath = await getAbsolutePath('node');
		invocation = {
			command: nodePath,
			argsPrefix: [resolvedCommand],
			resolvedCommand
		};
	} else {
		invocation = {
			command: resolvedCommand,
			argsPrefix: [],
			resolvedCommand
		};
	}

	invocationCache.set(command, invocation);
	return invocation;
}

function clearInvocationCache() {
	invocationCache.clear();
}

function extractTrailingJson(text) {
	if (!text) {
		return null;
	}

	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch (_error) {
		// continue
	}

	for (let start = trimmed.lastIndexOf('{'); start >= 0; start = trimmed.lastIndexOf('{', start - 1)) {
		const candidate = trimmed.slice(start);
		try {
			return JSON.parse(candidate);
		} catch (_error) {
			// try earlier opening brace
		}
	}

	return null;
}

function extractErrorMessage(error) {
	const candidates = [
		error?.stdout,
		error?.stderr,
		error?.message
	].filter(Boolean);

	for (const candidate of candidates) {
		const parsed = extractTrailingJson(candidate);
		if (!parsed) {
			continue;
		}

		if (parsed.error?.message) {
			return parsed.error.message;
		}

		if (parsed.message) {
			return parsed.message;
		}
	}

	return (candidates.find(Boolean) || '命令执行失败').trim();
}

// lark-cli 底层由 Go 二进制发起 HTTPS 请求。Go 1.24+ 默认拒绝 RSA 密钥 < 1024 位的
// 证书（报 "certificate is using a broken key size"），而飞书部分 API 端点的证书链命中
// 了该校验，会导致上传中断。这里为 lark-cli 子进程注入 GODEBUG 开关以恢复旧行为；
// 用户已显式设置 GODEBUG 时在其后追加，已包含该开关时不重复，保留覆盖能力。
function buildLarkCliEnv(baseEnv) {
	const env = { ...baseEnv };
	const existing = env.GODEBUG;
	if (existing === undefined || existing === '') {
		env.GODEBUG = 'x509usebrokenkeyscerts=1';
	} else if (!/x509usebrokenkeyscerts=/.test(existing)) {
		env.GODEBUG = `${existing},x509usebrokenkeyscerts=1`;
	}
	return env;
}

async function runCommand(command, args, options = {}) {
	const invocation = await resolveCommandInvocation(command);
	const finalArgs = [...invocation.argsPrefix, ...args];

	try {
		return await execFileAsync(invocation.command, finalArgs, {
			encoding: 'utf8',
			maxBuffer: 50 * 1024 * 1024,
			cwd: options.cwd,
			env: buildLarkCliEnv(process.env),
			windowsHide: true
		});
	} catch (error) {
		const wrapped = new Error(extractErrorMessage(error));
		wrapped.stdout = error.stdout || '';
		wrapped.stderr = error.stderr || '';
		wrapped.exitCode = typeof error.code === 'number' ? error.code : null;
		wrapped.command = invocation.command;
		wrapped.args = finalArgs;
		throw wrapped;
	}
}

async function runMarkdownCommand(command, args, markdown, options = {}) {
	const tempFile = path.join(
		os.tmpdir(),
		`obsidian-to-lark-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
	);
	const tempDir = path.dirname(tempFile);
	const tempName = path.basename(tempFile);

	await fs.promises.writeFile(tempFile, markdown, 'utf8');

	try {
		return await runCommand(command, [...args, '--content', `@./${tempName}`, '--doc-format', 'markdown'], {
			...options,
			cwd: options.cwd || tempDir
		});
	} finally {
		await fs.promises.unlink(tempFile).catch(() => undefined);
	}
}

function stripHighlightTags(value) {
	return String(value || '')
		.replace(/<[^>]+>/g, '')
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.trim();
}

function normalizeDocType(value) {
	if (Array.isArray(value)) {
		return normalizeDocType(value[0]);
	}

	return String(value || '').toUpperCase();
}

function normalizeSearchItem(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}

	const meta = raw.result_meta && typeof raw.result_meta === 'object' ? raw.result_meta : {};
	const title = stripHighlightTags(
		raw.title
		|| raw.title_highlighted
		|| raw.name
		|| raw.obj_title
		|| raw.display_name
	);
	const url = raw.url || raw.doc_url || raw.open_url || raw.web_url || meta.url || '';
	const docId = raw.doc_id || raw.document_id || raw.file_token || raw.obj_token || raw.token || meta.token || '';
	const docType = normalizeDocType(
		raw.doc_type
		|| raw.entity_type
		|| raw.type
		|| raw.obj_type
		|| raw.file_type
		|| raw.result_type
		|| meta.doc_type
		|| meta.entity_type
		|| raw?.result_meta?.doc_type
		|| raw?.result_meta?.doc_types
		|| meta.doc_types
	);

	if (!title && !url && !docId) {
		return null;
	}

	return {
		title,
		url,
		docId,
		docType,
		raw
	};
}

function extractSearchItems(payload) {
	const results = [];
	const seenObjects = new WeakSet();

	function visit(value) {
		if (!value || typeof value !== 'object') {
			return;
		}

		if (seenObjects.has(value)) {
			return;
		}
		seenObjects.add(value);

		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}

		const item = normalizeSearchItem(value);
		if (item) {
			results.push(item);
		}

		for (const nestedValue of Object.values(value)) {
			visit(nestedValue);
		}
	}

	visit(payload);

	const unique = new Map();
	for (const item of results) {
		const key = `${item.docId}::${item.url}::${item.title}::${item.docType}`;
		if (!unique.has(key)) {
			unique.set(key, item);
		}
	}

	return Array.from(unique.values());
}

function parseAuthStatusPayload(status) {
	if (!status || typeof status !== 'object') {
		return {
			success: false,
			message: '未检测到 user 身份授权'
		};
	}

	const nestedUser = status.identities?.user && typeof status.identities.user === 'object'
		? status.identities.user
		: null;
	const userInfo = nestedUser || status;
	const identity = status.identity || status.defaultAs || '';
	const isReady = userInfo.status === 'ready' || userInfo.available === true || identity === 'user';
	const openId = userInfo.userOpenId || userInfo.openId || status.userOpenId || status.openId || '';
	const userName = userInfo.userName || status.userName || '用户';

	if (isReady && (nestedUser || identity === 'user')) {
		return {
			success: true,
			message: `已登录：${userName} (${openId || '未知ID'})`,
			user: userName,
			openId: openId || '未知ID'
		};
	}

	return {
		success: false,
		message: status.error?.message || nestedUser?.message || status.message || '未检测到 user 身份授权'
	};
}

async function getVersionInfo(executablePath) {
	try {
		const { stdout } = await runCommand(executablePath, ['--version']);
		const versionMatch = stdout.match(/version\s+([\d.]+)/i);
		if (versionMatch?.[1]) {
			return versionMatch[1];
		}

		const directVersionMatch = stdout.match(/([\d.]+)(?:\s*\(.*\))?$/);
		if (directVersionMatch?.[1]) {
			return directVersionMatch[1];
		}

		return stdout.replace(/[^\d.]/g, '').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '') || 'unknown';
	} catch (_error) {
		return 'unknown';
	}
}

async function checkAuthStatus(executablePath) {
	try {
		const { stdout } = await runCommand(executablePath, ['auth', 'status']);
		const status = extractTrailingJson(stdout) || {};
		return parseAuthStatusPayload(status);
	} catch (error) {
		return {
			success: false,
			message: extractErrorMessage(error)
		};
	}
}

function formatAuthStatusMessage(status) {
	if (status?.success) {
		return `已授权：${status.user} (${status.openId})`;
	}

	return '未授权';
}

function extractAuthNoWaitInfo(text) {
	const parsed = extractTrailingJson(text);
	const data = parsed?.data || parsed || {};
	const sourceText = text || '';

	const url = data.verification_uri_complete
		|| data.verificationUriComplete
		|| data.verification_url
		|| data.verificationUrl
		|| sourceText.match(/https?:\/\/[^\s]+/)?.[0]
		|| null;

	const deviceCode = data.device_code
		|| data.deviceCode
		|| sourceText.match(/"device_code"\s*:\s*"([^"]+)"/)?.[1]
		|| sourceText.match(/device[_ -]?code[:=]\s*([A-Za-z0-9_-]+)/i)?.[1]
		|| null;

	return { url, deviceCode };
}

function openExternalUrl(url) {
	return new Promise((resolve, reject) => {
		let command = '';
		let args = [];

		if (process.platform === 'darwin') {
			command = 'open';
			args = [url];
		} else if (process.platform === 'win32') {
			command = 'cmd';
			args = ['/c', 'start', '', url];
		} else {
			command = 'xdg-open';
			args = [url];
		}

		const child = execFile(command, args, { windowsHide: true }, (error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});

		child.unref?.();
	});
}

async function beginAuthLogin(executablePath, requiredScopes) {
	const { stdout, stderr } = await runCommand(executablePath, [
		'auth',
		'login',
		'--scope',
		requiredScopes.join(' '),
		'--json',
		'--no-wait'
	]);

	const info = extractAuthNoWaitInfo(`${stdout}\n${stderr}`);
	if (!info.url || !info.deviceCode) {
		throw new Error('无法提取授权链接，请在终端中手动执行 lark-cli auth login --scope "..."');
	}

	return info;
}

async function completeAuthLogin(executablePath, deviceCode) {
	await runCommand(executablePath, ['auth', 'login', '--device-code', deviceCode]);
	return checkAuthStatus(executablePath);
}

const FEISHU_FOLDER_URL_PATTERN = /\/drive\/folder\/([A-Za-z0-9]+)/;

// 把设置项里的「文件夹 token 或飞书云空间文件夹 URL」统一解析成纯 token。
// 纯函数、无网络调用：URL 通过正则直接抽取 /drive/folder/<token> 段。
// - 空 → ''（保持现状：上传/查重走飞书根目录）
// - 非 URL → 原样返回（视为裸 token）
// - 含 /wiki/ → 抛错（暂不支持 Wiki 链接）
// - 匹配 /drive/folder/<token> → 返回该 token
// - 其他 URL → 抛错（无法识别）
function resolveFolderToken(rawValue) {
	const value = String(rawValue || '').trim();
	if (!value) {
		return '';
	}
	if (!/^https?:\/\//i.test(value)) {
		return value;
	}
	if (/\/wiki\//i.test(value)) {
		throw new Error(
			'暂不支持 Wiki 链接，请填写飞书文件夹 token 或云空间文件夹 URL（形如 https://xxx.feishu.cn/drive/folder/fldcnXXXX）。'
		);
	}
	const match = value.match(FEISHU_FOLDER_URL_PATTERN);
	if (match) {
		return match[1];
	}
	throw new Error(
		'无法识别的飞书链接，请确认是云空间文件夹 URL（形如 https://xxx.feishu.cn/drive/folder/fldcnXXXX）或直接填写文件夹 token。'
	);
}

// 解析失败时退化为空（即根目录），用于设置页展示等不应中断的场景。
function safeResolveFolderToken(rawValue) {
	try {
		return resolveFolderToken(rawValue);
	} catch (_error) {
		return '';
	}
}

const MAX_FOLDER_HISTORY = 20;
const ROOT_FOLDER_LABEL = '我的空间（根目录）';
const ADD_FOLDER_OPTION_VALUE = '__add_new_folder__';

function shortenFolderToken(token) {
	const value = String(token || '');
	if (value.length <= 14) {
		return value;
	}
	return `${value.slice(0, 12)}…`;
}

function normalizeFolderHistoryEntry(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}

	const token = String(raw.token || '').trim();
	if (!token) {
		return null;
	}

	const lastUsedAt = Number(raw.lastUsedAt);

	return {
		token,
		name: String(raw.name || '').trim(),
		lastUsedAt: Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? Math.floor(lastUsedAt) : 0
	};
}

// 历史上传位置：按 token 去重（名称与最近使用时间取更有信息量的一方），
// 按最近使用时间倒序，最多保留 MAX_FOLDER_HISTORY 条。
function normalizeFolderHistory(rawList) {
	const list = Array.isArray(rawList) ? rawList : [];
	const byToken = new Map();

	for (const raw of list) {
		const entry = normalizeFolderHistoryEntry(raw);
		if (!entry) {
			continue;
		}

		const existing = byToken.get(entry.token);
		if (!existing) {
			byToken.set(entry.token, entry);
			continue;
		}

		byToken.set(entry.token, {
			token: entry.token,
			name: entry.name || existing.name,
			lastUsedAt: Math.max(existing.lastUsedAt, entry.lastUsedAt)
		});
	}

	return Array.from(byToken.values())
		.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
		.slice(0, MAX_FOLDER_HISTORY);
}

// 新增或更新一条历史：名称为空时保留原有名称（避免刷新失败把备注抹掉）。
function upsertFolderHistoryEntry(list, entry) {
	const normalized = normalizeFolderHistoryEntry(entry);
	const current = normalizeFolderHistory(list);

	if (!normalized) {
		return current;
	}

	const existing = current.find((item) => item.token === normalized.token);
	const merged = existing
		? {
			token: normalized.token,
			name: normalized.name || existing.name,
			lastUsedAt: Math.max(normalized.lastUsedAt, existing.lastUsedAt)
		}
		: normalized;

	return normalizeFolderHistory([
		merged,
		...current.filter((item) => item.token !== normalized.token)
	]);
}

function removeFolderHistoryEntry(list, token) {
	const target = String(token || '').trim();
	return normalizeFolderHistory(list).filter((item) => item.token !== target);
}

// 重命名允许清空（清空后回落到 token 展示）。
function renameFolderHistoryEntry(list, token, name) {
	const target = String(token || '').trim();
	const nextName = String(name || '').trim();

	return normalizeFolderHistory(list).map((item) => (
		item.token === target
			? { token: item.token, name: nextName, lastUsedAt: item.lastUsedAt }
			: item
	));
}

function formatFolderHistoryLabel(entry) {
	const normalized = normalizeFolderHistoryEntry(entry);
	if (!normalized) {
		return ROOT_FOLDER_LABEL;
	}

	return normalized.name
		? `${normalized.name}（${shortenFolderToken(normalized.token)}）`
		: normalized.token;
}

// 下拉选项：根目录固定第一项；当前生效位置若不在历史里，补一条临时项避免选中态丢失。
function buildFolderOptions(history, currentToken) {
	const list = normalizeFolderHistory(history);
	const current = String(currentToken || '').trim();
	const options = [{ value: '', label: ROOT_FOLDER_LABEL }];

	for (const entry of list) {
		options.push({ value: entry.token, label: formatFolderHistoryLabel(entry) });
	}

	if (current && !list.some((item) => item.token === current)) {
		options.push({ value: current, label: `${shortenFolderToken(current)}（未加入历史）` });
	}

	return options;
}

function describeFolderTarget(history, token) {
	const target = String(token || '').trim();
	if (!target) {
		return ROOT_FOLDER_LABEL;
	}

	const entry = normalizeFolderHistory(history).find((item) => item.token === target);
	return entry ? formatFolderHistoryLabel(entry) : target;
}

// 解析 `drive +inspect` 输出。注意：token 不存在时 lark-cli 仍返回 ok:true 但 title 为空，
// 因此这里只负责解析，可用性交给 assertFolderAccessible 兜底校验。
function parseFolderInspectPayload(payload) {
	const root = payload && typeof payload === 'object' ? payload : {};

	if (root.ok === false) {
		throw new Error(root.error?.message || '飞书接口调用失败，无法解析文件夹信息。');
	}

	const data = root.data && typeof root.data === 'object' ? root.data : root;
	const type = String(data.type || '').trim().toLowerCase();

	if (type && type !== 'folder') {
		throw new Error(`目标不是云空间文件夹（识别为 ${type}），请填写文件夹 URL 或文件夹 token。`);
	}

	const token = String(data.token || '').trim();
	if (!token) {
		throw new Error('未能解析出文件夹 token，请确认填写的是云空间文件夹 URL 或 token。');
	}

	return { token, name: String(data.title || '').trim() };
}

const FOLDER_ACCESS_HINT = '请确认文件夹 token / URL 正确，且当前授权账号有访问权限。';

async function assertFolderAccessible(cliPath, token) {
	let stdout = '';

	try {
		({ stdout } = await runCommand(cliPath, [
			'drive',
			'files',
			'list',
			'--as',
			'user',
			'--params',
			JSON.stringify({ folder_token: token, page_size: 1 })
		]));
	} catch (error) {
		throw new Error(`无法访问该文件夹（${extractErrorMessage(error)}）。${FOLDER_ACCESS_HINT}`);
	}

	const payload = extractTrailingJson(stdout) || {};
	if (payload.ok === false) {
		const detail = payload.error?.message ? `（${payload.error.message}）` : '';
		throw new Error(`无法访问该文件夹${detail}。${FOLDER_ACCESS_HINT}`);
	}
}

// 取文件夹名称：优先 inspect 的 title；title 为空说明 token 可能无效，再用文件列表兜底校验。
async function fetchFolderMeta(cliPath, rawValue) {
	const raw = String(rawValue || '').trim();
	const token = resolveFolderToken(raw);

	if (!token) {
		return { token: '', name: ROOT_FOLDER_LABEL };
	}

	const args = ['drive', '+inspect', '--as', 'user', '--url', raw, '--json'];
	if (!/^https?:\/\//i.test(raw)) {
		args.push('--type', 'folder');
	}

	let stdout = '';
	try {
		({ stdout } = await runCommand(cliPath, args));
	} catch (error) {
		throw new Error(`解析文件夹信息失败（${extractErrorMessage(error)}）。${FOLDER_ACCESS_HINT}`);
	}

	const meta = parseFolderInspectPayload(extractTrailingJson(stdout) || {});
	const resolvedToken = meta.token || token;

	if (!meta.name) {
		await assertFolderAccessible(cliPath, resolvedToken);
	}

	return { token: resolvedToken, name: meta.name };
}

class LarkMarkdownUploader {
	constructor(options) {
		this.cliPath = options.cliPath;
		this.folderToken = resolveFolderToken(options.folderToken);
		this.ignoreBlockquotes = options.ignoreBlockquotes === true;
		this.convertSvgToRaster = options.convertSvgToRaster === true;
		this.highlightToCallout = options.highlightToCallout !== false;
		this.calloutEmoji = options.calloutEmoji || '💡';
		this.calloutBackgroundColor = options.calloutBackgroundColor || 'light-blue';
		this.highlightBackgroundColor = options.highlightBackgroundColor || 'light-purple';
		this.reportLog = options.reportLog || (() => undefined);
		this.reportProgress = options.reportProgress || (() => undefined);
	}

	log(message) {
		this.reportLog(message);
	}

	progress(value) {
		this.reportProgress(Math.max(0, Math.min(100, value)));
	}

	async listFilesInTargetFolder() {
		const files = [];
		let pageToken = '';
		const folderToken = this.folderToken || '';

		for (;;) {
			const params = { folder_token: folderToken };
			if (folderToken) {
				params.page_size = 200;
			}
			if (pageToken) {
				params.page_token = pageToken;
			}

			const { stdout } = await runCommand(this.cliPath, [
				'drive',
				'files',
				'list',
				'--as',
				'user',
				'--params',
				JSON.stringify(params)
			]);

			const payload = extractTrailingJson(stdout) || {};
			const data = payload.data || payload;
			const chunk = Array.isArray(data.files) ? data.files : [];
			files.push(...chunk);

			if (!folderToken || !data.has_more || !data.next_page_token) {
				break;
			}

			pageToken = data.next_page_token;
		}

		return files;
	}

	async searchDuplicateDocuments(title) {
		const files = await this.listFilesInTargetFolder();
		return files
			.map((file) => ({
				title: file.name || '',
				url: file.url || '',
				docId: file.token || '',
				docType: normalizeDocType(file.type || ''),
				modifiedTime: Number(file.modified_time || 0)
			}))
			.filter((item) =>
				item.title === title &&
				SEARCHABLE_DOC_TYPES.has(item.docType) &&
				item.docId
			)
			.sort((left, right) => right.modifiedTime - left.modifiedTime);
	}

	async listTargetDocuments() {
		const files = await this.listFilesInTargetFolder();
		return files
			.map((file) => ({
				title: file.name || '',
				url: file.url || '',
				docId: file.token || '',
				docType: normalizeDocType(file.type || ''),
				modifiedTime: Number(file.modified_time || 0)
			}))
			.filter((item) => SEARCHABLE_DOC_TYPES.has(item.docType) && item.docId)
			.sort((left, right) => right.modifiedTime - left.modifiedTime);
	}

	parseMarkdownBlocks(content) {
		const imageMatches = [];
		const mermaidMatches = [];
		const source = String(content || '');

		for (const match of source.matchAll(MERMAID_FENCE_PATTERN)) {
			mermaidMatches.push({
				start: match.index,
				end: match.index + match[0].length,
				type: 'mermaid',
				content: (match[1] || '').replace(/\r\n/g, '\n').replace(/\n+$/, '')
			});
		}

		for (const match of source.matchAll(OBSIDIAN_IMAGE_PATTERN)) {
			if (isWithinRanges(match.index, mermaidMatches)) {
				continue;
			}
			imageMatches.push({
				start: match.index,
				end: match.index + match[0].length,
				type: 'obsidian',
				filename: (match[1] || '').trim(),
				extra: match[2] || ''
			});
		}

		for (const match of source.matchAll(MARKDOWN_IMAGE_PATTERN)) {
			if (isWithinRanges(match.index, mermaidMatches)) {
				continue;
			}
			imageMatches.push({
				start: match.index,
				end: match.index + match[0].length,
				type: 'markdown',
				filename: (match[2] || '').trim(),
				caption: (match[1] || '').trim()
			});
		}

		const contentMatches = [...imageMatches, ...mermaidMatches].sort((left, right) => left.start - right.start);

		const blocks = [];
		let cursor = 0;

		for (const item of contentMatches) {
			const textBefore = source.slice(cursor, item.start);
			if (textBefore.length > 0) {
				blocks.push({ type: 'text', content: textBefore });
			}

			if (item.type === 'mermaid') {
				blocks.push({
					type: 'mermaid',
					content: item.content
				});
			} else {
				blocks.push({
					type: 'image',
					filename: item.filename,
					imageType: item.type,
					extra: item.extra || '',
					caption: item.caption || ''
				});
			}

			cursor = item.end;
		}

		const trailingText = source.slice(cursor);
		if (trailingText.length > 0) {
			blocks.push({ type: 'text', content: trailingText });
		}

		return blocks;
	}

	findVaultRoot(markdownDir) {
		let current = markdownDir;
		while (current && current !== path.dirname(current)) {
			if (fs.existsSync(path.join(current, '.obsidian'))) {
				return current;
			}
			current = path.dirname(current);
		}
		return null;
	}

	findImagePath(filename, markdownDir) {
		const normalized = String(filename || '').replace(/\\/g, '/');
		const parts = normalized.split('/');
		const pureFilename = parts[parts.length - 1];
		const candidates = [
			path.resolve(markdownDir, normalized),
			path.resolve(markdownDir, pureFilename)
		];

		for (const subdir of IMAGE_SEARCH_SUBDIRS) {
			candidates.push(path.resolve(markdownDir, subdir, pureFilename));
			candidates.push(path.resolve(markdownDir, subdir, normalized));
		}

		const vaultRoot = this.findVaultRoot(markdownDir);
		if (vaultRoot) {
			// Obsidian wikilink 的路径是相对于 vault 根的，直接解析完整路径最精确。
			// 这是带路径 wikilink（如 ![[2-Projects/.../img.png]]）的最高优先级命中方式。
			candidates.push(path.resolve(vaultRoot, normalized));
			for (const subdir of IMAGE_SEARCH_SUBDIRS) {
				candidates.push(path.resolve(vaultRoot, subdir, pureFilename));
				candidates.push(path.resolve(vaultRoot, subdir, normalized));
			}
		}

		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}

		// 兜底：剥离图源工具中缀（如 xxx.drawio.png → xxx.png）后再扫一遍同样的目录集合。
		// 仅在精确匹配全部失败时启用，不影响原有定位优先级。
		const fallbackNames = buildImageFallbackFilenames(pureFilename);
		if (fallbackNames.length > 0) {
			const fallbackDirs = [markdownDir];
			for (const subdir of IMAGE_SEARCH_SUBDIRS) {
				fallbackDirs.push(path.resolve(markdownDir, subdir));
			}
			if (vaultRoot) {
				for (const subdir of IMAGE_SEARCH_SUBDIRS) {
					fallbackDirs.push(path.resolve(vaultRoot, subdir));
				}
			}
			for (const dir of fallbackDirs) {
				for (const fallbackName of fallbackNames) {
					const candidate = path.resolve(dir, fallbackName);
					if (fs.existsSync(candidate)) {
						return candidate;
					}
				}
			}
		}

		// 最终兜底：当 wikilink 是纯文件名（无路径）且图片被移到固定搜索目录之外时，
		// 在 vault 内按文件名做一次全局递归搜索，模拟 Obsidian 的「全局按名查找」。
		// 带目录路径的 wikilink 不启此兜底——路径是用户/Obsidian 明确指定的，不应猜。
		const hasPath = normalized !== pureFilename;
		if (vaultRoot && !hasPath) {
			const searchNames = [pureFilename, ...fallbackNames];
			for (const searchName of searchNames) {
				const matches = findFileByNameInTree(vaultRoot, searchName, { findAll: true });
				if (matches.length === 1) {
					return matches[0];
				}
				if (matches.length > 1) {
					const paths = matches.map((p) => `  - ${p}`).join('\n');
					throw new Error(
						`找到多个同名图片文件"${pureFilename}"，请使用带路径的链接来消除歧义：\n${paths}`
					);
				}
			}
		}

		throw new Error(`找不到图片文件：${filename}`);
	}

	async createDocument(title, markdown) {
		const args = this.buildCreateDocumentArgs(title);

		if (this.folderToken) {
			args.push('--parent-token', this.folderToken);
		}

		const { stdout } = await runMarkdownCommand(this.cliPath, args, markdown);
		const payload = extractTrailingJson(stdout) || {};
		const doc = payload.data?.document || payload.data || {};

		const docId = doc.document_id || doc.doc_id || '';
		const docUrl = doc.url || doc.doc_url || '';
		if (!docId || !docUrl) {
			throw new Error('创建飞书文档成功，但未拿到 document_id 或 url');
		}

		return { docId, docUrl };
	}

	buildCreateDocumentArgs(title) {
		return [
			'docs',
			'+create',
			'--api-version',
			'v2',
			'--as',
			'user',
			'--doc-format',
			'markdown',
			'--title',
			title,
			'--json'
		];
	}

	async overwriteDocument(docRef, title, markdown) {
		// +update 没有 --title 参数，而飞书导入会把正文首个一级标题当成文档标题。
		// 这里把文件名以 <title> 标记前置到正文，使其优先于一级标题（与 +create 的 --title 行为一致）。
		const content = withDocumentTitle(markdown, title);
		await runMarkdownCommand(this.cliPath, [
			'docs',
			'+update',
			'--as',
			'user',
			'--doc',
			docRef,
			'--command',
			'overwrite',
			'--api-version',
			'v2'
		], content);
	}

	async appendText(docRef, text) {
		await runMarkdownCommand(this.cliPath, [
			'docs',
			'+update',
			'--as',
			'user',
			'--doc',
			docRef,
			'--command',
			'append',
			'--api-version',
			'v2'
		], text);
	}

	async fetchDocumentMarkdown(docRef) {
		const { stdout } = await runCommand(this.cliPath, [
			'docs',
			'+fetch',
			'--as',
			'user',
			'--doc',
			docRef,
			'--api-version',
			'v2'
		]);
		const payload = extractTrailingJson(stdout) || {};
		return extractFetchedDocumentContent(payload);
	}

	resolveWhiteboardToken(payload, markdownFallback = '') {
		const data = payload?.data || payload || {};
		const boardTokens = data.board_tokens || data.boardTokens || [];
		const newBlocks = Array.isArray(data.document?.new_blocks)
			? data.document.new_blocks
			: [];

		if (Array.isArray(boardTokens) && boardTokens[0]) {
			return boardTokens[0];
		}

		const blockToken = newBlocks.find((item) => item?.block_type === 'whiteboard')?.block_token || '';
		if (blockToken) {
			return blockToken;
		}

		return extractWhiteboardTokenFromMarkdown(markdownFallback);
	}

	resolveImageDisplaySize(imagePath, block = {}) {
		const hinted = block.imageType === 'obsidian'
			? parseObsidianImageSizeHint(block.extra)
			: null;
		const inferred = isSvgFile(imagePath)
			? (() => {
				try {
					return extractSvgDimensions(fs.readFileSync(imagePath, 'utf8'));
				} catch (_error) {
					return null;
				}
			})()
			: null;

		if (hinted?.width && !hinted.height && inferred?.width && inferred?.height) {
			return {
				width: hinted.width,
				height: Math.round(hinted.width * (inferred.height / inferred.width))
			};
		}

		if (hinted?.height && !hinted.width && inferred?.width && inferred?.height) {
			return {
				width: Math.round(hinted.height * (inferred.width / inferred.height)),
				height: hinted.height
			};
		}

		if (hinted) {
			return hinted;
		}

		if (inferred?.width && inferred?.height) {
			return {
				width: DEFAULT_LARK_IMAGE_WIDTH,
				height: Math.round(DEFAULT_LARK_IMAGE_WIDTH * (inferred.height / inferred.width))
			};
		}

		return { width: DEFAULT_LARK_IMAGE_WIDTH };
	}

	async rasterizeSvgWithCanvas(svgContent, outputPath, rasterSize) {
		if (
			typeof document === 'undefined' ||
			typeof Image === 'undefined' ||
			typeof Blob === 'undefined' ||
			typeof URL === 'undefined'
		) {
			return false;
		}

		const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
		const svgUrl = URL.createObjectURL(svgBlob);

		try {
			const image = await new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error('无法在画布中加载 SVG'));
				img.src = svgUrl;
			});

			const canvas = document.createElement('canvas');
			canvas.width = rasterSize.width;
			canvas.height = rasterSize.height;
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('无法创建 SVG 栅格化画布');
			}

			context.clearRect(0, 0, canvas.width, canvas.height);
			context.drawImage(image, 0, 0, canvas.width, canvas.height);

			const pngBlob = await new Promise((resolve, reject) => {
				canvas.toBlob(
					(blob) => (blob ? resolve(blob) : reject(new Error('SVG 转 PNG 失败'))),
					'image/png'
				);
			});

			await fs.promises.writeFile(outputPath, Buffer.from(await pngBlob.arrayBuffer()));
			return true;
		} finally {
			URL.revokeObjectURL(svgUrl);
		}
	}

	async rasterizeSvgWithImageMagick(svgPath, outputPath, rasterSize) {
		let magickPath = '';
		try {
			magickPath = await getAbsolutePath('magick');
		} catch (_error) {
			return false;
		}

		if (!magickPath || magickPath === 'magick' || !await exists(magickPath)) {
			return false;
		}

		await runCommand(magickPath, [
			svgPath,
			'-background',
			'none',
			'-density',
			'576',
			'-resize',
			`${rasterSize.width}x${rasterSize.height}`,
			`PNG32:${outputPath}`
		]);
		return true;
	}

	async prepareImageUploadAsset(imagePath, block = {}) {
		const displaySize = this.resolveImageDisplaySize(imagePath, block);

		if (!isSvgFile(imagePath) || !this.convertSvgToRaster) {
			return {
				uploadPath: imagePath,
				displaySize,
				cleanup: async () => undefined
			};
		}

		const svgContent = await fs.promises.readFile(imagePath, 'utf8');
		const intrinsicSize = extractSvgDimensions(svgContent);
		const rasterSize = getSvgRasterUploadSize(displaySize, intrinsicSize);
		const outputPath = path.join(
			os.tmpdir(),
			`obsidian-to-lark-svg-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
		);

		try {
			const canvasOk = await this.rasterizeSvgWithCanvas(svgContent, outputPath, rasterSize)
				.catch(() => false);
			const magickOk = canvasOk
				? true
				: await this.rasterizeSvgWithImageMagick(imagePath, outputPath, rasterSize).catch(() => false);

			if (!magickOk) {
				throw new Error('当前环境无法将 SVG 转为 PNG，请安装 ImageMagick 或在 Obsidian 桌面端内执行上传');
			}

			this.log(
				`[转换] SVG 转 PNG 上传：${path.basename(imagePath)} -> ${path.basename(outputPath)} (${rasterSize.width}x${rasterSize.height})`
			);

			return {
				uploadPath: outputPath,
				displaySize,
				cleanup: async () => {
					await fs.promises.unlink(outputPath).catch(() => undefined);
				}
			};
		} catch (error) {
			await fs.promises.unlink(outputPath).catch(() => undefined);
			throw error;
		}
	}

	buildMediaInsertArgs(docRef, imagePath, caption, _block = {}, displaySize = null) {
		const imageName = path.basename(imagePath);
		const args = [
			'docs',
			'+media-insert',
			'--as',
			'user',
			'--doc',
			docRef,
			'--file',
			`./${imageName}`
		];

		if (caption) {
			args.push('--caption', caption);
		}
		if (displaySize?.width) {
			args.push('--width', String(displaySize.width));
		}
		if (displaySize?.height) {
			args.push('--height', String(displaySize.height));
		}

		return args;
	}

	async insertImage(docRef, imagePath, caption, block = {}) {
		const prepared = await this.prepareImageUploadAsset(imagePath, block);
		const imageDir = path.dirname(prepared.uploadPath);
		const args = this.buildMediaInsertArgs(docRef, prepared.uploadPath, caption, block, prepared.displaySize);

		try {
			await runCommand(this.cliPath, args, { cwd: imageDir });
		} finally {
			await prepared.cleanup();
		}
	}

	async appendBlankWhiteboard(docRef) {
		const { stdout } = await runMarkdownCommand(this.cliPath, [
			'docs',
			'+update',
			'--as',
			'user',
			'--doc',
			docRef,
			'--command',
			'append',
			'--api-version',
			'v2'
		], '<whiteboard type="blank"></whiteboard>');

		const payload = extractTrailingJson(stdout) || {};
		let whiteboardToken = this.resolveWhiteboardToken(payload);

		if (!whiteboardToken) {
			const markdown = await this.fetchDocumentMarkdown(docRef).catch(() => '');
			whiteboardToken = this.resolveWhiteboardToken(payload, markdown);
		}

		if (!whiteboardToken) {
			throw new Error('已创建空白画板，但未拿到 board token');
		}

		return whiteboardToken;
	}

	async updateWhiteboardFromMermaid(whiteboardToken, mermaidSource) {
		const themed = applyDefaultMermaidTheme(mermaidSource, this.mermaidColorTheme);
		const tempFile = path.join(
			os.tmpdir(),
			`obsidian-to-lark-mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}.mmd`
		);
		await fs.promises.writeFile(tempFile, themed, 'utf8');
		const tempDir = path.dirname(tempFile);
		const tempName = path.basename(tempFile);

		try {
			await runCommand(this.cliPath, [
				'whiteboard',
				'+update',
				'--as',
				'user',
				'--whiteboard-token',
				whiteboardToken,
				'--input_format',
				'mermaid',
				'--source',
				`@./${tempName}`,
				'--overwrite'
			], { cwd: tempDir });
		} finally {
			await fs.promises.unlink(tempFile).catch(() => undefined);
		}
	}

	async insertMermaid(docRef, mermaidSource, processed, total) {
		this.log(`[上传] 插入 Mermaid 画板 ${processed}/${total}`);
		await this.appendText(docRef, serializeMermaidBlock(mermaidSource));
	}

	async upload(markdownPath, options = {}) {
		const title = options.targetTitle || path.parse(markdownPath).name;
		const markdownDir = path.dirname(markdownPath);

		this.progress(5);
		this.log(`[准备] 开始处理：${markdownPath}`);

		const authStatus = await checkAuthStatus(this.cliPath);
		if (!authStatus.success) {
			throw new Error(`飞书授权不可用：${authStatus.message}`);
		}

		this.log(`[准备] 当前授权：${authStatus.message}`);
		this.progress(10);

		const rawContent = await fs.promises.readFile(markdownPath, 'utf8');
		const afterBlockquote = this.ignoreBlockquotes ? stripBlockquotes(rawContent) : rawContent;
		const content = trimCodeBlockTrailingNewlines(afterBlockquote);
		const parsedBlocks = this.parseMarkdownBlocks(content);

		for (const block of parsedBlocks) {
			if (block.type !== 'text') {
				continue;
			}
			block.content = prepareTextBlockContent(block.content, this);
		}

		// 合并相邻文本块，减少 appendText 子进程调用（图片/Mermaid 仍是天然边界，不会被合进文本）。
		const blocks = mergeAdjacentTextBlocks(parsedBlocks);

		const imageCount = blocks.filter((block) => block.type === 'image').length;
		const mermaidCount = blocks.filter((block) => block.type === 'mermaid').length;
		this.log(`[解析] 共拆分 ${blocks.length} 个内容块，其中图片 ${imageCount} 个，Mermaid ${mermaidCount} 个`);
		this.progress(20);

		let docId = options.overwriteTarget?.docId || options.overwriteTarget?.url || '';
		let docUrl = options.overwriteTarget?.url || '';
		let startIndex = 0;

		if (options.overwriteTarget) {
			this.log(`[覆盖] 将覆盖已有文档：${options.overwriteTarget.title}`);
			const initialMarkdown = blocks[0]?.type === 'text' ? blocks[0].content : '';
			await this.overwriteDocument(docId, title, initialMarkdown);
			startIndex = blocks[0]?.type === 'text' ? 1 : 0;
			this.progress(35);
		} else {
			const initialMarkdown = blocks[0]?.type === 'text' ? blocks[0].content : '';
			const created = await this.createDocument(title, initialMarkdown);
			docId = created.docId;
			docUrl = created.docUrl;
			startIndex = blocks[0]?.type === 'text' ? 1 : 0;
			this.log(`[创建] 新文档已创建：${docUrl}`);
			this.progress(35);
		}

		const remainingBlocks = Math.max(blocks.length - startIndex, 1);
		for (let index = startIndex; index < blocks.length; index += 1) {
			const block = blocks[index];
			const processed = index - startIndex + 1;
			const percent = 35 + Math.round((processed / remainingBlocks) * 65);

			if (block.type === 'text') {
				if (!hasMeaningfulMarkdown(block.content)) {
					this.log(`[上传] 跳过空白文字块 ${processed}/${remainingBlocks}`);
					this.progress(percent);
					continue;
				}
				this.log(`[上传] 追加文字块 ${processed}/${remainingBlocks}`);
				await this.appendText(docId, block.content);
			} else if (block.type === 'image') {
				const imagePath = this.findImagePath(block.filename, markdownDir);
				this.log(`[上传] 插入图片 ${processed}/${remainingBlocks}：${path.basename(imagePath)}`);
				await this.insertImage(docId, imagePath, block.caption, block);
			} else {
				await this.insertMermaid(docId, block.content, processed, remainingBlocks);
			}

			this.progress(percent);
		}

		this.progress(100);
		this.log(`[完成] 飞书文档：${docUrl}`);
		return { docId, docUrl, title, blockCount: blocks.length, imageCount, mermaidCount };
	}
}

let ObsidianToLarkPlugin;
// 以下两个 UI 类在 CLI 环境下不会被定义，导出后可在测试里用假 DOM 驱动。
let UploadConfirmModal;
let ObsidianToLarkSettingTab;

if (Plugin) {
	// 上传确认弹窗：顺手做本次上传的目标位置选择，避免为了换目录专门去设置页。
	UploadConfirmModal = class UploadConfirmModal extends Modal {
		constructor(app, plugin, options) {
			super(app);
			this.plugin = plugin;
			this.options = options || {};
			this.resolved = false;
			this.selectedToken = plugin.getCurrentFolderToken();
			this.setAsDefault = false;
			this.promise = new Promise((resolve) => {
				this.resolvePromise = resolve;
			});
		}

		onOpen() {
			const { contentEl } = this;
			contentEl.empty();
			contentEl.createEl('h3', { text: '确认上传到飞书云文档' });
			contentEl.createEl('p', { text: `当前文件：${this.options.markdownPath}` });

			const targetRow = contentEl.createDiv({ cls: 'obsidian-to-lark-target-row' });
			targetRow.createSpan({ cls: 'obsidian-to-lark-target-label', text: '上传到：' });

			const select = targetRow.createEl('select', { cls: 'dropdown obsidian-to-lark-target-select' });
			for (const option of buildFolderOptions(this.plugin.getFolderHistory(), this.selectedToken)) {
				const optionEl = select.createEl('option', { text: option.label });
				optionEl.value = option.value;
			}
			select.value = this.selectedToken;
			select.addEventListener('change', () => {
				this.selectedToken = select.value;
			});

			const defaultRow = contentEl.createDiv({ cls: 'obsidian-to-lark-target-default' });
			const checkbox = defaultRow.createEl('input', { type: 'checkbox' });
			checkbox.id = 'obsidian-to-lark-set-default';
			checkbox.addEventListener('change', () => {
				this.setAsDefault = checkbox.checked;
			});
			const checkboxLabel = defaultRow.createEl('label', { text: '同时设为默认上传位置' });
			checkboxLabel.htmlFor = checkbox.id;

			contentEl.createDiv({
				cls: 'obsidian-to-lark-target-hint',
				text: '不勾选时，这里的选择只对本次上传生效；新增位置请到插件设置里添加。'
			});

			const buttonRow = contentEl.createDiv({ cls: 'obsidian-to-lark-actions' });
			const confirmButton = buttonRow.createEl('button', { text: '确认上传' });
			confirmButton.addClass('mod-cta');
			confirmButton.onclick = () => this.finish(true);

			const cancelButton = buttonRow.createEl('button', { text: '取消' });
			cancelButton.onclick = () => this.finish(false);

			confirmButton.focus();
		}

		onClose() {
			this.contentEl.empty();
			if (!this.resolved) {
				this.finish(false);
			}
		}

		finish(confirmed) {
			if (this.resolved) {
				return;
			}
			this.resolved = true;
			this.resolvePromise({
				confirmed,
				folderToken: this.selectedToken,
				setAsDefault: this.setAsDefault
			});
			this.close();
		}

		async waitForDecision() {
			this.open();
			return this.promise;
		}
	};

	class UploadLogModal extends Modal {
		constructor(app, plugin, options) {
			super(app);
			this.plugin = plugin;
			this.options = options;
			this.progressEl = null;
			this.logEl = null;
			this.resultEl = null;
		}

		onOpen() {
			const { contentEl } = this;
			contentEl.empty();
			contentEl.createEl('h3', { text: '上传到飞书云文档' });
			contentEl.createEl('p', { text: `当前文件：${this.options.markdownPath}` });

			this.progressEl = contentEl.createEl('progress');
			this.progressEl.max = 100;
			this.progressEl.value = 0;
			this.progressEl.addClass('obsidian-to-lark-progress');

			this.logEl = contentEl.createDiv({ cls: 'obsidian-to-lark-log' });
			this.resultEl = contentEl.createDiv({ cls: 'obsidian-to-lark-result' });
			void this.runUpload();
		}

		appendLog(message) {
			this.logEl.createDiv({ text: message });
			this.logEl.scrollTop = this.logEl.scrollHeight;
		}

		setProgress(value) {
			if (this.progressEl) {
				this.progressEl.value = value;
			}
		}

		renderResult(url) {
			this.resultEl.empty();
			this.resultEl.createEl('strong', { text: '飞书文档链接：' });
			this.resultEl.createEl('a', { text: url, href: url });
		}

		async runUpload() {
			try {
				this.appendLog('[检查] 正在检查 lark-cli...');
				const cliInfo = await this.plugin.resolveCliForUpload();
				this.appendLog(`[检查] lark-cli 可用：${cliInfo.path}${cliInfo.version ? ` (${cliInfo.version})` : ''}`);

				const targetFolderToken = typeof this.options.folderToken === 'string'
					? this.options.folderToken
					: this.plugin.settings.folderToken;

				const uploader = new LarkMarkdownUploader({
					cliPath: cliInfo.path,
					folderToken: String(targetFolderToken || '').trim(),
					ignoreBlockquotes: this.plugin.settings.ignoreBlockquotes,
					convertSvgToRaster: this.plugin.settings.convertSvgToRaster,
					highlightToCallout: this.plugin.settings.highlightToCallout,
					calloutEmoji: this.plugin.settings.calloutEmoji,
					calloutBackgroundColor: this.plugin.settings.calloutBackgroundColor,
					highlightBackgroundColor: this.plugin.settings.highlightBackgroundColor,
					reportLog: (message) => this.appendLog(message),
					reportProgress: (value) => this.setProgress(value)
				});
				this.appendLog(`[检查] 上传位置：${this.plugin.describeFolder(uploader.folderToken)}`);

				const title = path.parse(this.options.markdownPath).name;
				let overwriteTarget = null;
				let targetTitle = title;

				try {
					this.appendLog('[检查] 正在检测同名飞书文档...');
					const documents = await uploader.listTargetDocuments();
					const duplicates = documents.filter((item) => item.title === title);
					const uploadPlan = planUploadTarget({
						title,
						duplicates,
						existingTitles: documents.map((item) => item.title),
						autoCreateIfMissing: this.plugin.settings.autoCreateDocWhenMissing,
						duplicateStrategy: this.plugin.settings.duplicateDocStrategy
					});

					if (duplicates.length > 0) {
						this.appendLog(`[检查] 命中 ${duplicates.length} 个同名文档`);
					} else {
						this.appendLog('[检查] 未发现同名飞书文档');
					}

					if (uploadPlan.mode === 'overwrite') {
						overwriteTarget = uploadPlan.target;
						this.appendLog('[检查] 按设置覆盖现有文档');
					} else if (uploadPlan.mode === 'create') {
						targetTitle = uploadPlan.title;
						if (duplicates.length > 0) {
							this.appendLog(`[检查] 按设置新建文档：${targetTitle}`);
						} else {
							this.appendLog('[检查] 按设置自动创建同名新文档');
						}
					} else {
						throw new Error(
							`目标目录下未找到同名飞书文档“${title}”。请先在飞书中手动创建后再上传，或在设置中开启“无同名飞书文档时自动创建”。`
						);
					}
				} catch (error) {
					const message = extractErrorMessage(error);
					if (message.includes('space:document:retrieve')) {
						throw new Error('缺少 space:document:retrieve 授权，无法按目标目录执行同名检测。请在设置页重新授权后重试。');
					}
					throw error;
				}

				const result = await uploader.upload(this.options.markdownPath, {
					overwriteTarget,
					targetTitle
				});
				this.renderResult(result.docUrl);
				new Notice('上传完成', 4000);
			} catch (error) {
				const message = error.message || String(error);
				this.appendLog(`[失败] ${message}`);
				new Notice(message, 6000);
			}
		}

		onClose() {
			this.contentEl.empty();
		}
	}

	ObsidianToLarkPlugin = class ObsidianToLarkPlugin extends Plugin {
		async onload() {
			await this.loadSettings();

			this.addRibbonIcon('upload', '上传当前笔记到飞书云文档', async () => {
				await this.handleUploadCommand();
			});

			this.addCommand({
				id: 'upload-current-note-to-lark',
				name: '上传当前笔记到飞书云文档',
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || file.extension !== 'md') {
						return false;
					}

					if (!checking) {
						void this.handleUploadCommand();
					}

					return true;
				}
			});

			this.addSettingTab(new ObsidianToLarkSettingTab(this.app, this));
		}

		async loadSettings() {
			const loaded = await this.loadData();
			this.settings = normalizeSettings(loaded);
			if (shouldPersistSettings(loaded, this.settings)) {
				await this.saveSettings();
			}
		}

		async saveSettings() {
			this.settings = normalizeSettings(this.settings);
			// 设置变更（含 cliPath）可能改变 lark-cli 解析结果，清空命令调用缓存以便下次重新解析。
			clearInvocationCache();
			await this.saveData(this.settings);
		}

		getConfiguredCliPath() {
			return this.settings.larkCliPath.trim() || 'lark-cli';
		}

		getRequiredAuthScopes() {
			const scopes = Array.isArray(this.settings.requiredAuthScopes)
				? this.settings.requiredAuthScopes
				: [];
			return scopes.filter(Boolean);
		}

		getFolderHistory() {
			return normalizeFolderHistory(this.settings.folderHistory);
		}

		getCurrentFolderToken() {
			return safeResolveFolderToken(this.settings.folderToken);
		}

		describeFolder(token) {
			return describeFolderTarget(this.settings.folderHistory, token);
		}

		async setCurrentFolder(token) {
			const target = String(token || '').trim();
			this.settings.folderToken = target;

			if (target) {
				this.settings.folderHistory = upsertFolderHistoryEntry(this.settings.folderHistory, {
					token: target,
					name: '',
					lastUsedAt: Date.now()
				});
			}

			await this.saveSettings();
			return target;
		}

		async touchFolderUsage(token) {
			const target = String(token || '').trim();
			if (!target) {
				return;
			}

			this.settings.folderHistory = upsertFolderHistoryEntry(this.settings.folderHistory, {
				token: target,
				name: '',
				lastUsedAt: Date.now()
			});
			await this.saveSettings();
		}

		async addFolderToHistory(rawValue) {
			const cliInfo = await this.resolveCliForUpload();
			const meta = await fetchFolderMeta(cliInfo.path, rawValue);

			if (!meta.token) {
				this.settings.folderToken = '';
				await this.saveSettings();
				return meta;
			}

			this.settings.folderHistory = upsertFolderHistoryEntry(this.settings.folderHistory, {
				token: meta.token,
				name: meta.name,
				lastUsedAt: Date.now()
			});
			this.settings.folderToken = meta.token;
			await this.saveSettings();

			return meta;
		}

		async refreshFolderName(token) {
			const target = String(token || '').trim();
			if (!target) {
				return { token: '', name: ROOT_FOLDER_LABEL };
			}

			const cliInfo = await this.resolveCliForUpload();
			const meta = await fetchFolderMeta(cliInfo.path, target);

			if (meta.name) {
				this.settings.folderHistory = renameFolderHistoryEntry(
					this.settings.folderHistory,
					target,
					meta.name
				);
				await this.saveSettings();
			}

			return meta;
		}

		async renameFolder(token, name) {
			this.settings.folderHistory = renameFolderHistoryEntry(this.settings.folderHistory, token, name);
			await this.saveSettings();
		}

		async removeFolder(token) {
			const target = String(token || '').trim();
			this.settings.folderHistory = removeFolderHistoryEntry(this.settings.folderHistory, target);

			const fellBackToRoot = this.getCurrentFolderToken() === target && target !== '';
			if (fellBackToRoot) {
				this.settings.folderToken = '';
			}

			await this.saveSettings();
			return { fellBackToRoot };
		}

		async resolveCliForUpload() {
			const configured = this.getConfiguredCliPath();
			const cliPath = await getAbsolutePath(configured);
			const version = await getVersionInfo(cliPath);

			if (!version || version === 'unknown') {
				await runCommand(cliPath, ['--version']);
			}

			if (this.settings.larkCliPath !== cliPath) {
				this.settings.larkCliPath = cliPath;
				this.settings.lastCheckMessage = version === 'unknown'
					? `检测成功：${cliPath}`
					: `检测成功：${cliPath} (${version})`;
				await this.saveSettings();
			}

			return {
				path: cliPath,
				version: version === 'unknown' ? '' : version
			};
		}

		async checkLarkCli() {
			const cliName = 'lark-cli';

			try {
				const absolutePath = await getAbsolutePath(cliName);
				const version = await getVersionInfo(absolutePath);

				this.settings.larkCliPath = absolutePath;
				this.settings.lastCheckMessage = version === 'unknown'
					? `检测成功：${absolutePath}`
					: `检测成功：${absolutePath} (${version})`;
				await this.saveSettings();

				return {
					success: true,
					message: this.settings.lastCheckMessage,
					absolutePath
				};
			} catch (error) {
				const message = error?.message || '检测 lark-cli 失败';
				this.settings.lastCheckMessage = message;
				await this.saveSettings();
				return { success: false, message };
			}
		}

		async startAuth() {
			const cliPath = this.getConfiguredCliPath();
			const requiredScopes = this.getRequiredAuthScopes();

			try {
				const { url, deviceCode } = await beginAuthLogin(cliPath, requiredScopes);

				try {
					await openExternalUrl(url);
					this.settings.lastAuthMessage = `浏览器已打开，请完成授权：${url}`;
				} catch (_error) {
					this.settings.lastAuthMessage = `请手动打开授权链接：${url}`;
				}

				await this.saveSettings();

				const finalStatus = await completeAuthLogin(cliPath, deviceCode);
				await this.refreshAuthStatus({ save: true, fallbackStatus: finalStatus });
				return { success: finalStatus.success, message: this.settings.lastAuthMessage };
			} catch (error) {
				const message = `授权失败：${error.message || String(error)}`;
				this.settings.lastAuthMessage = message;
				await this.saveSettings();
				return { success: false, message };
			}
		}

		async refreshAuthStatus(options = {}) {
			const save = options.save !== false;
			const fallbackStatus = options.fallbackStatus || null;
			let status = fallbackStatus;

			if (!status) {
				status = await checkAuthStatus(this.getConfiguredCliPath());
			}

			this.settings.lastAuthMessage = formatAuthStatusMessage(status);
			if (save) {
				await this.saveSettings();
			}

			return {
				success: !!status?.success,
				message: this.settings.lastAuthMessage,
				raw: status
			};
		}

		async logoutAuth() {
			try {
				await runCommand(this.getConfiguredCliPath(), ['auth', 'logout']);
				return await this.refreshAuthStatus({ save: true });
			} catch (error) {
				const message = `取消授权失败：${error.message || String(error)}`;
				this.settings.lastAuthMessage = message;
				await this.saveSettings();
				return { success: false, message };
			}
		}

		resolveActiveMarkdownPath(file) {
			const basePath = this.app.vault.adapter?.getBasePath?.();
			if (!basePath) {
				throw new Error('无法获取当前 Vault 根目录，仅支持桌面端文件系统 Vault');
			}

			return path.join(basePath, file.path);
		}

		async handleUploadCommand() {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') {
				new Notice('请先打开一个 Markdown 笔记。', 4000);
				return;
			}

			try {
				const markdownPath = this.resolveActiveMarkdownPath(file);
				const decision = await new UploadConfirmModal(this.app, this, {
					markdownPath
				}).waitForDecision();

				if (!decision.confirmed) {
					new Notice('已取消上传', 3000);
					return;
				}

				if (decision.setAsDefault) {
					await this.setCurrentFolder(decision.folderToken);
				} else {
					await this.touchFolderUsage(decision.folderToken);
				}

				new UploadLogModal(this.app, this, {
					markdownPath,
					folderToken: decision.folderToken
				}).open();
			} catch (error) {
				new Notice(error.message || String(error), 6000);
			}
		}
	};

	ObsidianToLarkSettingTab = class ObsidianToLarkSettingTab extends PluginSettingTab {
		constructor(app, plugin) {
			super(app, plugin);
			this.plugin = plugin;
		}

		async display() {
			const { containerEl } = this;
			containerEl.empty();
			await this.plugin.refreshAuthStatus({ save: true });

			containerEl.createEl('h2', { text: 'Obsidian 转飞书文档' });

			new Setting(containerEl)
				.setName('lark-cli 配置')
				.setDesc('自动检测系统 PATH 和常见位置中的 lark-cli，或手动输入绝对路径。')
				.addText((text) => {
					text.inputEl.addClass('obsidian-to-lark-path-input');
					text
						.setPlaceholder('自动检测中...')
						.setValue(this.plugin.settings.larkCliPath)
						.onChange(async (value) => {
							this.plugin.settings.larkCliPath = value.trim();
							await this.plugin.saveSettings();
						});
				})
				.addButton((button) => {
					button.setButtonText('🔍 检测').onClick(async () => {
						button.setDisabled(true);
						const result = await this.plugin.checkLarkCli();
						new Notice(result.message, 5000);
						await this.display();
					});
				});

			const authSetting = new Setting(containerEl)
				.setName('验证飞书授权')
				.setDesc(this.plugin.settings.lastAuthMessage || '未授权')
				.addButton((button) => {
					button.setButtonText('前往授权').onClick(async () => {
						button.setDisabled(true);
						const result = await this.plugin.startAuth();
						new Notice(result.message, 5000);
						await this.display();
					});
				})
				.addButton((button) => {
					button.setButtonText('取消授权').onClick(async () => {
						button.setDisabled(true);
						const result = await this.plugin.logoutAuth();
						new Notice(result.message, 5000);
						await this.display();
					});
				});

			const scopeWrap = authSetting.descEl.createDiv({ cls: 'obsidian-to-lark-scope-editor' });
			scopeWrap.createDiv({ text: '最低授权 scopes' }).addClass('obsidian-to-lark-scope-label');
			const scopeTextarea = scopeWrap.createEl('textarea', {
				cls: 'obsidian-to-lark-scope-textarea'
			});
			scopeTextarea.rows = 3;
			scopeTextarea.placeholder = 'scope1 scope2 scope3';
			scopeTextarea.value = this.plugin.getRequiredAuthScopes().join(' ');
			scopeTextarea.addEventListener('change', async () => {
				this.plugin.settings.requiredAuthScopes = scopeTextarea.value
					.split(/\s+/)
					.map((item) => item.trim())
					.filter(Boolean);
				await this.plugin.saveSettings();
			});

			new Setting(containerEl)
				.setName('忽略引用块')
				.setDesc('默认关闭。开启后，上传时自动忽略 Markdown 中的引用内容（> 开头的行）。')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.ignoreBlockquotes)
						.onChange(async (value) => {
							this.plugin.settings.ignoreBlockquotes = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('SVG 转 PNG 后上传')
				.setDesc('默认关闭。开启后先转高分辨率 PNG 再上传，提升导出兼容性。')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.convertSvgToRaster)
						.onChange(async (value) => {
							this.plugin.settings.convertSvgToRaster = value;
							await this.plugin.saveSettings();
						});
				});

			this.renderFolderSection(containerEl.createDiv({ cls: 'obsidian-to-lark-folder-section' }));

			new Setting(containerEl)
				.setName('无同名飞书文档时自动创建')
				.setDesc('默认关闭。关闭时，上传前必须先在目标目录存在同名飞书文档。')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.autoCreateDocWhenMissing)
						.onChange(async (value) => {
							this.plugin.settings.autoCreateDocWhenMissing = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('发现同名飞书文档时')
				.setDesc('默认覆盖。可改为新建，新建时自动追加后缀，如 “文档名 (1)”。')
				.addDropdown((dropdown) => {
					dropdown
						.addOption('overwrite', '覆盖')
						.addOption('create_new', '新建')
						.setValue(this.plugin.settings.duplicateDocStrategy)
						.onChange(async (value) => {
							this.plugin.settings.duplicateDocStrategy = value === 'create_new'
								? 'create_new'
								: 'overwrite';
							await this.plugin.saveSettings();
						});
				});

			containerEl.createEl('h3', { text: '行内高亮转换' });

			new Setting(containerEl)
				.setName('==高亮== 背景色')
				.setDesc('Obsidian 的 ==text== 行内高亮将转换为飞书的 <text background-color> 行内样式。')
				.addDropdown((dropdown) => {
					for (const opt of HIGHLIGHT_BACKGROUND_COLOR_OPTIONS) {
						dropdown.addOption(opt.value, opt.label);
					}
					dropdown
						.setValue(this.plugin.settings.highlightBackgroundColor)
						.onChange(async (value) => {
							this.plugin.settings.highlightBackgroundColor = value;
							await this.plugin.saveSettings();
						});
				});

			containerEl.createEl('h3', { text: '高亮块转换' });

			const calloutEmojiSetting = new Setting(containerEl)
				.setName('Callout 图标')
				.setDesc('选择高亮块转换为 Callout 时显示的图标。')
				.addDropdown((dropdown) => {
					for (const opt of CALLOUT_EMOJI_OPTIONS) {
						dropdown.addOption(opt.value, opt.label);
					}
					dropdown
						.setValue(this.plugin.settings.calloutEmoji)
						.onChange(async (value) => {
							this.plugin.settings.calloutEmoji = value;
							await this.plugin.saveSettings();
						});
				});

			const calloutBgSetting = new Setting(containerEl)
				.setName('Callout 背景色')
				.setDesc('选择高亮块转换为 Callout 时的背景颜色。')
				.addDropdown((dropdown) => {
					for (const opt of CALLOUT_BACKGROUND_COLOR_OPTIONS) {
						dropdown.addOption(opt.value, opt.label);
					}
					dropdown
						.setValue(this.plugin.settings.calloutBackgroundColor)
						.onChange(async (value) => {
							this.plugin.settings.calloutBackgroundColor = value;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('转换 <highlight> 为飞书 Callout')
				.setDesc('默认开启。上传时自动将 Markdown 中的 <highlight> 标签转换为飞书文档的 Callout 高亮块。')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.highlightToCallout)
						.onChange(async (value) => {
							this.plugin.settings.highlightToCallout = value;
							await this.plugin.saveSettings();
							updateCalloutSettingsVisibility();
						});
				});

			const updateCalloutSettingsVisibility = () => {
				const show = this.plugin.settings.highlightToCallout;
				calloutEmojiSetting.settingEl.style.display = show ? '' : 'none';
				calloutBgSetting.settingEl.style.display = show ? '' : 'none';
			};

			updateCalloutSettingsVisibility();
		}

		// 上传位置区域会被局部重绘（避免整页 display() 重新拉授权状态）。
		renderFolderSection(sectionEl) {
			sectionEl.empty();

			const currentToken = this.plugin.getCurrentFolderToken();
			const history = this.plugin.getFolderHistory();
			let addRowEl = null;
			let addInputEl = null;

			const showAddRow = (visible) => {
				if (!addRowEl) {
					return;
				}
				addRowEl.style.display = visible ? 'flex' : 'none';
				if (visible && addInputEl) {
					addInputEl.value = '';
					addInputEl.focus();
				}
			};

			new Setting(sectionEl)
				.setName('默认上传位置')
				.setDesc('从历史位置下拉切换，或手动添加新的文件夹 URL / token；留空即上传到飞书根目录（查重也只查根目录）。暂不支持 Wiki 链接。')
				.addDropdown((dropdown) => {
					for (const option of buildFolderOptions(history, currentToken)) {
						dropdown.addOption(option.value, option.label);
					}
					dropdown.addOption(ADD_FOLDER_OPTION_VALUE, '＋ 添加新位置…');
					dropdown.setValue(currentToken);
					dropdown.onChange(async (value) => {
						if (value === ADD_FOLDER_OPTION_VALUE) {
							dropdown.setValue(currentToken);
							showAddRow(true);
							return;
						}

						await this.plugin.setCurrentFolder(value);
						new Notice(`默认上传位置：${this.plugin.describeFolder(value)}`, 4000);
						this.renderFolderSection(sectionEl);
					});
				})
				.addButton((button) => {
					button.setButtonText('＋ 新增').onClick(() => showAddRow(true));
				});

			addRowEl = sectionEl.createDiv({ cls: 'obsidian-to-lark-folder-add' });
			addRowEl.style.display = 'none';
			addInputEl = addRowEl.createEl('input', {
				type: 'text',
				cls: 'obsidian-to-lark-folder-input'
			});
			addInputEl.placeholder = 'https://xxx.feishu.cn/drive/folder/fldcnXXXX 或 fldcnXXXX';

			const confirmButton = addRowEl.createEl('button', { text: '校验并添加' });
			confirmButton.addClass('mod-cta');
			const cancelButton = addRowEl.createEl('button', { text: '取消' });
			cancelButton.onclick = () => showAddRow(false);

			const submitNewFolder = async () => {
				const raw = addInputEl.value.trim();
				if (!raw) {
					new Notice('请先填写文件夹 URL 或 token。', 4000);
					return;
				}

				confirmButton.disabled = true;
				confirmButton.textContent = '校验中…';

				try {
					const meta = await this.plugin.addFolderToHistory(raw);
					new Notice(
						meta.name
							? `已添加并切换到「${meta.name}」`
							: '已添加并切换到该文件夹（未取到名称，可在下方手动备注）',
						5000
					);
					this.renderFolderSection(sectionEl);
				} catch (error) {
					new Notice(extractErrorMessage(error), 7000);
					confirmButton.disabled = false;
					confirmButton.textContent = '校验并添加';
				}
			};

			confirmButton.onclick = () => {
				void submitNewFolder();
			};
			addInputEl.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void submitNewFolder();
				}
			});

			const listEl = sectionEl.createDiv({ cls: 'obsidian-to-lark-folder-list' });

			if (history.length === 0) {
				listEl.createDiv({
					cls: 'obsidian-to-lark-folder-empty',
					text: '还没有历史位置。点「＋ 新增」粘贴飞书文件夹链接，之后就能在上面的下拉里一键切换。'
				});
				return;
			}

			listEl.createDiv({
				cls: 'obsidian-to-lark-folder-list-title',
				text: `历史上传位置（${history.length}）`
			});

			for (const entry of history) {
				const row = listEl.createDiv({ cls: 'obsidian-to-lark-folder-row' });
				const isCurrent = entry.token === currentToken;
				if (isCurrent) {
					row.addClass('is-current');
				}

				row.createSpan({
					cls: 'obsidian-to-lark-folder-tag',
					text: isCurrent ? '当前' : ''
				});

				const nameInput = row.createEl('input', {
					type: 'text',
					cls: 'obsidian-to-lark-folder-name'
				});
				nameInput.value = entry.name;
				nameInput.placeholder = '未命名（可自定义备注）';
				nameInput.addEventListener('change', async () => {
					await this.plugin.renameFolder(entry.token, nameInput.value);
					this.renderFolderSection(sectionEl);
				});

				row.createSpan({ cls: 'obsidian-to-lark-folder-token', text: entry.token });

				const refreshButton = row.createEl('button', { text: '同步名称' });
				refreshButton.onclick = async () => {
					refreshButton.disabled = true;
					refreshButton.textContent = '同步中…';

					try {
						const meta = await this.plugin.refreshFolderName(entry.token);
						new Notice(
							meta.name
								? `已同步名称：${meta.name}`
								: '飞书未返回该文件夹名称，可手动填写备注。',
							5000
						);
						this.renderFolderSection(sectionEl);
					} catch (error) {
						new Notice(extractErrorMessage(error), 7000);
						refreshButton.disabled = false;
						refreshButton.textContent = '同步名称';
					}
				};

				const removeButton = row.createEl('button', { text: '删除' });
				removeButton.addClass('mod-warning');
				removeButton.onclick = async () => {
					const result = await this.plugin.removeFolder(entry.token);
					new Notice(
						result.fellBackToRoot
							? '已删除，当前上传位置回落到根目录。'
							: '已从历史中删除。',
						4000
					);
					this.renderFolderSection(sectionEl);
				};
			}
		}
	};
}

module.exports = ObsidianToLarkPlugin || {};
module.exports.__testables = {
	LarkMarkdownUploader,
	checkAuthStatus,
	beginAuthLogin,
	completeAuthLogin,
	shouldPersistSettings,
	extractSearchItems,
	extractTrailingJson,
	getAbsolutePath,
	parseAuthStatusPayload,
	formatAuthStatusMessage,
	normalizeSettings,
	resolveFolderToken,
	safeResolveFolderToken,
	normalizeFolderHistoryEntry,
	normalizeFolderHistory,
	upsertFolderHistoryEntry,
	removeFolderHistoryEntry,
	renameFolderHistoryEntry,
	formatFolderHistoryLabel,
	buildFolderOptions,
	describeFolderTarget,
	parseFolderInspectPayload,
	fetchFolderMeta,
	UploadConfirmModal,
	ObsidianToLarkSettingTab,
	ROOT_FOLDER_LABEL,
	MAX_FOLDER_HISTORY,
	normalizeMermaidColorTheme,
	extractWhiteboardTokenFromMarkdown,
	extractFetchedDocumentContent,
	convertHighlightToCallout,
	convertObsidianHighlight,
	shieldLeadingInlineTextTag,
	prepareTextBlockContent,
	hasMeaningfulMarkdown,
	serializeMermaidBlock,
	applyDefaultMermaidTheme,
	buildDuplicateDocumentTitle,
	planUploadTarget,
	stripBlockquotes,
	trimCodeBlockTrailingNewlines,
	protectCodeBlocks,
	restoreCodeBlocks,
	extractSvgDimensions,
	parseObsidianImageSizeHint,
	getSvgRasterUploadSize,
	buildImageFallbackFilenames,
	findFileByNameInTree,
	buildLarkCliEnv,
	mergeAdjacentTextBlocks,
	withDocumentTitle,
	escapeXmlText,
	clearInvocationCache,
	resolveCommandInvocation
};
