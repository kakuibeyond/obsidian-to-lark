const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
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
	buildImageFallbackFilenames
} = pluginModule.__testables;

// ---- 纯函数：buildImageFallbackFilenames ----

// drawio 中缀 → 剥离
assert.deepStrictEqual(
	buildImageFallbackFilenames('高管助手-本体实体关系属性.drawio.png'),
	['高管助手-本体实体关系属性.png']
);

// excalidraw 中缀 → 剥离
assert.deepStrictEqual(
	buildImageFallbackFilenames('sketch.excalidraw.png'),
	['sketch.png']
);

// 其他已知图源中缀
assert.deepStrictEqual(buildImageFallbackFilenames('seq.puml.svg'), ['seq.svg']);
assert.deepStrictEqual(buildImageFallbackFilenames('flow.mmd.png'), ['flow.png']);
assert.deepStrictEqual(buildImageFallbackFilenames('flow.mermaid.png'), ['flow.png']);

// 多段文件名：只剥离紧邻最终扩展名的图源中缀
assert.deepStrictEqual(
	buildImageFallbackFilenames('my.diagram.v2.drawio.png'),
	['my.diagram.v2.png']
);

// 中缀大小写不敏感，最终扩展名大小写保留
assert.deepStrictEqual(buildImageFallbackFilenames('arch.DRAWIO.PNG'), ['arch.PNG']);

// 无图源中缀 → 不生成兜底（避免误伤普通多扩展名文件）
assert.deepStrictEqual(buildImageFallbackFilenames('report.2026.pdf'), []);
assert.deepStrictEqual(buildImageFallbackFilenames('archive.tar.gz'), []);

// 无扩展名 / 单段 → 空数组
assert.deepStrictEqual(buildImageFallbackFilenames('readme'), []);
assert.deepStrictEqual(buildImageFallbackFilenames(''), []);
assert.deepStrictEqual(buildImageFallbackFilenames(null), []);
assert.deepStrictEqual(buildImageFallbackFilenames(undefined), []);

// ---- findImagePath：中缀剥离兜底命中 ----

const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

// 场景一：引用 xxx.drawio.png，实际文件是 xxx.png（与当前报错文档一致）
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-img-'));
	try {
		const realFile = path.join(tmpDir, '本体实体关系属性.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = uploader.findImagePath('assets/本体实体关系属性.drawio.png', tmpDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 场景二：实际文件放在 assets 子目录，兜底也能命中
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-img-'));
	try {
		fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
		const realFile = path.join(tmpDir, 'assets', 'arch.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = uploader.findImagePath('arch.excalidraw.png', tmpDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 场景三：精确匹配仍优先于兜底（实际文件名确实带 drawio 中缀时，不应被改写）
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-img-'));
	try {
		const exactFile = path.join(tmpDir, 'diagram.drawio.png');
		fs.writeFileSync(exactFile, 'png-bytes');
		const resolved = uploader.findImagePath('diagram.drawio.png', tmpDir);
		assert.strictEqual(resolved, exactFile);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 场景四：既无精确匹配、也无图源中缀可剥离时，仍抛错
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-img-'));
	try {
		assert.throws(
			() => uploader.findImagePath('missing.png', tmpDir),
			/找不到图片文件：missing\.png/
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

console.log('image fallback resolves drawio/excalidraw middle-infix filenames');
