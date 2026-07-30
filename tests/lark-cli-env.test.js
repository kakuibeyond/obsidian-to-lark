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

const { buildLarkCliEnv } = pluginModule.__testables;

// 无 GODEBUG → 注入开关，其余环境变量保留
assert.strictEqual(buildLarkCliEnv({}).GODEBUG, 'x509usebrokenkeyscerts=1');
assert.strictEqual(buildLarkCliEnv({ PATH: '/usr/bin' }).GODEBUG, 'x509usebrokenkeyscerts=1');
assert.strictEqual(buildLarkCliEnv({ PATH: '/usr/bin' }).PATH, '/usr/bin');

// 空 GODEBUG → 注入开关
assert.strictEqual(buildLarkCliEnv({ GODEBUG: '' }).GODEBUG, 'x509usebrokenkeyscerts=1');

// 已有其他 GODEBUG → 追加（逗号分隔）
assert.strictEqual(
	buildLarkCliEnv({ GODEBUG: 'rsa1024min=0' }).GODEBUG,
	'rsa1024min=0,x509usebrokenkeyscerts=1'
);

// 已包含该开关 → 不重复
assert.strictEqual(
	buildLarkCliEnv({ GODEBUG: 'x509usebrokenkeyscerts=1' }).GODEBUG,
	'x509usebrokenkeyscerts=1'
);
assert.strictEqual(
	buildLarkCliEnv({ GODEBUG: 'rsa1024min=0,x509usebrokenkeyscerts=1' }).GODEBUG,
	'rsa1024min=0,x509usebrokenkeyscerts=1'
);

// 不修改原始 baseEnv（纯函数）
const original = { PATH: '/usr/bin' };
buildLarkCliEnv(original);
assert.strictEqual(original.GODEBUG, undefined);

console.log('buildLarkCliEnv injects x509usebrokenkeyscerts GODEBUG for lark-cli subprocess');
