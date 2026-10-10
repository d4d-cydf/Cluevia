import type { DatabaseSync } from 'node:sqlite';
import { strongIdentifier } from './ontology.ts';
import type { OntologyEvidence, OntologyIdentifier } from '../src/types/ontology.ts';

const exists = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function graphIds(db: DatabaseSync, jobId: string): string[] {
  const row = db.prepare('SELECT payload FROM generation_jobs WHERE id=?').get(jobId);
  const job = row ? JSON.parse(String(row.payload)) as { graphIds?: string[]; graphId?: string } : {};
  const parts = exists(db, 'analysis_parts') ? db.prepare('SELECT graph_id FROM analysis_parts WHERE job_id=? AND graph_id IS NOT NULL').all(jobId).map(row => String(row.graph_id)) : [];
  return [...new Set([...parts, ...(job.graphIds ?? []), ...(job.graphId ? [job.graphId] : [])])];
}
export function jobForGraph(db: DatabaseSync, graphId: string): string | undefined {
  const member = exists(db, 'analysis_parts') ? db.prepare('SELECT job_id FROM analysis_parts WHERE graph_id=? LIMIT 1').get(graphId) : undefined;
  if (member) return String(member.job_id);
  const row = db.prepare("SELECT id FROM generation_jobs WHERE json_extract(payload,'$.graphId')=? OR EXISTS (SELECT 1 FROM json_each(payload,'$.graphIds') WHERE value=?) LIMIT 1").get(graphId, graphId);
  return row ? String(row.id) : undefined;
}
function removeGraphs(db: DatabaseSync, ids: string[]) {
  const entities = new Set<string>(); const documents = new Set<string>();
  for (const id of ids) {
    db.prepare('SELECT entity_id FROM entity_claims WHERE graph_id=?').all(id).forEach(row => entities.add(String(row.entity_id)));
    db.prepare('SELECT document_id FROM graph_documents WHERE graph_id=? AND document_id IS NOT NULL').all(id).forEach(row => documents.add(String(row.document_id)));
    for (const table of ['graph_ontologies', 'relations', 'entity_claims', 'graph_documents']) db.prepare(`DELETE FROM ${table} WHERE graph_id=?`).run(id);
    db.prepare('DELETE FROM graphs WHERE id=?').run(id);
  }
  // Shared objects/documents must not keep a deleted case's display description or
  // identifier aliases when another case only supports a different claim.
  for (const id of entities) {
    const remaining = db.prepare('SELECT claim_json FROM entity_claims WHERE entity_id=? ORDER BY rowid').all(id).map(row => JSON.parse(String(row.claim_json)) as { label: string; description: string; ontologyId?: string; identifiers: OntologyIdentifier[]; evidence: OntologyEvidence[] });
    if (!remaining.length) continue;
    db.prepare('UPDATE entities SET label=?,description=? WHERE id=?').run(remaining[0].label, remaining[0].description, id);
    if (exists(db, 'entity_identifier_index')) {
      db.prepare('DELETE FROM entity_identifier_index WHERE entity_id=?').run(id);
      const insert = db.prepare('INSERT OR IGNORE INTO entity_identifier_index VALUES (?,?,?)');
      for (const claim of remaining) for (const identifier of claim.identifiers) insert.run(id, identifier.namespace.normalize('NFKC').trim().toLowerCase(), identifier.value);
    }
    const type = String(db.prepare('SELECT type FROM entities WHERE id=?').get(id)!.type);
    const keys = new Set(remaining.flatMap(claim => claim.identifiers.flatMap(identifier => { const value = strongIdentifier(identifier, claim.evidence); return value ? [`${type}|id|${value}`] : []; })));
    for (const row of db.prepare('SELECT identity_key FROM entity_keys WHERE entity_id=?').all(id)) {
      const value = String(row.identity_key);
      if (value.includes('|id|') && !keys.has(value)) db.prepare('DELETE FROM entity_keys WHERE identity_key=?').run(value);
    }
  }
  for (const id of documents) {
    const row = db.prepare('SELECT source_json FROM graph_documents WHERE document_id=? ORDER BY rowid LIMIT 1').get(id);
    if (row) { const source = JSON.parse(String(row.source_json)) as { title: string; url?: string }; db.prepare('UPDATE documents SET title=?,url=? WHERE id=?').run(source.title, source.url ?? null, id); }
  }
  db.exec(`DELETE FROM entity_keys WHERE entity_id IN (SELECT id FROM entities WHERE NOT EXISTS (SELECT 1 FROM entity_claims WHERE entity_id=entities.id));
    DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM entity_claims WHERE entity_id=entities.id);
    DELETE FROM documents WHERE NOT EXISTS (SELECT 1 FROM graph_documents WHERE document_id=documents.id);`);
  // These caches predate per-case ownership. Purge derived cached content so deleted
  // quotations cannot be restored from an unowned cache. Other cases' records stay intact.
  for (const table of ['extraction_cache', 'jev_decision_cache']) if (exists(db, table)) db.exec(`DELETE FROM ${table}`);
}
export function deleteStoredCase(db: DatabaseSync, jobId: string): string[] {
  const row = db.prepare('SELECT input_json FROM generation_jobs WHERE id=?').get(jobId);
  if (!row) return [];
  const ids = graphIds(db, jobId);
  const input = row.input_json ? JSON.parse(String(row.input_json)) as { uploadIds?: string[] } : {};
  db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  try {
    for (const table of ['analysis_parts', 'analysis_plans', 'analysis_decisions', 'analysis_record_archive', 'evidence_search_terms', 'evidence_search', 'evidence_search_versions', 'claim_reviews', 'claim_review_history', 'case_chat_turns']) if (exists(db, table)) db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(jobId);
    db.prepare('DELETE FROM generation_jobs WHERE id=?').run(jobId);
    const removable = ids.filter(id => !jobForGraph(db, id));
    removeGraphs(db, removable);
    for (const table of ['entity_identifier_index']) if (exists(db, table)) db.prepare(`DELETE FROM ${table} WHERE entity_id NOT IN (SELECT id FROM entities)`).run();
    for (const table of ['entity_identity_links', 'entity_identity_history']) if (exists(db, table)) db.prepare(`DELETE FROM ${table} WHERE left_id NOT IN (SELECT id FROM entities) OR right_id NOT IN (SELECT id FROM entities)`).run();

    db.prepare('DELETE FROM ontology_definition_history WHERE job_id=? AND NOT EXISTS (SELECT 1 FROM graph_ontologies WHERE ontology_id=ontology_definition_history.id AND version=ontology_definition_history.version)').run(jobId);
    db.prepare('DELETE FROM ontology_definitions WHERE job_id=? AND NOT EXISTS (SELECT 1 FROM graph_ontologies WHERE ontology_id=ontology_definitions.id)').run(jobId);
    for (const id of input.uploadIds ?? []) {
      const used = db.prepare("SELECT 1 FROM generation_jobs WHERE EXISTS (SELECT 1 FROM json_each(input_json,'$.uploadIds') WHERE value=?) LIMIT 1").get(id);
      if (!used && exists(db, 'evidence_uploads')) db.prepare('DELETE FROM evidence_uploads WHERE id=?').run(id);
    }
    db.exec('COMMIT'); return removable;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function deleteStandaloneGraph(db: DatabaseSync, id: string): boolean {
  if (!db.prepare('SELECT 1 FROM graphs WHERE id=?').get(id)) return false;
  if (jobForGraph(db, id)) throw new Error('분석에 속한 그래프는 해당 케이스에서 삭제해주세요.');
  db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
  try { removeGraphs(db, [id]); db.exec('COMMIT'); return true; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
