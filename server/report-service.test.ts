import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ReportError, ReportService, parseReportContent } from './report-service.ts';
import { analysisRevision } from './why-not-service.ts';
import { whyFixture } from './why-not-fixture.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import { OntologyStore } from './ontology-store.ts';
import { compileExtraction } from './ontology.ts';
import { archiveRecord, createRecordArchive } from './analysis-case.ts';
import type { CodexInput } from './codex.ts';
import type { CodexRunner, GenerationJob } from './jobs.ts';
import type { WhyRun } from '../src/types/why-not.ts';
import type { ReportContent, ReportRun } from '../src/types/report.ts';

function reply(input: CodexInput): ReportContent {
  const context = JSON.parse(input.context!);
  return { title: '사건 E1 근거 검토', subtitle: '저장된 자료와 남은 확인 사항',
    conclusion: [{ text: '저장된 자료의 조건별 근거를 확인했으나 결론은 검토 범위 안에서 해석해야 합니다.', citationIds: context.citations.slice(0, 1).map((item: { id: string }) => item.id) }], sections: [],
    gapAnalysis: context.gaps.map((gap: { id: string }) => ({ gapId: gap.id, analysis: '저장된 판정에 이 확인 사항이 남아 있습니다.', recommendation: '해당 조건을 직접 확인하는 원문을 추가로 확보해야 합니다.' })),
    limitations: ['저장된 발췌 범위에 한정됩니다.'], nextSteps: ['누락된 조건에 해당하는 직접 자료를 확인합니다.'] };
}
function setup(t: TestContext, runner: CodexRunner = async input => reply(input), providedDb?: DatabaseSync) {
  const db = providedDb ?? new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE generation_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const snapshot = whyFixture(2); const at = '2026-10-11T00:00:00.000Z';
  const job: GenerationJob = { id: 'report-job', question: snapshot.goal, status: 'completed', stage: 'saving', message: '완료', createdAt: at, updatedAt: at, totalChunks: 1, completedChunks: 1, emptyChunks: 0, graphIds: [], resumable: false };
  const result = evaluateWhyNot(snapshot);
  const why: WhyRun = { id: 'why-ready', jobId: job.id, previousId: null, status: 'completed', stage: '완료', phase: 'ready', createdAt: at, updatedAt: at,
    analysisRevision: analysisRevision(job), snapshot, baseSnapshot: structuredClone(snapshot), result,
    preparation: { version: 'cluevia-preparation-1', ready: true, baselineScore: 50, score: 50, grade: 'F', preparedAt: at, animation: [], gapFill: [] } };
  db.prepare('INSERT INTO generation_jobs VALUES (?,?)').run(job.id, JSON.stringify(job));
  const service = new ReportService(db, { provider: 'claude', model: 'test-report', effort: 'low' }, runner, () => why);
  t.after(async () => { await service.close(); if (!providedDb) db.close(); });
  const get = (id: string) => JSON.parse(String(db.prepare('SELECT payload FROM case_reports WHERE id=?').get(id)!.payload)) as ReportRun;
  const finish = async (id: string) => { for (let count = 0; count < 100; count++) { const current = get(id); if (current.status !== 'running') return current; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Report did not settle'); };
  return { db, job, why, service, get, finish };
}

test('report persists current deterministic scores, exact citations and assessment context; reads are pure and completed input is idempotent', async t => {
  let calls = 0; let input: CodexInput | undefined;
  const s = setup(t, async (value, config) => { calls++; input = value; assert.equal(config?.effort, 'high'); assert.equal(value.purpose, 'case-report'); return reply(value); });
  s.why.result!.confidence.bayesian!.score = .99;
  const before = JSON.stringify(s.why);
  assert.equal(s.service.list(s.job).canGenerate, true); assert.equal(calls, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM case_reports').get()!.n, 0);
  const initial = s.service.generate(s.job); assert.equal(initial.status, 'running');
  const completed = await s.finish(initial.id); assert.equal(completed.status, 'completed');
  assert.equal(completed.snapshot.confidence.score, evaluateWhyNot(s.why.snapshot!).confidence.bayesian!.score * 100);
  assert.ok(completed.snapshot.graph.nodes.length); assert.equal(completed.snapshot.citations.length, 2);
  assert.equal(completed.snapshot.citations[0].quote, s.why.snapshot!.bindings[0].quote);
  const context = JSON.parse(input!.context!);
  assert.equal(context.assessments.length, 2); assert.equal(context.assessments[0].verdict, 'SUPPORTED');
  assert.ok(context.assessments[0].contributionReason); assert.ok(context.associationSummary);
  assert.equal(s.service.generate(s.job).id, initial.id); assert.equal(calls, 1);
  assert.equal(s.service.list(s.job).currentInputHash, initial.inputHash); assert.equal(JSON.stringify(s.why), before);
  const forced = s.service.generate(s.job, { force: true }); assert.notEqual(forced.id, initial.id);
  assert.equal((await s.finish(forced.id)).status, 'completed'); assert.equal(calls, 2); assert.equal(s.service.list(s.job).reports.length, 2);
});

test('incomplete main analysis, pending review and stale or missing assessment revisions cannot create mixed reports', t => {
  const s = setup(t);
  const reject = () => { assert.throws(() => s.service.generate(s.job), error => error instanceof ReportError && error.status === 409); assert.equal(s.service.list(s.job).canGenerate, false); };
  s.job.status = 'running'; reject(); s.job.status = 'completed';
  s.why.preparation!.ready = false; reject(); s.why.preparation!.ready = true;
  s.job.completedChunks = 2; reject(); s.job.completedChunks = 1;
  delete s.why.analysisRevision; reject();
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM case_reports').get()!.n, 0);
});

test('report snapshot remains immutable when a newer assessment appears while the model is writing', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup(t, async input => { await gate; return reply(input); });
  const first = s.service.generate(s.job);
  assert.equal(s.service.generate(s.job, { force: true }).id, first.id);
  s.why.id = 'why-new-version'; s.why.snapshot!.bindings[0].reason = '새 버전에서 검토한 이유';
  release(); const saved = await s.finish(first.id);
  assert.equal(saved.snapshot.whyRunId, 'why-ready'); assert.notEqual(s.service.list(s.job).currentInputHash, saved.inputHash);
  assert.equal(saved.snapshot.assessments![0].reason, '원문에 완료가 명시됨');
});

test('invalid model reference fails publication and never saves a partial report', async t => {
  const s = setup(t, async input => { const value = reply(input); value.conclusion[0].citationIds = ['invented-citation']; return value; });
  const saved = await s.finish(s.service.generate(s.job).id);
  assert.equal(saved.status, 'failed'); assert.match(saved.error!, /제공되지 않은 인용/); assert.equal(saved.content, undefined);
});

test('report validation rejects missing/duplicate gaps, unknown references, links and extra numeric fields', async t => {
  const s = setup(t); s.why.snapshot!.bindings[0].verdict = 'INSUFFICIENT';
  const complete = await s.finish(s.service.generate(s.job).id);
  const valid = complete.content!; const supplied = new Set(complete.snapshot.citations.map(citation => citation.id));
  assert.ok(valid.gapAnalysis.length);
  const invalid = [
    { ...valid, confidence: 99 }, { ...valid, gapAnalysis: [] },
    { ...valid, gapAnalysis: [...valid.gapAnalysis, valid.gapAnalysis[0]] },
    { ...valid, gapAnalysis: [{ ...valid.gapAnalysis[0], gapId: 'invented' }] },
    { ...valid, conclusion: [{ text: '외부 자료 https://invented.example', citationIds: [] }] },
    { ...valid, conclusion: [{ text: '<script>invalid</script>', citationIds: [] }] },
    { ...valid, conclusion: [{ text: '없는 출처', citationIds: ['invented'] }] },
  ];
  for (const value of invalid) assert.throws(() => parseReportContent(value, complete.snapshot, supplied), ReportError);
});

test('gap-only cases can create an honest report without fabricated documents or citations', async t => {
  const s = setup(t, async input => { assert.deepEqual(input.documents, []); return reply(input); });
  s.why.snapshot!.evidence = []; s.why.snapshot!.bindings = [];
  s.why.snapshot!.nodes.filter(node => node.kind === 'requirement').forEach(node => { node.children = []; });
  s.why.snapshot!.policy.independence = []; s.why.baseSnapshot = structuredClone(s.why.snapshot);
  const saved = await s.finish(s.service.generate(s.job).id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.snapshot.citations.length, 0); assert.ok(saved.snapshot.gaps.some(gap => gap.type === 'EVIDENCE_MISSING'));
});

test('cancellation and deletion stop late model results without losing previous completed reports', async t => {
  let gated = false;
  const s = setup(t, async (input, _config, options) => {
    if (!gated) return reply(input);
    return new Promise((_resolve, reject) => { if (options?.signal?.aborted) reject(new Error('cancelled')); else options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  });
  const previous = await s.finish(s.service.generate(s.job).id); gated = true;
  const current = s.service.generate(s.job, { force: true }); await Promise.resolve();
  assert.equal((await s.service.cancel(s.job.id))!.status, 'cancelled');
  assert.equal(s.get(previous.id).status, 'completed'); assert.equal(s.get(current.id).content, undefined);
  s.service.generate(s.job, { force: true }); await Promise.resolve(); await s.service.remove(s.job.id);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM case_reports').get()!.n, 0);
});

test('restart fails unfinished reports while many later failures never hide completed history', async t => {
  const s = setup(t); const complete = await s.finish(s.service.generate(s.job).id);
  for (let i = 0; i < 25; i++) { const value = { ...complete, id: `failed-${i}`, status: 'failed', content: undefined }; s.db.prepare('INSERT INTO case_reports VALUES (?,?,?,?)').run(value.id, s.job.id, value.createdAt, JSON.stringify(value)); }
  assert.ok(s.service.list(s.job).reports.some(report => report.id === complete.id));
  const interrupted = { ...complete, id: 'interrupted', status: 'running', content: undefined };
  s.db.prepare('INSERT INTO case_reports VALUES (?,?,?,?)').run(interrupted.id, s.job.id, interrupted.createdAt, JSON.stringify(interrupted));
  const restarted = new ReportService(s.db, {}, async input => reply(input), () => s.why); await restarted.close();
  assert.equal(s.get(interrupted.id).status, 'failed'); assert.match(s.get(interrupted.id).error!, /서버 재시작/); assert.equal(s.get(complete.id).status, 'completed');
  assert.ok(s.service.list(s.job).reports.some(report => report.id === complete.id));
});

test('at most two cases write reports concurrently while same-case starts remain idempotent', async t => {
  const s = setup(t, async (_input, _config, options) => new Promise((_resolve, reject) => {
    if (options?.signal?.aborted) reject(new Error('cancelled'));
    else options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const secondJob = { ...s.job, id: 'report-job-2' }; const thirdJob = { ...s.job, id: 'report-job-3' };
  for (const job of [secondJob, thirdJob]) s.db.prepare('INSERT INTO generation_jobs VALUES (?,?)').run(job.id, JSON.stringify(job));
  const first = s.service.generate(s.job); const second = s.service.generate(secondJob);
  assert.notEqual(first.id, second.id); assert.equal(s.service.generate(s.job).id, first.id);
  assert.throws(() => s.service.generate(thirdJob), error => error instanceof ReportError && error.status === 429);
  await Promise.resolve(); await s.service.cancel(s.job.id); await s.service.cancel(secondJob.id);
  assert.equal(s.get(first.id).status, 'cancelled'); assert.equal(s.get(second.id).status, 'cancelled');
});

test('association citations after the first 12000 characters are verified against the complete retained document', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close()); createRecordArchive(store.db);
  store.db.exec('CREATE TABLE analysis_parts(job_id TEXT,part_index INTEGER,graph_id TEXT,PRIMARY KEY(job_id,part_index))');
  const s = setup(t, undefined, store.db);
  const quote = 'Ocean Star visited Busan.'; const documents = [{ id: 'source-1', name: '긴 원문', text: '앞쪽에 있는 다른 기록. '.repeat(1800) + quote }];
  const evidence = [{ documentId: 'source-1', quote }];
  const extraction = { title: '방문 기록', summary: quote, limitations: [], entities: [
    { id: 'ship', label: 'Ocean Star', type: 'vessel', description: quote, identifiers: [], properties: [], evidence },
    { id: 'port', label: 'Busan', type: 'place', description: quote, identifiers: [], properties: [], evidence },
  ], relationships: [{ id: 'visit', source: 'ship', target: 'port', label: 'Visited', type: 'visited', description: quote, status: 'reported' as const, evidence }], events: [], findings: [] };
  const compiled = compileExtraction(extraction, { question: s.job.question, documents }); compiled.sources[0].excerpt = quote;
  const graph = store.saveGraph(compiled, documents, extraction);
  store.db.prepare('INSERT INTO analysis_parts VALUES (?,?,?)').run(s.job.id, 1, graph.id); archiveRecord(store.db, s.job.id, 1, documents, extraction);
  s.job.graphIds = [graph.id]; s.why.analysisRevision = analysisRevision(s.job);
  const saved = await s.finish(s.service.generate(s.job).id);
  assert.equal(saved.status, 'completed'); const citation = saved.snapshot.citations.find(citation => citation.quote === quote)!;
  assert.ok(citation); assert.equal(citation.record, 1);
  assert.ok(saved.snapshot.associationSummary!.edges[0].citationIds.includes(citation.id));
});
