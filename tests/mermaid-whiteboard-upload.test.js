// Mermaid 上传走「空白画板 + 画板 API」，不再把 ```mermaid 代码块交给 markdown 导入管道。
// 这里用假的 lark-cli（Node shebang 脚本）捕获真实子进程参数与临时文件内容，验证：
//   1) 源码原样传给画板 API（`<br/>` 不被改写、不注入主题色）
//   2) 顺序为先 append 空白画板占位、再灌入源码
//   3) Mermaid 直传失败时，本地转成 OpenAPI JSON 后以 raw 格式重试
//   4) fallback 仍失败时回收空白画板块，并保留直传与 fallback 的两段错误原因
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

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
	BLANK_WHITEBOARD_MARKUP,
	extractWhiteboardBlockId,
	buildWindowsWhiteboardConverterCandidates,
	selectExistingWindowsWhiteboardConverter
} = pluginModule.__testables;

// ---- 纯函数：空白画板标记与 block_id 提取 ----
assert.strictEqual(
	BLANK_WHITEBOARD_MARKUP,
	'<whiteboard type="blank"></whiteboard>',
	'空白画板占位标记应保持飞书可识别的写法'
);
assert.strictEqual(
	extractWhiteboardBlockId({
		data: {
			document: {
				new_blocks: [
					{ block_id: 'doxcn_text', block_type: 'paragraph' },
					{ block_id: 'doxcn_board', block_token: 'wbcn_1', block_type: 'whiteboard' }
				]
			}
		}
	}),
	'doxcn_board',
	'应取 whiteboard 块的 block_id（不是 token）'
);
assert.strictEqual(extractWhiteboardBlockId({ data: {} }), '', '没有 new_blocks 时返回空串');
assert.strictEqual(extractWhiteboardBlockId(null), '', '空 payload 安全返回空串');
assert.strictEqual(
	extractWhiteboardBlockId({ data: { document: { new_blocks: [{ block_type: 'whiteboard' }] } } }),
	'',
	'缺 block_id 时返回空串'
);

const windowsPortableNodeDir = 'D:\\portable-node';
const windowsPortableNode = `${windowsPortableNodeDir}\\node.exe`;
const windowsPortableNpxCli = `${windowsPortableNodeDir}\\node_modules\\npm\\bin\\npx-cli.js`;
const windowsRuntimeCandidates = buildWindowsWhiteboardConverterCandidates({
	cliPaths: ['C:\\Users\\will\\AppData\\Roaming\\npm\\lark-cli.cmd'],
	npxPaths: [`${windowsPortableNodeDir}\\npx.cmd`],
	nodePaths: ['node'],
	standardNodeDirs: ['C:\\Users\\will\\AppData\\Local\\Programs\\nodejs']
});
const selectedWindowsRuntime = selectExistingWindowsWhiteboardConverter(
	windowsRuntimeCandidates,
	[windowsPortableNode, windowsPortableNpxCli]
);
assert.deepStrictEqual(
	selectedWindowsRuntime,
	{ nodePath: windowsPortableNode, npxCliPath: windowsPortableNpxCli },
	'node PATH 解析仍是字面量时，应使用 npx wrapper 同目录已验证存在的 node.exe + npx-cli.js'
);
assert.strictEqual(path.win32.isAbsolute(selectedWindowsRuntime.nodePath), true, 'Windows node.exe 必须是绝对路径');
assert.strictEqual(path.win32.isAbsolute(selectedWindowsRuntime.npxCliPath), true, 'Windows npx-cli.js 必须是绝对路径');
assert.strictEqual(
	windowsRuntimeCandidates.some((candidate) =>
		candidate.nodePath === 'C:\\Users\\will\\AppData\\Local\\Programs\\nodejs\\node.exe'
	),
	true,
	'Windows 候选应覆盖 LOCALAPPDATA\\Programs\\nodejs 标准安装位置'
);

// ---- 假 lark-cli ----
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const logPath = process.env.LARK_TEST_LOG;
const record = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n');
const flag = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? null : args[index + 1];
};
const readAt = (value) => {
	if (!value || value.charAt(0) !== '@') {
		return null;
	}
	const raw = value.slice(1);
	const resolved = path.resolve(process.cwd(), raw.startsWith('./') ? raw.slice(2) : raw);
	try {
		return fs.readFileSync(resolved, 'utf8');
	} catch (_error) {
		return null;
	}
};

record({ args });

if (args[0] === 'whiteboard') {
	const inputFormat = flag('--input_format');
	record({
		kind: 'whiteboard-update',
		token: flag('--whiteboard-token'),
		inputFormat,
		overwrite: args.indexOf('--overwrite') !== -1,
		source: readAt(flag('--source'))
	});
	if (inputFormat === 'mermaid' && process.env.LARK_TEST_FAIL_MERMAID === '1') {
		process.stdout.write(JSON.stringify({
			ok: false,
			error: { message: 'direct mermaid parse failed: unsupported color #E6 F0EA' }
		}));
		process.exit(1);
	}
	if (inputFormat === 'raw' && process.env.LARK_TEST_FAIL_RAW === '1') {
		process.stdout.write(JSON.stringify({
			ok: false,
			error: { message: 'raw whiteboard update failed: invalid converted nodes' }
		}));
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ ok: true, data: { created_node_id: 't1:2' } }));
	process.exit(0);
}

const command = flag('--command');

if (args[0] === 'docs' && command === 'block_delete') {
	record({ kind: 'block-delete', blockId: flag('--block-id') });
	process.stdout.write(JSON.stringify({ ok: true, data: { result: 'success' } }));
	process.exit(0);
}

if (args[0] === 'docs' && command === 'append') {
	record({ kind: 'append', content: readAt(flag('--content')) });
	process.stdout.write(JSON.stringify({
		ok: true,
		data: {
			document: {
				new_blocks: [
					{ block_id: 'blk_whiteboard_1', block_token: 'wbcn_1', block_type: 'whiteboard' }
				]
			}
		}
	}));
	process.exit(0);
}

process.stderr.write('unsupported fake cli call: ' + args.join(' ') + '\\n');
process.exit(1);
`;

// ---- 假 whiteboard-cli：把 Mermaid 转成可供 lark-cli raw update 使用的 OpenAPI JSON ----
const FAKE_CONVERTER = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const logPath = process.env.LARK_TEST_LOG;
const flag = (shortName, longName) => {
	const shortIndex = args.indexOf(shortName);
	if (shortIndex !== -1) {
		return args[shortIndex + 1];
	}
	const longIndex = args.indexOf(longName);
	return longIndex === -1 ? null : args[longIndex + 1];
};
const inputPath = flag('-i', '--input');
const resolvedInput = inputPath ? path.resolve(process.cwd(), inputPath) : '';
const source = resolvedInput ? fs.readFileSync(resolvedInput, 'utf8') : '';

fs.appendFileSync(logPath, JSON.stringify({
	kind: 'whiteboard-convert',
	args,
	from: flag('-f', '--from'),
	to: flag('-t', '--to'),
	format: flag('-F', '--format'),
	source
}) + '\\n');

if (process.env.LARK_TEST_EMPTY_CONVERTER === '1') {
	process.stdout.write(JSON.stringify({ nodes: [] }));
	process.exit(0);
}

process.stdout.write(JSON.stringify({
	nodes: [
		{ id: 'shape_1', type: 'shape', text: { text: source } }
	]
}));
`;

// npx 自身会继续启动包里的 Node shebang 脚本。模拟这一层二级启动，确保即使
// Obsidian 的 PATH 很窄，转换器子进程仍能通过 /usr/bin/env 找到 node。
const FAKE_ADJACENT_NPX = FAKE_CONVERTER.replace(
	"const fs = require('fs');",
	"require('child_process').execFileSync('node', ['--version'], { stdio: 'ignore' });\nconst fs = require('fs');"
);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mermaid-upload-'));
const fakeCliPath = path.join(tmpRoot, 'fake-lark-cli.js');
const fakeConverterPath = path.join(tmpRoot, 'fake-whiteboard-cli.js');
const fakeAdjacentNpxPath = path.join(tmpRoot, process.platform === 'win32' ? 'npx.cmd' : 'npx');
const restrictedPathDir = path.join(tmpRoot, 'restricted-path');
const logPath = path.join(tmpRoot, 'calls.jsonl');

fs.mkdirSync(restrictedPathDir);
fs.writeFileSync(fakeCliPath, FAKE_CLI, { mode: 0o755 });
fs.writeFileSync(fakeConverterPath, FAKE_CONVERTER, { mode: 0o755 });
fs.writeFileSync(fakeAdjacentNpxPath, FAKE_ADJACENT_NPX, { mode: 0o755 });

const readCalls = () => fs.readFileSync(logPath, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const listMermaidTempArtifacts = () => fs.readdirSync(os.tmpdir())
	.filter((name) =>
		name.startsWith('obsidian-to-lark-mermaid-')
		|| name.startsWith('obsidian-to-lark-whiteboard-')
	)
	.sort();

const createUploader = () => new LarkMarkdownUploader({
	cliPath: fakeCliPath,
	whiteboardConverterCommand: fakeConverterPath,
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

const createDefaultConverterUploader = () => new LarkMarkdownUploader({
	cliPath: fakeCliPath,
	folderToken: '',
	reportProgress: () => {},
	reportLog: () => {}
});

const MERMAID_SOURCE = [
	'sequenceDiagram',
	'    participant C as MCP Client',
	'    participant S as MCP Server',
	'    C->>S: tools/call(filter_candidates)<br/>version + clientInfo',
	'    S-->>C: 候选人编号'
].join('\n');

(async () => {
	try {
		// ---- 成功路径 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_LOG = logPath;
		delete process.env.LARK_TEST_FAIL_MERMAID;
		delete process.env.LARK_TEST_FAIL_RAW;

		await createUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 1, 2);

		const successCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			successCalls.map((call) => call.kind),
			['append', 'whiteboard-update'],
			'应先 append 空白画板占位，再灌入 mermaid 源码'
		);
		assert.strictEqual(
			successCalls[0].content,
			BLANK_WHITEBOARD_MARKUP,
			'占位内容必须是空白画板标记，不能是 ```mermaid 代码块（会被 markdown 管道改写）'
		);
		assert.strictEqual(
			successCalls[1].source,
			MERMAID_SOURCE,
			'mermaid 源码必须逐字传参：`<br/>` 与缩进都不能被改写'
		);
		assert.match(successCalls[1].source, /<br\/>/, '`<br/>` 必须保留原样');
		assert.doesNotMatch(
			successCalls[1].source,
			/classDef|linkStyle|#[0-9A-Fa-f]{6}/,
			'不应向源码注入主题色（时序图里 classDef/linkStyle 会让画板解析失败）'
		);
		assert.strictEqual(successCalls[1].inputFormat, 'mermaid', '必须以 mermaid 格式灌入');
		assert.strictEqual(successCalls[1].token, 'wbcn_1', '应使用 append 返回的画板 token');
		assert.strictEqual(successCalls[1].overwrite, true, '灌入时应覆盖空白画板默认内容');

		// ---- fallback 成功：Mermaid 直传失败后本地转换，再用 raw 写入同一个画板 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_FAIL_MERMAID = '1';
		delete process.env.LARK_TEST_FAIL_RAW;

		await createUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 2, 3);

		const fallbackSuccessCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			fallbackSuccessCalls.map((call) => call.kind),
			['append', 'whiteboard-update', 'whiteboard-convert', 'whiteboard-update'],
			'Mermaid 直传失败后应本地转换，再对同一画板执行 raw update，且成功后不删除画板块'
		);
		assert.strictEqual(fallbackSuccessCalls[1].inputFormat, 'mermaid', '第一次仍应优先直传 Mermaid');
		assert.strictEqual(fallbackSuccessCalls[2].from, 'mermaid', '本地转换器输入类型应为 mermaid');
		assert.strictEqual(fallbackSuccessCalls[2].to, 'openapi', '本地转换器输出类型应为 openapi');
		assert.strictEqual(fallbackSuccessCalls[2].format, 'data', '转换器应直接输出可写入 raw API 的 data JSON');
		assert.strictEqual(
			fallbackSuccessCalls[2].source,
			MERMAID_SOURCE,
			'fallback 也必须把用户原始 Mermaid 源码逐字交给本地转换器'
		);
		assert.strictEqual(fallbackSuccessCalls[3].inputFormat, 'raw', 'fallback 应以 raw 格式写入转换结果');
		assert.strictEqual(fallbackSuccessCalls[3].token, 'wbcn_1', 'raw fallback 必须复用原占位画板 token');
		assert.strictEqual(fallbackSuccessCalls[3].overwrite, true, 'raw fallback 必须覆盖空白画板默认内容');
		assert.deepStrictEqual(
			JSON.parse(fallbackSuccessCalls[3].source),
			{ nodes: [{ id: 'shape_1', type: 'shape', text: { text: MERMAID_SOURCE } }] },
			'raw update 应收到本地转换器生成的 OpenAPI JSON'
		);
		assert.strictEqual(
			fallbackSuccessCalls.some((call) => call.kind === 'block-delete'),
			false,
			'fallback 成功后不应删除已经写好的画板块'
		);

		// ---- 默认转换器：优先使用与 lark-cli 同目录的 npx ----
		fs.writeFileSync(logPath, '');
		const originalPath = process.env.PATH;
		process.env.PATH = restrictedPathDir;
		try {
			await createDefaultConverterUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 3, 4);
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}

		const adjacentNpxCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			adjacentNpxCalls.map((call) => call.kind),
			['append', 'whiteboard-update', 'whiteboard-convert', 'whiteboard-update'],
			'PATH 中找不到 npx 时，应使用与 lark-cli 同目录的 npx 完成 fallback'
		);
		assert.strictEqual(
			adjacentNpxCalls[2].args[1],
			'@larksuite/whiteboard-cli@0.2.13',
			'默认 fallback 应精确锁定 whiteboard-cli 0.2.13'
		);

		// ---- 无效转换结果：不得将空 nodes 交给 raw API，且临时文件必须清理 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_EMPTY_CONVERTER = '1';
		const tempArtifactsBeforeInvalidOutput = listMermaidTempArtifacts();
		await assert.rejects(
			() => createUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 4, 5),
			(error) => {
				assert.match(error.message, /OpenAPI JSON 不包含画板节点/);
				return true;
			}
		);
		delete process.env.LARK_TEST_EMPTY_CONVERTER;

		const invalidOutputCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			invalidOutputCalls.map((call) => call.kind),
			['append', 'whiteboard-update', 'whiteboard-convert', 'block-delete'],
			'空节点转换结果应被拦截，不得执行 raw update'
		);
		assert.deepStrictEqual(
			listMermaidTempArtifacts(),
			tempArtifactsBeforeInvalidOutput,
			'转换结果无效时也应清理 Mermaid/OpenAPI 临时文件'
		);

		// ---- fallback 失败：回收空白画板，并同时保留直传与 raw 重试的原因 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_FAIL_RAW = '1';

		await assert.rejects(
			() => createUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 3, 3),
			(error) => {
				assert.match(error.message, /^Mermaid 画板写入失败：/, '错误应带明确前缀');
				assert.match(error.message, /direct mermaid parse failed/, '应保留第一次 Mermaid 直传失败原因');
				assert.match(error.message, /raw whiteboard update failed/, '应保留本地转换后 raw 重试失败原因');
				return true;
			}
		);

		const failureCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			failureCalls.map((call) => call.kind),
			['append', 'whiteboard-update', 'whiteboard-convert', 'whiteboard-update', 'block-delete'],
			'直传与 raw fallback 都失败后应删掉占位空白画板，避免文档里留下空块'
		);
		assert.strictEqual(
			failureCalls[4].blockId,
			'blk_whiteboard_1',
			'删除的应当是 append 返回的那个画板块'
		);

		console.log('mermaid-whiteboard-upload: blank-board + board API pass');
	} finally {
		delete process.env.LARK_TEST_LOG;
		delete process.env.LARK_TEST_FAIL_MERMAID;
		delete process.env.LARK_TEST_FAIL_RAW;
		delete process.env.LARK_TEST_EMPTY_CONVERTER;
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
})();
