const assert = require('assert');
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'obsidian') {
		class FakePlugin {}
		class FakePluginSettingTab {}
		class FakeSetting {}
		class FakeNotice {}
		class FakeModal {}

		return {
			Plugin: FakePlugin,
			PluginSettingTab: FakePluginSettingTab,
			Setting: FakeSetting,
			Notice: FakeNotice,
			Modal: FakeModal
		};
	}

	return originalLoad(request, parent, isMain);
};

const pluginModule = require(path.resolve(__dirname, '..', 'main.js'));
Module._load = originalLoad;

const {
	LarkMarkdownUploader,
	convertObsidianHighlight,
	convertHighlightToCallout,
	prepareTextBlockContent,
	hasMeaningfulMarkdown
} = pluginModule.__testables;

const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

assert.strictEqual(uploader.ignoreBlockquotes, false);

const markdown = [
	'前文',
	'![[cover.png]]',
	'',
	'中间正文',
	'',
	'![[diagram.png]]',
	'',
	'tail'
].join('\n');

const blocks = uploader.parseMarkdownBlocks(markdown);

assert.deepStrictEqual(blocks, [
	{
		type: 'text',
		content: '前文\n'
	},
	{
		type: 'image',
		filename: 'cover.png',
		imageType: 'obsidian',
		extra: '',
		caption: ''
	},
	{
		type: 'text',
		content: '\n\n中间正文\n\n'
	},
	{
		type: 'image',
		filename: 'diagram.png',
		imageType: 'obsidian',
		extra: '',
		caption: ''
	},
	{
		type: 'text',
		content: '\n\ntail'
	}
]);

const highlighted = [
	'==测试一句话==',
	'后面的正文也要保留。',
	'',
	'普通段落'
].join('\n');

assert.strictEqual(
	convertObsidianHighlight(highlighted, 'yellow'),
	[
		'<p><text background-color="yellow">测试一句话</text></p>',
		'后面的正文也要保留。',
		'',
		'普通段落'
	].join('\n')
);

assert.strictEqual(
	convertObsidianHighlight('普通句子里有 ==高亮片段== 和后续内容。', 'yellow'),
	'普通句子里有 <text background-color="yellow">高亮片段</text> 和后续内容。'
);

assert.strictEqual(
	convertHighlightToCallout('<highlight>\n重点内容\n</highlight>', '💡', 'light-blue'),
	'<callout emoji="💡" background-color="light-blue" border-color="light-blue">\n重点内容\n</callout>'
);
assert.ok(
	convertHighlightToCallout('<highlight>\n重点内容\n</highlight>', '💡', 'light-blue').includes('border-color="light-blue"')
);

assert.strictEqual(
	prepareTextBlockContent([
		'普通句子里有 ==行内重点==。',
		'',
		'<highlight>',
		'Callout 内容',
		'</highlight>',
		'',
		'```md',
		'==代码内不转换==',
		'<highlight>代码标签不转换</highlight>',
		'```'
	].join('\n'), {
		highlightBackgroundColor: 'yellow',
		highlightToCallout: true,
		calloutEmoji: '💡',
		calloutBackgroundColor: 'light-blue'
	}),
	[
		'普通句子里有 <text background-color="yellow">行内重点</text>。',
		'',
		'<callout emoji="💡" background-color="light-blue" border-color="light-blue">',
		'Callout 内容',
		'</callout>',
		'',
		'```md',
		'==代码内不转换==',
		'<highlight>代码标签不转换</highlight>',
		'```'
	].join('\n')
);

assert.strictEqual(hasMeaningfulMarkdown('\n  \n\t'), false);
assert.strictEqual(hasMeaningfulMarkdown('\n正文\n'), true);
assert.strictEqual(hasMeaningfulMarkdown('```mermaid\ngraph TD\nA --> B\n```'), true);

console.log('parse-markdown-blocks preserves blank lines between image blocks');
