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
	extractWhiteboardTokenFromMarkdown,
	extractFetchedDocumentContent,
	serializeMermaidBlock
} = pluginModule.__testables;

const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

const markdown = [
	'前文',
	'',
	'```mermaid',
	'graph TD',
	'  A[开始] --> B{判断}',
	'  B -->|是| C[处理]',
	'  B -->|否| D[结束]',
	'```',
	'',
	'后文'
].join('\n');

assert.deepStrictEqual(uploader.parseMarkdownBlocks(markdown), [
	{
		type: 'text',
		content: '前文\n\n'
	},
	{
		type: 'mermaid',
		content: [
			'graph TD',
			'  A[开始] --> B{判断}',
			'  B -->|是| C[处理]',
			'  B -->|否| D[结束]'
		].join('\n')
	},
	{
		type: 'text',
		content: '\n\n后文'
	}
]);

assert.strictEqual(
	serializeMermaidBlock('graph TD\nA --> B'),
	'```mermaid\ngraph TD\nA --> B\n```'
);
assert.doesNotMatch(serializeMermaidBlock('graph TD\nA --> B'), /classDef|linkStyle|#[0-9A-Fa-f]{6}/);

assert.deepStrictEqual(
	uploader.buildCreateDocumentArgs('测试文档'),
	[
		'docs',
		'+create',
		'--api-version',
		'v2',
		'--as',
		'user',
		'--doc-format',
		'markdown',
		'--title',
		'测试文档',
		'--json'
	]
);
assert.strictEqual(
	extractWhiteboardTokenFromMarkdown('前文\n<whiteboard token="wbcn_test_latest"/>\n后文'),
	'wbcn_test_latest'
);
assert.strictEqual(
	uploader.resolveWhiteboardToken({ data: {} }, '前文\n<whiteboard token="wbcn_test_latest"/>\n后文'),
	'wbcn_test_latest'
);
assert.strictEqual(
	extractFetchedDocumentContent({
		data: {
			document: {
				content: '前文\n<whiteboard token="wbcn_test_from_fetch"/>\n后文'
			}
		}
	}),
	'前文\n<whiteboard token="wbcn_test_from_fetch"/>\n后文'
);

console.log('mermaid blocks use native markdown conversion without injected colors');
