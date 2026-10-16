import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexError, runCodex } from './codex.ts';
import { probeClaude, resolveClaudeLauncher, runClaude } from './claude.ts';

const directory = await mkdtemp(path.join(tmpdir(), 'cluevia-claude-tests-'));
const fakeCli = path.join(directory, 'fake-claude.mjs');
await writeFile(fakeCli, `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
let args = process.argv.slice(2);
const transported = args[0] === '--cluevia-args-file';
if (transported) args = JSON.parse(readFileSync(args[1], 'utf8'));
const emit = value => console.log(JSON.stringify(value));
const result = (value, extra = {}) => emit({ type: 'result', subtype: 'success', is_error: false, structured_output: value, ...extra });
if (args.includes('--help')) {
  console.log('--print --output-format --json-schema --safe-mode --restricted --tools --strict-mcp-config --no-session-persistence --effort');
} else if (args.includes('auth') && args.includes('status')) {
  emit({ loggedIn: true, email: 'do-not-expose@example.test', accessToken: 'private-probe-token' });
} else {
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const pause = () => new Promise(resolve => setTimeout(resolve, 30_000));
  switch (prompt) {
    case 'timeout': await pause(); break;
    case 'auth': console.error('401 Unauthorized private-auth-token'); process.exitCode = 1; break;
    case 'version': console.error('unknown option private-detail'); process.exitCode = 1; break;
    case 'model': console.error('model_not_found private-model-detail'); process.exitCode = 1; break;
    case 'failed': console.error('private-provider-error'); process.exitCode = 1; break;
    case 'rate': emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['429 rate limit private-provider-detail'] }); break;
    case 'invalid': emit({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}' }); break;
    case 'array': result([]); break;
    case 'no-output': console.log('startup diagnostic'); break;
    case 'duplicate-result': result({ ok: true }); result({ ok: false }); break;
    case 'huge-result': result({ text: 'x'.repeat(2_000_001) }); break;
    case 'flood': console.log('x'.repeat(8_000_001)); break;
    case 'tool': emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }); await pause(); break;
    case 'server-tool': emit({ type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'web_search', input: {} }] } }); await pause(); break;
    case 'partial-tool': emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read', input: {} } } }); await pause(); break;
    case 'mcp-init': emit({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [{ name: 'unexpected' }] }); await pause(); break;
    case 'tool-init': emit({ type: 'system', subtype: 'init', tools: ['Bash'] }); await pause(); break;
    case 'hook': emit({ type: 'system', subtype: 'hook_started' }); await pause(); break;
    case 'subagent': emit({ type: 'assistant', parent_tool_use_id: 'unexpected-child', message: { content: [] } }); await pause(); break;
    case 'unicode': {
      const bytes = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { text: '북한군 자료 확인' } }));
      for (let offset = 0; offset < bytes.length; offset += 2) { process.stdout.write(bytes.subarray(offset, offset + 2)); await new Promise(resolve => setTimeout(resolve, 1)); }
      break;
    }
    default: {
      if (prompt.startsWith('tree:')) {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'inherit' });
        writeFileSync(prompt.slice(5), String(child.pid)); await pause(); break;
      }
      emit({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] });
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { ok: true } }] } });
      result({ ok: true, args, cwd: process.cwd(), prompt, transported,
        schema: JSON.parse(args[args.indexOf('--json-schema') + 1]),
        secret: process.env.CLUEVIA_TEST_SECRET ?? null, openai: process.env.OPENAI_API_KEY ?? null,
        nodeOptions: process.env.NODE_OPTIONS ?? null, inheritedHook: process.env.CLAUDE_CODE_SYSTEM_PROMPT_FILE ?? null,
        authPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), noColor: process.env.NO_COLOR,
      }, { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } });
    }
  }
}
`);
after(() => rm(directory, { recursive: true, force: true }));
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const config = { bin: fakeCli, model: 'claude-sonnet-5-5', effort: 'high' as const, timeoutMs: 5000 };
const isError = (code: string) => (error: unknown) => error instanceof CodexError && error.code === code;

test('confidence estimation reaches Claude with low effort and an explicit model-estimate contract', async () => {
  const input = { purpose: 'why-not' as const, question: '자료가 결론을 지지하는가?', documents: [{ id: 'e0', name: '자료', text: '기관은 사건 발생을 발표했다.' }], schema };
  const settings = { ...config, provider: 'claude' as const, efforts: { 'why-not': 'high' as const } };
  const estimate = await runCodex({ ...input, context: JSON.stringify({ mode: 'estimate-confidence' }) }, settings) as { args: string[]; prompt: string };
  assert.equal(estimate.args[estimate.args.indexOf('--effort') + 1], 'low');
  assert.ok(estimate.prompt.includes('explicitly authorized MODEL_ESTIMATE'));
  assert.ok(estimate.prompt.includes('not measured historical statistics'));
  assert.ok(estimate.prompt.includes('never target a desired score'));
  const review = await runCodex({ ...input, context: JSON.stringify({ mode: 'review' }) }, settings) as { args: string[]; prompt: string };
  assert.equal(review.args[review.args.indexOf('--effort') + 1], 'high');
  assert.ok(!review.prompt.includes('explicitly authorized MODEL_ESTIMATE'));
});

test('isolates input and environment, applies bounded flags, and accepts only structured final output', async () => {
  const temporary = { CLUEVIA_TEST_SECRET: 'unrelated-secret', OPENAI_API_KEY: 'unrelated-openai-secret', NODE_OPTIONS: '--no-warnings', CLAUDE_CODE_SYSTEM_PROMPT_FILE: '/private/custom-prompt', CLAUDE_CODE_OAUTH_TOKEN: 'test-auth-token' };
  const previous = Object.fromEntries(Object.keys(temporary).map(key => [key, process.env[key]]));
  Object.assign(process.env, temporary);
  const usage: unknown[] = []; const progress: string[] = [];
  try {
    const prompt = '`echo injection` $(echo injection) " & arbitrary text';
    const value = await runClaude(prompt, schema, config, { onUsage: item => usage.push(item), onProgress: item => progress.push(item) }) as Record<string, unknown>;
    assert.equal(value.ok, true); assert.equal(value.prompt, prompt); assert.deepEqual(value.schema, schema);
    assert.equal(value.secret, null); assert.equal(value.openai, null); assert.equal(value.nodeOptions, null); assert.equal(value.inheritedHook, null);
    assert.equal(value.authPresent, true); assert.equal(value.noColor, '1');
    assert.notEqual(value.cwd, process.cwd()); assert.match(String(value.cwd), /cluevia-claude-/);
    await assert.rejects(access(String(value.cwd)), { code: 'ENOENT' });
    const args = value.args as string[];
    for (const flag of ['--print', '--verbose', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag), flag);
    for (const flag of ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--continue', '--resume', '--add-dir']) assert.ok(!args.includes(flag), flag);
    for (const [flag, expected] of [['--model', 'claude-sonnet-5-5'], ['--effort', 'high'], ['--tools', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--setting-sources', ''], ['--permission-prompts', 'none'], ['--max-turns', '3'], ['--output-format', 'stream-json']]) assert.equal(args[args.indexOf(flag) + 1], expected);
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
    assert.deepEqual(usage, [{ inputTokens: 60, outputTokens: 40, cachedInputTokens: 30 }]);
    assert.equal(progress.length, 2);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('stage-resolved efforts pass through unchanged and default to high', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const value = await runClaude('effort', schema, { ...config, effort }) as { args: string[] };
    assert.equal(value.args[value.args.indexOf('--effort') + 1], effort);
  }
  const value = await runClaude('defaults', schema, { bin: fakeCli }) as { args: string[] };
  assert.equal(value.args[value.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(value.args[value.args.indexOf('--effort') + 1], 'high');
});

test('explicit bridge transport writes arguments to a private temporary file and cleans up', async () => {
  const largeSchema = { ...schema, description: 'x'.repeat(125_000) };
  const value = await runClaude('bridge', largeSchema, { ...config, argsFileTransport: true }) as { transported: boolean; schema: unknown; cwd: string };
  assert.equal(value.transported, true); assert.deepEqual(value.schema, largeSchema);
  await assert.rejects(access(value.cwd), { code: 'ENOENT' });
  await assert.rejects(runClaude('native', largeSchema, config), isError('CLAUDE_SCHEMA_LIMIT'));
});

test('handles UTF-8 split across chunks and a final event without trailing newline', async () => {
  assert.deepEqual(await runClaude('unicode', schema, config), { text: '북한군 자료 확인' });
});

test('probe reads local capabilities and login without exposing auth fields', async () => {
  const status = await probeClaude(config);
  assert.deepEqual(status, { available: true, authenticated: true, message: 'Claude CLI와 로그인 확인 완료. 모델 접근은 분석 시 확인합니다.' });
  assert.ok(!JSON.stringify(status).includes('private-probe-token'));
  assert.ok(!JSON.stringify(status).includes('example.test'));
  assert.equal((await probeClaude({ ...config, argsFileTransport: true })).authenticated, true);
  assert.equal((await probeClaude({ bin: path.join(directory, 'missing-cli') })).available, false);
  const old = path.join(directory, 'old.mjs'); await writeFile(old, 'console.log("old CLI");');
  assert.deepEqual(await probeClaude({ bin: old }), { available: false, authenticated: null, message: 'Claude CLI가 필요한 실행 옵션을 지원하지 않습니다. Claude Code를 업데이트해 주세요.' });
});

test('resolves native, JS and Windows npm shims without executing shell text', async () => {
  assert.deepEqual(await resolveClaudeLauncher(fakeCli), { command: process.execPath, args: [fakeCli] });
  const native = path.join(directory, 'claude.exe'); await writeFile(native, 'native placeholder');
  assert.deepEqual(await resolveClaudeLauncher(native, 'win32'), { command: native, args: [] });
  for (const local of [false, true]) {
    const prefix = path.join(directory, local ? 'local node_modules' : 'global npm');
    const entry = local ? path.join(prefix, '@anthropic-ai', 'claude-code', 'cli.js') : path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const shim = local ? path.join(prefix, '.bin', 'claude.cmd') : path.join(prefix, 'claude.cmd');
    await mkdir(path.dirname(entry), { recursive: true }); await mkdir(path.dirname(shim), { recursive: true });
    await writeFile(entry, ''); await writeFile(shim, '@echo arbitrary shim contents must never execute');
    assert.deepEqual(await resolveClaudeLauncher(shim, 'win32'), { command: process.execPath, args: [entry] });
  }
  const invalid = path.join(directory, 'unknown.cmd'); await writeFile(invalid, 'echo unsafe');
  await assert.rejects(resolveClaudeLauncher(invalid, 'win32'), isError('CLAUDE_CONFIGURATION'));
  await assert.rejects(resolveClaudeLauncher('claude\nextra'), isError('CLAUDE_CONFIGURATION'));
});

test('cancellation and deadlines use shared retry-compatible codes', async () => {
  await assert.rejects(runClaude('timeout', schema, config, { signal: AbortSignal.abort() }), isError('CODEX_CANCELLED'));
  const controller = new AbortController();
  const running = runClaude('timeout', schema, config, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(running, isError('CODEX_CANCELLED')); } finally { clearTimeout(timer); }
  await assert.rejects(runClaude('timeout', schema, { ...config, timeoutMs: 100 }), isError('CODEX_TIMEOUT'));
});

test('kills descendant processes on cancellation', { skip: process.platform === 'win32' }, async () => {
  const pidFile = path.join(directory, 'descendant.pid');
  const controller = new AbortController();
  const running = runClaude(`tree:${pidFile}`, schema, config, { signal: controller.signal });
  let pid = 0;
  try {
    for (let attempt = 0; attempt < 50 && !pid; attempt++) { try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert.ok(pid > 0); controller.abort(); await assert.rejects(running, isError('CODEX_CANCELLED'));
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return; }
      // A killed child may remain a zombie briefly until the host's init reaps it.
      try { if ((await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.startsWith('Z ')) return; } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('descendant still running after cancellation');
  } finally { controller.abort(); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
});

test('rejects executable tools, MCP activation, hooks and delegation', async () => {
  for (const prompt of ['tool', 'server-tool', 'partial-tool', 'mcp-init', 'tool-init', 'hook', 'subagent']) await assert.rejects(runClaude(prompt, schema, config), isError('CLAUDE_TOOL_REQUESTED'));
});

test('sanitizes provider errors including success-exit error results', async () => {
  for (const [prompt, code] of [['auth', 'CLAUDE_AUTH'], ['rate', 'CLAUDE_LIMIT'], ['version', 'CLAUDE_VERSION'], ['model', 'CLAUDE_MODEL'], ['failed', 'CLAUDE_FAILED']]) {
    await assert.rejects(runClaude(prompt, schema, config), error => {
      assert.ok(error instanceof CodexError); assert.equal(error.code, code); assert.ok(!error.message.includes('private-')); return true;
    });
  }
});

test('requires one final structured object and bounds both result and diagnostic output', async () => {
  for (const [prompt, code] of [['invalid', 'CLAUDE_INVALID_JSON'], ['array', 'CLAUDE_INVALID_JSON'], ['no-output', 'CLAUDE_NO_OUTPUT'], ['duplicate-result', 'CLAUDE_INVALID_OUTPUT'], ['huge-result', 'CLAUDE_OUTPUT_LIMIT'], ['flood', 'CLAUDE_OUTPUT_LIMIT']]) await assert.rejects(runClaude(prompt, schema, config), isError(code));
});

test('rejects invalid input, schema, model and runtime limits before launching', async () => {
  await assert.rejects(runClaude('', schema, config), isError('CLAUDE_INPUT'));
  await assert.rejects(runClaude('x'.repeat(1_000_001), schema, config), isError('CLAUDE_INPUT'));
  await assert.rejects(runClaude('input', { ...schema, description: 'x'.repeat(200_001) }, config), isError('CLAUDE_SCHEMA'));
  await assert.rejects(runClaude('input', schema, { ...config, model: 'model; arbitrary command' }), isError('CLAUDE_CONFIGURATION'));
  await assert.rejects(runClaude('input', schema, { ...config, timeoutMs: NaN }), isError('CLAUDE_CONFIGURATION'));
});
