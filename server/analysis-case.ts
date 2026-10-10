import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EvidenceDocument, GraphDocument } from '../src/types/graph.ts';
import type { OntologyExtraction } from '../src/types/ontology.ts';
import type { AnalysisCase, AnalysisRecord, AnalysisRecordDetail, RecordDocument } from '../src/types/analysis-case.ts';
import { relevantPassages, searchScore, searchTerms, indexTerms } from './evidence-search.ts';

interface CaseJob {
  id: string; question: string; status: string; createdAt: string; updatedAt: string;
  completedChunks?: number; totalChunks?: number; graphIds?: string[]; graphId?: string;
  ontologyId?: string; ontologyVersion?: number;
}
interface Archive { documents: EvidenceDocument[]; extraction?: OntologyExtraction }
interface Member { number: number; graphId?: string; archived: boolean; title?: string }
const key = (prefix: string, value: unknown) => `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const EVIDENCE_INDEX_VERSION = 2;

export function createRecordArchive(db: DatabaseSync) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='evidence_search'").get();
  const legacyFts = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(existing?.sql ?? ''));
  db.exec('SAVEPOINT record_archive_schema');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS analysis_record_archive (job_id TEXT NOT NULL, part_index INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(job_id,part_index))');
    // Older Windows installations have an FTS5 virtual table with this name.
    // It is only a derived search cache; originals remain in the archive/documents.
    // Replace it before CREATE INDEX, which SQLite forbids on virtual tables.
    if (legacyFts) db.exec('DROP TABLE evidence_search');
    db.exec(`CREATE TABLE IF NOT EXISTS evidence_search (job_id TEXT NOT NULL, part_index INTEGER NOT NULL, document_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_search_job ON evidence_search(job_id);
      CREATE TABLE IF NOT EXISTS evidence_search_terms (job_id TEXT NOT NULL, term TEXT NOT NULL, document_rowid INTEGER NOT NULL, PRIMARY KEY(job_id,term,document_rowid));
      CREATE TABLE IF NOT EXISTS evidence_search_versions (job_id TEXT PRIMARY KEY, records INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0)`);
    if (!db.prepare('PRAGMA table_info(evidence_search_versions)').all().some(column => column.name === 'version')) db.exec('ALTER TABLE evidence_search_versions ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
    // Old rowids and completion markers cannot describe the newly empty index.
    if (legacyFts) db.exec('DELETE FROM evidence_search_terms; DELETE FROM evidence_search_versions');
    db.exec('RELEASE record_archive_schema');
  } catch (error) {
    db.exec('ROLLBACK TO record_archive_schema; RELEASE record_archive_schema');
    if (legacyFts && error instanceof Error && /no such module:\s*fts\d/i.test(error.message)) {
      throw new Error('기존 검색 색인을 전환하려면 FTS5를 지원하는 Node.js에서 한 번 실행해야 합니다. 이 DB를 사용하던 Windows Node.js로 npm run dev를 실행해주세요. 기존 케이스와 원문은 변경하지 않았습니다.', { cause: error });
    }
    throw error;
  }
}
/** Called in the same transaction as the graph/checkpoint, including empty results. */
export function archiveRecord(db: DatabaseSync, jobId: string, number: number, documents: EvidenceDocument[], extraction?: OntologyExtraction) {
  db.prepare('INSERT OR IGNORE INTO analysis_record_archive VALUES (?,?,?)').run(jobId, number, JSON.stringify({ documents, extraction } satisfies Archive));
  db.prepare('DELETE FROM evidence_search_versions WHERE job_id=?').run(jobId);
}

/** Index retained originals, including records whose first extraction found no objects. */
export function searchCaseEvidence(db: DatabaseSync, job: CaseJob, question: string, limit = 12) {
  createRecordArchive(db);
  const legacy = members(db, job).filter(member => !member.archived && member.graphId);
  const count = Number(db.prepare('SELECT count(*) AS n FROM analysis_record_archive WHERE job_id=?').get(job.id)?.n ?? 0) + legacy.length;
  const indexed = db.prepare('SELECT records,version FROM evidence_search_versions WHERE job_id=?').get(job.id);
  if (indexed?.records !== count || indexed?.version !== EVIDENCE_INDEX_VERSION) {
    db.exec('SAVEPOINT evidence_index');
    try {
      db.prepare('DELETE FROM evidence_search WHERE job_id=?').run(job.id);
      db.prepare('DELETE FROM evidence_search_terms WHERE job_id=?').run(job.id);
      const insert = db.prepare('INSERT INTO evidence_search(job_id,part_index,document_id,name,text) VALUES (?,?,?,?,?)');
      const termInsert = db.prepare('INSERT OR IGNORE INTO evidence_search_terms VALUES (?,?,?)');
      const scan = db.prepare('SELECT part_index,record_json FROM analysis_record_archive WHERE job_id=? AND part_index>? ORDER BY part_index LIMIT 16');
      let after = 0;
      while (true) {
        const rows = scan.all(job.id, after); if (!rows.length) break;
        for (const row of rows) {
          after = Number(row.part_index);
          for (const document of (JSON.parse(String(row.record_json)) as Archive).documents) {
            const written = insert.run(job.id, row.part_index, document.id, document.name, document.text);
            for (const term of indexTerms(`${document.name} ${document.text}`)) termInsert.run(job.id, term, written.lastInsertRowid);
          }
        }
      }
      for (const member of legacy) for (const document of documentsFor(db, member)) {
        const written = insert.run(job.id, member.number, document.id, document.name, document.text);
        for (const term of indexTerms(`${document.name} ${document.text}`)) termInsert.run(job.id, term, written.lastInsertRowid);
      }
      db.prepare('INSERT OR REPLACE INTO evidence_search_versions (job_id,records,version) VALUES (?,?,?)').run(job.id, count, EVIDENCE_INDEX_VERSION);
      db.exec('RELEASE evidence_index');
    } catch (error) { db.exec('ROLLBACK TO evidence_index; RELEASE evidence_index'); throw error; }
  }
  const terms = searchTerms(question);
  const tokens = [...new Set(terms.flatMap(term => indexTerms(term)))].slice(0, 120);
  const hits = tokens.length ? db.prepare(`SELECT e.part_index,e.name,e.text,count(*) AS matches FROM evidence_search_terms t JOIN evidence_search e ON e.rowid=t.document_rowid WHERE t.job_id=? AND t.term IN (${tokens.map(() => '?').join(',')}) GROUP BY e.rowid ORDER BY matches DESC,e.part_index LIMIT 80`).all(job.id, ...tokens) : [];
  const grouped = new Map<number, { number: number; score: number; excerpts: string[]; evidenceTexts: string[] }>();
  for (const hit of hits) {
    const number = Number(hit.part_index); const text = String(hit.text);
    const score = searchScore(text, terms);
    const current = grouped.get(number) ?? { number, score: 0, excerpts: [], evidenceTexts: [] };
    current.score = Math.max(current.score, score);
    const selectedPassages = relevantPassages(text, terms, 5000);
    for (const passage of selectedPassages) if (!current.evidenceTexts.includes(passage.text)) current.evidenceTexts.push(passage.text);
    const passages = selectedPassages.map(part => `${String(hit.name)} [UTF-16 ${part.start}:${part.end}]\n${part.text}`).join('\n\n');
    if (!current.excerpts.includes(passages)) current.excerpts.push(passages);
    grouped.set(number, current);
  }
  return { indexedRecords: count, hits: [...grouped.values()].sort((a, b) => b.score - a.score || a.number - b.number).slice(0, limit) };
}

function members(db: DatabaseSync, job: CaseJob): Member[] {
  const parts = hasTable(db, 'analysis_parts') ? db.prepare('SELECT part_index,graph_id FROM analysis_parts WHERE job_id=? ORDER BY part_index').all(job.id) : [];
  const archives = new Map(hasTable(db, 'analysis_record_archive') ? db.prepare("SELECT part_index,json_extract(record_json,'$.extraction.title') AS title FROM analysis_record_archive WHERE job_id=?").all(job.id).map(row => [Number(row.part_index), row.title ? String(row.title) : undefined]) : []);
  if (parts.length) return parts.map(row => ({ number: Number(row.part_index), graphId: row.graph_id ? String(row.graph_id) : undefined, archived: archives.has(Number(row.part_index)), title: archives.get(Number(row.part_index)) }));
  // Legacy non-hybrid jobs stored membership in their job payload. Titles retain part numbers.
  const ids = job.graphIds?.length ? job.graphIds : job.graphId ? [job.graphId] : [];
  const indexed = new Map<number, string>();
  ids.forEach((id, index) => {
    const row = db.prepare('SELECT title FROM graphs WHERE id=?').get(id);
    const match = / · part (\d+)\/\d+$/.exec(String(row?.title ?? ''));
    indexed.set(match ? Number(match[1]) : index + 1, id);
  });
  const total = Math.max(job.totalChunks ?? 0, ids.length, ...indexed.keys());
  return Array.from({ length: total }, (_, index) => ({ number: index + 1, graphId: indexed.get(index + 1), archived: archives.has(index + 1), title: archives.get(index + 1) }));
}
function readGraph(db: DatabaseSync, id?: string): GraphDocument | undefined {
  const row = id ? db.prepare('SELECT graph_json FROM graphs WHERE id=?').get(id) : undefined;
  return row ? JSON.parse(String(row.graph_json)) as GraphDocument : undefined;
}
function summary(member: Member, job: CaseJob, graph?: GraphDocument): AnalysisRecord {
  return { number: member.number, graphId: member.graphId, archived: member.archived,
    title: (graph?.title ?? member.title ?? `분석 기록 ${member.number}`).replace(/ · part \d+\/\d+$/, ''),
    status: graph ? 'saved' : member.number <= (job.completedChunks ?? 0) ? 'empty' : 'pending',
    nodeCount: graph?.nodes.length ?? 0, edgeCount: graph?.edges.length ?? 0 };
}

/** Read only: projects existing verified identities, without new model calls or name-based merges. */
export function buildAnalysisCase(db: DatabaseSync, job: CaseJob): AnalysisCase {
  const graph: GraphDocument = { schemaVersion: '1.0', id: `case-${job.id}`, title: job.question, question: job.question,
    summary: '', origin: 'codex', createdAt: job.createdAt, ontologyId: job.ontologyId, ontologyVersion: job.ontologyVersion,
    groups: [], sources: [], nodes: [], edges: [], events: [], findings: [], limitations: [
      '저장된 객체 식별 기준으로 기록을 연결했습니다. 이름만 같은 객체를 새로 합치거나 근거 없는 관계를 만들지 않습니다.',
      '기록의 주장·추론·상충하는 속성은 원래 근거와 함께 보존합니다. 통합은 주장의 사실 여부를 확정하지 않습니다.',
    ] };
  const result: AnalysisCase = { schemaVersion: 'case-1.0', jobId: job.id, status: job.status, updatedAt: job.updatedAt, graph, records: [], provenance: {}, conflicts: [] };
  const nodes = new Map<string, GraphDocument['nodes'][number]>();
  const groups = new Map<string, GraphDocument['groups'][number]>();
  const variants = new Map<string, Map<string, Map<string, number[]>>>();
  const addRef = (id: string, record: number, localId: string) => { (result.provenance[id] ??= []).push({ record, localId }); };
  for (const member of members(db, job)) {
    const part = readGraph(db, member.graphId);
    result.records.push(summary(member, job, part));
    if (!part) continue;
    const scope = [part.ontologyId ?? 'legacy', part.ontologyVersion ?? 0];
    const sources = new Map(part.sources.map(source => [source.id, key('source', [part.id, source.id])]));
    const sourceIds = (ids: string[]) => ids.map(id => sources.get(id)!);
    const canonical = new Map(db.prepare('SELECT node_id,entity_id FROM entity_claims WHERE graph_id=?').all(part.id).map(row => [String(row.node_id), String(row.entity_id)]));
    const ids = new Map(part.nodes.map(node => [node.id, key('object', [...scope, node.type, canonical.get(node.id) ?? `${part.id}:${node.id}`])]));
    const edges = new Map(part.edges.map(edge => [edge.id, key('link', [part.id, edge.id])]));
    for (const source of part.sources) {
      const id = sources.get(source.id)!;
      graph.sources.push({ ...source, id, title: `기록 ${member.number} · ${source.title}` }); addRef(id, member.number, source.id);
    }
    for (const node of part.nodes) {
      const id = ids.get(node.id)!;
      const groupId = key('type', [...scope, node.type]);
      const originalGroup = part.groups.find(group => group.id === node.group)!;
      if (!groups.has(groupId)) groups.set(groupId, { ...originalGroup, id: groupId, label: node.type });
      const existing = nodes.get(id);
      if (existing) existing.sourceIds = [...new Set([...existing.sourceIds, ...sourceIds(node.sourceIds)])];
      else nodes.set(id, { ...node, id, group: groupId, sourceIds: sourceIds(node.sourceIds), properties: {} });
      addRef(id, member.number, node.id);
      let properties = variants.get(id); if (!properties) variants.set(id, properties = new Map());
      for (const [property, value] of Object.entries(node.properties)) {
        let values = properties.get(property); if (!values) properties.set(property, values = new Map());
        values.set(value, [...(values.get(value) ?? []), member.number]);
      }
    }
    for (const edge of part.edges) {
      const id = edges.get(edge.id)!;
      // Keep separate assertions (including reported/inferred and dates); do not invent consensus.
      graph.edges.push({ ...edge, id, source: ids.get(edge.source)!, target: ids.get(edge.target)!, sourceIds: sourceIds(edge.sourceIds) }); addRef(id, member.number, edge.id);
    }
    for (const event of part.events) {
      const id = key('event', [part.id, event.id]);
      graph.events.push({ ...event, id, nodeIds: event.nodeIds.map(id => ids.get(id)!), sourceIds: sourceIds(event.sourceIds) }); addRef(id, member.number, event.id);
    }
    graph.findings.push(...part.findings.map(finding => ({ ...finding, text: `기록 ${member.number} · ${finding.text}`, nodeIds: finding.nodeIds.map(id => ids.get(id)!), edgeIds: finding.edgeIds?.map(id => edges.get(id)!), sourceIds: sourceIds(finding.sourceIds) })));
  }
  for (const [id, properties] of variants) for (const [property, values] of properties) {
    nodes.get(id)!.properties[property] = values.size === 1 ? [...values.keys()][0] : `서로 다른 값 ${values.size}개 · 근거 기록 확인`;
    if (values.size > 1) result.conflicts.push({ nodeId: id, property, values: [...values].map(([value, records]) => ({ value, records: [...new Set(records)] })) });
  }
  if (hasTable(db, 'claim_reviews')) {
    const reviews = new Map(db.prepare('SELECT edge_id,payload FROM claim_reviews WHERE job_id=?').all(job.id).map(row => [String(row.edge_id), JSON.parse(String(row.payload))]));
    for (const edge of graph.edges) if (reviews.has(edge.id)) edge.review = reviews.get(edge.id);
  }
  graph.nodes = [...nodes.values()]; graph.groups = [...groups.values()];
  const completed = result.records.filter(record => record.status !== 'pending').length;
  graph.summary = `${completed} / ${job.totalChunks ?? result.records.length}개 기록에서 객체 ${graph.nodes.length}개와 관계 주장 ${graph.edges.length}개를 통합했습니다. 각 항목의 근거 기록에서 원문과 구간별 판단을 확인할 수 있습니다.`;
  if (result.conflicts.length) graph.limitations.push(`서로 다른 속성 값 ${result.conflicts.length}건이 있습니다. 해당 객체를 선택하면 기록별 값을 확인할 수 있습니다.`);
  if (job.status !== 'completed') graph.limitations.push('아직 전체 분석이 완료되지 않았습니다. 현재까지 저장된 기록을 표시합니다.');
  return result;
}

function archive(db: DatabaseSync, jobId: string, number: number): Archive | undefined {
  const row = hasTable(db, 'analysis_record_archive') ? db.prepare('SELECT record_json FROM analysis_record_archive WHERE job_id=? AND part_index=?').get(jobId, number) : undefined;
  return row ? JSON.parse(String(row.record_json)) as Archive : undefined;
}
function documentsFor(db: DatabaseSync, member: Member, stored?: Archive): EvidenceDocument[] {
  if (stored) return stored.documents;
  if (!member.graphId) return [];
  return db.prepare('SELECT gd.source_id,gd.source_json,d.text FROM graph_documents gd LEFT JOIN documents d ON d.id=gd.document_id WHERE gd.graph_id=?').all(member.graphId).filter(row => typeof row.text === 'string').map(row => ({ id: String(row.source_id), name: (JSON.parse(String(row.source_json)) as { title: string }).title, text: String(row.text) }));
}
const pageDocument = (document: EvidenceDocument, offset: number): RecordDocument => ({ id: document.id, name: document.name, text: document.text.slice(offset, offset + 12000), totalChars: document.text.length, offset });
export function getAnalysisRecord(db: DatabaseSync, job: CaseJob, number: number): AnalysisRecordDetail | undefined {
  const member = members(db, job).find(item => item.number === number); if (!member) return;
  const stored = archive(db, job.id, number); const graph = readGraph(db, member.graphId);
  const limitations = [...(stored?.extraction?.limitations ?? graph?.limitations ?? [])];
  if (!stored && !graph && number <= (job.completedChunks ?? 0)) limitations.push('이전 버전에서 비어 있는 결과의 원문 연결을 보존하지 않았습니다. 이 기록의 상세 원문은 복원할 수 없습니다.');
  return { record: summary(member, job, graph), graph, summary: stored?.extraction?.summary ?? graph?.summary ?? '', limitations,
    documents: documentsFor(db, member, stored).map(document => pageDocument(document, 0)),
    claims: graph ? db.prepare('SELECT node_id,claim_json FROM entity_claims WHERE graph_id=?').all(graph.id).map(row => ({ ...JSON.parse(String(row.claim_json)), nodeId: String(row.node_id) })) : [],
    relationClaims: graph ? db.prepare('SELECT local_id,claim_json FROM relations WHERE graph_id=?').all(graph.id).map(row => ({ ...JSON.parse(String(row.claim_json)), localId: String(row.local_id) })) : [] };
}
export function getRecordDocument(db: DatabaseSync, job: CaseJob, number: number, id: string, offset: number): RecordDocument | undefined {
  const member = members(db, job).find(item => item.number === number); if (!member) return;
  const document = documentsFor(db, member, archive(db, job.id, number)).find(document => document.id === id);
  return document ? pageDocument(document, offset) : undefined;
}
