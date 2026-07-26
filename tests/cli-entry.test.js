const assert = require('assert');
const path = require('path');

const cliModule = require(path.resolve(__dirname, '..', 'cli.js'));

const {
	parseCliArgs,
	buildCliSettings
} = cliModule.__testables;

assert.deepStrictEqual(
	parseCliArgs([
		'docs/plans/测试文档.md',
		'--title', '手动标题',
		'--folder-token', 'fldcn_test',
		'--duplicate-strategy', 'create_new',
		'--auto-create',
		'--ignore-blockquotes',
		'--svg-to-png'
	]),
	{
		command: 'upload',
		markdownPath: 'docs/plans/测试文档.md',
		help: false,
		overrides: {
			targetTitle: '手动标题',
			folderToken: 'fldcn_test',
			duplicateDocStrategy: 'create_new',
			autoCreateDocWhenMissing: true,
			ignoreBlockquotes: true,
			convertSvgToRaster: true
		}
	}
);

assert.deepStrictEqual(
	parseCliArgs([
		'note.md',
		'--no-auto-create',
		'--keep-blockquotes',
		'--no-svg-to-png',
		'--no-highlight-to-callout'
	]).overrides,
	{
		autoCreateDocWhenMissing: false,
		ignoreBlockquotes: false,
		convertSvgToRaster: false,
		highlightToCallout: false
	}
);

assert.deepStrictEqual(
	parseCliArgs(['--help']),
	{
		command: 'help',
		markdownPath: '',
		help: true,
		overrides: {}
	}
);

const merged = buildCliSettings(
	{
		folderToken: '',
		duplicateDocStrategy: 'overwrite',
		autoCreateDocWhenMissing: false,
		ignoreBlockquotes: false,
		convertSvgToRaster: false
	},
	{
		folderToken: 'fldcn_test',
		autoCreateDocWhenMissing: true
	}
);

assert.strictEqual(merged.folderToken, 'fldcn_test');
assert.strictEqual(merged.autoCreateDocWhenMissing, true);
assert.strictEqual(merged.duplicateDocStrategy, 'overwrite');

console.log('cli entry parsing and settings merge align with upload expectations');
