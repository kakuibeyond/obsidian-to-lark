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
	normalizeSettings,
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
	ROOT_FOLDER_LABEL,
	MAX_FOLDER_HISTORY
} = pluginModule.__testables;

// --- safeResolveFolderToken ---------------------------------------------

assert.strictEqual(safeResolveFolderToken(''), '');
assert.strictEqual(safeResolveFolderToken('fldcnAbc'), 'fldcnAbc');
assert.strictEqual(
	safeResolveFolderToken('https://example.feishu.cn/drive/folder/fldcnFromUrl'),
	'fldcnFromUrl'
);
// Wiki / 未知链接不再抛错，退化为根目录
assert.strictEqual(safeResolveFolderToken('https://example.feishu.cn/wiki/node123'), '');
assert.strictEqual(safeResolveFolderToken('https://example.feishu.cn/docs/doc123'), '');

// --- normalizeFolderHistoryEntry ----------------------------------------

assert.strictEqual(normalizeFolderHistoryEntry(null), null);
assert.strictEqual(normalizeFolderHistoryEntry('fldcnAbc'), null);
assert.strictEqual(normalizeFolderHistoryEntry({ name: '无 token' }), null);
assert.deepStrictEqual(
	normalizeFolderHistoryEntry({ token: '  fldcnAbc  ', name: '  work  ', lastUsedAt: '1700000000000' }),
	{ token: 'fldcnAbc', name: 'work', lastUsedAt: 1700000000000 }
);
assert.deepStrictEqual(
	normalizeFolderHistoryEntry({ token: 'fldcnAbc', lastUsedAt: -1 }),
	{ token: 'fldcnAbc', name: '', lastUsedAt: 0 }
);

// --- normalizeFolderHistory ---------------------------------------------

assert.deepStrictEqual(normalizeFolderHistory(undefined), []);
assert.deepStrictEqual(normalizeFolderHistory('not-an-array'), []);

const messyHistory = normalizeFolderHistory([
	{ token: 'fldA', name: '', lastUsedAt: 100 },
	null,
	{ token: '', name: '空 token' },
	{ token: 'fldB', name: 'work', lastUsedAt: 300 },
	{ token: 'fldA', name: 'life', lastUsedAt: 200 }
]);
assert.deepStrictEqual(messyHistory, [
	{ token: 'fldB', name: 'work', lastUsedAt: 300 },
	{ token: 'fldA', name: 'life', lastUsedAt: 200 }
]);

const overflowHistory = normalizeFolderHistory(
	Array.from({ length: MAX_FOLDER_HISTORY + 5 }, (_unused, index) => ({
		token: `fld${index}`,
		name: `folder-${index}`,
		lastUsedAt: index + 1
	}))
);
assert.strictEqual(overflowHistory.length, MAX_FOLDER_HISTORY);
assert.strictEqual(overflowHistory[0].token, `fld${MAX_FOLDER_HISTORY + 4}`);

// --- upsert / remove / rename -------------------------------------------

const afterInsert = upsertFolderHistoryEntry([], { token: 'fldA', name: 'life', lastUsedAt: 100 });
assert.deepStrictEqual(afterInsert, [{ token: 'fldA', name: 'life', lastUsedAt: 100 }]);

// 名称为空时保留原名称，最近使用时间取更大值
const afterTouch = upsertFolderHistoryEntry(afterInsert, { token: 'fldA', name: '', lastUsedAt: 500 });
assert.deepStrictEqual(afterTouch, [{ token: 'fldA', name: 'life', lastUsedAt: 500 }]);

const afterRename = upsertFolderHistoryEntry(afterTouch, { token: 'fldA', name: '生活', lastUsedAt: 0 });
assert.deepStrictEqual(afterRename, [{ token: 'fldA', name: '生活', lastUsedAt: 500 }]);

// 无效条目不改变原列表
assert.deepStrictEqual(upsertFolderHistoryEntry(afterRename, { token: '   ' }), afterRename);

// 最近使用的排在最前
const twoEntries = upsertFolderHistoryEntry(afterRename, { token: 'fldB', name: 'work', lastUsedAt: 900 });
assert.deepStrictEqual(twoEntries.map((item) => item.token), ['fldB', 'fldA']);

assert.deepStrictEqual(removeFolderHistoryEntry(twoEntries, 'fldB').map((item) => item.token), ['fldA']);
assert.deepStrictEqual(removeFolderHistoryEntry(twoEntries, 'not-exist'), twoEntries);

assert.strictEqual(renameFolderHistoryEntry(twoEntries, 'fldA', '  个人  ')[1].name, '个人');
// 允许清空名称，回落到 token 展示
assert.strictEqual(renameFolderHistoryEntry(twoEntries, 'fldA', '')[1].name, '');

// --- 展示 ----------------------------------------------------------------

assert.strictEqual(formatFolderHistoryLabel(null), ROOT_FOLDER_LABEL);
assert.strictEqual(formatFolderHistoryLabel({ token: 'fldcnOkikBRUXU0ZAKbxesgi3ge' }), 'fldcnOkikBRUXU0ZAKbxesgi3ge');
assert.strictEqual(
	formatFolderHistoryLabel({ token: 'fldcnOkikBRUXU0ZAKbxesgi3ge', name: 'life' }),
	'life（fldcnOkikBRU…）'
);
assert.strictEqual(formatFolderHistoryLabel({ token: 'fldShort', name: 'work' }), 'work（fldShort）');

const options = buildFolderOptions(
	[
		{ token: 'fldA', name: 'life', lastUsedAt: 200 },
		{ token: 'fldB', name: 'work', lastUsedAt: 300 }
	],
	'fldA'
);
assert.deepStrictEqual(options, [
	{ value: '', label: ROOT_FOLDER_LABEL },
	{ value: 'fldB', label: 'work（fldB）' },
	{ value: 'fldA', label: 'life（fldA）' }
]);

// 当前位置不在历史里时补一条临时项，避免下拉选中态丢失
const optionsWithOrphan = buildFolderOptions([{ token: 'fldA', name: 'life' }], 'fldOrphan');
assert.strictEqual(optionsWithOrphan.length, 3);
assert.deepStrictEqual(optionsWithOrphan[2], { value: 'fldOrphan', label: 'fldOrphan（未加入历史）' });

// 根目录不会重复出现临时项
assert.strictEqual(buildFolderOptions([], '').length, 1);

assert.strictEqual(describeFolderTarget([], ''), ROOT_FOLDER_LABEL);
assert.strictEqual(describeFolderTarget([{ token: 'fldA', name: 'life' }], 'fldA'), 'life（fldA）');
assert.strictEqual(describeFolderTarget([], 'fldUnknown'), 'fldUnknown');

// --- parseFolderInspectPayload ------------------------------------------

assert.deepStrictEqual(
	parseFolderInspectPayload({
		ok: true,
		data: { title: 'life', token: 'fldcnOki', type: 'folder' }
	}),
	{ token: 'fldcnOki', name: 'life' }
);

// token 无效时 lark-cli 仍返回 ok:true，只是 title 为空
assert.deepStrictEqual(
	parseFolderInspectPayload({ ok: true, data: { title: '', token: 'fldcnBad', type: 'folder' } }),
	{ token: 'fldcnBad', name: '' }
);

assert.throws(
	() => parseFolderInspectPayload({ ok: false, error: { message: 'permission denied' } }),
	/permission denied/
);

assert.throws(
	() => parseFolderInspectPayload({ ok: true, data: { title: '设计稿', token: 'doccnX', type: 'docx' } }),
	/不是云空间文件夹/
);

assert.throws(
	() => parseFolderInspectPayload({ ok: true, data: { title: 'life', type: 'folder' } }),
	/未能解析出文件夹 token/
);

// --- normalizeSettings 集成 ---------------------------------------------

const freshSettings = normalizeSettings({});
assert.deepStrictEqual(freshSettings.folderHistory, []);
assert.strictEqual(freshSettings.folderToken, '');

// 存量纯 token 配置自动补进历史
const migratedFromToken = normalizeSettings({ folderToken: 'fldcnLegacy' });
assert.strictEqual(migratedFromToken.folderToken, 'fldcnLegacy');
assert.deepStrictEqual(migratedFromToken.folderHistory, [
	{ token: 'fldcnLegacy', name: '', lastUsedAt: 0 }
]);

// 存量 URL 配置收敛成 token 并补进历史
const migratedFromUrl = normalizeSettings({
	folderToken: 'https://example.feishu.cn/drive/folder/fldcnFromUrl'
});
assert.strictEqual(migratedFromUrl.folderToken, 'fldcnFromUrl');
assert.deepStrictEqual(migratedFromUrl.folderHistory.map((item) => item.token), ['fldcnFromUrl']);

// 已在历史中的位置不会重复插入，且名称保留
const keepsExisting = normalizeSettings({
	folderToken: 'fldcnLegacy',
	folderHistory: [{ token: 'fldcnLegacy', name: 'work', lastUsedAt: 42 }]
});
assert.deepStrictEqual(keepsExisting.folderHistory, [
	{ token: 'fldcnLegacy', name: 'work', lastUsedAt: 42 }
]);

// 无法识别的链接不抛错：保留原值，不污染历史
const unknownLink = normalizeSettings({ folderToken: 'https://example.feishu.cn/wiki/node123' });
assert.strictEqual(unknownLink.folderToken, 'https://example.feishu.cn/wiki/node123');
assert.deepStrictEqual(unknownLink.folderHistory, []);

// 脏历史数据不会导致崩溃
const dirtyHistory = normalizeSettings({ folderHistory: [null, 'x', { token: 'fldA' }] });
assert.deepStrictEqual(dirtyHistory.folderHistory, [{ token: 'fldA', name: '', lastUsedAt: 0 }]);

// --- 插件层行为（不涉及网络） -------------------------------------------

const PluginClass = pluginModule;

function createPluginStub(initialSettings) {
	const plugin = new PluginClass();
	plugin.settings = normalizeSettings(initialSettings || {});
	plugin.savedTimes = 0;
	plugin.saveData = async () => {
		plugin.savedTimes += 1;
	};
	return plugin;
}

(async () => {
	const plugin = createPluginStub({
		folderHistory: [
			{ token: 'fldA', name: 'life', lastUsedAt: 100 },
			{ token: 'fldB', name: 'work', lastUsedAt: 200 }
		]
	});

	assert.strictEqual(plugin.getCurrentFolderToken(), '');
	assert.strictEqual(plugin.describeFolder(''), ROOT_FOLDER_LABEL);

	// 切换默认位置会刷新最近使用时间并落盘
	await plugin.setCurrentFolder('fldA');
	assert.strictEqual(plugin.settings.folderToken, 'fldA');
	assert.strictEqual(plugin.getFolderHistory()[0].token, 'fldA');
	assert.ok(plugin.getFolderHistory()[0].lastUsedAt > 200);
	assert.strictEqual(plugin.describeFolder('fldA'), 'life（fldA）');
	assert.strictEqual(plugin.savedTimes, 1);

	// 本次上传的临时选择只刷新使用时间，不改默认位置
	await plugin.touchFolderUsage('fldB');
	assert.strictEqual(plugin.settings.folderToken, 'fldA');
	assert.strictEqual(plugin.getFolderHistory()[0].token, 'fldB');

	// 根目录无需记录历史
	const beforeRootTouch = plugin.savedTimes;
	await plugin.touchFolderUsage('');
	assert.strictEqual(plugin.savedTimes, beforeRootTouch);

	await plugin.renameFolder('fldB', '  工作  ');
	assert.strictEqual(plugin.getFolderHistory()[0].name, '工作');

	// 删除非当前项：默认位置保持不变
	const removeOther = await plugin.removeFolder('fldB');
	assert.strictEqual(removeOther.fellBackToRoot, false);
	assert.strictEqual(plugin.settings.folderToken, 'fldA');

	// 删除当前项：默认位置回落到根目录
	const removeCurrent = await plugin.removeFolder('fldA');
	assert.strictEqual(removeCurrent.fellBackToRoot, true);
	assert.strictEqual(plugin.settings.folderToken, '');
	assert.deepStrictEqual(plugin.getFolderHistory(), []);

	// 切回根目录不会往历史里塞空 token
	await plugin.setCurrentFolder('');
	assert.deepStrictEqual(plugin.settings.folderHistory, []);

	console.log('folder-history tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
