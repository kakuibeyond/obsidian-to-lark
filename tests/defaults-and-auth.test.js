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
	normalizeSettings,
	shouldPersistSettings,
	formatAuthStatusMessage,
	formatAuthFailureMessage,
	parseAuthStatusPayload
} = pluginModule.__testables;

const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

assert.strictEqual(uploader.ignoreBlockquotes, false);
assert.strictEqual(uploader.highlightToCallout, true);
assert.strictEqual(uploader.highlightBackgroundColor, 'light-purple');

const defaultSettings = normalizeSettings({});
assert.strictEqual(defaultSettings.larkCliPath, '');
assert.strictEqual(defaultSettings.folderToken, '');
assert.strictEqual(defaultSettings.lastCheckMessage, '');
assert.strictEqual(defaultSettings.lastAuthMessage, '');

assert.strictEqual(normalizeSettings({ mermaidColorTheme: 'classic' }).mermaidColorTheme, undefined);
assert.strictEqual(shouldPersistSettings(null, defaultSettings), true);
assert.strictEqual(
	shouldPersistSettings(
		{
			requiredAuthScopes: [...defaultSettings.requiredAuthScopes]
		},
		defaultSettings
	),
	true
);
assert.strictEqual(shouldPersistSettings(defaultSettings, defaultSettings), false);

const parsed = parseAuthStatusPayload({
	appId: 'cli_xxx',
	identity: 'user',
	identities: {
		user: {
			status: 'ready',
			available: true,
			openId: 'ou_test_123',
			userName: '测试用户'
		}
	}
});

assert.deepStrictEqual(parsed, {
	success: true,
	message: '已登录：测试用户 (ou_test_123)',
	user: '测试用户',
	openId: 'ou_test_123'
});

assert.strictEqual(
	formatAuthStatusMessage(parsed),
	'已授权：测试用户 (ou_test_123)'
);

assert.match(
	formatAuthFailureMessage({ stdout: '[WARN] proxy detected: HTTPS_PROXY=http://127.0.0.1:60226', message: 'killed' }),
	/检测到网络代理异常/
);
assert.match(
	formatAuthFailureMessage({ stderr: 'dial tcp: lookup open.feishu.cn: no such host' }),
	/DNS 解析异常/
);
assert.match(
	formatAuthFailureMessage({ message: 'x509: certificate signed by unknown authority' }),
	/TLS\/证书校验异常/
);
assert.match(
	formatAuthFailureMessage({ message: 'request timed out' }),
	/连接飞书开放平台超时/
);
assert.strictEqual(
	formatAuthFailureMessage({ message: 'scope is invalid' }),
	'授权失败：scope is invalid'
);

console.log('defaults and auth parsing align with requested behavior');
