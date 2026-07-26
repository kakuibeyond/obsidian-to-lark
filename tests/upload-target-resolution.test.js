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
	resolveFolderToken,
	LarkMarkdownUploader
} = pluginModule.__testables;

// 空值 → ''（保持现状：走飞书根目录）
assert.strictEqual(resolveFolderToken(''), '');
assert.strictEqual(resolveFolderToken('   '), '');
assert.strictEqual(resolveFolderToken(undefined), '');
assert.strictEqual(resolveFolderToken(null), '');

// 裸 token → 原样返回
assert.strictEqual(resolveFolderToken('fldcnAbc123'), 'fldcnAbc123');
assert.strictEqual(resolveFolderToken('  fldcnX  '), 'fldcnX');

// 飞书云空间文件夹 URL → 抽取 token
assert.strictEqual(
	resolveFolderToken('https://example.feishu.cn/drive/folder/fldcnFolderToken123'),
	'fldcnFolderToken123'
);

// 带 query 参数也能解析
assert.strictEqual(
	resolveFolderToken('https://example.feishu.cn/drive/folder/fldcnFolderToken123?from=source'),
	'fldcnFolderToken123'
);

// 带尾斜杠也能解析
assert.strictEqual(
	resolveFolderToken('https://example.feishu.cn/drive/folder/fldcnFolderToken123/'),
	'fldcnFolderToken123'
);

// http 协议也接受
assert.strictEqual(
	resolveFolderToken('http://example.feishu.cn/drive/folder/fldcnHttp'),
	'fldcnHttp'
);

// Wiki 链接 → 抛错（暂不支持）
assert.throws(
	() => resolveFolderToken('https://example.feishu.cn/wiki/nodeToken123'),
	/暂不支持 Wiki 链接/
);

// 其他无法识别的 URL → 抛错
assert.throws(
	() => resolveFolderToken('https://example.feishu.cn/docs/someDocToken'),
	/无法识别的飞书链接/
);

// 构造函数接入：URL 在构造时被解析成 token
const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: 'https://example.feishu.cn/drive/folder/fldcnFromUrl',
	reportProgress: () => {},
	reportLog: () => {}
});
assert.strictEqual(uploader.folderToken, 'fldcnFromUrl');

// 构造函数接入：空值保持 ''
const emptyUploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});
assert.strictEqual(emptyUploader.folderToken, '');

// 构造函数接入：Wiki 链接在构造时抛错（会被上传流程的外层 try/catch 捕获并提示）
assert.throws(
	() => new LarkMarkdownUploader({
		cliPath: '/tmp/lark-cli',
		folderToken: 'https://example.feishu.cn/wiki/nodeToken123',
		reportProgress: () => {},
		reportLog: () => {}
	}),
	/暂不支持 Wiki 链接/
);

console.log('upload target resolution supports token, folder URL, and rejects wiki links');
