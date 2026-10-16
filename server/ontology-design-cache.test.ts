import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteOntologyDesignCache } from './ontology-design-cache.ts';
import type { OntologyDesignCache } from './ontology-design-cache.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { designOntology } from './ontology-planner.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';

const definition = () => parseOntologyDefinition({
  apiName: 'Employment', displayName: '고용 관계',
  objectTypes: ['Person', 'Company'].map(apiName => ({ apiName, primaryKey: 'name', titleProperty: 'name', properties: [{ apiName: 'name', baseType: 'string' }] })),
  linkTypes: [{ apiName: 'worksFor', sourceType: 'Person', targetType: 'Company', sourceCardinality: 'many', targetCardinality: 'one' }],
}, { id: 'ontology-first-job', version: 1 });

function database(t: TestContext): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

test('design cache survives restart and supports isolated identities for separate jobs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-design-cache-'));
  let active: DatabaseSync | undefined;
  t.after(async () => {
    active?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'cache.sqlite');
  const first = active = new DatabaseSync(file);
  new SqliteOntologyDesignCache(first).set('same-exact-design-input', definition());
  first.close(); active = undefined;
  const second = active = new DatabaseSync(file);
  const cache: OntologyDesignCache = new SqliteOntologyDesignCache(second);
  const reusable = cache.get('same-exact-design-input');
  assert.ok(reusable);
  const next = parseOntologyDefinition(reusable, { id: 'ontology-second-job', version: 2 });
  assert.equal(next.id, 'ontology-second-job');
  assert.equal(next.version, 2);
  assert.deepEqual(next.objectTypes, definition().objectTypes);
  assert.equal(cache.get('same-exact-design-input')!.id, 'ontology-first-job');
  assert.equal(cache.get('different-design-input'), undefined);
});

test('cache writes and reads do not share mutable definitions with callers', t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const original = definition();
  cache.set('immutable', original);
  original.objectTypes[0].displayName = 'external mutation';
  const first = cache.get('immutable')!;
  assert.notEqual(first.objectTypes[0].displayName, 'external mutation');
  first.objectTypes[0].displayName = 'read mutation';
  first.processing.decisionRules!.push({ apiName: 'not-a-rule' } as never);
  const second = cache.get('immutable')!;
  assert.deepEqual(second, definition());
});

test('malformed or invalid stored definitions are ignored and removed', t => {
  const db = database(t); const cache = new SqliteOntologyDesignCache(db);
  const insert = db.prepare('INSERT INTO ontology_design_cache VALUES (?,?,?)');
  insert.run('bad-json', '{', 1);
  insert.run('bad-contract', JSON.stringify({ ...definition(), linkTypes: [{ ...definition().linkTypes[0], targetType: 'Missing' }] }), 2);
  assert.equal(cache.get('bad-json'), undefined);
  assert.equal(cache.get('bad-contract'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ontology_design_cache').get()!.count, 0);
  cache.set('valid', definition());
  assert.doesNotThrow(() => cache.set('invalid', { ...definition(), objectTypes: [] }));
  assert.equal(cache.get('invalid'), undefined);
  assert.ok(cache.get('valid'));
});

test('bounded design cache evicts the least recently used entry', t => {
  const db = database(t); const cache = new SqliteOntologyDesignCache(db, { maxEntries: 2 });
  cache.set('one', definition()); cache.set('two', definition());
  assert.ok(cache.get('one'));
  cache.set('three', definition());
  assert.equal(cache.get('two'), undefined);
  assert.ok(cache.get('one')); assert.ok(cache.get('three'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ontology_design_cache').get()!.count, 2);
  // Replacing a key refreshes its position without allocating another cache entry.
  cache.set('one', definition()); cache.set('four', definition());
  assert.equal(cache.get('three'), undefined);
  assert.ok(cache.get('one')); assert.ok(cache.get('four'));
});

test('cache capacity is capped and lower startup capacity prunes existing entries', t => {
  const db = database(t); const cache = new SqliteOntologyDesignCache(db, { maxEntries: 1000 });
  for (let index = 0; index < 102; index++) cache.set(`entry-${index}`, definition());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ontology_design_cache').get()!.count, 100);
  assert.equal(cache.get('entry-0'), undefined);
  const smaller = new SqliteOntologyDesignCache(db, { maxEntries: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ontology_design_cache').get()!.count, 2);
  assert.ok(smaller.get('entry-100')); assert.ok(smaller.get('entry-101'));
});

test('unavailable or read-only cache storage never blocks fresh analysis', t => {
  const readOnly = database(t);
  readOnly.exec('PRAGMA query_only = ON');
  const disabled = new SqliteOntologyDesignCache(readOnly);
  assert.doesNotThrow(() => disabled.set('entry', definition()));
  assert.equal(disabled.get('entry'), undefined);
  const closed = new DatabaseSync(':memory:');
  const cache = new SqliteOntologyDesignCache(closed);
  cache.set('entry', definition()); closed.close();
  assert.equal(cache.get('entry'), undefined);
  assert.doesNotThrow(() => cache.set('entry', definition()));
  assert.doesNotThrow(() => new SqliteOntologyDesignCache(closed));
});

test('identical ontology input skips model design while each job receives fresh identity and version', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const input: GraphGenerationInput = { question: '고용 관계를 설계해줘', documents: [{ id: 'first-upload', name: 'report.txt', text: 'Alice works for Acme.' }] };
  let calls = 0;
  const runner: Parameters<typeof designOntology>[2] = async () => { calls++; return definition(); };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  const first = await designOntology(input, undefined, runner, {}, { ...options, id: 'first-ontology' });
  const reuploaded = { ...input, documents: [{ ...input.documents[0], id: 'different-upload-id' }] };
  const cachedMetrics: Record<string, number> = {};
  const second = await designOntology(reuploaded, undefined, runner, {}, { ...options, id: 'second-ontology', version: 2,
    metrics: delta => { for (const [key, value] of Object.entries(delta)) cachedMetrics[key] = (cachedMetrics[key] ?? 0) + value; },
  });
  assert.equal(calls, 1);
  assert.equal(first.id, 'first-ontology'); assert.equal(first.version, 1);
  assert.equal(second.id, 'second-ontology'); assert.equal(second.version, 2);
  assert.equal(cachedMetrics.ontologyCacheHits, 1);
  assert.ok(cachedMetrics.ontologyProfileMs >= 0); assert.ok(cachedMetrics.designMs >= 0);
  assert.equal(cachedMetrics.ontologyModelMs, undefined, 'a cache hit does not report a model invocation');
  assert.deepEqual(second.objectTypes, first.objectTypes);
  second.objectTypes[0].displayName = 'changed by caller';
  const third = await designOntology(input, undefined, runner, {}, { ...options, id: 'third-ontology' });
  assert.equal(calls, 1);
  assert.deepEqual(third.objectTypes, first.objectTypes);
});

test('changed full evidence invalidates cached design even when bounded previews are identical', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const text = 'A'.repeat(4000) + 'middle'.repeat(5000) + 'Z'.repeat(4000);
  const input: GraphGenerationInput = { question: '자료 구조를 설계해줘', documents: [{ id: 'report', name: 'report.txt', text }] };
  const previews: string[] = [];
  const runner: Parameters<typeof designOntology>[2] = async candidate => { previews.push(candidate.documents[0].text); return definition(); };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  await designOntology(input, undefined, runner, {}, { ...options, id: 'original' });
  const changed = { ...input, documents: [{ ...input.documents[0], text: text.slice(0, 12000) + 'X' + text.slice(12001) }] };
  await designOntology(changed, undefined, runner, {}, { ...options, id: 'changed' });
  assert.equal(previews.length, 2, 'the full content hash must invalidate a preview-equivalent source');
  assert.equal(previews[0], previews[1], 'the changed evidence is outside the bounded schema preview');
});

test('duplicate text filenames and content keep distinct model document IDs and reusable design', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const input: GraphGenerationInput = { question: '중복 제출 자료의 고용 관계를 설계해줘', documents: [
    { id: 'first-upload', name: 'report.txt', text: 'Alice works for Acme.' },
    { id: 'second-upload', name: 'report.txt', text: 'Alice works for Acme.' },
  ] };
  let calls = 0;
  const runner: Parameters<typeof designOntology>[2] = async candidate => {
    calls++;
    assert.equal(candidate.documents.length, 2, 'both submitted sources reach the design request');
    const ids = candidate.documents.map(document => document.id);
    assert.equal(new Set(ids).size, 2, 'Codex rejects duplicate document IDs even for identical samples');
    for (const id of ids) assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/);
    return definition();
  };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  await designOntology(input, undefined, runner, {}, { ...options, id: 'duplicate-sources' });
  const reuploaded = { ...input, documents: input.documents.map((document, index) => ({ ...document, id: `new-upload-${index}` })) };
  const reused = await designOntology(reuploaded, undefined, runner, {}, { ...options, id: 'reuploaded-duplicates' });
  assert.equal(calls, 1, 'source multiplicity and contents are unchanged despite new upload identifiers');
  assert.equal(reused.id, 'reuploaded-duplicates');
});

test('confirmed scope and model settings isolate ontology cache entries', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const input: GraphGenerationInput = { question: '고용 관계', documents: [], analysisBrief: { objective: '고용 관계 확인', scope: '2025년', output: '관계 그래프', answers: [] } };
  let calls = 0;
  const runner: Parameters<typeof designOntology>[2] = async () => { calls++; return definition(); };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  await designOntology(input, undefined, runner, { model: 'model-one' }, { ...options, id: 'first' });
  await designOntology({ ...input, analysisBrief: { ...input.analysisBrief!, scope: '2026년' } }, undefined, runner, { model: 'model-one' }, { ...options, id: 'changed-scope' });
  await designOntology(input, undefined, runner, { model: 'model-two' }, { ...options, id: 'changed-model' });
  await designOntology(input, undefined, runner, { model: 'model-one', efforts: { 'ontology-design': 'high' } }, { ...options, id: 'changed-effort' });
  assert.equal(calls, 4);
});

test('explicit repair bypasses cached design and leaves the original reusable result intact', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  const input: GraphGenerationInput = { question: '고용 관계', documents: [] };
  let calls = 0;
  const runner: Parameters<typeof designOntology>[2] = async () => {
    calls++;
    return { ...definition(), displayName: calls === 2 ? '수정된 설계' : '원래 설계' };
  };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  await designOntology(input, undefined, runner, {}, { ...options, id: 'original' });
  const repaired = await designOntology(input, undefined, runner, {}, { ...options, id: 'original', version: 2, repairReason: 'identity mapping requires correction' });
  const reused = await designOntology(input, undefined, runner, {}, { ...options, id: 'later-job' });
  assert.equal(calls, 2);
  assert.equal(repaired.displayName, '수정된 설계'); assert.equal(repaired.version, 2);
  assert.equal(reused.displayName, '원래 설계'); assert.equal(reused.id, 'later-job');
});

const reportsDefinition = () => parseOntologyDefinition({
  apiName: 'Reports', displayName: '보고서',
  objectTypes: [{ apiName: 'Report', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }] }],
  sourceMappings: [{ sourceName: 'reports.jsonl', format: 'jsonl', objectType: 'Report', columns: ['id'].map(column => ({ column, property: column })), identityColumns: ['id'], semanticColumns: ['body'], relations: [] }],
});
const reportsInput = (): GraphGenerationInput => ({ question: '보고서 내용을 분석해줘', documents: [{ id: 'reports', name: 'reports.jsonl', text: [
  JSON.stringify({ id: 'R1', body: 'First reported observation.' }),
  JSON.stringify({ id: 'R2', body: 'Second reported observation.' }),
].join('\n') }] });

test('failed optional Jev planning is not cached, while a successful empty plan is reusable', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  let designs = 0; let rules = 0;
  const runner: Parameters<typeof designOntology>[2] = async input => {
    if (input.purpose === 'ontology-design') { designs++; return reportsDefinition(); }
    assert.equal(input.purpose, 'jev-planning'); rules++;
    if (rules === 1) throw new Error('Temporary optional rule failure');
    return { decisionRules: [] };
  };
  const options = { cache, planJevRules: true, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  const first = await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'fallback' });
  assert.deepEqual(first.processing.decisionRules, []);
  await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'retried' });
  await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'reused' });
  assert.equal(designs, 2); assert.equal(rules, 2, 'temporary rule failure must not freeze the degraded result');
});

test('unresolved structured mapping gaps are not cached and can improve on the next design', async t => {
  const cache = new SqliteOntologyDesignCache(database(t));
  let calls = 0;
  const runner: Parameters<typeof designOntology>[2] = async () => {
    calls++;
    const candidate = reportsDefinition();
    if (calls <= 2) candidate.sourceMappings[0].semanticColumns = [];
    return candidate;
  };
  const options = { cache, signal: new AbortController().signal, usage: () => {}, progress: () => {} };
  const first = await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'unresolved' });
  assert.equal(calls, 2, 'one mapping repair is attempted before retaining originals for model review');
  assert.match(first.processing.rationale, /직접 변환 규칙에 포함되지 않은/);
  const second = await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'improved' });
  assert.deepEqual(second.sourceMappings[0].semanticColumns, ['body']);
  await designOntology(reportsInput(), undefined, runner, {}, { ...options, id: 'reused' });
  assert.equal(calls, 3, 'the complete replacement design is now reusable');
});
