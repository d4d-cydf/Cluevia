import type { DatabaseSync } from 'node:sqlite';
import type { OntologyDefinition } from '../src/types/ontology.ts';
import { parseOntologyDefinition } from './ontology-schema.ts';

/** Keys describe the complete design input and contract, never a job identity. */
export interface OntologyDesignCache {
  get(key: string): OntologyDefinition | undefined;
  set(key: string, definition: OntologyDefinition): void;
}

/** Reuse validated domain decisions. The planner assigns each job its own ID and version.
 * Cache failures are misses: this optional optimization never prevents a fresh design. */
export class SqliteOntologyDesignCache implements OntologyDesignCache {
  private readonly db: DatabaseSync;
  private readonly maxEntries: number;
  private ready = false;

  constructor(db: DatabaseSync, options: { maxEntries?: number } = {}) {
    this.db = db;
    this.maxEntries = Number.isInteger(options.maxEntries) && Number(options.maxEntries) > 0
      ? Math.min(Number(options.maxEntries), 100) : 50;
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ontology_design_cache (
        cache_key TEXT PRIMARY KEY, definition_json TEXT NOT NULL, access_order INTEGER NOT NULL
      )`);
      this.prune();
      this.ready = true;
    } catch { /* Fresh ontology design remains available when cache storage is unavailable. */ }
  }

  get(key: string): OntologyDefinition | undefined {
    if (!this.ready) return undefined;
    try {
      const row = this.db.prepare('SELECT definition_json FROM ontology_design_cache WHERE cache_key=?').get(key);
      if (!row) return undefined;
      // Parse again on every read. Corrupt/stale contracts never enter a job, and callers
      // cannot mutate a shared object or affect the next job's reused definition.
      const definition = parseOntologyDefinition(JSON.parse(String(row.definition_json)));
      this.db.prepare('UPDATE ontology_design_cache SET access_order=(SELECT COALESCE(MAX(access_order),0)+1 FROM ontology_design_cache) WHERE cache_key=?').run(key);
      return definition;
    } catch {
      try { this.db.prepare('DELETE FROM ontology_design_cache WHERE cache_key=?').run(key); } catch { /* Best effort. */ }
      return undefined;
    }
  }

  set(key: string, definition: OntologyDefinition): void {
    if (!this.ready) return;
    try {
      const checked = parseOntologyDefinition(definition);
      this.db.prepare(`INSERT INTO ontology_design_cache(cache_key,definition_json,access_order)
        VALUES (?, ?, (SELECT COALESCE(MAX(access_order),0)+1 FROM ontology_design_cache))
        ON CONFLICT(cache_key) DO UPDATE SET definition_json=excluded.definition_json,access_order=excluded.access_order
      `).run(key, JSON.stringify(checked));
      this.prune();
    } catch { /* Validation or storage failure cannot invalidate the current analysis. */ }
  }

  private prune(): void {
    this.db.prepare(`DELETE FROM ontology_design_cache WHERE cache_key IN (
      SELECT cache_key FROM ontology_design_cache ORDER BY access_order DESC,rowid DESC LIMIT -1 OFFSET ?
    )`).run(this.maxEntries);
  }
}
