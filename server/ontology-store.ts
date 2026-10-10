import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GRAPH_LIMITS, parseGraphDocument } from '../src/lib/graph-document.ts';
import type { EvidenceDocument, GraphDocument } from '../src/types/graph.ts';
import type { EntityType, OntologyEntityDetail, OntologyEntitySummary, OntologyEvidence, OntologyExtraction, OntologySummary, OntologyIdentifier, OntologyRelationship, OntologyDefinition, JsonValue } from '../src/types/ontology.ts';
import { parseOntologyDefinition, typedValuesFor } from './ontology-schema.ts';
import { coarseEntityType, compileExtraction, ONTOLOGY_ENTITY_TYPES, parseExtraction, strongIdentifier } from './ontology.ts';

interface EntityRow { id: string; label: string; type: EntityType; description: string; updated_at: string; case_count?: number }
interface SourceRow { id: string; title: string; text: string; url: string | null; created_at: string }
export interface StoredGraphSummary { id: string; title: string; question: string; summary: string; origin: GraphDocument['origin']; createdAt: string; nodeCount: number; edgeCount: number; eventCount: number }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizeContent = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
const normalizeLabel = (label: string) => label.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** A single local database; graph and ontology changes always commit together. */
export class OntologyStore {
  readonly db: DatabaseSync;
  constructor(databasePath = '.cluevia/ontology.sqlite') {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS graphs (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, question TEXT NOT NULL, summary TEXT NOT NULL,
        origin TEXT NOT NULL, created_at TEXT NOT NULL, node_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL, event_count INTEGER NOT NULL, graph_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        text TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_documents (
        graph_id TEXT NOT NULL REFERENCES graphs(id), source_id TEXT NOT NULL,
        document_id TEXT REFERENCES documents(id), source_json TEXT NOT NULL,
        PRIMARY KEY(graph_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
        description TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_keys (
        identity_key TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id)
      );
      CREATE TABLE IF NOT EXISTS ambiguous_entity_keys (identity_key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS entity_claims (
        graph_id TEXT NOT NULL REFERENCES graphs(id), node_id TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id), claim_json TEXT NOT NULL,
        PRIMARY KEY(graph_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS claims_entity ON entity_claims(entity_id);
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id),
        local_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES entities(id),
        target_id TEXT NOT NULL REFERENCES entities(id), type TEXT NOT NULL,
        status TEXT NOT NULL, claim_json TEXT NOT NULL, UNIQUE(graph_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS relations_source ON relations(source_id);
      CREATE INDEX IF NOT EXISTS relations_target ON relations(target_id);
      CREATE TABLE IF NOT EXISTS ontology_definitions (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, job_id TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL, definition_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_ontologies (
        graph_id TEXT PRIMARY KEY REFERENCES graphs(id), ontology_id TEXT NOT NULL REFERENCES ontology_definitions(id), version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS graph_ontology_scope ON graph_ontologies(ontology_id,version);
      CREATE TABLE IF NOT EXISTS ontology_definition_history (
        id TEXT NOT NULL, version INTEGER NOT NULL, job_id TEXT NOT NULL,
        archived_at TEXT NOT NULL, definition_json TEXT NOT NULL,
        PRIMARY KEY(id,version)
      );
      CREATE TABLE IF NOT EXISTS entity_identifier_index (entity_id TEXT NOT NULL, namespace TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(entity_id,namespace,value));
      CREATE INDEX IF NOT EXISTS entity_identifier_lookup ON entity_identifier_index(namespace,value);
      CREATE TABLE IF NOT EXISTS entity_identity_links (left_id TEXT NOT NULL, right_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(left_id,right_id));
      CREATE TABLE IF NOT EXISTS entity_identity_history (left_id TEXT NOT NULL, right_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close(): void { this.db.close(); }

  saveDefinition(definition: OntologyDefinition, jobId: string): OntologyDefinition {
    const checked = parseOntologyDefinition(definition);
    const previous = this.getDefinitionForJob(jobId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(checked)) throw new Error('이미 사용 중인 온톨로지 정의는 변경할 수 없습니다. 새 분석으로 생성해주세요.');
      return previous;
    }
    this.db.prepare('INSERT INTO ontology_definitions VALUES (?,?,?,?,?)').run(checked.id, checked.version, jobId, new Date().toISOString(), JSON.stringify(checked));
    return checked;
  }
  /** A failed zero-progress design may be corrected; definitions used by graphs stay immutable. */
  replaceUnusedDefinition(definition: OntologyDefinition, jobId: string, onReplaced: () => void): void {
    const checked = parseOntologyDefinition(definition);
    this.transaction(() => {
      const previous = this.getDefinitionForJob(jobId);
      if (!previous || previous.id !== checked.id || checked.version !== previous.version + 1) throw new Error('수정할 온톨로지 버전이 일치하지 않습니다.');
      if (this.db.prepare('SELECT graph_id FROM graph_ontologies WHERE ontology_id=? LIMIT 1').get(previous.id)) throw new Error('저장된 그래프가 사용하는 온톨로지는 다시 설계할 수 없습니다.');
      this.db.prepare('INSERT INTO ontology_definition_history VALUES (?,?,?,?,?)').run(previous.id, previous.version, jobId, new Date().toISOString(), JSON.stringify(previous));
      this.db.prepare('UPDATE ontology_definitions SET version=?,definition_json=? WHERE id=? AND job_id=?').run(checked.version, JSON.stringify(checked), checked.id, jobId);
      onReplaced();
    });
  }
  getDefinition(id: string): OntologyDefinition | undefined {
    const row = this.db.prepare('SELECT definition_json FROM ontology_definitions WHERE id=?').get(id);
    return row ? parseOntologyDefinition(json(row.definition_json)) : undefined;
  }
  getDefinitionForJob(jobId: string): OntologyDefinition | undefined {
    const row = this.db.prepare('SELECT definition_json FROM ontology_definitions WHERE job_id=?').get(jobId);
    return row ? parseOntologyDefinition(json(row.definition_json)) : undefined;
  }
  listDefinitions(): OntologyDefinition[] {
    return this.db.prepare('SELECT definition_json FROM ontology_definitions ORDER BY created_at DESC,rowid DESC LIMIT 100').all().map(row => parseOntologyDefinition(json(row.definition_json)));
  }

  seedGfw(graph: GraphDocument, sourceText: string): void {
    if (this.db.prepare('SELECT value FROM store_metadata WHERE key = ?').get('seed:gfw-galapagos:v1')) return;
    const documents = graph.sources.map(source => ({ id: source.id, name: `${source.title} — 공개 사례 요약`, text: sourceText, ...(source.url ? { url: source.url } : {}) }));
    this.transaction(() => {
      this.insertGraph(parseGraphDocument(graph), documents);
      this.db.prepare('INSERT INTO store_metadata(key,value) VALUES (?,?)').run('seed:gfw-galapagos:v1', new Date().toISOString());
    });
  }

  saveGraph(graph: GraphDocument, documents: EvidenceDocument[] = [], extraction?: OntologyExtraction, onSaved?: (graph: GraphDocument) => void): GraphDocument {
    const parsed = parseGraphDocument({ ...graph, id: `graph-${randomUUID()}` });
    const definition = parsed.ontologyId ? this.getDefinition(parsed.ontologyId) : undefined;
    if (parsed.ontologyId && (!definition || definition.version !== parsed.ontologyVersion || !extraction)) throw new Error('그래프의 온톨로지 정의·버전·검증된 추출 결과가 필요합니다.');
    let checked: OntologyExtraction | undefined;
    if (extraction) checked = parseExtraction(extraction, { question: parsed.question, documents }, definition);
    // Structured records are parsed locally and can contain very large cells. The model input
    // limits do not apply to their retained raw evidence; the rendered graph still has all limits.
    const structured = parsed.origin === 'structured';
    if (documents.length > GRAPH_LIMITS.sources || documents.some(doc => !doc.id || !doc.name || typeof doc.text !== 'string' || (!structured && doc.text.length > GRAPH_LIMITS.documentChars)) || (!structured && documents.reduce((sum, doc) => sum + doc.text.length, 0) > GRAPH_LIMITS.totalDocumentChars)) throw new Error('저장할 자료의 크기가 허용 범위를 초과했습니다.');
    if (new Set(documents.map(doc => doc.id)).size !== documents.length) throw new Error('중복 자료 ID는 저장할 수 없습니다.');
    if (checked) {
      const compiled = compileExtraction(checked, { question: parsed.question, documents }, definition);
      if ((['nodes', 'edges', 'events', 'findings'] as const).some(field => JSON.stringify(compiled[field]) !== JSON.stringify(parsed[field]))) throw new Error('추출 결과와 그래프가 일치하지 않습니다.');
    }
    this.transaction(() => { this.insertGraph(parsed, documents, checked, definition); onSaved?.(parsed); });
    return parsed;
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private insertGraph(graph: GraphDocument, documents: EvidenceDocument[], extraction?: OntologyExtraction, definition?: OntologyDefinition): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO graphs VALUES (?,?,?,?,?,?,?,?,?,?)').run(graph.id, graph.title, graph.question, graph.summary, graph.origin, graph.createdAt, graph.nodes.length, graph.edges.length, graph.events.length, JSON.stringify(graph));
    if (definition) this.db.prepare('INSERT INTO graph_ontologies VALUES (?,?,?)').run(graph.id, definition.id, definition.version);
    const supplied = new Map(documents.map(document => [document.id, document]));
    const sourceKeys = new Map<string, string[]>();
    const sourceDocumentIds = new Map<string, string>();
    for (const source of graph.sources) {
      const document = supplied.get(source.id);
      let documentId: string | null = null;
      if (document?.text.trim()) {
        const fingerprint = hash(document.text);
        documentId = `ctx-${fingerprint.slice(0, 32)}`;
        this.db.prepare('INSERT OR IGNORE INTO documents VALUES (?,?,?,?,?,?)').run(documentId, fingerprint, document.name, document.text, document.url ?? source.url ?? null, now);
        sourceKeys.set(source.id, [hash(normalizeContent(document.text)), ...(document.identityScope ? [`scope-${hash(document.identityScope)}`] : [])]); sourceDocumentIds.set(source.id, documentId);
      }
      this.db.prepare('INSERT INTO graph_documents VALUES (?,?,?,?)').run(graph.id, source.id, documentId, JSON.stringify(source));
    }
    const toPersistedEvidence = (items: OntologyEvidence[]): OntologyEvidence[] => items.map(item => {
      const source = supplied.get(item.documentId); const positions: number[] = [];
      if (source) for (let position = source.text.indexOf(item.quote); position >= 0 && positions.length < 32; position = source.text.indexOf(item.quote, position + 1)) positions.push(position);
      return { documentId: sourceDocumentIds.get(item.documentId) ?? item.documentId, quote: item.quote, sourceId: item.documentId, spans: positions.map(start => ({ start, end: start + item.quote.length })), offsetUnit: 'utf16', textHash: source ? hash(source.text) : undefined, ambiguous: positions.length !== 1 };
    });
    const nodeIds = new Map<string, string>();
    for (const node of graph.nodes) {
      const extracted = extraction?.entities.find(entity => entity.id === node.id);
      const type = extracted?.type ?? coarseEntityType(node.type, node.group);
      const verifiedIdentifiers = extracted?.identifiers.filter(identifier => strongIdentifier(identifier, extracted.evidence)) ?? [];
      const typedProperties = definition && extracted ? typedValuesFor(extracted, definition) : undefined;
      const objectType = definition?.objectTypes.find(item => item.apiName === type);
      const primaryKey = objectType?.primaryKey;
      const families = extracted ? [...new Set(extracted.evidence.map(item => supplied.get(item.documentId)?.identityScope ?? item.documentId))].sort() : [];
      const identityScope = objectType?.identityScope === 'source' ? `source-${hash(JSON.stringify(families))}` : 'ontology';
      if (definition && (!typedProperties || !primaryKey || !Object.hasOwn(typedProperties, primaryKey))) throw new Error('객체의 Primary Key 값이 없습니다.');
      const identifierKeys = definition && typedProperties && primaryKey
        ? [`${definition.id}|v${definition.version}|${type}|${identityScope}|pk|${JSON.stringify(typedProperties[primaryKey])}`]
        : verifiedIdentifiers.map(identifier => `${type}|id|${strongIdentifier(identifier, extracted!.evidence)}`);
      // Exact source content plus type and name is a deliberately conservative fallback.
      const fingerprintKeys = definition ? [] : node.sourceIds.flatMap(sourceId => (sourceKeys.get(sourceId) ?? []).map(key => `${type}|source|${key}|${normalizeLabel(node.label)}`)).filter(key => !this.db.prepare('SELECT identity_key FROM ambiguous_entity_keys WHERE identity_key=?').get(key));
      const keys = [...new Set([...identifierKeys, ...fingerprintKeys])];
      const lookup = this.db.prepare('SELECT entity_id FROM entity_keys WHERE identity_key = ?');
      const candidates = new Set(keys.flatMap(key => { const row = lookup.get(key); return row ? [String(row.entity_id)] : []; }));
      const markSourceKeysAmbiguous = () => {
        for (const key of fingerprintKeys) {
          this.db.prepare('DELETE FROM entity_keys WHERE identity_key=?').run(key);
          this.db.prepare('INSERT OR IGNORE INTO ambiguous_entity_keys VALUES (?)').run(key);
        }
      };
      // Conflicting identities are kept separate; never combine two existing entities automatically.
      const identityConflict = candidates.size > 1;
      if (identityConflict) markSourceKeysAmbiguous();
      const existingId = candidates.size === 1 ? [...candidates][0] : undefined;
      let entityId = existingId ?? `entity-${randomUUID()}`;
      // Separate IDs in one extraction with the same name are not evidence of one identity.
      if (existingId && !identifierKeys.length && [...nodeIds.values()].includes(existingId)) {
        entityId = `entity-${randomUUID()}`;
        markSourceKeysAmbiguous();
      }
      if (existingId && identifierKeys.length) {
        const existingKeys = this.db.prepare("SELECT identity_key FROM entity_keys WHERE entity_id = ? AND identity_key LIKE '%|id|%'").all(existingId).map(row => String(row.identity_key));
        const conflict = identifierKeys.some(key => existingKeys.some(other => key.slice(0, key.lastIndexOf(':')) === other.slice(0, other.lastIndexOf(':')) && key !== other));
        if (conflict) { entityId = `entity-${randomUUID()}`; markSourceKeysAmbiguous(); }
      }
      if (entityId !== existingId) this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(entityId, type, node.label, node.description, now, now);
      else this.db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?').run(now, entityId);
      for (const key of keys) {
        if (identityConflict || this.db.prepare('SELECT identity_key FROM ambiguous_entity_keys WHERE identity_key=?').get(key)) continue;
        this.db.prepare('INSERT OR IGNORE INTO entity_keys VALUES (?,?)').run(key, entityId);
      }
      const indexIdentifier = this.db.prepare('INSERT OR IGNORE INTO entity_identifier_index VALUES (?,?,?)');
      for (const identifier of extracted?.identifiers ?? []) indexIdentifier.run(entityId, identifier.namespace.normalize('NFKC').trim().toLowerCase(), identifier.value);
      if (definition && objectType?.identityScope === 'ontology' && primaryKey && !/name|title|label/i.test(primaryKey) && objectType.properties.find(property => property.apiName === primaryKey)?.valueSource !== 'evidenceId') indexIdentifier.run(entityId, `${type}:${primaryKey}`, JSON.stringify(typedProperties![primaryKey]));
      nodeIds.set(node.id, entityId);
      this.db.prepare('INSERT INTO entity_claims VALUES (?,?,?,?)').run(graph.id, node.id, entityId, JSON.stringify({
        label: node.label, description: node.description, properties: node.properties, sourceIds: node.sourceIds,
        ...(definition ? { ontologyId: definition.id, ontologyVersion: definition.version, typedProperties } : {}),
        identifiers: verifiedIdentifiers, evidence: toPersistedEvidence(extracted?.evidence ?? []), identityConflict: identityConflict || (!!existingId && existingId !== entityId),
      }));
    }
    for (const edge of graph.edges) {
      const extracted = extraction?.relationships.find(relation => relation.id === edge.id);
      if (definition && extracted && (!extracted.claim || (extracted.claim.stance === 'asserted' && !extracted.claim.validFrom && !extracted.claim.validTo))) {
        const link = definition.linkTypes.find(link => link.apiName === extracted.type)!;
        const scope = [definition.id, definition.version, extracted.type];
        const source = nodeIds.get(edge.source)!; const target = nodeIds.get(edge.target)!;
        const conflict = (own: 'source_id' | 'target_id', other: 'source_id' | 'target_id', ownId: string, otherId: string) =>
          this.db.prepare(`SELECT r.id FROM relations r JOIN graph_ontologies g ON g.graph_id=r.graph_id WHERE g.ontology_id=? AND g.version=? AND r.type=? AND (json_extract(r.claim_json,'$.claim.stance') IS NULL OR json_extract(r.claim_json,'$.claim.stance')='asserted') AND json_extract(r.claim_json,'$.claim.validFrom') IS NULL AND json_extract(r.claim_json,'$.claim.validTo') IS NULL AND r.${own}=? AND r.${other}<>? LIMIT 1`).get(...scope, ownId, otherId);
        if ((link.targetCardinality === 'one' && conflict('source_id', 'target_id', source, target)) || (link.sourceCardinality === 'one' && conflict('target_id', 'source_id', target, source))) throw new Error(`관계 ${link.apiName}의 cardinality가 이전에 저장된 객체와 충돌합니다. 근거와 스키마를 확인해주세요.`);
      }
      this.db.prepare('INSERT INTO relations VALUES (?,?,?,?,?,?,?,?)').run(`relation-${randomUUID()}`, graph.id, edge.id, nodeIds.get(edge.source)!, nodeIds.get(edge.target)!, extracted?.type ?? 'associated_with', edge.status, JSON.stringify({ label: edge.label, description: edge.description, ...(edge.claim ? { claim: edge.claim } : {}), sourceIds: edge.sourceIds, evidence: toPersistedEvidence(extracted?.evidence ?? []) }));
    }
  }

  getGraph(id: string): GraphDocument | undefined {
    const row = this.db.prepare('SELECT graph_json FROM graphs WHERE id = ?').get(id);
    return row ? parseGraphDocument(json(row.graph_json)) : undefined;
  }

  listGraphs(): StoredGraphSummary[] {
    return this.db.prepare('SELECT id,title,question,summary,origin,created_at,node_count,edge_count,event_count FROM graphs ORDER BY created_at DESC, rowid DESC LIMIT 100').all().map(row => ({
      id: String(row.id), title: String(row.title), question: String(row.question), summary: String(row.summary), origin: row.origin as GraphDocument['origin'], createdAt: String(row.created_at), nodeCount: Number(row.node_count), edgeCount: Number(row.edge_count), eventCount: Number(row.event_count),
    }));
  }

  summary(): OntologySummary {
    const count = (table: 'entities' | 'relations' | 'documents' | 'graphs') => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    const types = this.db.prepare('SELECT type,COUNT(*) AS count FROM entities GROUP BY type').all();
    return { entities: count('entities'), relationships: count('relations'), documents: count('documents'), graphs: count('graphs'), types: [...new Set([...ONTOLOGY_ENTITY_TYPES.map(type => type.id), ...types.map(row => String(row.type))])].map(type => ({ type, count: Number(types.find(row => row.type === type)?.count ?? 0) })) };
  }

  private entitySummary(row: EntityRow): OntologyEntitySummary { return { id: row.id, label: row.label, type: row.type, description: row.description, caseCount: Number(row.case_count ?? 0), updatedAt: row.updated_at }; }

  listEntities(query = '', type?: string, ontologyId?: string): OntologyEntitySummary[] {
    const needle = `%${query.slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`;
    return (this.db.prepare(`SELECT e.*, COUNT(DISTINCT c.graph_id) AS case_count FROM entities e LEFT JOIN entity_claims c ON c.entity_id = e.id
      WHERE (e.label LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\') AND (? = '' OR e.type = ?) AND (? = '' OR EXISTS (SELECT 1 FROM graph_ontologies go WHERE go.graph_id=c.graph_id AND go.ontology_id=?))
      GROUP BY e.id ORDER BY e.updated_at DESC,e.label LIMIT 200`).all(needle, needle, type ?? '', type ?? '', ontologyId ?? '', ontologyId ?? '') as unknown as EntityRow[]).map(row => this.entitySummary(row));
  }

  getEntity(id: string): OntologyEntityDetail | undefined {
    const row = this.db.prepare('SELECT e.*,COUNT(DISTINCT c.graph_id) AS case_count FROM entities e LEFT JOIN entity_claims c ON c.entity_id=e.id WHERE e.id=? GROUP BY e.id').get(id) as unknown as EntityRow | undefined;
    if (!row) return undefined;
    const identifiers = new Map<string, OntologyIdentifier>();
    const claims = this.db.prepare('SELECT c.*,g.title,g.created_at FROM entity_claims c JOIN graphs g ON g.id=c.graph_id WHERE c.entity_id=? ORDER BY g.created_at DESC').all(id).map(claim => {
      const data = json<{ label: string; description: string; properties: Record<string, string>; sourceIds: string[]; evidence: OntologyEvidence[]; identifiers: OntologyIdentifier[]; typedProperties?: Record<string, JsonValue>; ontologyId?: string; ontologyVersion?: number }>(claim.claim_json);
      for (const identifier of data.identifiers) identifiers.set(`${identifier.namespace}:${identifier.value}`, identifier);
      return { ...(data.ontologyId ? { ontologyId: data.ontologyId, ontologyVersion: data.ontologyVersion, typedProperties: data.typedProperties } : {}), graphId: String(claim.graph_id), graphTitle: String(claim.title), nodeId: String(claim.node_id), label: data.label, description: data.description, properties: data.properties, sourceIds: data.sourceIds, evidence: data.evidence, createdAt: String(claim.created_at) };
    });
    const relationships = this.db.prepare(`SELECT r.*,s.label AS source_label,t.label AS target_label FROM relations r JOIN entities s ON r.source_id=s.id JOIN entities t ON r.target_id=t.id WHERE r.source_id=? OR r.target_id=? ORDER BY r.rowid DESC LIMIT 500`).all(id, id).map(relation => {
      const data = json<{ label: string; description: string; evidence: OntologyEvidence[] }>(relation.claim_json);
      return { id: String(relation.id), graphId: String(relation.graph_id), source: String(relation.source_id), target: String(relation.target_id), type: relation.type, status: relation.status, label: data.label, description: data.description, sourceLabel: String(relation.source_label), targetLabel: String(relation.target_label), evidence: data.evidence } as OntologyRelationship;
    });
    return { ...this.entitySummary(row), identifiers: [...identifiers.values()], claims, relationships, identityCandidates: this.identityCandidates(id) };
  }

  identityCandidates(id: string) {
    // Backfill identifier evidence from older cases. No names are used as identity keys.
    this.db.prepare(`INSERT OR IGNORE INTO entity_identifier_index SELECT c.entity_id,lower(json_extract(j.value,'$.namespace')),json_extract(j.value,'$.value') FROM entity_claims c,json_each(c.claim_json,'$.identifiers') j WHERE c.entity_id=?`).run(id);
    if (!this.db.prepare("SELECT value FROM store_metadata WHERE key='identity-index-v1'").get()) {
      this.db.exec(`INSERT OR IGNORE INTO entity_identifier_index SELECT c.entity_id,lower(json_extract(j.value,'$.namespace')),json_extract(j.value,'$.value') FROM entity_claims c,json_each(c.claim_json,'$.identifiers') j; INSERT OR REPLACE INTO store_metadata VALUES ('identity-index-v1','ready')`);
    }
    const rows = this.db.prepare(`SELECT DISTINCT e.id,e.label,e.type,other.namespace,other.value FROM entity_identifier_index own JOIN entity_identifier_index other ON own.namespace=other.namespace AND own.value=other.value JOIN entities e ON e.id=other.entity_id WHERE own.entity_id=? AND other.entity_id<>? LIMIT 50`).all(id, id);
    const candidates = new Map<string, { id: string; label: string; type: string; reasons: string[]; status: string; note: string }>();
    for (const row of rows) {
      const pair = [id, String(row.id)].sort();
      const review = this.db.prepare('SELECT status,note FROM entity_identity_links WHERE left_id=? AND right_id=?').get(...pair);
      const candidate = candidates.get(String(row.id)) ?? { id: String(row.id), label: String(row.label), type: String(row.type), reasons: [], status: String(review?.status ?? 'unreviewed'), note: String(review?.note ?? '') };
      candidate.reasons.push(`${row.namespace}: ${row.value}`); candidates.set(candidate.id, candidate);
    }
    return [...candidates.values()];
  }
  reviewIdentity(left: string, right: string, status: string, note: string) {
    if (left === right || !['linked', 'rejected', 'unreviewed'].includes(status) || note.length > 2000 || (status !== 'unreviewed' && !note.trim())) throw new Error('동일 객체 검토 요청이 올바르지 않습니다.');
    if (!this.identityCandidates(left).some(candidate => candidate.id === right)) throw new Error('식별자 근거가 일치하는 후보만 검토할 수 있습니다.');
    const pair = [left, right].sort(); const values = [...pair, status, note, new Date().toISOString()];
    this.transaction(() => { this.db.prepare('INSERT OR REPLACE INTO entity_identity_links VALUES (?,?,?,?,?)').run(...values); this.db.prepare('INSERT INTO entity_identity_history VALUES (?,?,?,?,?)').run(...values); });
    return this.identityCandidates(left);
  }

  /** Retrieves stored original text, not generated claims, so new extraction can re-check quotations. */
  searchContext(question: string): { documents: EvidenceDocument[]; entities: OntologyEntitySummary[] } {
    const terms = [...new Set(question.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 30);
    const normalizedQuestion = normalizeLabel(question);
    const candidates = this.listEntities();
    // A translated label or Korean postposition may have no literal token match in the original article.
    const directlyMatched = candidates.filter(entity => normalizedQuestion.includes(normalizeLabel(entity.label)));
    const matchingDocumentIds = new Set<string>();
    const documentsForEntity = this.db.prepare(`SELECT DISTINCT d.document_id FROM entity_claims c
      JOIN graph_documents d ON d.graph_id = c.graph_id
      WHERE c.entity_id = ? AND d.document_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(c.claim_json, '$.sourceIds') source WHERE source.value = d.source_id)
      ORDER BY c.rowid DESC LIMIT 100`);
    for (const entity of directlyMatched.slice(0, 30)) {
      for (const document of documentsForEntity.all(entity.id)) {
        if (matchingDocumentIds.size >= 100) break;
        matchingDocumentIds.add(String(document.document_id));
      }
    }
    const rows = this.db.prepare('SELECT * FROM documents ORDER BY created_at DESC,rowid DESC LIMIT 500').all() as unknown as SourceRow[];
    const byId = new Map(rows.map(row => [row.id, row]));
    // Include provenanced documents even when they have fallen outside the recent-document window.
    for (const documentId of matchingDocumentIds) {
      if (byId.has(documentId)) continue;
      const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as unknown as SourceRow | undefined;
      if (row) byId.set(documentId, row);
    }
    const ranked = [...byId.values()].map(row => ({ row, score: (matchingDocumentIds.has(row.id) ? 200 : 0) + terms.reduce((score, term) => score + (row.title.toLocaleLowerCase('en-US').includes(term) ? 5 : 0) + (row.text.toLocaleLowerCase('en-US').includes(term) ? 1 : 0), 0) })).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score);
    const documents: EvidenceDocument[] = []; let remaining: number = GRAPH_LIMITS.totalDocumentChars;
    for (const { row } of ranked) {
      if (documents.length >= GRAPH_LIMITS.documents || remaining < 100) break;
      const text = row.text.slice(0, Math.min(GRAPH_LIMITS.documentChars, remaining)); remaining -= text.length;
      documents.push({ id: row.id, name: row.title, text, ...(row.url ? { url: row.url } : {}) });
    }
    const entities = [...new Map([...directlyMatched, ...candidates.filter(entity => terms.some(term => `${entity.label} ${entity.description}`.toLocaleLowerCase('en-US').includes(term)))].map(entity => [entity.id, entity])).values()].slice(0, 30);
    return { documents, entities };
  }
}
