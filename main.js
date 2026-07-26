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

function convertObsidianHighlight(content, backgroundColor) {
	return String(content || '')
		.split(/\r?\n/)
		.map((line) => {
			const standaloneMatch = line.match(/^\s*==([^\r\n]+?)==\s*$/);
			if (standaloneMatch) {
				return `<p><text background-color="${backgroundColor}">${standaloneMatch[1]}</text></p>`;
			}

			return line.replace(
				/(?<!\=)==([^\r\n]+?)==(?!=)/g,
				(_, text) => `<text background-color="${backgroundColor}">${text}</text>`
			);
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

async function resolveCommandInvocation(command) {
	const resolvedCommand = await getAbsolutePath(command);
	const firstLine = readFirstLine(resolvedCommand);

	if (/^#!.*\bnode\b/i.test(firstLine)) {
		const nodePath = await getAbsolutePath('node');
		return {
			command: nodePath,
			argsPrefix: [resolvedCommand],
			resolvedCommand
		};
	}

	return {
		command: resolvedCommand,
		argsPrefix: [],
		resolvedCommand
	};
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

async function runCommand(command, args, options = {}) {
	const invocation = await resolveCommandInvocation(command);
	const finalArgs = [...invocation.argsPrefix, ...args];

	try {
		return await execFileAsync(invocation.command, finalArgs, {
			encoding: 'utf8',
			maxBuffer: 50 * 1024 * 1024,
			cwd: options.cwd,
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

class LarkMarkdownUploader {
	constructor(options) {
		this.cliPath = options.cliPath;
		this.folderToken = options.folderToken || '';
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
		], markdown);
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
		const blocks = this.parseMarkdownBlocks(content);

		for (const block of blocks) {
			if (block.type !== 'text') {
				continue;
			}
			block.content = prepareTextBlockContent(block.content, this);
		}

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

if (Plugin) {
	class SimpleConfirmModal extends Modal {
		constructor(app, options) {
			super(app);
			this.options = options;
			this.resolved = false;
			this.promise = new Promise((resolve) => {
				this.resolvePromise = resolve;
			});
		}

		onOpen() {
			const { contentEl } = this;
			contentEl.empty();
			contentEl.createEl('h3', { text: this.options.title });
			if (this.options.message) {
				contentEl.createEl('p', { text: this.options.message });
			}
			if (this.options.detail) {
				contentEl.createEl('p', { text: this.options.detail });
			}

			const buttonRow = contentEl.createDiv({ cls: 'obsidian-to-lark-actions' });
			const confirmButton = buttonRow.createEl('button', { text: this.options.confirmText || '确认' });
			confirmButton.addClass('mod-cta');
			confirmButton.onclick = () => this.finish(true);

			const cancelButton = buttonRow.createEl('button', { text: this.options.cancelText || '取消' });
			cancelButton.onclick = () => this.finish(false);
		}

		onClose() {
			this.contentEl.empty();
			if (!this.resolved) {
				this.finish(false);
			}
		}

		finish(result) {
			if (this.resolved) {
				return;
			}
			this.resolved = true;
			this.resolvePromise(result);
			this.close();
		}

		async waitForDecision() {
			this.open();
			return this.promise;
		}
	}

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
				this.appendLog(`[检查] folder_token：${this.plugin.settings.folderToken.trim() || '(未设置，默认根目录查重)'}`);

				const uploader = new LarkMarkdownUploader({
					cliPath: cliInfo.path,
					folderToken: this.plugin.settings.folderToken.trim(),
					ignoreBlockquotes: this.plugin.settings.ignoreBlockquotes,
					convertSvgToRaster: this.plugin.settings.convertSvgToRaster,
					highlightToCallout: this.plugin.settings.highlightToCallout,
					calloutEmoji: this.plugin.settings.calloutEmoji,
					calloutBackgroundColor: this.plugin.settings.calloutBackgroundColor,
					highlightBackgroundColor: this.plugin.settings.highlightBackgroundColor,
					reportLog: (message) => this.appendLog(message),
					reportProgress: (value) => this.setProgress(value)
				});

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
				const confirmed = await new SimpleConfirmModal(this.app, {
					title: '确认上传到飞书云文档',
					message: `当前文件：${markdownPath}`,
					confirmText: '确认上传',
					cancelText: '取消'
				}).waitForDecision();

				if (!confirmed) {
					new Notice('已取消上传', 3000);
					return;
				}

				new UploadLogModal(this.app, this, { markdownPath }).open();
			} catch (error) {
				new Notice(error.message || String(error), 6000);
			}
		}
	};

	class ObsidianToLarkSettingTab extends PluginSettingTab {
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

			new Setting(containerEl)
				.setName('默认 folder_token')
				.setDesc('可选。留空时创建到飞书根目录；查重仅检查根目录。')
				.addText((text) => {
					text
						.setPlaceholder('fldcnxxxxxxxxxxxx')
						.setValue(this.plugin.settings.folderToken)
						.onChange(async (value) => {
							this.plugin.settings.folderToken = value.trim();
							await this.plugin.saveSettings();
						});
				});

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
	}
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
	normalizeMermaidColorTheme,
	extractWhiteboardTokenFromMarkdown,
	extractFetchedDocumentContent,
	convertHighlightToCallout,
	convertObsidianHighlight,
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
	getSvgRasterUploadSize
};
