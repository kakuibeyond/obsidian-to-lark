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
	extractSvgDimensions,
	parseObsidianImageSizeHint,
	getSvgRasterUploadSize
} = pluginModule.__testables;

const uploader = new LarkMarkdownUploader({
	cliPath: '/tmp/lark-cli',
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

const svgMarkup = [
	'<svg viewBox="0 0 680 1110" width="100%" xmlns="http://www.w3.org/2000/svg">',
	'<rect x="0" y="0" width="680" height="1110" />',
	'</svg>'
].join('');

assert.deepStrictEqual(extractSvgDimensions(svgMarkup), {
	width: 680,
	height: 1110
});

assert.deepStrictEqual(parseObsidianImageSizeHint('300'), {
	width: 300
});

assert.deepStrictEqual(parseObsidianImageSizeHint('320x180'), {
	width: 320,
	height: 180
});

assert.deepStrictEqual(
	getSvgRasterUploadSize({ width: 1200, height: 1959 }, { width: 680, height: 1110 }),
	{ width: 4800, height: 7835 }
);

assert.deepStrictEqual(
	getSvgRasterUploadSize({ width: 300, height: 490 }, { width: 680, height: 1110 }),
	{ width: 4800, height: 7835 }
);

async function main() {
	const tempSvgPath = path.join(os.tmpdir(), `obsidian-to-lark-svg-${Date.now()}.svg`);
	fs.writeFileSync(tempSvgPath, svgMarkup, 'utf8');

	const svgKeepingUploader = new LarkMarkdownUploader({
		cliPath: '/tmp/lark-cli',
		folderToken: '',
		convertSvgToRaster: false,
		reportProgress: () => {},
		reportLog: () => {}
	});

	try {
		assert.deepStrictEqual(
			uploader.resolveImageDisplaySize(tempSvgPath, { extra: '', imageType: 'obsidian' }),
			{ width: 1200, height: 1959 }
		);

		assert.deepStrictEqual(
			uploader.resolveImageDisplaySize(tempSvgPath, { extra: '300', imageType: 'obsidian' }),
			{ width: 300, height: 490 }
		);

		assert.deepStrictEqual(
			uploader.buildMediaInsertArgs('doc-1', '/tmp/diagram.svg', '', { extra: '', imageType: 'obsidian' }, {
				width: 1200,
				height: 1959
			}),
			[
				'docs',
				'+media-insert',
				'--as',
				'user',
				'--doc',
				'doc-1',
				'--file',
				'./diagram.svg',
				'--width',
				'1200',
				'--height',
				'1959'
			]
		);

		const prepared = await svgKeepingUploader.prepareImageUploadAsset(tempSvgPath, { extra: '', imageType: 'markdown' });
		assert.strictEqual(prepared.uploadPath, tempSvgPath);
		assert.deepStrictEqual(prepared.displaySize, { width: 1200, height: 1959 });
		await prepared.cleanup();
		console.log('svg image sizing helpers infer stable dimensions and pass explicit media-insert args');
	} finally {
		fs.unlinkSync(tempSvgPath);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
