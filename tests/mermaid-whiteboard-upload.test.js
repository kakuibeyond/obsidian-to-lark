// Mermaid 上传走「空白画板 + 画板 API」，不再把 ```mermaid 代码块交给 markdown 导入管道。
// 这里用假的 lark-cli（Node shebang 脚本）捕获真实子进程参数与临时文件内容，验证：
//   1) 源码原样传给画板 API（`<br/>` 不被改写、不注入主题色）
//   2) 顺序为先 append 空白画板占位、再灌入源码
//   3) 灌入失败时回收空白画板块并抛出带前缀的错误
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
	extractWhiteboardBlockId
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
	record({
		kind: 'whiteboard-update',
		token: flag('--whiteboard-token'),
		inputFormat: flag('--input_format'),
		overwrite: args.indexOf('--overwrite') !== -1,
		source: readAt(flag('--source'))
	});
	if (process.env.LARK_TEST_FAIL_WHITEBOARD === '1') {
		process.stdout.write(JSON.stringify({
			ok: false,
			error: { message: 'Whiteboard content parse failed. Check the whiteboard content format' }
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mermaid-upload-'));
const fakeCliPath = path.join(tmpRoot, 'fake-lark-cli.js');
const logPath = path.join(tmpRoot, 'calls.jsonl');

fs.writeFileSync(fakeCliPath, FAKE_CLI, { mode: 0o755 });

const readCalls = () => fs.readFileSync(logPath, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const createUploader = () => new LarkMarkdownUploader({
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
		delete process.env.LARK_TEST_FAIL_WHITEBOARD;

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

		// ---- 失败路径：灌入失败要回收空白画板并抛出可读错误 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_FAIL_WHITEBOARD = '1';

		await assert.rejects(
			() => createUploader().insertMermaid('doxcn_doc', MERMAID_SOURCE, 2, 2),
			(error) => {
				assert.match(error.message, /^Mermaid 画板写入失败：/, '错误应带明确前缀');
				assert.match(error.message, /Whiteboard content parse failed/, '应保留飞书返回的原因');
				return true;
			}
		);

		const failureCalls = readCalls().filter((call) => call.kind);
		assert.deepStrictEqual(
			failureCalls.map((call) => call.kind),
			['append', 'whiteboard-update', 'block-delete'],
			'灌入失败后应删掉占位空白画板，避免文档里留下空块'
		);
		assert.strictEqual(
			failureCalls[2].blockId,
			'blk_whiteboard_1',
			'删除的应当是 append 返回的那个画板块'
		);

		console.log('mermaid-whiteboard-upload: blank-board + board API pass');
	} finally {
		delete process.env.LARK_TEST_LOG;
		delete process.env.LARK_TEST_FAIL_WHITEBOARD;
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
})();
