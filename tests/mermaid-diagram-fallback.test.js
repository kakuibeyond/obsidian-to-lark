// journey / journal 这类飞书画板不支持的类型，改为写入飞书「文本绘图」块。
// 这里覆盖三层：
//   1) 纯函数：图类型识别、白名单判定、前端头与 add_ons record 构造
//   2) 设置归一化：新开关默认开启、显式关闭时保持关闭
//   3) 用假 lark-cli 跑真实的 insertMermaid 链路，确认
//      - 白名单外类型不插占位画板，直接 POST 文本绘图块（view=chart、带 --- 头）
//      - 白名单内类型仍走画板
//      - 类型判断有偏差时（画板报 not supported）先回收画板再降级
//      - 开关关闭时保持原有报错行为
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
	normalizeSettings,
	extractMermaidDiagramType,
	shouldUseDiagramBlock,
	isUnsupportedMermaidTypeError,
	extractUnsupportedMermaidType,
	buildDiagramSource,
	buildDiagramBlockRecord,
	buildDiagramBlockCreateBody,
	WHITEBOARD_MERMAID_TYPES,
	DIAGRAM_COMPONENT_TYPE_ID,
	BLANK_WHITEBOARD_MARKUP,
	MERMAID_MODE_FALLBACK,
	MERMAID_MODE_STRICT,
	MERMAID_MODE_DIAGRAM,
	normalizeMermaidMode
} = pluginModule.__testables;

const JOURNEY_SOURCE = [
	'journey',
	'    title My working day',
	'    section Go to work',
	'      Make tea: 5: Me',
	'      Do work: 1: Me, Cat',
	'    section Go home',
	'      Sit down: 5: Me'
].join('\n');

const SEQUENCE_SOURCE = [
	'sequenceDiagram',
	'    participant C as MCP Client',
	'    C->>S: tools/call<br/>version + clientInfo'
].join('\n');

// ---- 1. 图类型识别 ----
assert.strictEqual(extractMermaidDiagramType(JOURNEY_SOURCE), 'journey', '应识别 journey');
assert.strictEqual(extractMermaidDiagramType('journal\n  title x'), 'journal', '应识别 journal');
assert.strictEqual(
	extractMermaidDiagramType('erDiagram\n  A ||--o{ B : has'),
	'erdiagram',
	'类型名统一转小写，白名单同样是小写'
);
assert.strictEqual(extractMermaidDiagramType(SEQUENCE_SOURCE), 'sequence', 'sequenceDiagram 归到 sequence');
assert.strictEqual(extractMermaidDiagramType('graph TD\n  A-->B'), 'flowchart-v2', 'graph 归到 flowchart-v2');
assert.strictEqual(extractMermaidDiagramType('flowchart LR\n  A-->B'), 'flowchart', 'flowchart LR 取类型名');
assert.strictEqual(
	extractMermaidDiagramType('flowchart-elk TD\n  A-->B'),
	'flowchart-elk',
	'flowchart-elk 是独立类型名，不能被空格截断'
);
assert.strictEqual(
	extractMermaidDiagramType('stateDiagram-v2\n  [*] --> Idle'),
	'statediagram',
	'stateDiagram-v2 归一为 statediagram'
);
assert.strictEqual(
	extractMermaidDiagramType('erDiagram\n  A ||--o{ B : has'),
	'erdiagram',
	'类型名统一转小写，白名单同样是小写'
);
assert.strictEqual(
	extractMermaidDiagramType('%%{init: {"theme": "default"}}%%\n\ngantt\n  title x'),
	'gantt',
	'应跳过 init 指令与空行'
);
assert.strictEqual(
	extractMermaidDiagramType('---\ntitle: x\n---\njourney\n  title y'),
	'journey',
	'应跳过文本绘图块自带的 YAML 前端头'
);
assert.strictEqual(extractMermaidDiagramType(''), '', '空源码返回空串');
assert.strictEqual(extractMermaidDiagramType('   \n\n'), '', '只有空白返回空串');

// ---- 2. 白名单判定 ----
assert.strictEqual(shouldUseDiagramBlock(JOURNEY_SOURCE), true, 'journey 应降级为文本绘图块');
assert.strictEqual(shouldUseDiagramBlock('journal\n  title x'), true, 'journal 应降级');
assert.strictEqual(shouldUseDiagramBlock('not a diagram'), true, '识别不出类型时按不支持处理');
assert.strictEqual(shouldUseDiagramBlock(SEQUENCE_SOURCE), false, 'sequence 仍走画板');
assert.strictEqual(shouldUseDiagramBlock('gantt\n  title x'), false, 'gantt 仍走画板');
assert.strictEqual(shouldUseDiagramBlock(SEQUENCE_SOURCE, { forced: true }), true, 'forced 时无条件降级');
assert.ok(WHITEBOARD_MERMAID_TYPES.includes('xychart'), '白名单应覆盖 xychart');

assert.strictEqual(
	isUnsupportedMermaidTypeError(new Error('parse Mermaid failed, type: journey not supported, supported types: flowchart-v2')),
	true,
	'应识别画板返回的类型不支持错误'
);
assert.strictEqual(isUnsupportedMermaidTypeError(new Error('network timeout')), false, '普通错误不识别为类型问题');
assert.strictEqual(
	extractUnsupportedMermaidType(new Error('type: journey not supported, supported types: x')),
	'journey',
	'应从错误里取出类型名'
);

// ---- 3. 前端头与 record 构造 ----
const diagramSource = buildDiagramSource(JOURNEY_SOURCE, { title: 'My working day' });
assert.strictEqual(
	diagramSource,
	`---\ntitle: My working day\n---\n${JOURNEY_SOURCE}`,
	'没有前端头时必须补上 --- title ---：飞书只有带头的才渲染成图'
);
assert.strictEqual(
	buildDiagramSource(`---\ntitle: 已有\n---\n${JOURNEY_SOURCE}`, { title: '覆盖' }),
	`---\ntitle: 已有\n---\n${JOURNEY_SOURCE}`,
	'已有前端头时保持原样'
);
assert.ok(buildDiagramSource('', {}).startsWith('---\ntitle: Mermaid\n---'), '缺标题时用 Mermaid 兜底');

const record = JSON.parse(buildDiagramBlockRecord(JOURNEY_SOURCE, { title: 'My working day' }));
assert.deepStrictEqual(
	Object.keys(record).sort(),
	['data', 'theme', 'view'],
	'record 只应包含 data/theme/view'
);
assert.strictEqual(record.view, 'chart', '视图必须是仅显示图表（chart）');
assert.strictEqual(record.theme, 'default', '主题保持飞书默认值');
assert.strictEqual(record.data, diagramSource, 'record.data 应是带前端头的源码');

const createBody = JSON.parse(buildDiagramBlockCreateBody(JOURNEY_SOURCE, { title: 'My working day' }));
assert.strictEqual(createBody.index, -1, '应追加到文档末尾');
assert.strictEqual(createBody.children.length, 1, '一次只插一个块');
assert.strictEqual(createBody.children[0].block_type, 40, '文本绘图块的 block_type 为 40');
assert.strictEqual(
	createBody.children[0].add_ons.component_type_id,
	DIAGRAM_COMPONENT_TYPE_ID,
	'必须带上飞书文本绘图的 component_type_id'
);
assert.strictEqual(
	typeof createBody.children[0].add_ons.record,
	'string',
	'record 必须是 JSON 字符串而不是对象'
);

// ---- 4. 设置归一化：三选一模式 ----
assert.strictEqual(normalizeSettings({}).mermaidMode, MERMAID_MODE_FALLBACK, '默认应为 fallback 模式');
assert.strictEqual(normalizeMermaidMode('strict'), MERMAID_MODE_STRICT, 'strict 应保留');
assert.strictEqual(normalizeMermaidMode('diagram'), MERMAID_MODE_DIAGRAM, 'diagram 应保留');
assert.strictEqual(normalizeMermaidMode(' DIAGRAM '), MERMAID_MODE_DIAGRAM, '应忽略大小写与空白');
assert.strictEqual(normalizeMermaidMode('whatever'), MERMAID_MODE_FALLBACK, '非法值回落到 fallback');
assert.strictEqual(normalizeMermaidMode(undefined), MERMAID_MODE_FALLBACK, '缺失值回落到 fallback');
assert.strictEqual(
	normalizeSettings({ mermaidMode: 'diagram' }).mermaidMode,
	MERMAID_MODE_DIAGRAM,
	'设置里的模式应被归一化保留'
);

// 旧布尔开关迁移：true → fallback，false → strict，且不留旧字段
const migratedTrue = normalizeSettings({ mermaidUnsupportedToDiagram: true });
assert.strictEqual(migratedTrue.mermaidMode, MERMAID_MODE_FALLBACK, '旧开关 true 迁移为 fallback');
assert.strictEqual(
	Object.prototype.hasOwnProperty.call(migratedTrue, 'mermaidUnsupportedToDiagram'),
	false,
	'迁移后应删除旧布尔字段'
);
assert.strictEqual(
	normalizeSettings({ mermaidUnsupportedToDiagram: false }).mermaidMode,
	MERMAID_MODE_STRICT,
	'旧开关 false 迁移为 strict'
);
assert.strictEqual(
	normalizeSettings({ mermaidUnsupportedToDiagram: true, mermaidMode: 'diagram' }).mermaidMode,
	MERMAID_MODE_DIAGRAM,
	'新模式优先于旧开关'
);

// ---- 5. 用假 lark-cli 跑 insertMermaid ----
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

if (args[0] === 'api' && args[1] === 'POST' && args[2].indexOf('/children') !== -1) {
	record({ kind: 'diagram-insert', path: args[2], body: flag('--data') });
	process.stdout.write(JSON.stringify({
		ok: true,
		data: { children: [{ block_id: 'blk_diagram_1', block_type: 40 }] }
	}));
	process.exit(0);
}

if (args[0] === 'whiteboard') {
	const inputFormat = flag('--input_format');
	record({ kind: 'whiteboard-update', inputFormat, source: readAt(flag('--source')) });
	// 模拟飞书对不支持类型的一致表现：直传与 raw 回写都会报类型不支持
	if (process.env.LARK_TEST_UNSUPPORTED_TYPE === '1') {
		process.stdout.write(JSON.stringify({
			ok: false,
			code: 1770001,
			error: {
				message: 'Invalid request parameter：code. Invalid reason : parse Mermaid failed, type: journey not supported, supported types: flowchart-v2, sequence'
			}
		}));
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ ok: true, data: { created_node_id: 't1:2' } }));
	process.exit(0);
}

if (args[0] === 'docs' && flag('--command') === 'allow-unknown') {
	process.exit(1);
}

if (args[0] === 'docs' && flag('--command') === 'block_delete') {
	record({ kind: 'block-delete', blockId: flag('--block-id') });
	process.stdout.write(JSON.stringify({ ok: true, data: { result: 'success' } }));
	process.exit(0);
}

if (args[0] === 'docs' && flag('--command') === 'append') {
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

// 不支持 api 子命令的旧版 lark-cli：退化成普通子命令写法也不行时应当把错误抛出来。
const FAKE_CLI_WITHOUT_API = FAKE_CLI.replace(
	"if (args[0] === 'api' && args[1] === 'POST'",
	"if (args[0] === 'api') { process.stderr.write('unknown command \"api\" for \"lark-cli\"'); process.exit(1); }\nif (args[0] === 'POST') { process.stderr.write('unknown command \"POST\" for \"lark-cli\"'); process.exit(1); }\nif (false && args[0] === 'POST'"
);

// 假转换器：真实 whiteboard-cli 在类型不支持时就是这样报错的
const FAKE_CONVERTER = `#!/usr/bin/env node
const path = require('path');

const args = process.argv.slice(2);
const inputFlag = args.indexOf('-i');
const inputPath = inputFlag === -1 ? null : path.resolve(process.cwd(), args[inputFlag + 1]);
const source = inputPath ? require('fs').readFileSync(inputPath, 'utf8') : '';

fs.appendFileSync(process.env.LARK_TEST_LOG, JSON.stringify({ kind: 'whiteboard-convert' }) + '\\n');
process.stderr.write(
	'Mermaid parse error: parse Mermaid failed, type: journey not supported, supported types: flowchart-v2, sequence\\n'
);
process.exit(1);
`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mermaid-diagram-'));
const fakeCliPath = path.join(tmpRoot, 'fake-lark-cli.js');
const fakeCliWithoutApiPath = path.join(tmpRoot, 'fake-lark-cli-legacy.js');
const fakeConverterPath = path.join(tmpRoot, 'fake-whiteboard-cli.js');
const logPath = path.join(tmpRoot, 'calls.jsonl');

fs.writeFileSync(fakeCliPath, FAKE_CLI, { mode: 0o755 });
fs.writeFileSync(fakeConverterPath, FAKE_CONVERTER, { mode: 0o755 });
fs.writeFileSync(fakeCliWithoutApiPath, FAKE_CLI_WITHOUT_API, { mode: 0o755 });

const readCalls = () => fs.readFileSync(logPath, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((call) => call.kind);

const createUploader = (options = {}) => new LarkMarkdownUploader({
	cliPath: options.cliPath || fakeCliPath,
	whiteboardConverterCommand: options.whiteboardConverterCommand,
	folderToken: '',
	reportProgress: () => {},
	reportLog: (message) => (options.logs || []).push(message),
	mermaidMode: options.mermaidMode
});

(async () => {
	try {
		process.env.LARK_TEST_LOG = logPath;

		// ---- journey：不插占位画板，直接写文本绘图块 ----
		fs.writeFileSync(logPath, '');
		const journeyLogs = [];
		const journeyResult = await createUploader({ logs: journeyLogs })
			.insertMermaid('doxcn_doc', JOURNEY_SOURCE, 1, 2, { title: '我的工作日记' });

		const journeyCalls = readCalls();
		assert.deepStrictEqual(
			journeyCalls.map((call) => call.kind),
			['diagram-insert'],
			'白名单外类型不应再插空白画板，直接写文本绘图块'
		);
		assert.strictEqual(
			journeyCalls[0].path,
			'/open-apis/docx/v1/documents/doxcn_doc/blocks/doxcn_doc/children',
			'应走 docx 原生 children 接口'
		);
		const insertedBody = JSON.parse(journeyCalls[0].body);
		const insertedRecord = JSON.parse(insertedBody.children[0].add_ons.record);
		assert.strictEqual(insertedRecord.view, 'chart', '写入时视图应为仅显示图表');
		assert.ok(
			insertedRecord.data.startsWith('---\ntitle: 我的工作日记\n---\n'),
			'前端头 title 应取当前文档标题'
		);
		assert.ok(insertedRecord.data.endsWith(JOURNEY_SOURCE), '原始源码应原样保留');
		assert.strictEqual(journeyResult.blockType, 'diagram', '返回值应标明走了文本绘图块');
		assert.ok(
			journeyLogs.some((line) => line.includes('文本绘图') && line.includes('journey')),
			'日志应明确说明是文本绘图块以及原因'
		);

		// ---- 画板支持的类型仍走画板 ----
		fs.writeFileSync(logPath, '');
		const sequenceResult = await createUploader().insertMermaid('doxcn_doc', SEQUENCE_SOURCE, 2, 2, { title: 't' });
		assert.deepStrictEqual(
			readCalls().map((call) => call.kind),
			['append', 'whiteboard-update'],
			'sequence 仍应先插空白画板再直传源码'
		);
		assert.strictEqual(
			readCalls()[0].content,
			BLANK_WHITEBOARD_MARKUP,
			'占位内容必须是空白画板'
		);
		assert.strictEqual(readCalls()[1].source, SEQUENCE_SOURCE, '直传的应是原始源码，不加前端头');
		assert.strictEqual(sequenceResult.blockType, 'whiteboard', '返回值应标明走了画板');

		// ---- strict 模式：白名单外直接报错，既不插画板也不写文本绘图 ----
		fs.writeFileSync(logPath, '');
		await assert.rejects(
			() => createUploader({ mermaidMode: MERMAID_MODE_STRICT })
				.insertMermaid('doxcn_doc', JOURNEY_SOURCE, 1, 1, { title: 't' }),
			(error) => {
				assert.match(error.message, /^Mermaid 画板写入失败：/);
				assert.match(error.message, /journey/);
				assert.match(error.message, /flowchart-v2/, '报错里应列出画板支持的类型');
				return true;
			},
			'strict 模式下 journey 应直接报错'
		);
		assert.deepStrictEqual(
			readCalls().map((call) => call.kind),
			[],
			'strict 模式不支持的图不应产生任何写入调用'
		);

		// strict 模式对画板支持的类型仍走画板
		fs.writeFileSync(logPath, '');
		const strictSequence = await createUploader({ mermaidMode: MERMAID_MODE_STRICT })
			.insertMermaid('doxcn_doc', SEQUENCE_SOURCE, 1, 1, { title: 't' });
		assert.deepStrictEqual(
			readCalls().map((call) => call.kind),
			['append', 'whiteboard-update'],
			'strict 模式下支持的图仍应走画板'
		);
		assert.strictEqual(strictSequence.blockType, 'whiteboard', 'strict 模式下支持的图返回画板结果');

		// ---- diagram 模式：所有 Mermaid 都写文本绘图，不走画板 ----
		fs.writeFileSync(logPath, '');
		const diagramModeResult = await createUploader({ mermaidMode: MERMAID_MODE_DIAGRAM })
			.insertMermaid('doxcn_doc', SEQUENCE_SOURCE, 1, 1, { title: 't' });
		assert.deepStrictEqual(
			readCalls().map((call) => call.kind),
			['diagram-insert'],
			'diagram 模式下画板支持的 sequence 也只写文本绘图块'
		);
		assert.strictEqual(diagramModeResult.blockType, 'diagram', 'diagram 模式应返回文本绘图块结果');
		assert.strictEqual(
			JSON.parse(JSON.parse(readCalls()[0].body).children[0].add_ons.record).view,
			'chart',
			'diagram 模式同样把视图设为仅显示图表'
		);

		// ---- fallback 模式的运行期兜底：画板报类型不支持 → 回收画板 → 写文本绘图块 ----
		fs.writeFileSync(logPath, '');
		process.env.LARK_TEST_UNSUPPORTED_TYPE = '1';
		const fallbackLogs = [];

		fs.writeFileSync(logPath, '');
		const degradedUploader = createUploader({ logs: fallbackLogs });
		const degraded = await degradedUploader.insertMermaid('doxcn_doc', SEQUENCE_SOURCE, 1, 1, { title: 't' });
		assert.deepStrictEqual(
			readCalls().map((call) => call.kind),
			['append', 'whiteboard-update', 'whiteboard-update', 'block-delete', 'diagram-insert'],
			'raw 重试同样被类型拒绝后，应先回收占位画板，再写文本绘图块'
		);
		assert.strictEqual(readCalls()[3].blockId, 'blk_whiteboard_1', '应回收 append 返回的画板块');
		assert.strictEqual(degraded.blockType, 'diagram', '降级成功后应返回文本绘图块结果');
		assert.ok(
			fallbackLogs.some((line) => line.includes('journey')),
			'降级日志应带上飞书报出的类型名'
		);

		delete process.env.LARK_TEST_UNSUPPORTED_TYPE;

		// ---- 老版本 lark-cli 没有 api 子命令时，错误要如实抛出 ----
		fs.writeFileSync(logPath, '');
		await assert.rejects(
			() => createUploader({ cliPath: fakeCliWithoutApiPath })
				.insertMermaid('doxcn_doc', JOURNEY_SOURCE, 1, 1, { title: 't' }),
			/unknown command/,
			'两种调用写法都不支持时才抛出错误'
		);

		console.log('mermaid-diagram-fallback: fallback / strict / diagram modes pass');
	} finally {
		delete process.env.LARK_TEST_LOG;
		delete process.env.LARK_TEST_UNSUPPORTED_TYPE;
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
})();
