import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkPool } from './work-pool.ts';
import { AnalysisPipeline } from './analysis-pipeline.ts';
import { JobManager } from './jobs.ts';
import { OntologyStore } from './ontology-store.ts';
import { archiveRecord, createRecordArchive, searchCaseEvidence } from './analysis-case.ts';
import { relevantPassages, searchTerms } from './evidence-search.ts';
import { scopeExclusion } from './analysis-scope.ts';
import { compileExtraction, parseExtraction } from './ontology.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';
import { genericStructuredBatches } from './generic-ingest.ts';
import { exploreGraph } from '../src/lib/graph-exploration.ts';
import { goldCases, scoreExtraction } from './analysis-evaluation.ts';
import { parseAnalysisBrief } from './clarification.ts';
import type { GraphGenerationInput } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import type { AnalysisBrief } from '../src/types/clarification.ts';

const controller = () => new AbortController();
function extracted(input: GraphGenerationInput): OntologyExtraction {
  return { title: 'Synthetic case', summary: 'Synthetic evidence', entities: [{ id: 'company', label: 'Aster', type: 'organization', description: '', identifiers: [{ namespace: 'registry', value: 'ORG-101' }], properties: [], evidence: [{ documentId: input.documents[0].id, quote: input.documents[0].text }] }], relationships: [], events: [], findings: [], limitations: [] };
}
const input: GraphGenerationInput = { question: 'Identify the company', documents: [{ id: 'doc', name: 'source.txt', text: 'Synthetic register: Aster has registry ID ORG-101.' }] };

test('bounded workers release cancelled waiters and make room for another case', async () => {
  const pool = new WorkPool(2); const first = await pool.acquire(controller().signal); const second = await pool.acquire(controller().signal);
  const aborted = controller(); const waiting = pool.acquire(aborted.signal); aborted.abort(); await assert.rejects(waiting);
  let entered = false; const next = pool.acquire(controller().signal).then(release => { entered = true; release(); });
  await delay(0); assert.equal(entered, false); first(); await next; second();
  assert.equal(entered, true);
});

test('independent Codex work runs concurrently and changing effective effort misses cache', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  let active = 0; let peak = 0; let calls = 0;
  const run = async (request: GraphGenerationInput) => { active++; calls++; peak = Math.max(peak, active); await delay(15); active--; return extracted(request); };
  const pipeline = new AnalysisPipeline(store.db, { concurrency: 2, effort: 'high' }, run, undefined, {});
  const signal = controller().signal; const process = (text: string) => pipeline.process({ documents: [{ ...input.documents[0], text }], records: 0 }, input.question, signal, () => {}, () => {});
  await Promise.all([process(input.documents[0].text), process(input.documents[0].text + ' Second source.')]);
  assert.equal(peak, 2); assert.equal(calls, 2);
  const changed = new AnalysisPipeline(store.db, { effort: 'xhigh' }, run, undefined, {});
  await changed.process({ documents: input.documents, records: 0 }, input.question, signal, () => {}, () => {});
  assert.equal(calls, 3);
});

test('cancelling one case cannot cancel a different case with identical source content', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  const pipeline = new AnalysisPipeline(store.db, { concurrency: 2 }, async (request, _config, options) => {
    await delay(20, undefined, { signal: options?.signal }); return extracted(request);
  }, undefined, {});
  const a = controller(); const b = controller();
  const first = pipeline.process({ documents: input.documents, records: 0 }, input.question, a.signal, () => {}, () => {}, undefined, undefined, 'case-a');
  const second = pipeline.process({ documents: input.documents, records: 0 }, input.question, b.signal, () => {}, () => {}, undefined, undefined, 'case-b');
  a.abort(); const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
});

test('search reaches the end of retained originals including empty extraction records', () => {
  const store = new OntologyStore(':memory:'); createRecordArchive(store.db);
  try {
    const text = 'Administrative background. '.repeat(1600) + ' Aster 송금 참조 TX-778 수취인 Boreal';
    archiveRecord(store.db, 'case-a', 1, [{ id: 'raw', name: 'ledger.txt', text }]);
    archiveRecord(store.db, 'case-b', 1, [{ id: 'private', name: 'other.txt', text: 'TX-778 is not in case-a.' }]);
    const job = { id: 'case-a', question: '', status: 'completed', createdAt: '', updatedAt: '' };
    const result = searchCaseEvidence(store.db, job, 'Aster 자금 흐름');
    assert.equal(result.indexedRecords, 1); assert.equal(result.hits.length, 1);
    assert.match(result.hits[0].excerpts.join(' '), /TX-778/);
    assert.doesNotMatch(result.hits[0].excerpts.join(' '), /not in case-a/);
    const spans = relevantPassages(text, searchTerms('TX-778'), 4000);
    assert.ok(spans.every(span => text.slice(span.start, span.end) === span.text));
    assert.ok(spans.some(span => span.start > 12000));
  } finally { store.close(); }
});

test('legacy graph evidence receives the same complete original-text index', () => {
  const store = new OntologyStore(':memory:');
  try {
    const request = { ...input, documents: [{ ...input.documents[0], text: input.documents[0].text + ' Background. '.repeat(2000) + ' Reference LEGACY-778.' }] };
    const value = extracted(request); value.entities[0].evidence[0].quote = input.documents[0].text;
    const graph = store.saveGraph(compileExtraction(value, request), request.documents, value);
    const job = { id: 'legacy-case', question: '', status: 'completed', createdAt: '', updatedAt: '', graphIds: [graph.id] };
    const result = searchCaseEvidence(store.db, job, 'LEGACY-778');
    assert.equal(result.indexedRecords, 1); assert.equal(result.hits.length, 1);
    assert.ok(result.hits[0].evidenceTexts.some(text => text.includes('LEGACY-778')));
    assert.deepEqual(searchCaseEvidence(store.db, job, 'LEGACY-778'), result);
  } finally { store.close(); }
});

test('preparation warms a bounded window and saves graphs before later extraction finishes', async t => {
  const store = new OntologyStore(':memory:'); let release!: () => void; let calls = 0;
  const later = new Promise<void>(resolve => { release = resolve; });
  const manager = new JobManager(store, { concurrency: 2 }, async request => {
    calls++;
    if (Number(request.documents[0].id.slice(4)) >= 2) await later;
    return extracted(request);
  }, undefined, {});
  t.after(async () => { release(); await manager.close(); store.close(); });
  const job = manager.create({ ...input, documents: Array.from({ length: 6 }, (_, index) => ({ ...input.documents[0], id: `doc-${index}`, name: `source-${index}.txt`, text: `${input.documents[0].text} Record ${index}.` })) });
  for (let attempt = 0; attempt < 300 && !manager.get(job.id)?.graphCount; attempt++) await delay(5);
  assert.ok(manager.get(job.id)!.graphCount! > 0, 'the first graph must not wait for every extraction');
  assert.equal(manager.get(job.id)!.totalChunks, 6);
  assert.ok(calls < 6, 'remaining model work should launch as committed slots become free');
  release();
  for (let attempt = 0; attempt < 300 && manager.get(job.id)!.status === 'running'; attempt++) await delay(5);
  assert.equal(manager.get(job.id)!.status, 'completed', manager.get(job.id)!.error);
  assert.equal(manager.get(job.id)!.graphCount, 6);
});

test('one worker begins extraction during preparation without repeating or skipping an uploaded part', async t => {
  const store = new OntologyStore(':memory:');
  const texts = Array.from({ length: 4 }, (_, index) => `${input.documents[0].text} Uploaded record ${index}.`);
  let reads = 0; let active = 0; let peak = 0;
  const calls: { text: string; reads: number }[] = [];
  const uploads = {
    get: (id: string) => ({ id, name: 'source.txt', bytes: 1000, characters: 1000, chunkCount: texts.length, createdAt: '' }),
    getChunk: (id: string, index: number) => { reads++; return { id: `${id}-${index}`, name: `source.txt · part ${index + 1}`, text: texts[index], identityScope: id }; },
  };
  const manager = new JobManager(store, { concurrency: 1 }, async request => {
    calls.push({ text: request.documents[0].text, reads }); active++; peak = Math.max(peak, active);
    try { await delay(5); return extracted(request); } finally { active--; }
  }, uploads, {});
  t.after(async () => { await manager.close(); store.close(); });
  const created = manager.create({ ...input, documents: [], uploadIds: ['upload'] });
  for (let attempt = 0; attempt < 300 && ['queued', 'running'].includes(manager.get(created.id)!.status); attempt++) await delay(5);
  const job = manager.get(created.id)!;
  assert.equal(job.status, 'completed', job.error);
  assert.ok(calls[0].reads < texts.length, 'the first model call overlaps preparation of later uploads');
  assert.deepEqual(calls.map(call => call.text), texts, 'warmup must share its extraction with the saving worker');
  assert.equal(peak, 1); assert.equal(reads, texts.length);
  assert.equal(job.completedChunks, texts.length); assert.equal(job.graphCount, texts.length);
});

test('long-document preparation preserves complete text, stable source identity and excerpt IDs', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  const pipeline = new AnalysisPipeline(store.db, {}, async () => { throw new Error('Preparation must not call a model.'); }, undefined, {});
  const document = { id: 'long-source', name: 'long-source.txt', text: 'Aster synthetic source record 🌊\n'.repeat(4_000) };
  const total = await pipeline.prepare('long-document', { ...input, documents: [document] }, controller().signal, () => {});
  const scope = `inline-${createHash('sha256').update(document.text).digest('hex')}`;
  const stem = `text-${createHash('sha256').update(document.id).digest('hex').slice(0, 24)}`;
  assert.ok(total > 3);
  let reconstructed = '';
  for (let index = 1; index <= total; index++) {
    const part = pipeline.getPart('long-document', index).documents[0];
    assert.equal(part.identityScope, scope); assert.equal(part.id, `${stem}-${index}`);
    assert.ok(part.text.length <= 30_000);
    if (index === 1) reconstructed = part.text;
    else {
      const overlap = reconstructed.endsWith(part.text.slice(0, 201)) ? 201 : 200;
      assert.ok(reconstructed.endsWith(part.text.slice(0, overlap)));
      reconstructed += part.text.slice(overlap);
    }
  }
  assert.equal(reconstructed, document.text);
});

test('a wholly excluded case completes without model calls and retains searchable originals', async t => {
  const store = new OntologyStore(':memory:'); let calls = 0;
  const manager = new JobManager(store, { concurrency: 2 }, async request => { calls++; return extracted(request); }, undefined, {});
  t.after(async () => { await manager.close(); store.close(); });
  const job = manager.create({ ...input, analysisBrief: { objective: 'Filtered scope', scope: 'Only selected source', output: 'Graph', answers: [], filters: { sourceNames: ['selected.txt'], dateField: '', dateFrom: '', dateTo: '' } } });
  for (let attempt = 0; attempt < 300 && ['queued', 'running'].includes(manager.get(job.id)!.status); attempt++) await delay(5);
  const result = manager.get(job.id)!;
  assert.equal(result.status, 'completed', result.error); assert.equal(calls, 0);
  assert.equal(result.graphCount, 0); assert.equal(result.metrics?.scopeSkippedParts, 1);
  assert.equal(result.metrics?.deterministicParts, 0); assert.equal(result.completedChunks, result.totalChunks);
  assert.equal(searchCaseEvidence(store.db, result, 'ORG-101').hits.length, 1);
});

const brief: AnalysisBrief = { objective: '기간 분석', scope: '2026년', output: '그래프', answers: [], filters: { sourceNames: ['rows.jsonl'], dateField: 'date', dateFrom: '2026-01-01', dateTo: '2026-12-31' } };
test('selected files use original names even when displayed chunk names are truncated or decorated', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  const name = 'long-source-'.repeat(23) + '.txt';
  const uploads = {
    get: (id: string) => ({ id, name, bytes: 100, characters: 100, chunkCount: 1, createdAt: '' }),
    getChunk: () => ({ ...input.documents[0], name: `${name.slice(0, 260)} · part 1` }),
  };
  const pipeline = new AnalysisPipeline(store.db, {}, async request => extracted(request), uploads, {});
  const scoped = { ...brief, filters: { sourceNames: [name, 'rows.csv'], dateField: '', dateFrom: '', dateTo: '' } };
  const total = await pipeline.prepare('selected-files', { ...input, analysisBrief: scoped, documents: [{ id: 'csv', name: 'rows.csv', text: 'vessel_name,operator_company\nOcean Star,Harbor Company\n' }], uploadIds: ['upload'] }, controller().signal, () => {});
  assert.equal(total, 2);
  assert.ok(pipeline.getPart('selected-files', 1).extraction!.entities.length > 0);
  assert.equal(pipeline.getPart('selected-files', 2).extraction, undefined, 'selected narrative stays eligible for model analysis');
});
test('scope filters only explicit sources and dates; ambiguity and counterevidence survive', () => {
  assert.ok(scopeExclusion('other.txt', 'x', brief));
  assert.ok(scopeExclusion('rows.jsonl', 'ordinary record', brief, { date: '2025-01-01' }));
  assert.equal(scopeExclusion('rows.jsonl', 'report denies previous ownership', brief, { date: '2025-01-01' }), undefined);
  assert.equal(scopeExclusion('rows.jsonl', 'unknown date', brief, { date: 'yesterday' }), undefined);
  assert.equal(scopeExclusion('rows.jsonl', 'invalid date', brief, { date: '2025-02-31' }), undefined);
  assert.throws(() => parseAnalysisBrief({ ...brief, filters: { ...brief.filters, dateFrom: '2026-02-31' } }));
});

test('excluded structured rows are retained without creating facts or losing following rows', async () => {
  const definition = parseOntologyDefinition({ apiName: 'Rows', displayName: 'Rows', objectTypes: [{ apiName: 'Row', primaryKey: 'id', titleProperty: 'id', properties: [{ apiName: 'id', baseType: 'string' }, { apiName: 'date', baseType: 'string' }, { apiName: 'text', baseType: 'string' }] }], sourceMappings: [{ sourceName: 'rows.jsonl', format: 'jsonl', objectType: 'Row', identityColumns: ['id'], columns: [{ column: 'id', property: 'id' }, { column: 'date', property: 'date' }, { column: 'text', property: 'text' }], relations: [] }] });
  const rows = [{ id: 'R-1', date: '2026-01-01', text: 'in scope' }, { id: 'R-2', date: '2025-01-01', text: 'outside' }, { id: 'R-3', date: 'unknown', text: 'unknown' }, { id: 'R-4', date: '2025-01-01', text: 'denied earlier claim' }];
  const parts = [];
  for await (const part of genericStructuredBatches({ id: 'source', name: 'rows.jsonl' }, [rows.map(row => JSON.stringify(row)).join('\n')], definition, { analysisBrief: brief })) parts.push(part);
  assert.equal(parts.reduce((sum, part) => sum + part.records, 0), 4);
  assert.equal(parts.filter(part => part.extraction?.limitations.some(note => note.startsWith('[범위 제외]'))).length, 1);
  assert.equal(parts.flatMap(part => part.extraction?.entities ?? []).length, 3);
  assert.ok(parts.some(part => part.documents.some(document => document.text.includes('R-2'))));
});

function denial() {
  const request = { question: 'Assess ownership', documents: [{ id: 'doc', name: 'statement.txt', text: 'Aster (ORG-101) denied ownership of Nova (ASSET-101) on 2026-01-02.' }] };
  const value = extracted(request);
  value.entities.push({ ...value.entities[0], id: 'asset', label: 'Nova', type: 'asset', identifiers: [{ namespace: 'registry', value: 'ASSET-101' }] });
  value.relationships.push({ id: 'owns', source: 'company', target: 'asset', type: 'owns', label: 'ownership denial', description: '', status: 'reported', evidence: value.entities[0].evidence, claim: { stance: 'denied', attributedTo: 'Aster', validFrom: null, validTo: null, publishedAt: '2026-01-02', derivedFrom: null } });
  return { request, value };
}
test('claim stance and provenance survive validation, storage, reload and exact source spans', () => {
  const store = new OntologyStore(':memory:');
  try {
    const { request, value } = denial(); const graph = compileExtraction(value, request);
    const stored = store.saveGraph(graph, request.documents, value);
    assert.equal(store.getGraph(stored.id)!.edges[0].claim?.stance, 'denied');
    const claim = JSON.parse(String(store.db.prepare('SELECT claim_json FROM relations').get()!.claim_json));
    assert.equal(claim.claim.attributedTo, 'Aster'); assert.equal(claim.evidence[0].sourceId, 'doc');
    const span = claim.evidence[0].spans[0]; assert.equal(request.documents[0].text.slice(span.start, span.end), claim.evidence[0].quote);
    assert.match(claim.evidence[0].textHash, /^[a-f0-9]{64}$/);
    value.relationships[0].claim!.attributedTo = 'Invented publisher'; assert.throws(() => parseExtraction(value, request));
  } finally { store.close(); }
});

test('cross-case identity approval and undo preserve every original entity and claim', () => {
  const store = new OntologyStore(':memory:');
  try {
    for (const suffix of [' Record A.', ' Record B.']) { const request = { ...input, documents: [{ ...input.documents[0], text: input.documents[0].text + suffix }] }; const value = extracted(request); store.saveGraph(compileExtraction(value, request), request.documents, value); }
    const ids = store.db.prepare('SELECT id FROM entities').all().map(row => String(row.id)); assert.equal(ids.length, 2);
    const candidates = store.identityCandidates(ids[0]); assert.equal(candidates[0].id, ids[1]);
    assert.equal(store.reviewIdentity(ids[0], ids[1], 'linked', 'Checked registry scope')[0].status, 'linked');
    assert.equal(store.reviewIdentity(ids[0], ids[1], 'unreviewed', 'Reopen')[0].status, 'unreviewed');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM entities').get()!.n, 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM entity_identity_history').get()!.n, 2);
  } finally { store.close(); }
});

test('large graph projection is bounded, fully pageable and follows a selected relationship', () => {
  const graph = compileExtraction(denial().value, denial().request);
  graph.nodes = Array.from({ length: 10000 }, (_, index) => ({ ...graph.nodes[0], id: `N-${index}`, label: `Object ${index}` }));
  graph.edges = [{ ...graph.edges[0], id: 'selected', source: 'N-9998', target: 'N-9999' }];
  const selected = exploreGraph(graph, { selection: { kind: 'edge', id: 'selected' }, query: '', group: '', page: 0, depth: 1 });
  assert.equal(selected.graph.nodes.length, 2); assert.equal(selected.graph.edges[0].id, 'selected');
  const searched = exploreGraph(graph, { selection: null, query: 'Object 9999', group: '', page: 0, depth: 0 });
  assert.equal(searched.graph.nodes[0].id, 'N-9999');
  const seen = new Set<string>(); let pages = 1;
  for (let page = 0; page < pages; page++) { const result = exploreGraph(graph, { selection: { kind: 'edge', id: 'selected' }, query: '', group: '', page, depth: 0 }); pages = result.pages; assert.ok(result.graph.nodes.length <= 200); result.graph.nodes.forEach(node => seen.add(node.id)); }
  assert.equal(seen.size, 10000); assert.equal(graph.nodes.length, 10000);
});

test('quality scoring catches positive relations extracted from denial evidence', () => {
  const { value } = denial(); const gold = goldCases.find(item => item.id === 'denial')!;
  assert.equal(scoreExtraction(gold, value).relationRecall, 1);
  value.relationships[0].claim!.stance = 'asserted';
  assert.equal(scoreExtraction(gold, value).relationRecall, 0); assert.equal(scoreExtraction(gold, value).stanceErrors, 1);
});
