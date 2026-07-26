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
	buildDuplicateDocumentTitle,
	planUploadTarget
} = pluginModule.__testables;

assert.strictEqual(
	buildDuplicateDocumentTitle('周报', ['周报', '周报 (1)', '周报 (2)']),
	'周报 (3)'
);

assert.deepStrictEqual(
	planUploadTarget({
		title: '周报',
		duplicates: [],
		autoCreateIfMissing: false,
		duplicateStrategy: 'overwrite'
	}),
	{
		mode: 'missing',
		title: '周报'
	}
);

assert.deepStrictEqual(
	planUploadTarget({
		title: '周报',
		duplicates: [],
		autoCreateIfMissing: true,
		duplicateStrategy: 'overwrite'
	}),
	{
		mode: 'create',
		title: '周报'
	}
);

const duplicate = {
	title: '周报',
	docId: 'doc-1',
	url: 'https://example.com/doc-1',
	modifiedTime: 1
};

assert.deepStrictEqual(
	planUploadTarget({
		title: '周报',
		duplicates: [duplicate],
		autoCreateIfMissing: false,
		duplicateStrategy: 'overwrite'
	}),
	{
		mode: 'overwrite',
		title: '周报',
		target: duplicate
	}
);

assert.deepStrictEqual(
	planUploadTarget({
		title: '周报',
		duplicates: [
			duplicate,
			{ title: '周报 (1)', docId: 'doc-2', url: 'https://example.com/doc-2', modifiedTime: 2 }
		],
		autoCreateIfMissing: false,
		duplicateStrategy: 'create_new'
	}),
	{
		mode: 'create',
		title: '周报 (2)'
	}
);

console.log('upload target selection honors auto-create and duplicate strategies');
