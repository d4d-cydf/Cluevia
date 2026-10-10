import { resolve } from 'node:path';
import type { CodexConfig } from './codex.ts';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_STAGE_EFFORTS } from './codex.ts';
import { readJevConfig } from './jev.ts';
import type { JevConfig } from './jev.ts';

export interface ProductConfig {
  root: string;
  dataDir: string;
  accessToken: string;
  codex: CodexConfig;
  jev?: JevConfig;
  ontologyPlanning?: boolean;
  seedExample: boolean;
  /** 0 means no application upload byte cap. Model batches remain bounded. */
  maxUploadBytes?: number;
}

export function readProductConfig(root: string, environment: Record<string, string | undefined> = process.env): ProductConfig {
  const timeout = Number(environment.CODEX_TIMEOUT_MS || 180_000);
  if (!Number.isFinite(timeout) || timeout < 10_000 || timeout > 600_000) throw new Error('CODEX_TIMEOUT_MS must be between 10000 and 600000.');
  const ontologyTimeout = Number(environment.CODEX_ONTOLOGY_TIMEOUT_MS || timeout);
  if (!Number.isFinite(ontologyTimeout) || ontologyTimeout < 10_000 || ontologyTimeout > 600_000) throw new Error('CODEX_ONTOLOGY_TIMEOUT_MS must be between 10000 and 600000.');
  const accessToken = environment.CLUEVIA_ACCESS_TOKEN?.trim() || '';
  const effort = environment.CODEX_REASONING_EFFORT?.trim() || DEFAULT_CODEX_EFFORT;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('CODEX_REASONING_EFFORT must be low, medium, high, xhigh or max.');
  if (accessToken && accessToken.length < 16) throw new Error('CLUEVIA_ACCESS_TOKEN must contain at least 16 characters.');
  const maximumMb = Number(environment.CLUEVIA_MAX_UPLOAD_MB || 0);
  const maxUploadBytes = maximumMb * 1024 * 1024;
  if (!Number.isFinite(maximumMb) || maximumMb < 0 || !Number.isSafeInteger(maxUploadBytes)) throw new Error('CLUEVIA_MAX_UPLOAD_MB must be a non-negative number of megabytes (0 disables the application cap).');
  const bounded = (name: string, fallback: number, maximum: number) => {
    const value = Number(environment[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`);
    return value;
  };
  const efforts: NonNullable<CodexConfig['efforts']> = {};
  for (const [purpose, name] of [['extraction', 'CODEX_EXTRACTION_EFFORT'], ['ontology-design', 'CODEX_ONTOLOGY_EFFORT'], ['case-chat', 'CODEX_CHAT_EFFORT'], ['clarification', 'CODEX_CLARIFICATION_EFFORT'], ['jev-planning', 'CODEX_JEV_PLANNING_EFFORT']] as const) {
    const value = environment[name]?.trim() || DEFAULT_CODEX_STAGE_EFFORTS[purpose] || effort;
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error(`${name} has an invalid reasoning effort.`);
    efforts[purpose] = value as NonNullable<CodexConfig['effort']>;
  }
  return {
    root,
    dataDir: resolve(root, environment.CLUEVIA_DATA_DIR || '.cluevia'),
    accessToken,
    codex: { bin: environment.CODEX_BIN?.trim() || undefined, model: environment.CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL, effort: effort as CodexConfig['effort'], timeoutMs: timeout, ontologyTimeoutMs: ontologyTimeout, concurrency: bounded('CODEX_CONCURRENCY', 2, 8), jobConcurrency: bounded('CLUEVIA_JOB_CONCURRENCY', 2, 4), efforts },
    jev: readJevConfig(environment),
    ontologyPlanning: true,
    seedExample: environment.CLUEVIA_SEED_EXAMPLE !== 'false',
    maxUploadBytes,
  };
}
