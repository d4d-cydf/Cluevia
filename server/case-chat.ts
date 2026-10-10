import { relevantPassages, searchScore, searchTerms } from './evidence-search.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GenerationJob } from './jobs.ts';
import type { GraphSelection } from '../src/types/graph.ts';
import type { CaseChatTurn, CaseChatState } from '../src/types/case-chat.ts';
import { buildAnalysisCase, getAnalysisRecord, searchCaseEvidence } from './analysis-case.ts';
import { CodexError, DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT, effectiveCodexConfig, runCodex } from './codex.ts';
import type { CodexConfig, CodexDocument } from './codex.ts';

const answerSchema = { type: 'object', additionalProperties: false, required: ['answer', 'citations'], properties: {
  answer: { type: 'string', minLength: 1, maxLength: 14000 }, citations: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['record', 'quote'], properties: { record: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 1000 } } } },
} };

export class CaseChatError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

/** Local retrieval over the complete case; only bounded excerpts are passed to Codex. */
export function caseChatContext(db: DatabaseSync, job: GenerationJob, question: string, selection?: GraphSelection) {
  const value = buildAnalysisCase(db, job); const graph = value.graph;
  const terms = searchTerms(question);
  const score = (text: string) => searchScore(text, terms);
  const searched = searchCaseEvidence(db, job, question);
  const selectedIds = new Set<string>();
  if (selection?.kind === 'node' && graph.nodes.some(node => node.id === selection.id)) selectedIds.add(selection.id);
  if (selection?.kind === 'edge') { const edge = graph.edges.find(edge => edge.id === selection.id); if (edge) { selectedIds.add(edge.source); selectedIds.add(edge.target); } }
  if (selection?.kind === 'event') graph.events.find(event => event.id === selection.id)?.nodeIds.forEach(id => selectedIds.add(id));
  if (selection && !selectedIds.size) throw new CaseChatError(400, '선택한 항목은 이 케이스에 없습니다.');
  const neighbors = new Set(graph.edges.filter(edge => selectedIds.has(edge.source) || selectedIds.has(edge.target)).flatMap(edge => [edge.source, edge.target]));
  const ranked = graph.nodes.map(node => ({ node, score: (selectedIds.has(node.id) ? 100 : neighbors.has(node.id) ? 20 : 0) + score(`${node.label} ${node.type} ${node.description} ${Object.values(node.properties).join(' ')}`) })).sort((a, b) => b.score - a.score);
  const chosen = ranked.slice(0, 100).map(item => item.node);
  const nodeIds = new Set(chosen.map(node => node.id));
  const links = graph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).slice(0, 140);
  const recordScores = new Map(value.records.filter(record => record.status !== 'pending').map(record => [record.number, score(record.title)]));
  for (const item of ranked.slice(0, 100)) for (const ref of value.provenance[item.node.id] ?? []) recordScores.set(ref.record, (recordScores.get(ref.record) ?? 0) + item.score);
  for (const finding of graph.findings) for (const id of finding.sourceIds) for (const ref of value.provenance[id] ?? []) recordScores.set(ref.record, (recordScores.get(ref.record) ?? 0) + score(finding.text) * 3);
  for (const hit of searched.hits) recordScores.set(hit.number, (recordScores.get(hit.number) ?? 0) + 100 + hit.score);
  const recordsUsed = [...recordScores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10).map(([number]) => number);
  const quoteTexts = new Map<number, string[]>();
  const documents: CodexDocument[] = recordsUsed.map(number => {
    const detail = getAnalysisRecord(db, job, number)!;
    const hit = searched.hits.find(hit => hit.number === number);
    const raw = hit ? hit.excerpts.join('\n\n').slice(0, 8000) : detail.documents.map(doc => `${doc.name}\n${relevantPassages(doc.text, terms, 5000).map(part => part.text).join('\n\n')}`).join('\n\n').slice(0, 8000);
    const quotes = [...detail.claims.flatMap(claim => claim.evidence), ...detail.relationClaims.flatMap(claim => claim.evidence)].map(item => item.quote);
    quoteTexts.set(number, [...(hit?.evidenceTexts ?? detail.documents.map(document => document.text)), ...quotes]);
    const text = `${raw}\n\n검증된 원문 인용:\n${[...new Set(quotes)].map(quote => quote.slice(0, 500)).join('\n').slice(0, 5000)}`;
    return { id: `record-${number}`, name: `기록 ${number} · ${detail.record.title}`.slice(0, 300), text: text.trim() || '원문 인용이 저장되지 않았습니다.' };
  });
  const context = {
    caseQuestion: job.question, summary: graph.summary, totalObjects: graph.nodes.length, totalLinks: graph.edges.length,
    coverage: { indexedRecords: searched.indexedRecords, matchedRecords: searched.hits.length, totalRecords: value.records.length, recordsUsed, objectsShown: chosen.length, linksShown: links.length, note: 'These are retrieved excerpts, not all raw evidence. Do not infer absence from omitted records.' },
    records: value.records.map(record => ({ number: record.number, title: record.title.slice(0, 140), status: record.status })).slice(0, 200),
    nodes: chosen.map(node => ({ id: node.id, type: node.type, label: node.label, description: node.description.slice(0, 240), properties: Object.fromEntries(Object.entries(node.properties).slice(0, 10).map(([key, value]) => [key, value.slice(0, 120)])), records: [...new Set((value.provenance[node.id] ?? []).map(ref => ref.record))] })),
    links: links.map(edge => ({ source: edge.source, target: edge.target, label: edge.label, status: edge.status, ...(edge.claim ? { claim: edge.claim } : {}), description: edge.description.slice(0, 200), records: (value.provenance[edge.id] ?? []).map(ref => ref.record) })),
    conflicts: value.conflicts.filter(item => nodeIds.has(item.nodeId)).slice(0, 30), limitations: graph.limitations,
  };
  // Structured context is reduced as whole items, never invalid truncated JSON.
  while (JSON.stringify(context).length > 60000 && context.nodes.length > 1) {
    context.nodes.pop(); const retained = new Set(context.nodes.map(node => node.id)); context.links = context.links.filter(link => retained.has(link.source) && retained.has(link.target));
    context.conflicts = context.conflicts.filter(item => retained.has(item.nodeId));
  }
  context.coverage.objectsShown = context.nodes.length; context.coverage.linksShown = context.links.length;
  while (JSON.stringify(context).length > 60000 && context.conflicts.length) context.conflicts.pop();
  while (JSON.stringify(context).length > 60000 && context.records.length) context.records.pop();
  return { context, documents, quoteTexts, recordsUsed, totalRecords: value.records.length, indexedRecords: searched.indexedRecords };
}

export class CaseChat {
  private db: DatabaseSync; private config: CodexConfig; private run: typeof runCodex;
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private deleting = new Set<string>(); private closing = false;
  constructor(db: DatabaseSync, config: CodexConfig, run: typeof runCodex = runCodex) {
    this.db = db; this.config = effectiveCodexConfig(config, 'case-chat'); this.run = run;
    db.exec('CREATE TABLE IF NOT EXISTS case_chat_turns (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id), created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS case_chat_job ON case_chat_turns(job_id,created_at)');
    for (const row of db.prepare("SELECT id,payload FROM case_chat_turns WHERE json_extract(payload,'$.status')='running'").all()) {
      const turn = JSON.parse(String(row.payload)) as CaseChatTurn;
      db.prepare('UPDATE case_chat_turns SET payload=? WHERE id=?').run(JSON.stringify({ ...turn, status: 'failed', error: '서버 재시작으로 대화가 중단되었습니다. 질문을 다시 보내주세요.' }), String(row.id));
    }
  }
  list(jobId: string): CaseChatState {
    const turns = this.db.prepare('SELECT payload FROM case_chat_turns WHERE job_id=? ORDER BY created_at,rowid').all(jobId).map(row => JSON.parse(String(row.payload)) as CaseChatTurn);
    return { turns, model: this.config.model || DEFAULT_CODEX_MODEL, effort: this.config.effort || DEFAULT_CODEX_EFFORT };
  }
  send(job: GenerationJob, question: string, selection?: GraphSelection): CaseChatTurn {
    if (this.closing || this.deleting.has(job.id)) throw new CaseChatError(409, '이 케이스의 대화를 종료하고 있습니다.');
    if (job.status !== 'completed') throw new CaseChatError(409, '전체 분석이 완료된 후 케이스 결과에 대해 질문할 수 있습니다.');
    if (this.active.has(job.id)) throw new CaseChatError(409, '현재 답변이 완료된 후 다음 질문을 보내주세요.');
    if (this.active.size >= 2) throw new CaseChatError(429, '다른 대화의 답변을 생성 중입니다. 잠시 후 다시 보내주세요.');
    const retrieved = caseChatContext(this.db, job, question, selection);
    if (!retrieved.documents.length) throw new CaseChatError(400, '아직 대화에 사용할 분석 근거가 없습니다.');
    const previous = this.list(job.id).turns.filter(turn => turn.status === 'completed').slice(-8).map(turn => ({ question: turn.question, answer: turn.answer?.slice(0, 1500) }));
    const turn: CaseChatTurn = { id: `chat-${randomUUID()}`, question, createdAt: new Date().toISOString(), status: 'running', recordsUsed: retrieved.recordsUsed, totalRecords: retrieved.totalRecords, indexedRecords: retrieved.indexedRecords };
    this.db.prepare('INSERT INTO case_chat_turns VALUES (?,?,?,?)').run(turn.id, job.id, turn.createdAt, JSON.stringify(turn));
    const controller = new AbortController();
    const task = (async () => {
      try {
        const answer = await this.run({ purpose: 'case-chat', question, documents: retrieved.documents, schema: answerSchema, context: JSON.stringify({ ...retrieved.context, conversation: previous }) }, this.config, { signal: controller.signal });
        controller.signal.throwIfAborted();
        const candidate = answer as { answer?: unknown; citations?: unknown };
        if (!candidate || typeof candidate !== 'object' || typeof candidate.answer !== 'string' || !candidate.answer.trim() || candidate.answer.length > 14000 || !Array.isArray(candidate.citations) || candidate.citations.length > 20) throw new CaseChatError(502, 'Codex 대화 응답 형식이 올바르지 않습니다.');
        const citations = candidate.citations.map(item => {
          if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.record) || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 1000 || !retrieved.documents.find(doc => doc.id === `record-${item.record}`)?.text.includes(item.quote) || !retrieved.quoteTexts.get(item.record)?.some(text => text.includes(item.quote))) throw new CaseChatError(502, '답변에 제공된 원문과 일치하지 않는 인용이 있어 저장하지 않았습니다.');
          return { record: item.record as number, quote: item.quote as string };
        });
        this.save({ ...turn, status: 'completed', answer: candidate.answer, citations });
      } catch (error) {
        this.save({ ...turn, status: 'failed', error: error instanceof CaseChatError || error instanceof CodexError ? error.message : controller.signal.aborted ? '대화 생성을 중단했습니다.' : '답변 생성 중 오류가 발생했습니다. 다시 질문해주세요.' });
      }
    })().finally(() => this.active.delete(job.id));
    this.active.set(job.id, { controller, task });
    return turn;
  }
  private save(turn: CaseChatTurn) { this.db.prepare('UPDATE case_chat_turns SET payload=? WHERE id=?').run(JSON.stringify(turn), turn.id); }
  async remove(jobId: string) { this.deleting.add(jobId); const pending = this.active.get(jobId); pending?.controller.abort(); await pending?.task; }
  async close() { this.closing = true; for (const item of this.active.values()) item.controller.abort(); await Promise.allSettled([...this.active.values()].map(item => item.task)); }
}
