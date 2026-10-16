import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WhyNotService, makeWhyEvidence, snapshotFromWhyDraft } from './why-not-service.ts';
import { createProductBackend } from './product-api.ts';
import { archiveRecord, createRecordArchive } from './analysis-case.ts';
import { whyFixture } from './why-not-fixture.ts';
import { evaluateWhyNot } from './why-not-engine.ts';
import type { GenerationJob, CodexRunner } from './jobs.ts';
import type { WhyOverviewLayout, WhyRun, WhySnapshot } from '../src/types/why-not.ts';
import type { resolveUrlEvidence } from './url-evidence.ts';

const job: GenerationJob = { id: 'why-job', status: 'completed', stage: 'saving', message: '완료', question: 'E1 완료', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedChunks: 1, totalChunks: 1, emptyChunks: 0, graphIds: [], resumable: false };
/** Older fixtures supply graph drafts; review fixtures explicitly classify the
 * fixed saved IDs in the separate provider request. New phase tests use raw runners. */
function phaseFixture(runner: CodexRunner): CodexRunner {
  const proposed = new Map<string, ReturnType<typeof draft>['bindings'][number]>();
  const key = (binding: { evidenceId: string; requirementId: string; quote: string }) => JSON.stringify([binding.evidenceId, binding.requirementId, binding.quote]);
  return async (input, config, options) => {
    const context = JSON.parse(input.context ?? '{}');
    if (context.mode === 'estimate-confidence') return { prior: { probability: null, reason: '테스트에서 수치 추정하지 않음', anchors: [] }, bindings: [], sources: [] };
    if (context.mode === 'review') return { decisions: context.bindings.filter((binding: { id: string }) => context.bindingIds.includes(binding.id)).map((binding: { id: string; evidenceId: string; requirementId: string; quote: string }) => { const original = proposed.get(key(binding)); return { bindingId: binding.id, verdict: original?.verdict ?? 'SUPPORTED', reason: original?.reason ?? '원문에 완료가 명시됨', missingRequirements: original?.missingRequirements ?? [], metadata: original?.metadata ?? { fields: [], start: null, end: null, timeQuote: null } }; }), duplicates: [] };
    const output = await runner(input, config, options) as ReturnType<typeof draft>;
    if (!output || !Array.isArray(output.bindings) || !Array.isArray(output.nodes)) return output;
    for (const binding of output.bindings) proposed.set(key(binding), binding);
    return { rootId: output.rootId, nodes: output.nodes, eventRules: output.eventRules, bindings: output.bindings.map(({ evidenceId, requirementId, quote }) => ({ evidenceId, requirementId, quote })) };
  };
}
function memory(t: TestContext, runner?: CodexRunner, rawPhases = false, resolveUrls?: typeof resolveUrlEvidence) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE generation_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, input_json TEXT)'); db.prepare('INSERT INTO generation_jobs VALUES (?,?,?)').run(job.id, JSON.stringify(job), JSON.stringify({ documents: [] }));
  const service = new WhyNotService(db, {}, runner && !rawPhases ? phaseFixture(runner) : runner, undefined, resolveUrls); t.after(async () => { await service.close(); db.close(); }); return { db, service };
}
function draft(sourceId: string, quote: string, supplement = true) {
  const s = whyFixture(1);
  return { rootId: 'root', nodes: supplement ? [] : s.nodes.map(n => ({ ...n, children: n.kind === 'requirement' ? [] : n.children })), eventRules: [], bindings: [{ evidenceId: sourceId, requirementId: 'r0', quote, verdict: 'SUPPORTED', reason: '원문에 완료가 명시되어 있음', missingRequirements: [], metadata: { fields: [], start: null, end: null, timeQuote: null } }] };
}
function overviewFixture(count = 1) { const snapshot = whyFixture(count); snapshot.goal = job.question; return snapshot; }
async function finished(service: WhyNotService, id: string) {
  for (let i = 0; i < 100; i++) { const run = service.get(job.id, id); if (run.status !== 'running') return run; await delay(5); }
  throw new Error('test completion timed out');
}
test('model adapter pins real sources and rejects fabricated references and quotations', () => {
  const source = makeWhyEvidence('e', '원문', '실제 완료 기록');
  const s = snapshotFromWhyDraft(draft(source.id, source.text, false), 'E1 완료', [source], 'v1');
  assert.equal(s.evidence[0].sourceCoefficient, null); assert.equal(s.coverage.complete, false); assert.equal(s.bindings[0].materialCoefficient, null);
  assert.deepEqual(s.policy.bayes, { target: 'GOAL', priors: [], conditionalIndependence: [] });
  assert.equal(evaluateWhyNot(s).confidence.bayesian?.score, .5);
  assert.equal(evaluateWhyNot(s).confidence.bayesian?.status, 'PARTIAL');
  assert.throws(() => snapshotFromWhyDraft(draft('invented', source.text, false), 'E1 완료', [source], 'v1'));
  assert.throws(() => snapshotFromWhyDraft(draft('e', '가공 인용', false), 'E1 완료', [source], 'v1'));
});
test('model duplicate decisions require direct references and preserve their explanation', () => {
  const sources = [makeWhyEvidence('left', '원문', '발행 E1 완료'), makeWhyEvidence('right', '재게시', '재게시: 발행 E1 완료')];
  const raw = draft('left', '발행 E1 완료', false);
  raw.bindings.push({ ...raw.bindings[0], evidenceId: 'right' });
  const duplicates = [{ requirementId: 'r0', leftEvidenceId: 'left', rightEvidenceId: 'right', leftQuote: '발행 E1 완료', rightQuote: '발행 E1 완료', verdict: 'SAME_OBSERVATION', reason: '같은 발행 기록의 재게시' }];
  const s = snapshotFromWhyDraft({ ...raw, duplicates }, '완료 확인', sources, 'v2'); assert.equal(s.duplicates[0].reason, duplicates[0].reason);
  assert.throws(() => snapshotFromWhyDraft({ ...raw, duplicates: [{ ...duplicates[0], rightQuote: '가공 인용' }] }, '완료 확인', sources, 'v2'));
});
test('review creates immutable versions, no-op replays reuse a version, and stale writes fail', t => {
  const { service } = memory(t); const first = service.evaluate(job, { snapshot: whyFixture(1) });
  const next = structuredClone(first.snapshot!); next.policy.threshold = .9;
  const second = service.evaluate(job, { previousId: first.id, snapshot: next });
  assert.equal(second.previousId, first.id); assert.equal(second.result!.accepted, false); assert.equal(service.get(job.id, first.id).result!.accepted, true);
  assert.equal(service.evaluate(job, { previousId: second.id, snapshot: second.snapshot }).id, second.id);
  assert.throws(() => service.evaluate(job, { previousId: first.id, snapshot: next }), /다른 창/);
  const changed = structuredClone(second.snapshot!); changed.evidence = []; changed.bindings = []; changed.nodes[1].children = [];
  assert.throws(() => service.evaluate(job, { previousId: second.id, snapshot: changed }), /원문/);
  assert.equal(service.list(job.id).runs.length, 2);
});
test('overview layout persists separately from immutable assessments, survives service reload and cascades with its case', async t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; return {}; });
  assert.deepEqual(service.layout(job.id), { jobId: job.id, revision: 0, updatedAt: null, positions: {} });
  assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM why_not_layouts').get()!.n), 0);
  const assessment = service.evaluate(job, { snapshot: overviewFixture() });
  const original = String(db.prepare('SELECT payload FROM why_not_runs WHERE id=?').get(assessment.id)!.payload);
  const positions = { 'why:root': { x: 15.25, y: -20 }, 'evidence:e0': { x: 100, y: 0 } };
  const saved = service.saveLayout(job.id, { revision: 0, positions });
  assert.equal(saved.revision, 1); assert.ok(saved.updatedAt); assert.deepEqual(saved.positions, positions);
  assert.equal(String(db.prepare('SELECT payload FROM why_not_runs WHERE id=?').get(assessment.id)!.payload), original);
  saved.positions['why:root'].x = 999;
  assert.equal(service.layout(job.id).positions['why:root'].x, 15.25);
  const reviewed = structuredClone(assessment.snapshot!); reviewed.policy.threshold = .9;
  service.evaluate(job, { previousId: assessment.id, snapshot: reviewed });
  assert.deepEqual(service.layout(job.id).positions, positions);
  const reloaded = new WhyNotService(db, {}, async () => { calls++; return {}; });
  assert.deepEqual(reloaded.layout(job.id), service.layout(job.id)); await reloaded.close();
  db.prepare('INSERT INTO generation_jobs VALUES (?,?,?)').run('other-case', JSON.stringify({ ...job, id: 'other-case' }), '{}');
  service.saveLayout('other-case', { revision: 0, positions: { 'why:root': { x: 44, y: 55 } } });
  assert.deepEqual(service.layout(job.id).positions, positions);
  assert.equal(service.layout('other-case').positions['why:root'].x, 44);
  db.prepare('DELETE FROM generation_jobs WHERE id=?').run(job.id);
  assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM why_not_layouts WHERE job_id=?').get(job.id)!.n), 0);
  assert.equal(service.layout('other-case').revision, 1); assert.equal(calls, 0);
});
test('overview layout validates bounded coordinates and uses revision checks for atomic replacement and clearing', t => {
  const { db, service } = memory(t);
  for (const raw of [null, [], {}, { revision: 0, positions: {}, snapshot: {} }, { revision: -1, positions: {} }, { revision: .5, positions: {} },
    { revision: Number.MAX_SAFE_INTEGER, positions: {} }, { revision: 0, positions: null }, { revision: 0, positions: [] },
    ...[{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 1000001, y: 0 }, { x: 0, y: -1000001 }, { x: '1', y: 0 }, { x: 1 }, { x: 1, y: 2, claim: 'ignored?' }, [1, 2]].map(point => ({ revision: 0, positions: { node: point } })),
    { revision: 0, positions: { '': { x: 0, y: 0 } } }, { revision: 0, positions: { ['n'.repeat(501)]: { x: 0, y: 0 } } },
    { revision: 0, positions: JSON.parse('{"__proto__":{"x":0,"y":0}}') },
    { revision: 0, positions: Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`node-${index}`, { x: 0, y: 0 }])) },
  ]) assert.throws(() => service.saveLayout(job.id, raw), { status: 400 });
  assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM why_not_layouts').get()!.n), 0);
  const positions = Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`node-${index}`, { x: -1000000, y: 1000000 }]));
  const first = service.saveLayout(job.id, { revision: 0, positions });
  assert.equal(Object.keys(first.positions).length, 10000);
  assert.throws(() => service.saveLayout(job.id, { revision: 0, positions: {} }), { status: 409 });
  assert.throws(() => service.saveLayout(job.id, { revision: 2, positions: {} }), { status: 409 });
  assert.deepEqual(service.layout(job.id), first);
  const second = service.saveLayout(job.id, { revision: first.revision, positions: { retained: { x: 0, y: 0 } } });
  assert.equal(second.revision, 2); assert.equal(Object.keys(service.layout(job.id).positions).length, 1);
  assert.throws(() => service.saveLayout(job.id, { revision: first.revision, positions: {} }), { status: 409 });
  assert.deepEqual(service.saveLayout(job.id, { revision: second.revision, positions: {} }).positions, {});
  assert.throws(() => service.saveLayout('missing-case', { revision: 0, positions: {} }), { status: 404 });
  assert.equal(service.list(job.id).runs.length, 0);
});
test('failed zero-graph jobs retain their failure while missing and insufficient evidence diagnoses are saved', t => {
  const { db, service } = memory(t);
  const failed: GenerationJob = { ...job, status: 'failed', completedChunks: 0, totalChunks: 0, error: '원문에서 객체를 추출하지 못했습니다.' };
  db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify(failed), failed.id);
  const source = makeWhyEvidence('url-only', '제공한 링크', 'https://example.org/report');
  const proposed = draft(source.id, source.text, false);
  const missing = snapshotFromWhyDraft({ ...proposed, bindings: [] }, failed.question, [source], 'missing-v1');
  const first = service.evaluate(failed, { snapshot: missing });
  assert.equal(first.status, 'completed');
  assert.ok(first.result!.gaps.some(gap => gap.type === 'EVIDENCE_MISSING'));
  assert.equal(first.result!.accepted, false);
  assert.equal(first.result!.chainStatus, 'UNDETERMINED');
  const insufficient = snapshotFromWhyDraft({ ...proposed, bindings: proposed.bindings.map(binding => ({ ...binding, verdict: 'INSUFFICIENT', reason: '링크만 제공되어 본문의 주장을 확인할 수 없습니다.', missingRequirements: ['본문 원문'] })) }, failed.question, [source], 'insufficient-v1');
  const second = service.evaluate(failed, { previousId: first.id, snapshot: insufficient });
  assert.ok(second.result!.gaps.some(gap => gap.type === 'EVIDENCE_INSUFFICIENT' && gap.explanation.includes('링크만')));
  assert.equal(second.result!.accepted, false);
  assert.equal(second.snapshot!.coverage.complete, false);
  assert.equal(second.snapshot!.evidence[0].sourceCoefficient, null);
  assert.equal(second.snapshot!.bindings[0].materialCoefficient, null);
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(failed.id)!.payload)), failed);
  assert.equal(service.list(failed.id).runs.length, 2);
});
test('failed jobs with no archived records use actual URL-only retained input without inventing page content', async t => {
  const original = { id: 'uploaded-links', name: '입력한 자료', text: 'https://example.org/article\nhttps://example.org/permit' };
  let calls = 0;
  const { db, service } = memory(t, async input => {
    calls++;
    assert.equal(input.documents.length, 1);
    assert.equal(input.documents[0].name, original.name);
    assert.equal(input.documents[0].text, original.text);
    assert.match(input.context!, /URL references are not fetched page content/);
    const proposed = draft(input.documents[0].id, original.text, false);
    return { ...proposed, bindings: proposed.bindings.map(binding => ({ ...binding, verdict: 'INSUFFICIENT', reason: '본문이 제공되지 않은 URL 목록입니다.', missingRequirements: ['문서 본문'] })) };
  });
  const failed: GenerationJob = { ...job, status: 'failed', completedChunks: 0, totalChunks: 0 };
  db.prepare('UPDATE generation_jobs SET payload=?,input_json=? WHERE id=?').run(JSON.stringify(failed), JSON.stringify({ documents: [original] }), failed.id);
  const started = service.start(failed, { goal: failed.question });
  const saved = await finished(service, started.id);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal(calls, 1);
  assert.equal(saved.snapshot!.evidence[0].text, original.text);
  assert.equal(saved.snapshot!.evidence[0].documentId, original.id);
  assert.equal(saved.snapshot!.evidence[0].record, null);
  assert.equal(saved.snapshot!.evidence[0].sourceGrade, null);
  assert.equal(saved.snapshot!.coverage.complete, false);
  assert.equal(saved.result!.accepted, false);
  assert.ok(saved.result!.gaps.some(gap => gap.type === 'EVIDENCE_INSUFFICIENT'));
  assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(failed.id)!.payload)).status, 'failed');
});
test('retained input fallback limits source count and excerpt size and does not turn excerpts into complete coverage', async t => {
  const documents = Array.from({ length: 12 }, (_, index) => ({ id: `original-${index}`, name: `원문 ${index}`, text: `${index}:` + '실제 원문 '.repeat(3000) }));
  const { db, service } = memory(t, async input => {
    assert.equal(input.documents.length, 10);
    input.documents.forEach((document, index) => assert.equal(document.text, documents[index].text.slice(0, 10000)));
    return { ...draft(input.documents[0].id, input.documents[0].text.slice(0, 100), false), bindings: [] };
  });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents }), job.id);
  const failed: GenerationJob = { ...job, status: 'failed', completedChunks: 0, totalChunks: 0 };
  const saved = await finished(service, service.start(failed, { goal: failed.question }).id);
  assert.equal(saved.status, 'completed', saved.error);
  assert.equal(saved.snapshot!.evidence.length, 10);
  assert.equal(saved.snapshot!.coverage.complete, false);
  assert.ok(saved.result!.gaps.some(gap => gap.type === 'EVIDENCE_MISSING'));
});
test('queued, running and cancelled analysis jobs cannot start or save diagnosis versions', t => {
  const { service } = memory(t);
  for (const status of ['queued', 'running', 'cancelled'] as const) {
    assert.throws(() => service.start({ ...job, status }, { goal: job.question }), { status: 409 });
    assert.throws(() => service.evaluate({ ...job, status }, { snapshot: whyFixture(1) }), { status: 409 });
  }
  assert.equal(service.list(job.id).runs.length, 0);
});
test('automatic assessment only accepts completed analysis and validates its narrow request', t => {
  let calls = 0; const { service } = memory(t, async () => { calls++; return {}; });
  for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) {
    assert.throws(() => service.start({ ...job, status }, { auto: true }), { status: 409 });
  }
  assert.throws(() => service.start(job, { auto: 'true' }), { status: 400 });
  assert.throws(() => service.start(job, { auto: true, supplement: { name: '추가', text: '원문' } }), { status: 400 });
  assert.equal(service.list(job.id).runs.length, 0); assert.equal(calls, 0);
});
test('automatic mounts share one persisted attempt and expose actual stages without repeating the provider', async t => {
  let release!: () => void; let calls = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const { db, service } = memory(t, async input => {
    calls++;
    const persisted = service.list(job.id).runs[0];
    assert.equal(persisted.status, 'running'); assert.ok(persisted.attemptKey);
    assert.equal(input.question, job.question);
    assert.deepEqual(persisted.stages?.map(stage => stage.stage), ['drafting']);
    await waiting;
    return draft(input.documents[0].id, input.documents[0].text, false);
  });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료를 직접 기록한 원문' }] }), job.id);
  const first = service.start(job, { auto: true });
  const racing = service.start(job, { auto: true });
  assert.equal(racing.id, first.id); assert.equal(racing.attemptKey, first.attemptKey);
  assert.equal(service.list(job.id).runs.length, 1);
  await delay(0);
  const drafting = service.get(job.id, first.id);
  assert.equal(drafting.stages?.[0].stage, 'drafting');
  assert.equal(drafting.stages?.[0].completedAt, undefined);
  assert.equal(service.start(job, { auto: true }).id, first.id);
  release(); const saved = await finished(service, first.id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(calls, 1);
  assert.deepEqual(saved.stages?.map(stage => stage.stage), ['drafting', 'validating', 'evaluating', 'estimating', 'saving']);
  let previousEnd = Date.parse(saved.createdAt);
  for (const stage of saved.stages!) {
    assert.ok(Number.isFinite(Date.parse(stage.startedAt)));
    assert.ok(stage.completedAt && Date.parse(stage.completedAt) >= Date.parse(stage.startedAt));
    assert.ok(Date.parse(stage.startedAt) >= previousEnd);
    previousEnd = Date.parse(stage.completedAt!);
    assert.deepEqual(Object.keys(stage).sort(), ['completedAt', 'stage', 'startedAt']);
  }
  assert.deepEqual(service.start(job, { auto: true }), saved);
  assert.equal(service.list(job.id).runs.length, 1); assert.equal(calls, 1);
});
test('automatic assessment preserves existing reviewed history even after analysis changes', t => {
  let calls = 0; const { service } = memory(t, async () => { calls++; return {}; });
  const saved = service.evaluate(job, { snapshot: overviewFixture() });
  const changedJob = { ...job, question: '새 대상 질문', completedChunks: 2, totalChunks: 2 };
  assert.deepEqual(service.start(changedJob, { auto: true, previousId: 'stale-client-version' }), saved);
  assert.equal(service.confidence(changedJob).state, 'stale');
  assert.equal(service.list(job.id).runs.length, 1); assert.equal(calls, 0);
  assert.throws(() => service.start(changedJob, { goal: changedJob.question }), { status: 409 });
});
test('failed quote validation records only reached stages and automatic refresh never retries it', async t => {
  let calls = 0;
  const { db, service } = memory(t, async input => { calls++; return draft(input.documents[0].id, '원문에 없는 가공 인용문', false); });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료 원문' }] }), job.id);
  const failed = await finished(service, service.start(job, { auto: true }).id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.snapshot, undefined); assert.equal(failed.result, undefined);
  assert.deepEqual(failed.stages?.map(stage => stage.stage), ['drafting', 'validating']);
  assert.ok(failed.stages![0].completedAt); assert.equal(failed.stages![1].completedAt, undefined);
  assert.deepEqual(service.start(job, { auto: true }), failed);
  assert.equal(service.list(job.id).runs.length, 1); assert.equal(calls, 1);
});
test('cancelled automatic runs retain their attempt and never advance stages on late model success', async t => {
  let release!: () => void; let calls = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const { db, service } = memory(t, async input => { calls++; await waiting; return draft(input.documents[0].id, input.documents[0].text, false); });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료 원문' }] }), job.id);
  const first = service.start(job, { auto: true }); await delay(0);
  const cancellation = service.cancel(job.id); release(); await cancellation;
  const cancelled = service.get(job.id, first.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result, undefined);
  assert.deepEqual(cancelled.stages?.map(stage => stage.stage), ['drafting']);
  assert.equal(cancelled.stages![0].completedAt, undefined); assert.equal(cancelled.attemptKey, first.attemptKey);
  assert.deepEqual(service.start(job, { auto: true }), cancelled);
  assert.equal(service.list(job.id).runs.length, 1); assert.equal(calls, 1);
});
test('supplement uses the previous tree, preserves reviewed evidence, and rejects repeated content', async t => {
  let calls = 0; const { service } = memory(t, async input => { calls++; assert.equal(input.purpose, 'why-not'); return draft(input.documents[0].id, input.documents[0].text); });
  const first = service.evaluate(job, { snapshot: whyFixture(1) });
  const run = service.start(job, { previousId: first.id, supplement: { name: '추가 확인', text: '추가 완료 기록' } });
  const second = await finished(service, run.id); assert.equal(second.status, 'completed', second.error); assert.equal(second.snapshot!.treeVersion, first.snapshot!.treeVersion);
  assert.equal(second.snapshot!.evidence.length, 2); assert.equal(second.snapshot!.bindings.length, 2); assert.deepEqual(second.snapshot!.evidence[0], first.snapshot!.evidence[0]);
  assert.throws(() => service.start(job, { previousId: second.id, supplement: { name: '다른 이름', text: '추가 완료 기록' } }), /동일한 원문/); assert.equal(calls, 1);
});
test('cancelled/failed runs retain the previous snapshot and never write late model success', async t => {
  let resolve!: (value: unknown) => void;
  const { service } = memory(t, async () => new Promise(r => { resolve = r; })); const first = service.evaluate(job, { snapshot: whyFixture(1) });
  const started = service.start(job, { previousId: first.id, supplement: { name: '추가', text: '보완 근거' } }); await delay(0);
  const cancellation = service.cancel(job.id); resolve({}); await cancellation;
  const cancelled = service.get(job.id, started.id); assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.snapshot, first.snapshot);
  assert.equal(service.get(job.id, first.id).status, 'completed');
});
test('restart recovers running rows as failed and deleting a case cascades all diagnosis versions', async t => {
  const { db, service } = memory(t); const first = service.evaluate(job, { snapshot: whyFixture(1) });
  const stages = [{ stage: 'drafting', startedAt: first.createdAt }];
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify({ ...first, status: 'running', attemptKey: 'persisted-auto-key', stages }), first.id);
  let calls = 0; const restored = new WhyNotService(db, {}, async () => { calls++; return {}; });
  const recovered = restored.get(job.id, first.id); assert.equal(recovered.status, 'failed'); assert.match(recovered.error!, /재시작/);
  assert.equal(recovered.attemptKey, 'persisted-auto-key'); assert.deepEqual(recovered.stages, stages);
  assert.deepEqual(restored.start(job, { auto: true }), recovered); assert.equal(calls, 0);
  await restored.close(); db.prepare('DELETE FROM generation_jobs WHERE id=?').run(job.id); assert.equal(service.list(job.id).runs.length, 0);
});
test('overview confidence without an assessment is read-only and never substitutes default coefficients', t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; throw new Error('confidence must not invoke a model'); });
  const before = db.prepare('SELECT * FROM generation_jobs').all();
  const summary = service.confidence(job);
  assert.equal(summary.state, 'unassessed'); assert.equal(summary.confidence, null);
  assert.equal(summary.assessmentVersion, null); assert.equal(summary.policyVersion, null);
  assert.deepEqual(summary.inputs, []); assert.equal(summary.accepted, false);
  assert.match(summary.unknownReasons.join(' '), /기본값/);
  assert.equal(service.confidence({ ...job, status: 'running' }).state, 'pending');
  assert.equal(calls, 0); assert.equal(service.list(job.id).runs.length, 0);
  assert.deepEqual(db.prepare('SELECT * FROM generation_jobs').all(), before);
});
test('overview confidence recalculates the saved snapshot and caches no mutable public result', t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; throw new Error('no model'); });
  const saved = service.evaluate(job, { snapshot: overviewFixture() });
  assert.ok(saved.analysisRevision);
  const forged = { ...saved, result: { ...saved.result!, confidence: { ...saved.result!.confidence, supportScore: .99 } } };
  const payload = JSON.stringify(forged); db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(payload, saved.id);
  const summary = service.confidence(job);
  assert.equal(summary.state, 'ready'); assert.equal(summary.confidence!.supportScore, .8);
  assert.equal(summary.confidence!.method, 'SHARED_ATOMS'); assert.equal(summary.accepted, true);
  assert.equal(summary.goal, job.question); assert.equal(summary.assessmentVersion, saved.id);
  assert.equal(summary.policyVersion, saved.snapshot!.policy.version);
  assert.equal(summary.inputs[0].sourceCoefficient, .8); assert.equal(summary.inputs[0].materialCoefficient, 1);
  assert.equal(summary.nodeLabels!.root, saved.snapshot!.nodes[0].statement);
  summary.confidence!.supportScore = 0;
  assert.equal(service.confidence(job).confidence!.supportScore, .8);
  assert.equal(String(db.prepare('SELECT payload FROM why_not_runs WHERE id=?').get(saved.id)!.payload), payload);
  assert.equal(service.list(job.id).runs.length, 1); assert.equal(calls, 0);
});
test('overview recalculates Bayesian inputs without rewriting history and persists explicit LR review versions', t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; return {}; });
  const snapshot = overviewFixture(); snapshot.evidence[0].sourceCoefficient = .5;
  snapshot.policy.threshold = .3;
  snapshot.policy.bayes = { priors: [{ nodeId: 'r0', probability: .2, reason: '검토자가 명시한 사전 모형' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 4, basis: 'EXPERT_ESTIMATE', reason: '검토자가 명시한 가설 대비 상대적 가능도' };
  const saved = service.evaluate(job, { snapshot });
  const original = String(db.prepare('SELECT payload FROM why_not_runs WHERE id=?').get(saved.id)!.payload);
  const summary = service.confidence(job);
  // Grade B fixes r=.8 regardless of the old sourceCoefficient=.5: adjusted LR=3.4.
  assert.ok(Math.abs(summary.confidence!.bayesian!.posterior! - 17 / 37) < 1e-12);
  assert.equal(summary.confidence!.supportScore, .5); assert.equal(summary.accepted, true);
  assert.equal(summary.confidence!.bayesian!.bindings[0].rawLikelihoodRatio, 4);
  assert.equal(String(db.prepare('SELECT payload FROM why_not_runs WHERE id=?').get(saved.id)!.payload), original);
  const changed = structuredClone(saved.snapshot!); changed.bindings[0].likelihood!.ratio = 1;
  const next = service.evaluate(job, { previousId: saved.id, snapshot: changed });
  assert.notEqual(next.id, saved.id); assert.equal(next.analysisRevision, saved.analysisRevision);
  assert.ok(Math.abs(service.confidence(job).confidence!.bayesian!.posterior! - .2) < 1e-12);
  assert.equal(service.confidence(job).accepted, false);
  assert.equal(service.get(job.id, saved.id).snapshot!.bindings[0].likelihood!.ratio, 4);
  assert.equal(calls, 0);
});
test('provider-proposed likelihood numbers are not accepted as reviewed calibration', () => {
  const source = makeWhyEvidence('source', '원문', '실제 완료 기록');
  const proposed = draft(source.id, source.text, false);
  const raw = { ...proposed, bindings: proposed.bindings.map(binding => ({ ...binding, likelihood: { ratio: 100, basis: 'CALIBRATED', reason: '모델이 임의로 만든 값' } })) };
  const snapshot = snapshotFromWhyDraft(raw, 'E1 완료', [source], 'model-v1');
  assert.deepEqual(snapshot.bindings[0].likelihood, { ratio: null, basis: 'UNASSESSED', reason: '우도비와 산정 근거는 사용자 검토가 필요합니다.' });
  assert.deepEqual(snapshot.policy.bayes!.priors, []);
});
test('overview exposes the latest reviewed coefficients and preserves zero without inventing an operating threshold', t => {
  const { service } = memory(t);
  const first = service.evaluate(job, { snapshot: overviewFixture() });
  const changed = structuredClone(first.snapshot!); changed.bindings[0].materialCoefficient = .5;
  const second = service.evaluate(job, { previousId: first.id, snapshot: changed });
  assert.equal(second.analysisRevision, first.analysisRevision);
  let summary = service.confidence(job);
  assert.equal(summary.assessmentVersion, second.id); assert.equal(summary.confidence!.supportScore, .4);
  const zero = structuredClone(second.snapshot!); zero.evidence[0].sourceCoefficient = 0; zero.policy.threshold = null;
  service.evaluate(job, { previousId: second.id, snapshot: zero }); summary = service.confidence(job);
  assert.equal(summary.state, 'ready'); assert.equal(summary.confidence!.supportScore, 0);
  assert.deepEqual(summary.confidence!.range, [0, 0]); assert.equal(summary.confidence!.sufficient, null);
  assert.equal(summary.accepted, false); assert.ok(summary.unknownReasons.some(reason => /임계값/.test(reason)));
});
test('overview lists unknown coefficients and every input even when pending provenance produces no confidence atoms', t => {
  const { service } = memory(t); const snapshot = overviewFixture();
  snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceCoefficient = null; snapshot.evidence[0].sourceReason = '';
  snapshot.bindings[0].materialCoefficient = null; snapshot.bindings[0].materialReason = '';
  snapshot.evidence.push(makeWhyEvidence('unbound', '미연결 원문', '주장과 아직 연결하지 않은 실제 자료'));
  snapshot.coverage = { complete: false, note: '일부 원문만 확인했습니다.' };
  service.evaluate(job, { snapshot }); const summary = service.confidence(job);
  assert.equal(summary.state, 'incomplete'); assert.equal(summary.confidence!.supportScore, null);
  assert.deepEqual(summary.confidence!.atoms, []); assert.equal(summary.inputs.length, 2);
  assert.ok(summary.unknownReasons.includes('출처 등급 미평가: 2개'));
  assert.ok(summary.unknownReasons.includes('출처 계수 미평가: 2개'));
  assert.ok(summary.unknownReasons.includes('자료 품질 계수 미평가: 1개'));
  assert.equal(summary.inputs[0].excludedReason, '출처 등급 미평가');
  assert.equal(summary.inputs[1].excludedReason, '자료–주장 연결이 없음');
  assert.equal(summary.coverageNote, '일부 원문만 확인했습니다.');
});
test('overview marks changed analysis, differing goals and unversioned historic snapshots stale', t => {
  const { db, service } = memory(t); const saved = service.evaluate(job, { snapshot: overviewFixture() });
  for (const changed of [
    { ...job, completedChunks: 2, totalChunks: 2 },
    { ...job, graphIds: ['different-graph'] },
    { ...job, ontologyVersion: 2 },
    { ...job, question: '다른 사건을 검증하는 새 질문' },
  ]) {
    const summary = service.confidence(changed);
    assert.equal(summary.state, 'stale'); assert.equal(summary.accepted, false);
    assert.equal(summary.confidence!.supportScore, .8);
  }
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify({ ...saved, analysisRevision: undefined }), saved.id);
  const historic = service.confidence(job);
  assert.equal(historic.state, 'stale'); assert.match(historic.reason, /분석 버전 정보/);
});
test('editing and supplementing old evidence never refreshes its analysis revision', async t => {
  const { service } = memory(t, async input => draft(input.documents[0].id, input.documents[0].text));
  const original = service.evaluate(job, { snapshot: overviewFixture() });
  const advanced = { ...job, completedChunks: 2, totalChunks: 2, graphIds: ['new-graph'] };
  const edited = structuredClone(original.snapshot!); edited.policy.threshold = .9;
  const reviewed = service.evaluate(advanced, { previousId: original.id, snapshot: edited });
  assert.equal(reviewed.analysisRevision, original.analysisRevision);
  assert.equal(service.confidence(advanced).state, 'stale');
  const supplement = service.start(advanced, { previousId: reviewed.id, supplement: { name: '새 보완 자료', text: '추가로 확인한 실제 관측 자료입니다.' } });
  const supplemented = await finished(service, supplement.id);
  assert.equal(supplemented.status, 'completed', supplemented.error);
  assert.equal(supplemented.analysisRevision, original.analysisRevision);
  assert.equal(service.confidence(advanced).state, 'stale');
});
test('rebuilding identical excerpts cannot replay an unversioned assessment or an older analysis revision', async t => {
  let calls = 0;
  const { db, service } = memory(t, async input => { calls++; return draft(input.documents[0].id, input.documents[0].text, false); });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 실제 완료를 기록한 자료입니다.' }] }), job.id);
  const first = await finished(service, service.start(job, { goal: job.question }).id);
  assert.equal(first.status, 'completed', first.error);
  assert.equal(service.start(job, { previousId: first.id, goal: job.question }).id, first.id);
  assert.equal(calls, 1);
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify({ ...first, analysisRevision: undefined }), first.id);
  const second = await finished(service, service.start(job, { previousId: first.id, goal: job.question }).id);
  assert.notEqual(second.id, first.id); assert.equal(second.status, 'completed', second.error);
  assert.equal(calls, 2);
  const advanced = { ...job, completedChunks: 2, totalChunks: 2 };
  const third = await finished(service, service.start(advanced, { previousId: second.id, goal: job.question }).id);
  assert.notEqual(third.id, second.id); assert.notEqual(third.analysisRevision, second.analysisRevision);
  assert.equal(third.status, 'completed', third.error); assert.equal(calls, 3);
});
test('overview labels partial coverage and limited candidate scores instead of accepting them as the complete graph', t => {
  const { service } = memory(t); const snapshot = overviewFixture(2);
  snapshot.nodes[0].operator = 'OR'; snapshot.policy.maxCandidates = 1;
  const saved = service.evaluate(job, { snapshot });
  let summary = service.confidence(job);
  assert.equal(summary.state, 'incomplete'); assert.equal(summary.confidence!.supportScore, .8);
  assert.equal(summary.accepted, false); assert.match(summary.unknownReasons.join(' '), /일부 경로/);
  const partial = structuredClone(saved.snapshot!); partial.policy.maxCandidates = 512;
  partial.coverage = { complete: false, note: '자료의 발췌 부분만 평가했습니다.' };
  service.evaluate(job, { previousId: saved.id, snapshot: partial }); summary = service.confidence(job);
  assert.equal(summary.state, 'incomplete'); assert.equal(summary.confidence!.supportScore, .96);
  assert.equal(summary.accepted, false); assert.match(summary.reason, /전체 분석의 확정 점수.*아닙니다/);
});
test('overview finds the last complete assessment beyond the list limit and explains newer failed or cancelled attempts', t => {
  const { db, service } = memory(t); const saved = service.evaluate(job, { snapshot: overviewFixture() });
  const insert = db.prepare('INSERT INTO why_not_runs VALUES (?,?,?,?)');
  for (let index = 0; index < 51; index++) {
    const run = { ...saved, id: `failed-${index}`, status: 'failed', snapshot: undefined, result: undefined };
    insert.run(run.id, job.id, saved.createdAt, JSON.stringify(run));
  }
  assert.equal(service.list(job.id).runs.some(run => run.status === 'completed'), false);
  let summary = service.confidence(job);
  assert.equal(summary.assessmentVersion, saved.id); assert.equal(summary.confidence!.supportScore, .8);
  assert.match(summary.reason, /최근 근거 평가에 실패.*마지막으로 저장/);
  const cancelled = { ...saved, id: 'cancelled-last', status: 'cancelled', snapshot: undefined, result: undefined };
  insert.run(cancelled.id, job.id, saved.createdAt, JSON.stringify(cancelled)); summary = service.confidence(job);
  assert.match(summary.reason, /최근 근거 평가를 중단.*마지막으로 저장/);
  const running = { ...saved, id: 'running-last', status: 'running', snapshot: undefined, result: undefined };
  insert.run(running.id, job.id, saved.createdAt, JSON.stringify(running)); summary = service.confidence(job);
  assert.equal(summary.state, 'pending'); assert.equal(summary.accepted, false);
  assert.match(summary.reason, /새 근거 평가를 진행/);
  assert.equal(service.confidence({ ...job, status: 'running' }).state, 'pending');
});
test('overview keeps disqualified sources and refuted inputs visible without counting them as support', t => {
  const { service } = memory(t); const snapshot = overviewFixture(3); snapshot.nodes[0].operator = 'OR';
  snapshot.evidence[1].sourceGrade = 'D'; snapshot.bindings[2].verdict = 'REFUTED';
  service.evaluate(job, { snapshot }); const summary = service.confidence(job);
  assert.equal(summary.inputs.length, 3); assert.equal(summary.confidence!.supportScore, .8);
  assert.match(summary.inputs[1].excludedReason!, /D등급/); assert.match(summary.inputs[2].excludedReason!, /반증/);
  assert.equal(summary.accepted, false);
});
test('HTTP integration: authentication, generation, review, search, reload and case deletion', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-why-api-')); const token = 'test-why-not-token-2026';
  const backend = await createProductBackend({ root: process.cwd(), dataDir: directory, accessToken: token, seedExample: false, codex: {} }, { run: phaseFixture(async input => draft(input.documents[0].id, input.documents[0].text, false)) });
  backend.store.db.prepare('INSERT INTO generation_jobs VALUES (?,?,?,?)').run(job.id, JSON.stringify(job), job.createdAt, JSON.stringify({ question: job.question, documents: [] }));
  createRecordArchive(backend.store.db); archiveRecord(backend.store.db, job.id, 1, [{ id: 'original', name: '원본', text: 'E1 실제 완료 기록' }]);
  const server = createServer((req, res) => backend.middleware(req, res, () => { res.writeHead(404); res.end(); })); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await backend.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs/${job.id}`;
  const call = (path: string, method = 'GET', body?: unknown, auth = true) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call('/why-not', 'GET', undefined, false)).status, 401);
  assert.equal((await call('/why-not/estimate', 'POST', { previousId: 'anything' }, false)).status, 401);
  assert.equal((await call('/why-not/estimate', 'GET')).status, 405);
  assert.equal((await call('/why-not/layout', 'GET', undefined, false)).status, 401);
  assert.equal((await call('/why-not/layout', 'PUT', { revision: 0, positions: {} }, false)).status, 401);
  const emptyLayout = await call('/why-not/layout'); assert.equal(emptyLayout.status, 200);
  assert.deepEqual(await emptyLayout.json(), { jobId: job.id, revision: 0, updatedAt: null, positions: {} });
  assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_layouts').get()!.n), 0);
  const savedLayout = await call('/why-not/layout', 'PUT', { revision: 0, positions: { 'why:root': { x: 10, y: 20 } } });
  assert.equal(savedLayout.status, 200); const layout = await savedLayout.json() as WhyOverviewLayout;
  assert.equal(layout.revision, 1); assert.equal(layout.positions['why:root'].x, 10);
  assert.equal((await call('/why-not/layout', 'PUT', { revision: 0, positions: {} })).status, 409);
  assert.equal((await call('/why-not/layout', 'PUT', { revision: 1, positions: { n: { x: null, y: 0 } } })).status, 400);
  assert.equal((await call('/why-not/layout', 'POST', { revision: 1, positions: {} })).status, 405);
  assert.deepEqual(await (await call('/why-not/layout')).json(), layout);
  assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_runs').get()!.n), 0);
  const start = await call('/why-not', 'POST', { goal: job.question, previousId: null }); assert.equal(start.status, 202); const started = (await start.json() as { run: WhyRun }).run;
  let item: WhyRun | undefined;
  for (let i = 0; i < 100; i++) { const response = await call('/why-not'); item = (await response.json() as { runs: WhyRun[] }).runs[0]; if (item.status !== 'running') break; await delay(5); }
  assert.equal(item?.status, 'completed', item?.error); assert.equal(item?.id, started.id); assert.equal(item.result!.accepted, false);
  const snapshot = item.snapshot as WhySnapshot; snapshot.evidence[0].sourceGrade = 'B'; snapshot.evidence[0].sourceReason = '사용자 원문 확인'; snapshot.evidence[0].sourceCoefficient = .8; snapshot.bindings[0].materialCoefficient = 1; snapshot.bindings[0].materialReason = '명시적 완료'; snapshot.policy.threshold = .7;
  snapshot.policy.bayes = { priors: [{ nodeId: 'r0', probability: .5, reason: '이 검증 사례에서 명시한 사전 모형' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 9, basis: 'EXPERT_ESTIMATE', reason: '이 검증 사례에서 명시한 전문가 추정' };
  snapshot.coverage = { complete: true, note: '테스트 원문 전체를 검토했습니다.' };
  const review = await call('/why-not/evaluate', 'POST', { previousId: item.id, snapshot }); assert.equal(review.status, 200); const reviewed = (await review.json() as { run: WhyRun }).run; assert.equal(reviewed.result!.accepted, true);
  const saved = await call(`/why-not/runs/${item.id}`); assert.equal((await saved.json() as { run: WhyRun }).run.result!.accepted, false);
  const search = await call('/why-not/search?q=E1'); assert.equal(search.status, 200); assert.equal((await search.json() as { hits: unknown[] }).hits.length, 1);
  const stale = await call('/why-not/evaluate', 'POST', { previousId: item.id, snapshot }); assert.equal(stale.status, 409);
  const deletion = await call('', 'DELETE'); assert.equal(deletion.status, 200); assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_runs').get()!.n), 0);
  assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_layouts').get()!.n), 0);
  assert.equal((await call('/why-not/layout')).status, 404);
});
test('HTTP automatic assessment stays authenticated, rejects unfinished analysis and deduplicates concurrent requests', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cluevia-auto-why-api-')); const token = 'test-auto-why-token-2026';
  let calls = 0; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const backend = await createProductBackend({ root: process.cwd(), dataDir: directory, accessToken: token, seedExample: false, codex: {} }, { run: phaseFixture(async input => { calls++; await waiting; return draft(input.documents[0].id, input.documents[0].text, false); }) });
  backend.store.db.prepare('INSERT INTO generation_jobs VALUES (?,?,?,?)').run(job.id, JSON.stringify(job), job.createdAt, JSON.stringify({ question: job.question, documents: [{ id: 'original', name: '원문', text: 'E1 완료를 기록한 실제 원문' }] }));
  const server = createServer((req, res) => backend.middleware(req, res, () => { res.writeHead(404); res.end(); })); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await backend.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs/${job.id}/why-not`;
  const post = (body: unknown, auth = true) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ auto: true }, false)).status, 401);
  for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) {
    backend.store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...job, status }), job.id);
    assert.equal((await post({ auto: true })).status, 409);
  }
  backend.store.db.prepare('UPDATE generation_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), job.id);
  assert.equal((await post({ auto: 'true' })).status, 400);
  assert.equal((await post({ auto: true, supplement: { name: '추가', text: '원문' } })).status, 400);
  assert.equal(calls, 0);
  assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_runs').get()!.n), 0);
  const starts = await Promise.all([post({ auto: true }), post({ auto: true })]);
  assert.deepEqual(starts.map(response => response.status), [202, 202]);
  const runs = await Promise.all(starts.map(async response => (await response.json() as { run: WhyRun }).run));
  assert.equal(runs[0].id, runs[1].id); assert.ok(runs[0].attemptKey); assert.equal(calls, 1);
  assert.equal(Number(backend.store.db.prepare('SELECT COUNT(*) n FROM why_not_runs').get()!.n), 1);
  release();
  let saved: WhyRun | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    saved = (await response.json() as { runs: WhyRun[] }).runs[0];
    if (saved.status !== 'running') break;
    await delay(5);
  }
  assert.equal(saved?.status, 'completed', saved?.error);
  assert.equal((await (await post({ auto: true })).json() as { run: WhyRun }).run.id, runs[0].id);
  assert.equal(calls, 1);
});

test('backend preparation persists diagnostics without a browser and deduplicates completion notifications', async t => {
  let calls = 0;
  const { db, service } = memory(t, async request => { calls++; return draft(request.documents[0].id, request.documents[0].text, false); });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료' }] }), job.id);
  db.exec("CREATE TABLE snapshot_checkpoints (payload TEXT); CREATE TRIGGER capture_baseline AFTER UPDATE ON why_not_runs WHEN json_extract(NEW.payload,'$.status')='running' AND json_type(NEW.payload,'$.snapshot')='object' BEGIN INSERT INTO snapshot_checkpoints VALUES (NEW.payload); END");
  service.schedulePreparation(job); service.schedulePreparation(job);
  for (let i = 0; i < 100 && !service.list(job.id).runs[0]?.preparation?.ready; i++) await delay(5);
  const saved = service.list(job.id).runs[0];
  assert.equal(calls, 1); assert.equal(saved.status, 'completed'); assert.equal(saved.preparation?.ready, true);
  assert.equal(saved.preparation!.score, 50); assert.equal(saved.preparation!.baselineScore, 50);
  assert.deepEqual(saved.preparation!.animation.map(step => step.gapId), saved.result!.gaps.map(gap => gap.id));
  assert.deepEqual(saved.preparation!.gapFill.map(step => step.actionId), saved.result!.actions.map(action => action.id));
  assert.ok(Number(db.prepare('SELECT COUNT(*) n FROM snapshot_checkpoints').get()!.n) > 0);
  service.schedulePreparation(job); service.confidence(job); service.list(job.id); await delay(50);
  assert.equal(calls, 1); assert.equal(service.list(job.id).runs.length, 1);
});

test('startup preparation upgrades stored diagnostics without replacing manual history or making model calls', async t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; return {}; });
  const reviewed = service.evaluate(job, { snapshot: overviewFixture() });
  const old = { ...reviewed }; delete old.preparation; delete old.phase; delete old.baseSnapshot; delete old.graphReadyAt;
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify(old), old.id);
  db.prepare('INSERT INTO why_not_preparation_attempts VALUES (?,?,?)').run(job.id, old.analysisRevision!, old.createdAt);
  service.schedulePreparation(job);
  for (let i = 0; i < 100 && !service.get(job.id, old.id).preparation?.ready; i++) await delay(5);
  const upgraded = service.get(job.id, old.id);
  assert.equal(calls, 0); assert.equal(upgraded.preparation?.ready, true);
  assert.equal(upgraded.phase, 'ready'); assert.equal(upgraded.baseSnapshot!.bindings[0].verdict, 'UNREVIEWED');
  assert.equal(upgraded.preparation!.score, evaluateWhyNot(old.snapshot!).confidence.bayesian!.score * 100);
  assert.deepEqual(upgraded.snapshot, old.snapshot); assert.deepEqual(upgraded.result, old.result);
  assert.equal(service.list(job.id).runs.length, 1);
});

test('preparation migration refreshes score, gaps, actions and animation together while preserving all assessment inputs and older history', async t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; throw new Error('No model request expected'); });
  const first = service.evaluate(job, { snapshot: overviewFixture() }); const historic = service.get(job.id, first.id);
  const updated = structuredClone(first.snapshot!); updated.bindings[0].verdict = 'INSUFFICIENT'; updated.bindings[0].reason = '직접 근거가 필요함';
  const latest = service.evaluate(job, { previousId: first.id, snapshot: updated });
  const stale = structuredClone(latest); stale.result!.confidence.bayesian!.score = .9999; stale.result!.gaps = []; stale.result!.actions = [];
  stale.preparation!.score = 99.99; stale.preparation!.animation = []; stale.preparation!.gapFill = [];
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify(stale), stale.id);
  db.prepare('INSERT INTO why_not_preparation_attempts VALUES (?,?,?)').run(job.id, stale.analysisRevision!, stale.createdAt);
  service.schedulePreparation(job);
  for (let i = 0; i < 100 && !service.get(job.id, stale.id).result!.gaps.length; i++) await delay(5);
  const fresh = service.get(job.id, stale.id); const expected = evaluateWhyNot(stale.snapshot!);
  assert.equal(calls, 0); assert.deepEqual(fresh.result, expected); assert.equal(fresh.preparation!.score, expected.confidence.bayesian!.score * 100);
  assert.deepEqual(fresh.preparation!.animation.map(step => step.gapId), expected.gaps.map(gap => gap.id));
  assert.deepEqual(fresh.preparation!.gapFill.map(step => step.actionId), expected.actions.map(action => action.id));
  assert.deepEqual(fresh.snapshot, stale.snapshot); assert.deepEqual(fresh.baseSnapshot, stale.baseSnapshot); assert.deepEqual(fresh.estimation, stale.estimation);
  assert.deepEqual(service.get(job.id, first.id), historic); assert.equal(service.list(job.id).runs.length, 2);
  assert.equal(service.confidence(job).confidence!.bayesian!.score, fresh.result!.confidence.bayesian!.score);
});

test('identical evaluate input creates a new immutable version only when the deterministic result changed', t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; throw new Error('No model request expected'); });
  const previous = service.evaluate(job, { snapshot: overviewFixture() });
  const stale = structuredClone(previous); stale.result!.confidence.bayesian!.score = .9999;
  db.prepare('UPDATE why_not_runs SET payload=? WHERE id=?').run(JSON.stringify(stale), stale.id);
  const saved = service.evaluate(job, { previousId: stale.id, snapshot: stale.snapshot });
  assert.notEqual(saved.id, stale.id); assert.equal(saved.previousId, stale.id);
  assert.deepEqual(saved.result, evaluateWhyNot(saved.snapshot!)); assert.deepEqual(saved.snapshot!.evidence, stale.snapshot!.evidence);
  assert.deepEqual(saved.snapshot!.bindings.map(({ decisionVersion: _version, ...binding }) => binding), stale.snapshot!.bindings.map(({ decisionVersion: _version, ...binding }) => binding));
  assert.deepEqual(service.get(job.id, stale.id), stale); assert.equal(calls, 0);
  assert.equal(service.evaluate(job, { previousId: saved.id, snapshot: saved.snapshot }).id, saved.id); assert.equal(service.list(job.id).runs.length, 2);
});

test('failed background preparation is not retried after service restart', async t => {
  let calls = 0; const { db, service } = memory(t, async () => { calls++; throw new Error('provider unavailable'); });
  service.schedulePreparation(job);
  for (let i = 0; i < 100 && service.list(job.id).runs[0]?.status !== 'failed'; i++) await delay(5);
  assert.equal(calls, 1); assert.equal(service.list(job.id).runs[0].status, 'failed');
  await service.close();
  const restarted = new WhyNotService(db, {}, async () => { calls++; return {}; });
  t.after(() => restarted.close()); restarted.schedulePreparation(job); await delay(50);
  assert.equal(calls, 1); assert.equal(restarted.list(job.id).runs.length, 1);
});

test('background preparation serializes cases and persists one attempt per analysis revision', async t => {
  let active = 0; let peak = 0; let calls = 0;
  const { db, service } = memory(t, async request => { calls++; active++; peak = Math.max(peak, active); await delay(35); active--; return draft(request.documents[0].id, request.documents[0].text, false); });
  const other = { ...job, id: 'why-second' };
  const input = JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료' }] });
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(input, job.id);
  db.prepare('INSERT INTO generation_jobs VALUES (?,?,?)').run(other.id, JSON.stringify(other), input);
  service.schedulePreparation(job); service.schedulePreparation(other); service.schedulePreparation(other);
  for (let i = 0; i < 100 && !service.list(other.id).runs[0]?.preparation?.ready; i++) await delay(5);
  assert.equal(peak, 1); assert.equal(calls, 2); assert.equal(service.list(other.id).runs[0].preparation?.ready, true);
  assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM why_not_preparation_attempts').get()!.n), 2);
});

function baselineReply(input: Parameters<CodexRunner>[0]) {
  const proposed = draft(input.documents[0].id, input.documents[0].text, false);
  return { rootId: proposed.rootId, nodes: proposed.nodes, eventRules: [], bindings: proposed.bindings.map(({ evidenceId, requirementId, quote }) => ({ evidenceId, requirementId, quote })) };
}
function reviewReply(input: Parameters<CodexRunner>[0]) {
  const context = JSON.parse(input.context!);
  return { decisions: context.bindingIds.map((id: string) => ({ bindingId: id, verdict: 'SUPPORTED', reason: '실제 완료 원문', missingRequirements: [], metadata: { fields: [], start: null, end: null, timeQuote: null } })), duplicates: [] };
}
const earlyDocument = { id: 'initial-source', name: '최초 원문', text: 'E1 완료' };
function persistMain(db: DatabaseSync, state: GenerationJob) { db.prepare('UPDATE generation_jobs SET payload=?,input_json=? WHERE id=?').run(JSON.stringify(state), JSON.stringify({ documents: [earlyDocument] }), state.id); }
async function earlyReady(service: WhyNotService) {
  for (let i = 0; i < 150; i++) { const item = service.list(job.id).runs[0]; if (item?.phase === 'graph-ready') return item; await delay(5); }
  throw new Error('Early neutral graph did not finish');
}
function phasedRunner(modes: string[]): CodexRunner { return async input => { const mode = JSON.parse(input.context!).mode; modes.push(mode); return mode === 'baseline' ? baselineReply(input) : mode === 'review' ? reviewReply(input) : { prior: { probability: null, reason: '추정 보류', anchors: [] }, bindings: [], sources: [] }; }; }
test('early neutral graph waits for main analysis then promotes the same run to the final revision', async t => {
  const modes: string[] = []; const { db, service } = memory(t, phasedRunner(modes), true);
  const running = { ...job, status: 'running' as const, completedChunks: 0, totalChunks: 0 };
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]);
  const ready = await earlyReady(service);
  assert.equal(ready.awaitingAnalysis, true); assert.equal(ready.baseSnapshot!.bindings[0].verdict, 'UNREVIEWED');
  assert.equal(ready.result, undefined); assert.deepEqual(modes, ['baseline']);
  await delay(35); assert.deepEqual(modes, ['baseline']);
  persistMain(db, job); service.schedulePreparation(job);
  const saved = await finished(service, ready.id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.awaitingAnalysis, false);
  assert.notEqual(saved.analysisRevision, ready.analysisRevision); assert.deepEqual(saved.baseSnapshot, ready.baseSnapshot);
  assert.deepEqual(modes, ['baseline', 'review', 'estimate-confidence']); assert.equal(service.list(job.id).runs.length, 1);
  assert.notEqual(service.confidence(job).state, 'stale');
});
test('completion during early graph generation releases review without another baseline call', async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const modes: string[] = [];
  const runner = phasedRunner(modes);
  const { db, service } = memory(t, async (input, config, options) => { if (JSON.parse(input.context!).mode === 'baseline') await held; return runner(input, config, options); }, true);
  const running = { ...job, status: 'running' as const, completedChunks: 0 };
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]);
  for (let i = 0; i < 100 && !service.list(job.id).runs.length; i++) await delay(5);
  const initial = service.list(job.id).runs[0]; persistMain(db, job); service.schedulePreparation(job); release();
  const saved = await finished(service, initial.id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.awaitingAnalysis, false);
  assert.deepEqual(modes, ['baseline', 'review', 'estimate-confidence']); assert.equal(service.list(job.id).runs.length, 1);
});
test('early graph rejects changed input and manual checks remain possible on a failed main analysis', async t => {
  const modes: string[] = []; const { db, service } = memory(t, phasedRunner(modes), true);
  const running = { ...job, status: 'running' as const, completedChunks: 0 };
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]); const ready = await earlyReady(service);
  persistMain(db, job); db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ ...earlyDocument, text: '다른 입력' }] }), job.id);
  service.schedulePreparation(job); const stopped = await finished(service, ready.id);
  assert.equal(stopped.status, 'failed'); assert.match(stopped.error!, /입력 자료가 변경/); assert.deepEqual(modes, ['baseline']);
  const failedMain = { ...job, status: 'failed' as const }; persistMain(db, failedMain);
  const manual = service.start(failedMain, { previousId: stopped.id, goal: job.question });
  assert.equal((await finished(service, manual.id)).status, 'completed'); assert.equal(modes.filter(mode => mode === 'review').length, 1);
});
test('main failure preserves a waiting graph; explicit resume reuses it and preserves the stopped version', async t => {
  const modes: string[] = []; const { db, service } = memory(t, phasedRunner(modes), true);
  const running = { ...job, status: 'running' as const, completedChunks: 0 };
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]); const ready = await earlyReady(service);
  const failedMain = { ...running, status: 'failed' as const }; persistMain(db, failedMain); service.stopAnalysis(failedMain);
  const stopped = service.get(job.id, ready.id); assert.equal(stopped.status, 'failed'); assert.deepEqual(stopped.baseSnapshot, ready.baseSnapshot);
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]); const resumed = await earlyReady(service);
  assert.notEqual(resumed.id, ready.id); assert.equal(resumed.previousId, ready.id); assert.deepEqual(modes, ['baseline']);
  persistMain(db, job); service.schedulePreparation(job); const saved = await finished(service, resumed.id);
  assert.equal(saved.status, 'completed', saved.error); assert.deepEqual(modes, ['baseline', 'review', 'estimate-confidence']);
  assert.deepEqual(service.get(job.id, ready.id), stopped); assert.deepEqual(saved.baseSnapshot, ready.baseSnapshot);
});
test('restart holds an early neutral graph until main completion and waiting cancellation is terminal', async t => {
  const modes: string[] = []; const { db, service } = memory(t, phasedRunner(modes), true);
  const running = { ...job, status: 'running' as const, completedChunks: 0 };
  persistMain(db, running); service.scheduleBaseline(running, [earlyDocument]); const ready = await earlyReady(service); await service.close();
  const restarted = new WhyNotService(db, {}, phasedRunner(modes)); t.after(() => restarted.close());
  await delay(35); assert.deepEqual(modes, ['baseline']); assert.equal(restarted.get(job.id, ready.id).phase, 'graph-ready');
  await restarted.cancel(job.id); assert.equal(restarted.get(job.id, ready.id).status, 'cancelled');
  persistMain(db, job); restarted.schedulePreparation(job); await delay(40);
  assert.deepEqual(modes, ['baseline']); assert.equal(restarted.get(job.id, ready.id).status, 'cancelled');
});
test('complete neutral base is durable and readable before the separate diagnostic model request finishes', async t => {
  const modes: string[] = []; let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const { db, service } = memory(t, async input => {
    const context = JSON.parse(input.context!); modes.push(context.mode);
    if (context.mode === 'estimate-confidence') return { prior: { probability: null, reason: '추정 보류', anchors: [] }, bindings: [], sources: [] };
    if (context.mode === 'baseline') { assert.ok(!JSON.stringify(input.schema).includes('verdict')); return baselineReply(input); }
    assert.equal(context.mode, 'review'); assert.equal(service.list(job.id).runs[0].phase, 'diagnosing');
    assert.ok(service.list(job.id).runs[0].graphReadyAt); await hold; return reviewReply(input);
  }, true);
  t.after(() => release());
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료' }] }), job.id);
  db.exec("CREATE TABLE graph_ready_checkpoints(payload TEXT); CREATE TRIGGER checkpoint_ready AFTER UPDATE ON why_not_runs WHEN json_extract(NEW.payload,'$.phase')='graph-ready' BEGIN INSERT INTO graph_ready_checkpoints VALUES (NEW.payload); END");
  const started = service.start(job, { auto: true });
  for (let i = 0; i < 100 && service.get(job.id, started.id).phase !== 'diagnosing'; i++) await delay(5);
  const pending = service.get(job.id, started.id);
  assert.deepEqual(modes, ['baseline', 'review']); assert.equal(pending.status, 'running'); assert.equal(pending.result, undefined);
  assert.ok(pending.baseSnapshot); assert.equal(pending.baseSnapshot.bindings[0].verdict, 'UNREVIEWED'); assert.deepEqual(pending.baseSnapshot.duplicates, []);
  assert.equal(pending.preparation?.ready, false); assert.ok(Number(db.prepare('SELECT COUNT(*) n FROM graph_ready_checkpoints').get()!.n) >= 1);
  assert.ok(Date.parse(pending.graphReadyAt!) <= Date.parse(pending.stages!.find(stage => stage.stage === 'evaluating')!.startedAt));
  release(); const saved = await finished(service, started.id);
  assert.equal(saved.phase, 'ready'); assert.equal(saved.status, 'completed'); assert.equal(saved.snapshot!.bindings[0].verdict, 'SUPPORTED');
  assert.deepEqual(saved.baseSnapshot, pending.baseSnapshot); assert.deepEqual(saved.snapshot!.nodes, pending.baseSnapshot.nodes);
  assert.deepEqual(saved.snapshot!.bindings.map(binding => [binding.id, binding.quote]), pending.baseSnapshot.bindings.map(binding => [binding.id, binding.quote]));
});
test('shutdown after graph completion resumes only diagnostics from the immutable base checkpoint', async t => {
  const { db, service } = memory(t, async (input, _config, options) => {
    if (JSON.parse(input.context!).mode === 'baseline') return baselineReply(input);
    return await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('shutdown')), { once: true }));
  }, true);
  db.prepare('UPDATE generation_jobs SET input_json=? WHERE id=?').run(JSON.stringify({ documents: [{ id: 'original', name: '원문', text: 'E1 완료' }] }), job.id);
  const started = service.start(job, { auto: true });
  for (let i = 0; i < 100 && service.get(job.id, started.id).phase !== 'diagnosing'; i++) await delay(5);
  const original = service.get(job.id, started.id).baseSnapshot;
  await service.close(); assert.equal(service.get(job.id, started.id).phase, 'graph-ready');
  let reviewCalls = 0;
  const resumed = new WhyNotService(db, {}, async input => { if (JSON.parse(input.context!).mode === 'estimate-confidence') return { prior: { probability: null, reason: '추정 보류', anchors: [] }, bindings: [], sources: [] }; assert.equal(JSON.parse(input.context!).mode, 'review'); reviewCalls++; return reviewReply(input); });
  const saved = await finished(resumed, started.id); await resumed.close();
  assert.equal(reviewCalls, 1); assert.equal(saved.status, 'completed'); assert.equal(saved.phase, 'ready'); assert.deepEqual(saved.baseSnapshot, original);
});

test('explicit LOW confidence estimation creates one immutable version without graph generation or review calls', async t => {
  const modes: string[] = [];
  const { service } = memory(t, async (input, config) => {
    modes.push(JSON.parse(input.context!).mode); assert.equal(config?.effort, 'low'); assert.equal(config?.efforts?.['why-not'], 'low');
    const context = JSON.parse(input.context!); const binding = context.bindings[0];
    return { prior: { probability: .2, reason: '목표의 모형 사전 추정', anchors: [{ evidenceId: binding.evidenceId, quote: binding.quote }] }, bindings: [{ bindingId: binding.id, ratio: 4, reason: '동일 목표 대비 원문 관측의 상대 가능도 추정', anchors: [{ evidenceId: binding.evidenceId, quote: binding.quote }] }], sources: [] };
  }, true);
  const previous = service.evaluate(job, { snapshot: overviewFixture() }); const original = service.get(job.id, previous.id);
  const started = service.estimate(job, { previousId: previous.id });
  assert.equal(service.estimate(job, { previousId: previous.id }).id, started.id);
  assert.equal(started.phase, 'graph-ready'); assert.equal(started.preparation?.ready, false);
  const saved = await finished(service, started.id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.estimation?.status, 'completed', saved.estimation?.error);
  assert.deepEqual(modes, ['estimate-confidence']); assert.equal(saved.previousId, previous.id);
  assert.deepEqual(saved.baseSnapshot, previous.baseSnapshot); assert.deepEqual(saved.snapshot!.nodes, previous.snapshot!.nodes);
  assert.deepEqual(saved.snapshot!.bindings.map(binding => [binding.id, binding.quote]), previous.snapshot!.bindings.map(binding => [binding.id, binding.quote]));
  assert.equal(saved.snapshot!.bindings[0].likelihood?.basis, 'MODEL_ESTIMATE');
  assert.equal(saved.snapshot!.evidence[0].sourceGrade, 'B');
  assert.ok(Math.abs(saved.result!.confidence.bayesian!.score - 17 / 37) < 1e-12);
  assert.deepEqual(service.get(job.id, previous.id), original);
  assert.equal(service.estimate(job, { previousId: previous.id }).id, saved.id);
  service.confidence(job); service.list(job.id); assert.equal(modes.length, 1);
  assert.throws(() => service.estimate(job, { previousId: 'obsolete' }), { status: 409 });
});
test('estimation failure preserves completed diagnostics and records neutral fallback without retrying reads', async t => {
  let calls = 0; const { service } = memory(t, async () => { calls++; throw new Error('provider unavailable'); }, true);
  const previous = service.evaluate(job, { snapshot: overviewFixture() });
  const saved = await finished(service, service.estimate(job, { previousId: previous.id }).id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.estimation?.status, 'failed'); assert.ok(saved.estimation?.error);
  assert.equal(saved.preparation?.ready, true); assert.deepEqual(saved.baseSnapshot, previous.baseSnapshot);
  assert.deepEqual(saved.snapshot, previous.snapshot); assert.equal(saved.result!.confidence.bayesian!.score, .5);
  assert.ok(service.confidence(job).unknownReasons.some(reason => reason.includes('모델 신뢰도 추정 실패')));
  assert.equal(service.estimate(job, { previousId: previous.id }).id, saved.id); assert.equal(calls, 1);
});

test('unlinked supplemental material is saved in a completed version without inventing links or changing confidence', async t => {
  let baselineCalls = 0;
  const { service } = memory(t, async input => {
    baselineCalls++; assert.equal(JSON.parse(input.context!).supplement, true);
    const response = draft(input.documents[0].id, input.documents[0].text);
    return { ...response, bindings: [] };
  });
  const snapshot = overviewFixture();
  snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '기존 검토자의 사전 모형' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 3, basis: 'EXPERT_ESTIMATE', reason: '기존 검토자의 가능도 모형' };
  const previous = service.evaluate(job, { snapshot }); const old = service.get(job.id, previous.id);
  const saved = await finished(service, service.start(job, { previousId: previous.id, supplement: { name: '추가 확인', text: '없음', url: '' } }).id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(saved.phase, 'ready'); assert.equal(saved.preparation?.ready, true);
  assert.equal(saved.previousId, previous.id); assert.equal(saved.snapshot!.evidence.length, previous.snapshot!.evidence.length + 1);
  const added = saved.snapshot!.evidence.find(source => source.id.startsWith('user-'))!;
  assert.equal(added.text, '없음'); assert.equal(added.name, '추가 확인');
  assert.ok(!saved.snapshot!.bindings.some(binding => binding.evidenceId === added.id));
  assert.deepEqual(saved.snapshot!.bindings, previous.snapshot!.bindings);
  assert.equal(saved.result!.confidence.bayesian!.score, previous.result!.confidence.bayesian!.score);
  assert.ok(!saved.snapshot!.coverage.note.includes('다음 단계'));
  assert.deepEqual(service.get(job.id, previous.id), old); assert.equal(baselineCalls, 1);
});

test('supplementary URL body resolves a missing condition and raises confidence through its assessed LR while preserving reviewed inputs', async t => {
  const url = 'https://evidence.example/record'; const article = 'E1의 두 번째 조건이 별도 관측 기록에서 완료되었다.';
  const note = '이 링크가 두 번째 조건을 뒷받침합니다.'; const modes: string[] = []; let reads = 0;
  const resolver: typeof resolveUrlEvidence = async documents => {
    reads++; assert.ok(documents[0].text.includes(url));
    return { documents: [{ ...documents[0], text: note }, { id: 'url-fetched-body', name: '공개 관측 기록', text: article, url }], results: [{ documentId: documents[0].id, url, status: 'fetched', finalUrl: url, characters: article.length }] };
  };
  const { service } = memory(t, async input => {
    const context = JSON.parse(input.context!); modes.push(context.mode);
    if (context.mode === 'baseline') {
      const fetched = input.documents.find(document => document.text === article)!; assert.ok(fetched);
      const userNote = input.documents.find(document => document.text === note)!; assert.ok(userNote); assert.notEqual(fetched.id, userNote.id);
      return { rootId: 'root', nodes: [], eventRules: [], bindings: [{ evidenceId: fetched.id, requirementId: 'r1', quote: article }] };
    }
    if (context.mode === 'review') {
      assert.equal(context.bindingIds.length, 1); assert.ok(input.documents.some(document => document.text === article));
      return reviewReply(input);
    }
    assert.equal(context.prior.eligible, false);
    const added = context.bindings.find((binding: { evidenceId: string }) => binding.evidenceId === 'user-url-fetched-body'); assert.ok(added);
    assert.ok(input.documents.some(document => document.id === added.evidenceId));
    return { prior: { probability: .9, reason: '기존 수동 사전확률은 교체하면 안 됨', anchors: [{ evidenceId: added.evidenceId, quote: article }] },
      bindings: [{ bindingId: added.id, ratio: 4, reason: '새 독립 관측은 목표가 참일 때 더 예상됨', anchors: [{ evidenceId: added.evidenceId, quote: article }] }, { bindingId: 'b0', ratio: 100, reason: '기존 수동값은 교체하면 안 됨', anchors: [{ evidenceId: 'e0', quote: 'E1 완료 0' }] }],
      sources: [{ evidenceId: added.evidenceId, grade: 'B', reason: '시험에서 지정한 비당사자 공개 관측 기록', anchors: [{ evidenceId: added.evidenceId, quote: article }] }] };
  }, true, resolver);
  const snapshot = overviewFixture(2); snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '기존 검토자의 사전 모형', basis: 'EXPERT_ESTIMATE' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 2, basis: 'CALIBRATED', reason: '기존 검토 수치', hypothesisId: 'root' };
  snapshot.bindings[1].verdict = 'INSUFFICIENT'; snapshot.bindings[1].reason = '두 번째 조건의 직접 관측이 필요함'; snapshot.bindings[1].likelihood = { ratio: 1, basis: 'EXPERT_ESTIMATE', reason: '불충분한 자료는 중립', hypothesisId: 'root' };
  snapshot.evidence[1].sourceGrade = null; snapshot.evidence[1].sourceCoefficient = null;
  const previous = service.evaluate(job, { snapshot }); const old = service.get(job.id, previous.id);
  assert.equal(previous.result!.chainStatus, 'NO_COMPLETE_CHAIN');
  const added = await finished(service, service.start(job, { previousId: previous.id, supplement: { name: '보완 URL', text: note, url } }).id);
  assert.equal(added.status, 'completed', added.error); assert.deepEqual(modes, ['baseline', 'review', 'estimate-confidence']);
  assert.equal(added.urlReads![0].status, 'fetched'); assert.equal(added.snapshot!.evidence.find(source => source.text === note)!.url, null);
  const fetched = added.snapshot!.evidence.find(source => source.text === article)!; assert.equal(fetched.url, url); assert.equal(fetched.originalVerified, false); assert.equal(fetched.sourceGrade, 'B');
  assert.deepEqual(added.snapshot!.bindings.slice(0, 2), old.snapshot!.bindings); assert.deepEqual(added.snapshot!.policy.bayes!.priors, old.snapshot!.policy.bayes!.priors);
  assert.deepEqual(service.get(job.id, previous.id), old);
  assert.equal(added.result!.chainStatus, 'COMPLETE_CHAIN_FOUND'); assert.ok(added.preparation!.score! > previous.preparation!.score!);
  assert.ok(Math.abs(added.result!.confidence.bayesian!.score - 6.12 / 7.12) < 1e-12);
  assert.equal(service.confidence(job).confidence!.bayesian!.score, added.result!.confidence.bayesian!.score);
  const duplicate = await finished(service, service.start(job, { previousId: added.id, supplement: { name: '같은 URL 재확인', text: note, url } }).id);
  assert.equal(duplicate.status, 'completed'); assert.equal(duplicate.preparation!.score, added.preparation!.score); assert.deepEqual(duplicate.snapshot, added.snapshot);
  assert.equal(reads, 2); assert.equal(modes.length, 3);
});

test('unreadable URL-only supplements retain the previous score without model calls', async t => {
  let calls = 0; const url = 'https://evidence.example/unavailable';
  const { service } = memory(t, async () => { calls++; return {}; }, true, async documents => ({ documents: [], results: [{ documentId: documents[0].id, url, status: 'failed', reason: '원문을 읽을 수 없음' }] }));
  const previous = service.evaluate(job, { snapshot: overviewFixture() });
  const stopped = await finished(service, service.start(job, { previousId: previous.id, supplement: { name: '본문 링크', text: '', url } }).id);
  assert.equal(stopped.status, 'failed'); assert.match(stopped.error!, /원문을 읽/); assert.equal(stopped.urlReads![0].status, 'failed');
  assert.deepEqual(stopped.snapshot, previous.snapshot); assert.equal(calls, 0); assert.equal(service.confidence(job).confidence!.bayesian!.score, previous.result!.confidence.bayesian!.score);
});

for (const oldNote of ['', '해당 URL이 근거입니다.']) test(`a ${oldNote ? 'previously saved note with a URL' : 'URL without a note'} reads new body before quote review`, async t => {
  const url = 'https://evidence.example/new'; const body = '새로 읽은 E1 완료 원문'; let calls = 0;
  const { service } = memory(t, async input => { calls++; assert.equal(input.documents.length, 1); assert.equal(input.documents[0].text, body); return draft(input.documents[0].id, body); }, false,
    async documents => ({ documents: [...(oldNote ? [{ ...documents[0], text: oldNote }] : []), { id: 'url-fetched-new', name: '본문', text: body, url }], results: [{ documentId: documents[0].id, url, status: 'fetched' }] }));
  const snapshot = overviewFixture(); if (oldNote) snapshot.evidence.push(makeWhyEvidence('user-old-note', '기존 설명', oldNote, null, url));
  const previous = service.evaluate(job, { snapshot });
  const saved = await finished(service, service.start(job, { previousId: previous.id, supplement: { name: '새 원문', text: oldNote, url } }).id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(calls, 1);
  assert.equal(saved.snapshot!.evidence.filter(source => source.text === body).length, 1);
  if (oldNote) assert.equal(saved.snapshot!.evidence.filter(source => source.text === oldNote).length, 1);
  assert.deepEqual(service.get(job.id, previous.id), previous);
});

test('cancelled supplementary URL reads cannot invoke the provider or save late fetched evidence', async t => {
  let release!: () => void; let fetching = false; let calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const { service } = memory(t, async () => { calls++; return {}; }, true, async documents => { fetching = true; await gate; return { documents: [{ id: 'url-late', name: '늦은 원문', text: 'E1 완료', url: 'https://evidence.example/late' }], results: [{ documentId: documents[0].id, url: 'https://evidence.example/late', status: 'fetched' }] }; });
  const previous = service.evaluate(job, { snapshot: overviewFixture() });
  const pending = service.start(job, { previousId: previous.id, supplement: { name: '링크', text: '', url: 'https://evidence.example/late' } });
  for (let i = 0; i < 100 && !fetching; i++) await delay(5);
  const cancelling = service.cancel(job.id); release(); await cancelling;
  const cancelled = service.get(job.id, pending.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(calls, 0); assert.deepEqual(cancelled.snapshot, previous.snapshot);
});

test('source-only LOW estimation fills an unknown official classification and reuses the saved calibrated LR', async t => {
  let calls = 0;
  const { service } = memory(t, async (input, config) => {
    calls++; assert.equal(JSON.parse(input.context!).mode, 'estimate-confidence'); assert.equal(config?.effort, 'low');
    const context = JSON.parse(input.context!); assert.deepEqual(context.targets.bindingIds, []); assert.deepEqual(context.targets.sourceIds, ['e0']);
    const schema = input.schema as { properties: { sources: { minItems: number } } }; assert.equal(schema.properties.sources.minItems, 1);
    return { prior: { probability: null, reason: '기존 사전 모형 유지', anchors: [] }, bindings: [], sources: [{ evidenceId: 'e0', grade: 'B', reason: '제공된 문서에서 사건 직접 당사자가 아닌 정부간기구의 공식 발표로 판단한 모델 분류입니다.', anchors: [{ evidenceId: 'e0', quote: 'E1 완료 0' }] }] };
  }, true);
  const snapshot = overviewFixture(); snapshot.policy.bayes = { target: 'GOAL', priors: [{ nodeId: 'root', probability: .5, reason: '기존 검토자 설정', basis: 'EXPERT_ESTIMATE' }], conditionalIndependence: [] };
  snapshot.bindings[0].likelihood = { ratio: 3, basis: 'CALIBRATED', reason: '기존 저장 수치', hypothesisId: 'root' };
  snapshot.evidence[0].sourceGrade = null; snapshot.evidence[0].sourceCoefficient = null; snapshot.evidence[0].sourceReason = '';
  const previous = service.evaluate(job, { snapshot }); assert.equal(previous.preparation!.score, 50);
  const saved = await finished(service, service.estimate(job, { previousId: previous.id }).id);
  assert.equal(saved.status, 'completed', saved.error); assert.equal(calls, 1); assert.equal(saved.snapshot!.evidence[0].sourceGrade, 'B'); assert.equal(saved.snapshot!.evidence[0].originalVerified, false);
  assert.deepEqual(saved.snapshot!.bindings[0], previous.snapshot!.bindings[0]); assert.deepEqual(saved.baseSnapshot, previous.baseSnapshot);
  assert.ok(Math.abs(saved.preparation!.score! - 100 * 2.6 / 3.6) < 1e-10); assert.deepEqual(service.get(job.id, previous.id), previous);
});
