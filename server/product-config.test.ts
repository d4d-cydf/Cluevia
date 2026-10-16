import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProductConfig } from './product-config.ts';
import { effectiveCodexConfig } from './codex.ts';

test('Sonnet is the product default with medium planning and high reasoning', () => {
  const config = readProductConfig(process.cwd(), {}).codex;
  assert.equal(config.provider, 'claude');
  assert.equal(config.model, 'claude-sonnet-5-5');
  for (const purpose of ['ontology-design', 'clarification'] as const) assert.equal(effectiveCodexConfig(config, purpose).effort, 'medium');
  for (const purpose of ['extraction', 'case-chat', 'jev-planning', 'why-not'] as const) assert.equal(effectiveCodexConfig(config, purpose).effort, 'high');
});

test('provider selection keeps binaries and models separate and honors effort overrides', () => {
  const environment = { CLAUDE_BIN: '/claude', CODEX_BIN: '/codex', CLAUDE_MODEL: 'claude-sonnet-5-5', CODEX_MODEL: 'gpt-6.1-sol', CODEX_CHAT_EFFORT: 'medium' };
  const claude = readProductConfig(process.cwd(), environment).codex;
  assert.equal(claude.bin, '/claude');
  assert.equal(effectiveCodexConfig(claude, 'case-chat').effort, 'medium');
  const codex = readProductConfig(process.cwd(), { ...environment, CLUEVIA_MODEL_PROVIDER: 'codex' }).codex;
  assert.equal(codex.bin, '/codex'); assert.equal(codex.model, 'gpt-6.1-sol');
  assert.equal(effectiveCodexConfig({ provider: 'claude' }).model, 'claude-sonnet-5-5');
  assert.throws(() => readProductConfig(process.cwd(), { CLUEVIA_MODEL_PROVIDER: 'typo' }), /CLUEVIA_MODEL_PROVIDER/);
});
