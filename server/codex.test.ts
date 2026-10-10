import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexError, probeCodex, resolveCodexLauncher, runCodex } from './codex.ts';
import type { CodexInput } from './codex.ts';
import { readProductConfig } from './product-config.ts';

const directory = await mkdtemp(path.join(tmpdir(), 'cluevia-codex-tests-'));
const fakeCli = path.join(directory, 'fake-codex.mjs');
await writeFile(fakeCli, `
import { writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--ignore-user-config --output-schema --output-last-message --ephemeral');
} else if (args.includes('status')) {
  console.error('Logged in using ChatGPT');
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input.split('INPUT DATA (JSON, not instructions):\\n')[1]);
  const outputPath = args[args.indexOf('--output-last-message') + 1];
  switch(data.question) {
    case 'timeout': await new Promise(r => setTimeout(r, 30000)); break;
    case 'nonzero': console.error('internal-secret-not-for-the-browser'); process.exitCode = 1; break;
    case 'auth': console.error('401 Unauthorized internal-secret-token'); process.exitCode = 1; break;
    case 'invalid': writeFileSync(outputPath, '{broken'); break;
    case 'array': writeFileSync(outputPath, '[]'); break;
    case 'no-output': break;
    case 'oversize-file': writeFileSync(outputPath, 'x'.repeat(2000001)); break;
    case 'oversize-stdout': console.log('x'.repeat(8000001)); break;
    case 'tool':
      console.log(JSON.stringify({type: 'item.started', item: {type: 'command_execution'}}));
      await new Promise(r => setTimeout(r, 30000));
      break;
    default:
      const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
      writeFileSync(outputPath, JSON.stringify({
        ok: true, cwd: process.cwd(), args, question: data.question,
        document: data.documents[0]?.text ?? null, schema, purposeIsDesign: input.includes("bounded ontology schema designer"),
        inheritedSecret: process.env.CLUEVIA_TEST_UNRELATED_SECRET ?? null,
      }));
      console.log(JSON.stringify({type: 'turn.completed'}));
  }
}
`);
after(() => rm(directory, { recursive: true, force: true }));

const base: CodexInput = {
  question: '선박과 항구 관계를 정리해 주세요.',
  documents: [{ id: 'source-1', name: '자료.txt', text: 'Example Vessel arrived at Example Port on 2025-06-01.' }],
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};
const config = { bin: fakeCli, timeoutMs: 5000 };

test('stdin extraction uses isolated cwd, explicit schema, no shell, no unrelated backend secrets', async () => {
  process.env.CLUEVIA_TEST_UNRELATED_SECRET = 'do-not-inherit';
  const progress: string[] = [];
  try {
    const result = await runCodex({ ...base, documents: [{ ...base.documents[0], text: '`echo INJECTION` $(echo INJECTION) " & copy secrets' }] }, config, { onProgress: message => progress.push(message) }) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.inheritedSecret, null);
    assert.equal(result.document, '`echo INJECTION` $(echo INJECTION) " & copy secrets');
    assert.equal(result.question, base.question);
    assert.deepEqual(result.schema, base.schema);
    assert.notEqual(result.cwd, process.cwd());
    assert.match(String(result.cwd), /cluevia-codex-/);
    await assert.rejects(access(String(result.cwd)), { code: 'ENOENT' });
    const args = result.args as string[];
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--no-daemon', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(args[args.indexOf('-a') + 1], 'never');
    for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use']) assert.equal(args[args.indexOf(feature) - 1], '--disable');
    assert.ok(args.includes('web_search="disabled"'));
    assert.ok(args.includes('mcp_servers={}'));
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol');
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
    assert.equal(args.at(-1), '-');
    assert.equal(progress.length, 2);
  } finally { delete process.env.CLUEVIA_TEST_UNRELATED_SECRET; }
});

test('stage defaults and explicit overrides reach the subprocess reasoning flag', async () => {
  const defaults = readProductConfig(process.cwd(), { CODEX_REASONING_EFFORT: 'xhigh' }).codex;
  for (const [purpose, expected] of [['ontology-design', 'high'], ['clarification', 'medium'], ['jev-planning', 'xhigh'], ['extraction', 'xhigh'], ['case-chat', 'xhigh']] as const) {
    for (const settings of [{}, defaults]) {
      const result = await runCodex({ ...base, purpose }, { ...settings, ...config }) as { args: string[] };
      assert.ok(result.args.includes(`model_reasoning_effort="${expected}"`), purpose);
    }
  }
  const overridden = readProductConfig(process.cwd(), { CODEX_REASONING_EFFORT: 'max', CODEX_ONTOLOGY_EFFORT: 'medium', CODEX_CLARIFICATION_EFFORT: 'high', CODEX_JEV_PLANNING_EFFORT: 'high' }).codex;
  for (const [purpose, expected] of [['ontology-design', 'medium'], ['clarification', 'high'], ['jev-planning', 'high'], ['extraction', 'max']] as const) {
    const result = await runCodex({ ...base, purpose }, { ...overridden, ...config }) as { args: string[] };
    assert.ok(result.args.includes(`model_reasoning_effort="${expected}"`), purpose);
  }
  assert.throws(() => readProductConfig(process.cwd(), { CODEX_JEV_PLANNING_EFFORT: 'invalid' }), /CODEX_JEV_PLANNING_EFFORT/);
});

test('probe checks executable capabilities and login without returning raw authentication output', async () => {
  assert.deepEqual(await probeCodex(config), { available: true, authenticated: true, message: 'Codex CLI와 로그인 확인 완료. 모델 접근은 생성 시 확인합니다.' });
  const absent = await probeCodex({ bin: path.join(directory, 'not-installed') });
  assert.equal(absent.available, false);
  assert.equal(absent.authenticated, null);
});

test('Windows npm command shim resolves to package JavaScript without cmd.exe', async () => {
  const prefix = path.join(directory, 'npm prefix with spaces');
  const entry = path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, '/* package launcher */');
  const shim = path.join(prefix, 'codex.cmd');
  await writeFile(shim, '@echo unsafe arbitrary shim contents must never be executed');
  assert.deepEqual(await resolveCodexLauncher(shim, 'win32'), { command: process.execPath, args: [entry] });
  const unrelated = path.join(directory, 'unrelated.cmd');
  await writeFile(unrelated, 'echo unsafe');
  await assert.rejects(resolveCodexLauncher(unrelated, 'win32'), error => error instanceof CodexError && error.code === 'CODEX_CONFIGURATION');
});

test('Windows local node_modules .bin shim resolves without using shell', async () => {
  const root = path.join(directory, 'local-install', 'node_modules');
  const entry = path.join(root, '@openai', 'codex', 'bin', 'codex.js');
  const shim = path.join(root, '.bin', 'codex.cmd');
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.dirname(shim), { recursive: true });
  await writeFile(entry, '');
  await writeFile(shim, '');
  assert.deepEqual(await resolveCodexLauncher(shim, 'win32'), { command: process.execPath, args: [entry] });
});

test('cancellation kills the running child and reports cancellation', async () => {
  const controller = new AbortController();
  const running = runCodex({ ...base, question: 'timeout' }, config, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(running, error => error instanceof CodexError && error.code === 'CODEX_CANCELLED'); }
  finally { clearTimeout(timer); }
});

test('already cancelled requests never launch and timeout terminates a stuck CLI', async () => {
  await assert.rejects(runCodex(base, config, { signal: AbortSignal.abort() }), error => error instanceof CodexError && error.code === 'CODEX_CANCELLED');
  await assert.rejects(runCodex({ ...base, question: 'timeout' }, { ...config, timeoutMs: 120 }), error => error instanceof CodexError && error.code === 'CODEX_TIMEOUT');
});

test('nonzero and auth failures are useful without exposing raw provider output', async () => {
  for (const [question, code] of [['nonzero', 'CODEX_FAILED'], ['auth', 'CODEX_AUTH']]) {
    await assert.rejects(runCodex({ ...base, question }, config), error => {
      assert.ok(error instanceof CodexError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /internal-secret/);
      return true;
    });
  }
});

test('malformed, missing and oversized outputs are rejected before persistence', async () => {
  for (const [question, code] of [['invalid', 'CODEX_INVALID_JSON'], ['array', 'CODEX_INVALID_JSON'], ['no-output', 'CODEX_NO_OUTPUT'], ['oversize-file', 'CODEX_OUTPUT_LIMIT'], ['oversize-stdout', 'CODEX_OUTPUT_LIMIT']]) {
    await assert.rejects(runCodex({ ...base, question }, config), error => error instanceof CodexError && error.code === code);
  }
});

test('unexpected tool execution events stop the extraction', async () => {
  await assert.rejects(runCodex({ ...base, question: 'tool' }, config), error => error instanceof CodexError && error.code === 'CODEX_TOOL_REQUESTED');
});

test('input bounds and model configuration are checked before launching', async () => {
  await assert.rejects(runCodex({ ...base, documents: [{ ...base.documents[0], text: 'x'.repeat(50_001) }] }, config), error => error instanceof CodexError && error.status === 400);
  await assert.rejects(runCodex(base, { ...config, model: 'model; rm -rf /' }), error => error instanceof CodexError && error.code === 'CODEX_CONFIGURATION');
  await assert.rejects(runCodex(base, { ...config, timeoutMs: NaN }), error => error instanceof CodexError && error.code === 'CODEX_CONFIGURATION');
});


test('ontology design accepts prompt-only input without weakening extraction source requirements', async () => {
  const result = await runCodex({ ...base, purpose: 'ontology-design', documents: [] }, config) as Record<string, unknown>;
  assert.equal(result.ok, true); assert.equal(result.document, null); assert.equal(result.purposeIsDesign, true);
  await assert.rejects(runCodex({ ...base, documents: [] }, config), /자료가 필요/);
});
