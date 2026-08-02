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
	mergeAdjacentTextBlocks,
	withDocumentTitle,
	escapeXmlText,
	clearInvocationCache,
	resolveCommandInvocation
} = pluginModule.__testables;

// --- mergeAdjacentTextBlocks ---
const inputBlocks = [
	{ type: 'text', content: 'A' },
	{ type: 'image', filename: 'x.png', imageType: 'obsidian', extra: '', caption: '' },
	{ type: 'text', content: 'B' },
	{ type: 'text', content: 'C' },
	{ type: 'mermaid', content: 'graph TD' },
	{ type: 'text', content: '   ' }, // 空白文本块应被丢弃
	{ type: 'text', content: 'D' }
];

const merged = mergeAdjacentTextBlocks(inputBlocks);

assert.deepStrictEqual(merged, [
	{ type: 'text', content: 'A' },
	{ type: 'image', filename: 'x.png', imageType: 'obsidian', extra: '', caption: '' },
	{ type: 'text', content: 'BC' },
	{ type: 'mermaid', content: 'graph TD' },
	{ type: 'text', content: 'D' }
], '相邻文本块应被合并，空白块被丢弃，图片/Mermaid 作为边界保留');
assert.strictEqual(merged.length, 5, '合并后块数减少');

// 合并时应直接拼接原文（不额外插入分隔符），忠实还原逐块追加效果
assert.strictEqual(
	mergeAdjacentTextBlocks([
		{ type: 'text', content: '前文\n' },
		{ type: 'text', content: '\n\n后续' }
	])[0].content,
	'前文\n\n\n后续'
);

// 空输入安全
assert.deepStrictEqual(mergeAdjacentTextBlocks(), [], '空输入返回空数组');
assert.deepStrictEqual(mergeAdjacentTextBlocks(null), [], 'null 输入返回空数组');

// --- withDocumentTitle / escapeXmlText ---
assert.strictEqual(
	withDocumentTitle('# 标题\n正文', '文件名'),
	'<title>文件名</title>\n# 标题\n正文',
	'标题应以 <title> 标记前置到正文'
);
assert.strictEqual(
	escapeXmlText('a<b>&c'),
	'a&lt;b&gt;&amp;c',
	'XML 特殊字符应被转义'
);
assert.strictEqual(
	withDocumentTitle('<b>&</b>', 'a<b>&c'),
	'<title>a&lt;b&gt;&amp;c</title>\n<b>&</b>',
	'标题文本需转义，正文原样保留'
);

// --- resolveCommandInvocation 缓存 ---
(async () => {
	const cmd = 'nonexistent-cli-xyz';
	const first = await resolveCommandInvocation(cmd);
	const second = await resolveCommandInvocation(cmd);
	assert.strictEqual(first, second, '相同命令应命中缓存，返回同一对象');
	assert.ok('command' in first && 'argsPrefix' in first && 'resolvedCommand' in first, '返回结构应含 command/argsPrefix/resolvedCommand');

	clearInvocationCache();
	const third = await resolveCommandInvocation(cmd);
	assert.notStrictEqual(first, third, '清空缓存后应重新解析，返回新对象');
	assert.strictEqual(third.resolvedCommand, cmd, '不存在的命令应回退为自身');

	console.log('perf-and-title: merge / title element / command cache all pass');
})();
