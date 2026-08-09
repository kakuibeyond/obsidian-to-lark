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
	buildImageFallbackFilenames,
	findFileByNameInTree
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

// ---- findFileByNameInTree：vault 全局按名查找 ----

// 基础：在多层子目录里按名命中
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		fs.mkdirSync(path.join(tmpDir, '课程图片', '第4课'), { recursive: true });
		const realFile = path.join(tmpDir, '课程图片', '第4课', '4-mineru新版本支持更多格式.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = findFileByNameInTree(tmpDir, '4-mineru新版本支持更多格式.png');
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 跳过 .obsidian / .git / 隐藏目录，不在其中匹配
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		fs.mkdirSync(path.join(tmpDir, '.obsidian'), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.obsidian', 'target.png'), 'png-bytes');
		fs.writeFileSync(path.join(tmpDir, '.git', 'target.png'), 'png-bytes');
		fs.mkdirSync(path.join(tmpDir, 'real'), { recursive: true });
		const realFile = path.join(tmpDir, 'real', 'target.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = findFileByNameInTree(tmpDir, 'target.png');
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// 不存在时返回 null
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		assert.strictEqual(findFileByNameInTree(tmpDir, 'nope.png'), null);
		assert.strictEqual(findFileByNameInTree(tmpDir, ''), null);
		assert.strictEqual(findFileByNameInTree('', 'x.png'), null);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// findAll: true — 多个同名文件时返回全部匹配
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		fs.mkdirSync(path.join(tmpDir, 'a', 'b'), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, 'c'), { recursive: true });
		const f1 = path.join(tmpDir, 'a', 'b', 'dup.png');
		const f2 = path.join(tmpDir, 'c', 'dup.png');
		fs.writeFileSync(f1, '1');
		fs.writeFileSync(f2, '2');
		const results = findFileByNameInTree(tmpDir, 'dup.png', { findAll: true });
		assert.strictEqual(results.length, 2);
		assert.ok(results.includes(f1));
		assert.ok(results.includes(f2));
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// findAll: true — 无匹配返回空数组
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		const results = findFileByNameInTree(tmpDir, 'nope.png', { findAll: true });
		assert.ok(Array.isArray(results));
		assert.strictEqual(results.length, 0);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// findAll: true — 唯一匹配返回单元素数组
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tree-'));
	try {
		fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, 'sub', 'only.png'), '1');
		const results = findFileByNameInTree(tmpDir, 'only.png', { findAll: true });
		assert.strictEqual(results.length, 1);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ---- findImagePath：图片移到自定义目录时，vault 全局搜索兜底命中 ----

// 辅助：构造一个带 .obsidian 的模拟 vault 根
function makeFakeVault() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-vault-'));
	fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
	return root;
}

// 场景五：图片放在自定义目录（非 attachments/images/assets/附件），全局搜索命中
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes', '课程');
		fs.mkdirSync(mdDir, { recursive: true });
		const imgDir = path.join(vaultRoot, 'notes', '课程图片', '第4课');
		fs.mkdirSync(imgDir, { recursive: true });
		const realFile = path.join(imgDir, '4-mineru新版本支持更多格式.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = uploader.findImagePath('4-mineru新版本支持更多格式.png', mdDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景六：图源中缀 + 自定义目录组合：引用 xxx.drawio.png，实际 xxx.png 在自定义目录
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		const imgDir = path.join(vaultRoot, '自定义图库');
		fs.mkdirSync(imgDir, { recursive: true });
		const realFile = path.join(imgDir, 'arch.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = uploader.findImagePath('arch.drawio.png', mdDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景七：精确匹配优先于全局搜索（同名文件在当前目录与别处都有，应取当前目录）
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		const exactFile = path.join(mdDir, 'dup.png');
		fs.writeFileSync(exactFile, 'png-bytes');
		const otherFile = path.join(vaultRoot, 'elsewhere', 'dup.png');
		fs.mkdirSync(path.dirname(otherFile), { recursive: true });
		fs.writeFileSync(otherFile, 'png-bytes');
		const resolved = uploader.findImagePath('dup.png', mdDir);
		assert.strictEqual(resolved, exactFile);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景八：vault 内不存在该文件时仍抛错
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		assert.throws(
			() => uploader.findImagePath('missing.png', mdDir),
			/找不到图片文件：missing\.png/
		);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// ---- 带路径 wikilink：Obsidian wikilink 路径相对 vault 根精确命中 ----

// 场景九：两个同名文件在不同目录，带路径 wikilink 应各自精确命中（不会混淆）
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes', '课程');
		fs.mkdirSync(mdDir, { recursive: true });

		const fileA = path.join(vaultRoot, 'Attachments', '4-mineru后端支持.png');
		fs.mkdirSync(path.dirname(fileA), { recursive: true });
		fs.writeFileSync(fileA, 'content-A');

		const fileB = path.join(vaultRoot, '2-Projects', 'lector', '课件附图', '4-mineru后端支持.png');
		fs.mkdirSync(path.dirname(fileB), { recursive: true });
		fs.writeFileSync(fileB, 'content-B');

		// 带路径的 wikilink 应从 vault 根直接精确命中各自文件
		const resolvedA = uploader.findImagePath('Attachments/4-mineru后端支持.png', mdDir);
		assert.strictEqual(resolvedA, fileA);
		const resolvedB = uploader.findImagePath('2-Projects/lector/课件附图/4-mineru后端支持.png', mdDir);
		assert.strictEqual(resolvedB, fileB);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景十：带路径 wikilink 直接从 vault 根解析命中
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		const imgDir = path.join(vaultRoot, '自定义图库', '第4课');
		fs.mkdirSync(imgDir, { recursive: true });
		const realFile = path.join(imgDir, '4-mineru后端支持.png');
		fs.writeFileSync(realFile, 'png-bytes');
		const resolved = uploader.findImagePath('自定义图库/第4课/4-mineru后端支持.png', mdDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景十一：带路径 wikilink 文件不存在时抛错，不走全局搜索
// （即使 vault 里存在同名纯文件名文件，也不应猜出一个替代者）
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		// 放一个同名纯文件名文件在别处——全局搜索如果误触发会找到它
		fs.mkdirSync(path.join(vaultRoot, 'elsewhere'), { recursive: true });
		fs.writeFileSync(path.join(vaultRoot, 'elsewhere', '4-mineru后端支持.png'), 'wrong-content');
		assert.throws(
			() => uploader.findImagePath('不存在的目录/4-mineru后端支持.png', mdDir),
			/找不到图片文件：不存在的目录\/4-mineru后端支持\.png/
		);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景十二：纯文件名链接不存在时，仍触发全局搜索兜底（确认回退行为保留）
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		const imgDir = path.join(vaultRoot, '非标准目录');
		fs.mkdirSync(imgDir, { recursive: true });
		const realFile = path.join(imgDir, '4-mineru后端支持.png');
		fs.writeFileSync(realFile, 'png-bytes');
		// 纯文件名 → 固定目录找不到 → 全局搜索兜底命中（唯一匹配）
		const resolved = uploader.findImagePath('4-mineru后端支持.png', mdDir);
		assert.strictEqual(resolved, realFile);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

// 场景十三：纯文件名链接在 vault 中有多个同名文件（且都不在固定搜索目录内）
// → 全局搜索发现歧义，抛错并列出所有路径
{
	const vaultRoot = makeFakeVault();
	try {
		const mdDir = path.join(vaultRoot, 'notes');
		fs.mkdirSync(mdDir, { recursive: true });
		// 两个同名文件都放在非标准目录（不在 attachments/images/assets/附件 中），
		// 确保精确匹配全部失败、走到全局搜索的多匹配检测。
		const dirA = path.join(vaultRoot, '课程图片');
		const dirB = path.join(vaultRoot, '统一管理');
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, '4-mineru后端支持.png'), 'content-A');
		fs.writeFileSync(path.join(dirB, '4-mineru后端支持.png'), 'content-B');
		assert.throws(
			() => uploader.findImagePath('4-mineru后端支持.png', mdDir),
			/找到多个同名图片文件/
		);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
}

console.log('image fallback resolves drawio/excalidraw middle-infix filenames');
