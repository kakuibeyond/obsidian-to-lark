#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pluginModule = require('./main.js');
const {
	LarkMarkdownUploader,
	normalizeSettings,
	planUploadTarget,
	describeFolderTarget
} = pluginModule.__testables;

const CLI_USAGE = [
	'Obsidian to Lark CLI',
	'',
	'Usage:',
	'  node cli.js <markdown-path> [options]',
	'  ./upload-to-lark.sh <markdown-path> [options]',
	'',
	'Options:',
	'  --help                              Show this help message',
	'  --title <title>                     Override the target doc title',
	'  --lark-cli-path <path>              Override lark-cli executable path',
	'  --folder-token <token>              Override target folder token or Feishu drive folder URL',
	'  --auto-create                       Auto create doc when missing',
	'  --no-auto-create                    Require existing same-name doc',
	'  --duplicate-strategy <mode>         overwrite | create_new',
	'  --ignore-blockquotes                Ignore Markdown blockquotes',
	'  --keep-blockquotes                  Keep blockquotes in upload',
	'  --svg-to-png                        Rasterize SVG before upload',
	'  --no-svg-to-png                     Keep SVG as-is',
	'  --highlight-to-callout              Convert <highlight> to callout',
	'  --no-highlight-to-callout           Keep <highlight> tags untouched',
	'  --callout-emoji <emoji>             Callout emoji',
	'  --callout-background-color <color>  Callout background color',
	'  --highlight-background-color <c>    Inline highlight background color',
	'',
	'Notes:',
	'  - Local defaults are loaded from ./data.json when present.',
	'  - Missing ./data.json falls back to code defaults in main.js.'
].join('\n');

function parseCliArgs(argv) {
	const args = Array.isArray(argv) ? [...argv] : [];
	const result = {
		command: 'upload',
		markdownPath: '',
		help: false,
		overrides: {}
	};

	const takeValue = (index, flag) => {
		const value = args[index + 1];
		if (!value || value.startsWith('--')) {
			throw new Error(`${flag} requires a value`);
		}
		return value;
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (arg === '--help' || arg === '-h') {
			result.command = 'help';
			result.help = true;
			continue;
		}

		if (!arg.startsWith('--') && !result.markdownPath) {
			result.markdownPath = arg;
			continue;
		}

		switch (arg) {
		case '--title':
			result.overrides.targetTitle = takeValue(index, arg);
			index += 1;
			break;
		case '--lark-cli-path':
			result.overrides.larkCliPath = takeValue(index, arg);
			index += 1;
			break;
		case '--folder-token':
			result.overrides.folderToken = takeValue(index, arg);
			index += 1;
			break;
		case '--duplicate-strategy':
			result.overrides.duplicateDocStrategy = takeValue(index, arg);
			index += 1;
			break;
		case '--callout-emoji':
			result.overrides.calloutEmoji = takeValue(index, arg);
			index += 1;
			break;
		case '--callout-background-color':
			result.overrides.calloutBackgroundColor = takeValue(index, arg);
			index += 1;
			break;
		case '--highlight-background-color':
			result.overrides.highlightBackgroundColor = takeValue(index, arg);
			index += 1;
			break;
		case '--auto-create':
			result.overrides.autoCreateDocWhenMissing = true;
			break;
		case '--no-auto-create':
			result.overrides.autoCreateDocWhenMissing = false;
			break;
		case '--ignore-blockquotes':
			result.overrides.ignoreBlockquotes = true;
			break;
		case '--keep-blockquotes':
			result.overrides.ignoreBlockquotes = false;
			break;
		case '--svg-to-png':
			result.overrides.convertSvgToRaster = true;
			break;
		case '--no-svg-to-png':
			result.overrides.convertSvgToRaster = false;
			break;
		case '--highlight-to-callout':
			result.overrides.highlightToCallout = true;
			break;
		case '--no-highlight-to-callout':
			result.overrides.highlightToCallout = false;
			break;
		default:
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!result.help && !result.markdownPath) {
		throw new Error('markdown path is required');
	}

	return result;
}

function buildCliSettings(baseSettings, overrides) {
	return normalizeSettings(Object.assign({}, baseSettings || {}, overrides || {}));
}

function loadSettingsFile(dataFilePath) {
	try {
		return JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

async function runUploadFromCli(options = {}, dependencies = {}) {
	const logger = dependencies.logger || console;
	const dataFilePath = dependencies.dataFilePath || path.join(__dirname, 'data.json');
	const baseSettings = normalizeSettings(loadSettingsFile(dataFilePath));
	const settings = buildCliSettings(baseSettings, options.overrides);
	const markdownPath = path.resolve(options.markdownPath);

	if (!fs.existsSync(markdownPath)) {
		throw new Error(`Markdown file not found: ${markdownPath}`);
	}

	const uploader = new LarkMarkdownUploader({
		cliPath: settings.larkCliPath || 'lark-cli',
		folderToken: settings.folderToken,
		ignoreBlockquotes: settings.ignoreBlockquotes,
		convertSvgToRaster: settings.convertSvgToRaster,
		highlightToCallout: settings.highlightToCallout,
		calloutEmoji: settings.calloutEmoji,
		calloutBackgroundColor: settings.calloutBackgroundColor,
		highlightBackgroundColor: settings.highlightBackgroundColor,
		reportLog: (message) => logger.log(message),
		reportProgress: (value) => logger.log(`[progress] ${value}`)
	});

	const baseTitle = options.overrides?.targetTitle || path.parse(markdownPath).name;
	logger.log(`[检查] 准备上传：${markdownPath}`);
	logger.log(`[检查] 上传位置：${describeFolderTarget(settings.folderHistory, uploader.folderToken)}`);

	const documents = await uploader.listTargetDocuments();
	const duplicates = documents.filter((item) => item.title === baseTitle);
	const uploadPlan = planUploadTarget({
		title: baseTitle,
		duplicates,
		existingTitles: documents.map((item) => item.title),
		autoCreateIfMissing: settings.autoCreateDocWhenMissing,
		duplicateStrategy: settings.duplicateDocStrategy
	});

	let overwriteTarget = null;
	let targetTitle = baseTitle;

	if (uploadPlan.mode === 'overwrite') {
		overwriteTarget = uploadPlan.target;
		logger.log(`[检查] 按设置覆盖现有文档：${overwriteTarget.title}`);
	} else if (uploadPlan.mode === 'create') {
		targetTitle = uploadPlan.title;
		logger.log(`[检查] 按设置创建文档：${targetTitle}`);
	} else {
		throw new Error(
			`目标目录下未找到同名飞书文档“${baseTitle}”。请先在飞书中手动创建后再上传，或使用 --auto-create。`
		);
	}

	const result = await uploader.upload(markdownPath, {
		overwriteTarget,
		targetTitle
	});

	logger.log(`[结果] ${result.docUrl}`);
	return result;
}

async function runCli(argv, dependencies = {}) {
	let parsed;
	try {
		parsed = parseCliArgs(argv);
	} catch (error) {
		(dependencies.stderr || process.stderr).write(`${error.message}\n\n${CLI_USAGE}\n`);
		return { exitCode: 1 };
	}

	if (parsed.help) {
		(dependencies.stdout || process.stdout).write(`${CLI_USAGE}\n`);
		return { exitCode: 0 };
	}

	try {
		const result = await runUploadFromCli(parsed, dependencies);
		return { exitCode: 0, result };
	} catch (error) {
		(dependencies.stderr || process.stderr).write(`${error.message || String(error)}\n`);
		return { exitCode: 1 };
	}
}

if (require.main === module) {
	runCli(process.argv.slice(2)).then(({ exitCode }) => {
		process.exit(exitCode);
	});
}

module.exports = {
	runCli,
	__testables: {
		parseCliArgs,
		buildCliSettings,
		loadSettingsFile,
		runUploadFromCli,
		CLI_USAGE
	}
};
