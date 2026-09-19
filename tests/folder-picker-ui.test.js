const assert = require('assert');
const Module = require('module');
const path = require('path');

// --- 极简假 DOM ----------------------------------------------------------

class FakeEl {
	constructor(tag = 'div', options = {}) {
		this.tagName = tag;
		this.children = [];
		this.classes = new Set();
		this.style = {};
		this.listeners = {};
		this.textContent = options.text || '';
		this.value = '';
		this.placeholder = '';
		this.disabled = false;
		this.focused = false;

		if (options.type) {
			this.type = options.type;
		}
		for (const cls of String(options.cls || '').split(/\s+/).filter(Boolean)) {
			this.classes.add(cls);
		}
	}

	empty() {
		this.children = [];
	}

	addClass(cls) {
		this.classes.add(cls);
	}

	hasClass(cls) {
		return this.classes.has(cls);
	}

	createEl(tag, options = {}) {
		const el = new FakeEl(tag, options);
		this.children.push(el);
		return el;
	}

	createDiv(options = {}) {
		return this.createEl('div', options);
	}

	createSpan(options = {}) {
		return this.createEl('span', options);
	}

	addEventListener(type, handler) {
		this.listeners[type] = this.listeners[type] || [];
		this.listeners[type].push(handler);
	}

	dispatch(type, event = {}) {
		for (const handler of this.listeners[type] || []) {
			handler(event);
		}
	}

	focus() {
		this.focused = true;
	}

	collect(predicate, acc = []) {
		for (const child of this.children) {
			if (predicate(child)) {
				acc.push(child);
			}
			child.collect(predicate, acc);
		}
		return acc;
	}

	findButton(text) {
		return this.collect((el) => el.tagName === 'button' && el.textContent === text)[0] || null;
	}

	findByClass(cls) {
		return this.collect((el) => el.hasClass(cls));
	}
}

// --- obsidian 桩 ---------------------------------------------------------

const notices = [];

class FakeDropdown {
	constructor() {
		this.options = [];
		this.value = '';
		this.changeHandler = null;
	}

	addOption(value, label) {
		this.options.push({ value, label });
		return this;
	}

	setValue(value) {
		this.value = value;
		return this;
	}

	onChange(handler) {
		this.changeHandler = handler;
		return this;
	}

	async select(value) {
		this.value = value;
		if (this.changeHandler) {
			await this.changeHandler(value);
		}
	}
}

class FakeButtonComponent {
	constructor() {
		this.text = '';
		this.clickHandler = null;
	}

	setButtonText(text) {
		this.text = text;
		return this;
	}

	setDisabled(value) {
		this.disabled = value;
		return this;
	}

	onClick(handler) {
		this.clickHandler = handler;
		return this;
	}

	async click() {
		if (this.clickHandler) {
			await this.clickHandler();
		}
	}
}

const settingRegistry = [];

class FakeSetting {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.name = '';
		this.desc = '';
		this.dropdowns = [];
		this.buttons = [];
		settingRegistry.push(this);
	}

	setName(name) {
		this.name = name;
		return this;
	}

	setDesc(desc) {
		this.desc = desc;
		return this;
	}

	addDropdown(callback) {
		const dropdown = new FakeDropdown();
		this.dropdowns.push(dropdown);
		callback(dropdown);
		return this;
	}

	addButton(callback) {
		const button = new FakeButtonComponent();
		this.buttons.push(button);
		callback(button);
		return this;
	}
}

class FakeNotice {
	constructor(message) {
		notices.push(String(message));
	}
}

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
	if (request === 'obsidian') {
		class FakePlugin {}
		class FakePluginSettingTab {}
		class FakeModal {
			constructor() {
				this.contentEl = new FakeEl('div');
				this.opened = false;
				this.closed = false;
			}

			open() {
				this.opened = true;
				if (typeof this.onOpen === 'function') {
					this.onOpen();
				}
			}

			close() {
				this.closed = true;
			}
		}

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
	ObsidianToLarkSettingTab,
	UploadConfirmModal,
	ROOT_FOLDER_LABEL,
	resolvePluginVersion
} = pluginModule.__testables;

const PluginClass = pluginModule;
const manifestVersion = JSON.parse(
	require('fs').readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8')
).version;

// --- 版本号读取：优先用 Obsidian 注入的 manifest，缺失时回落到 manifest.json ---
assert.strictEqual(
	resolvePluginVersion({ manifest: { version: '9.9.9' } }),
	'9.9.9',
	'有 manifest 时应以 manifest.version 为准'
);
assert.strictEqual(
	resolvePluginVersion({ manifest: { version: ' 1.2.3 ' } }),
	'1.2.3',
	'版本号应去掉首尾空白'
);
assert.strictEqual(
	resolvePluginVersion({}),
	manifestVersion,
	'没有 manifest 时回落到插件目录下的 manifest.json'
);
assert.strictEqual(resolvePluginVersion(null), manifestVersion, '空插件实例安全回落');
assert.strictEqual(
	resolvePluginVersion({ manifest: { version: '' } }),
	manifestVersion,
	'manifest.version 为空时应回落'
);

function createPluginStub(initialSettings) {
	const plugin = new PluginClass();
	plugin.settings = normalizeSettings(initialSettings || {});
	plugin.saveData = async () => {};
	return plugin;
}

function createTab(plugin) {
	const tab = new ObsidianToLarkSettingTab({}, plugin);
	tab.plugin = plugin;
	return tab;
}

(async () => {
	// --- 设置页：历史为空 ----------------------------------------------
	{
		settingRegistry.length = 0;
		const plugin = createPluginStub({});
		const tab = createTab(plugin);
		const section = new FakeEl('div');
		tab.renderFolderSection(section);

		const setting = settingRegistry[0];
		assert.strictEqual(setting.name, '默认上传位置');
		assert.deepStrictEqual(
			setting.dropdowns[0].options.map((item) => item.label),
			[ROOT_FOLDER_LABEL, '＋ 添加新位置…']
		);
		assert.strictEqual(section.findByClass('obsidian-to-lark-folder-empty').length, 1);
	}

	// --- 设置页：历史存在时的展示与切换 ----------------------------------
	{
		settingRegistry.length = 0;
		notices.length = 0;

		const plugin = createPluginStub({
			folderToken: 'fldA',
			folderHistory: [
				{ token: 'fldA', name: 'life', lastUsedAt: 100 },
				{ token: 'fldB', name: 'work', lastUsedAt: 200 }
			]
		});
		const tab = createTab(plugin);
		const section = new FakeEl('div');
		tab.renderFolderSection(section);

		const dropdown = settingRegistry[0].dropdowns[0];
		assert.deepStrictEqual(
			dropdown.options.map((item) => item.label),
			[ROOT_FOLDER_LABEL, 'work（fldB）', 'life（fldA）', '＋ 添加新位置…']
		);
		assert.strictEqual(dropdown.value, 'fldA');

		// 历史行：当前项有标记，且按钮齐全
		const rows = section.findByClass('obsidian-to-lark-folder-row');
		assert.strictEqual(rows.length, 2);
		assert.strictEqual(rows.filter((row) => row.hasClass('is-current')).length, 1);
		assert.ok(section.findButton('同步名称'));
		assert.ok(section.findButton('删除'));

		// 选择历史位置 → 写入默认位置并提示
		await dropdown.select('fldB');
		assert.strictEqual(plugin.settings.folderToken, 'fldB');
		assert.ok(notices.some((item) => item.includes('work')));

		// 选「添加新位置」不会改动设置，只展开输入行
		const addRowBefore = section.findByClass('obsidian-to-lark-folder-add')[0];
		assert.strictEqual(addRowBefore.style.display, 'none');
		const dropdownAfterRerender = settingRegistry[settingRegistry.length - 1].dropdowns[0];
		await dropdownAfterRerender.select('__add_new_folder__');
		assert.strictEqual(plugin.settings.folderToken, 'fldB');
		assert.strictEqual(dropdownAfterRerender.value, 'fldB');
		const addRow = section.findByClass('obsidian-to-lark-folder-add')[0];
		assert.strictEqual(addRow.style.display, 'flex');
	}

	// --- 设置页：空输入直接提交会被拦住（不会触网） -----------------------
	{
		settingRegistry.length = 0;
		notices.length = 0;

		const plugin = createPluginStub({});
		plugin.addFolderToHistory = async () => {
			throw new Error('不应在空输入时调用');
		};
		const tab = createTab(plugin);
		const section = new FakeEl('div');
		tab.renderFolderSection(section);

		section.findButton('校验并添加').onclick();
		await Promise.resolve();
		assert.ok(notices.some((item) => item.includes('请先填写')));
	}

	// --- 设置页：重命名与删除 --------------------------------------------
	{
		settingRegistry.length = 0;
		notices.length = 0;

		const plugin = createPluginStub({
			folderToken: 'fldA',
			folderHistory: [{ token: 'fldA', name: 'life', lastUsedAt: 100 }]
		});
		const tab = createTab(plugin);
		const section = new FakeEl('div');
		tab.renderFolderSection(section);

		const nameInput = section.findByClass('obsidian-to-lark-folder-name')[0];
		nameInput.value = '生活';
		nameInput.dispatch('change');
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(plugin.getFolderHistory()[0].name, '生活');

		await section.findButton('删除').onclick();
		assert.deepStrictEqual(plugin.getFolderHistory(), []);
		assert.strictEqual(plugin.settings.folderToken, '');
		assert.ok(notices.some((item) => item.includes('回落到根目录')));
	}

	// --- 上传确认弹窗：临时切换目标位置 ------------------------------------
	{
		const plugin = createPluginStub({
			folderToken: 'fldA',
			folderHistory: [
				{ token: 'fldA', name: 'life', lastUsedAt: 100 },
				{ token: 'fldB', name: 'work', lastUsedAt: 200 }
			]
		});

		const modal = new UploadConfirmModal({}, plugin, { markdownPath: '/tmp/note.md' });
		const decisionPromise = modal.waitForDecision();

		const select = modal.contentEl.collect((el) => el.tagName === 'select')[0];
		assert.deepStrictEqual(
			select.children.map((option) => option.textContent),
			[ROOT_FOLDER_LABEL, 'work（fldB）', 'life（fldA）']
		);
		assert.strictEqual(select.value, 'fldA');

		// 弹窗除「当前文件」外还要显示插件版本（取自 manifest.json）
		const confirmTexts = modal.contentEl.collect((el) => el.tagName === 'p').map((el) => el.textContent);
		assert.ok(
			confirmTexts.includes('当前文件：/tmp/note.md'),
			'确认弹窗应显示当前文件路径'
		);
		const versionLine = modal.contentEl.findByClass('obsidian-to-lark-plugin-version')[0];
		assert.ok(versionLine, '确认弹窗应渲染插件版本行');
		assert.strictEqual(versionLine.textContent, `插件版本：${manifestVersion}`);

		select.value = 'fldB';
		select.dispatch('change');

		const checkbox = modal.contentEl.collect((el) => el.type === 'checkbox')[0];
		checkbox.checked = true;
		checkbox.dispatch('change');

		modal.contentEl.findButton('确认上传').onclick();
		const decision = await decisionPromise;
		assert.deepStrictEqual(decision, {
			confirmed: true,
			folderToken: 'fldB',
			setAsDefault: true
		});
		// 弹窗本身不写设置，交给调用方决定
		assert.strictEqual(plugin.settings.folderToken, 'fldA');
	}

	// --- 上传确认弹窗：取消 ------------------------------------------------
	{
		const plugin = createPluginStub({});
		// 模拟真实 Obsidian 环境：插件实例带有已加载的 manifest
		plugin.manifest = { version: '1.2.3' };
		const modal = new UploadConfirmModal({}, plugin, { markdownPath: '/tmp/note.md' });
		const decisionPromise = modal.waitForDecision();
		assert.strictEqual(
			modal.contentEl.findByClass('obsidian-to-lark-plugin-version')[0].textContent,
			'插件版本：1.2.3',
			'有 manifest 时应显示 manifest.version'
		);
		modal.contentEl.findButton('取消').onclick();
		const decision = await decisionPromise;
		assert.strictEqual(decision.confirmed, false);
		assert.strictEqual(decision.folderToken, '');
	}

	console.log('folder-picker-ui tests passed');
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
