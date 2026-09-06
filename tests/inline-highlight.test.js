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
	convertObsidianHighlight,
	shieldLeadingInlineTextTag,
	prepareTextBlockContent
} = pluginModule.__testables;

const ZWSP = '\u200B';
const COLOR = 'light-purple';

// --- 行首高亮必须被遮挡，否则飞书会把后续内容整段吞掉 ---
const lineStartConverted = convertObsidianHighlight(
	'==典型错误做法==：拿到企业各种文档，挨个试一下',
	COLOR
);
assert.strictEqual(
	lineStartConverted,
	`${ZWSP}<text background-color="${COLOR}">典型错误做法</text>：拿到企业各种文档，挨个试一下`,
	'行首的 <text> 前应插入零宽空格'
);

// 行内（非行首）高亮不应该被污染
const inlineConverted = convertObsidianHighlight('前缀 ==高亮== 后缀', COLOR);
assert.strictEqual(
	inlineConverted,
	`前缀 <text background-color="${COLOR}">高亮</text> 后缀`,
	'非行首高亮不应插入零宽空格'
);

// 缩进后的行首同样要遮挡
assert.strictEqual(
	convertObsidianHighlight('   ==行首缩进==：内容', COLOR),
	`   ${ZWSP}<text background-color="${COLOR}">行首缩进</text>：内容`,
	'带缩进的行首高亮也应被遮挡（缩进行首保留）'
);

// 整行只有一个高亮时走 <p> 分支，飞书解析正常，不需要遮挡
assert.strictEqual(
	convertObsidianHighlight('==独立高亮==', COLOR),
	`<p><text background-color="${COLOR}">独立高亮</text></p>`,
	'整行高亮仍使用 <p> 包裹'
);

// 用户手写的行首 <text> 标签也要遮挡
assert.strictEqual(
	convertObsidianHighlight('<text background-color="red">手写</text>：后续', COLOR),
	`${ZWSP}<text background-color="red">手写</text>：后续`,
	'手写的行首 <text> 同样应被遮挡'
);

// 多行：每行独立判定
assert.strictEqual(
	convertObsidianHighlight('==A==：甲\n普通行\n==B==：乙', COLOR),
	`${ZWSP}<text background-color="${COLOR}">A</text>：甲\n普通行\n${ZWSP}<text background-color="${COLOR}">B</text>：乙`,
	'多行场景逐行判定'
);

// --- shieldLeadingInlineTextTag 纯函数 ---
assert.strictEqual(shieldLeadingInlineTextTag('<text>x</text>'), `${ZWSP}<text>x</text>`);
assert.strictEqual(shieldLeadingInlineTextTag('  <text>x</text>'), `  ${ZWSP}<text>x</text>`);
assert.strictEqual(shieldLeadingInlineTextTag('a <text>x</text>'), 'a <text>x</text>');
assert.strictEqual(shieldLeadingInlineTextTag('<callout>x</callout>'), '<callout>x</callout>', '块级标签不应被遮挡');
assert.strictEqual(shieldLeadingInlineTextTag(''), '');
assert.strictEqual(shieldLeadingInlineTextTag(null), '');

// --- 代码块内的 == 不应被转换，也不应被遮挡 ---
const withCode = prepareTextBlockContent(
	'```\n==不该转换==\n```\n\n==该转换==：正文',
	{ highlightBackgroundColor: COLOR }
);
assert.ok(withCode.includes('==不该转换=='), '代码块内的高亮语法应保持原样');
assert.ok(
	withCode.includes(`${ZWSP}<text background-color="${COLOR}">该转换</text>：正文`),
	'代码块之外的高亮仍需转换并遮挡'
);

// --- 端到端：用户报告的场景，内容不能被截断 ---
const reported = `5.2 常见误区

==典型错误做法==：拿到企业各种文档，挨个试一下，对比一下哪种 Chunking 方法最好

---

根本不存在脱离文档分布和查询分布的通用最优方案`;

const prepared = prepareTextBlockContent(reported, { highlightBackgroundColor: COLOR });
assert.ok(
	prepared.includes('根本不存在脱离文档分布和查询分布的通用最优方案'),
	'高亮行之后的内容必须完整保留'
);
assert.ok(prepared.startsWith(`5.2 常见误区\n\n${ZWSP}<text`), '高亮行应被遮挡');
assert.ok(!prepared.includes('==典型错误做法=='), '原始 == 语法应被替换掉');

console.log('inline-highlight: 行首高亮遮挡 / 代码块保护 / 端到端内容完整性 all pass');
