import { randomId } from '../lib/random-id';
import { GRAPH_LIMITS, parseGraphDocument, parseGraphText } from '../lib/graph-document';
import type { GraphDocument } from '../types/graph';
import { apiRequest, ApiError, ApiUnavailableError } from './api-client';
import type { GraphSummary } from './api-client';

const prefix = 'cluevia.graph.v1.';
export const GFW_CASE_ID = 'gfw-galapagos';

export async function getGraph(id: string): Promise<GraphDocument | null> {
  if (id === GFW_CASE_ID) {
    const response = await fetch('/examples/gfw-galapagos.json');
    if (!response.ok) throw new Error('GFW 예제를 불러오지 못했습니다.');
    return parseGraphDocument(await response.json());
  }
  try {
    const result = await apiRequest<{ graph: unknown }>(`/api/graphs/${encodeURIComponent(id)}`);
    return parseGraphDocument(result.graph);
  } catch (error) {
    if (!(error instanceof ApiUnavailableError) && !(error instanceof ApiError && error.status === 404)) throw error;
    let raw: string | null;
    try { raw = localStorage.getItem(prefix + id); } catch { throw new Error('브라우저 저장소에 접근할 수 없습니다.'); }
    if (raw) return parseGraphText(raw);
    if (error instanceof ApiUnavailableError) throw error;
    return null;
  }
}

export function saveGraph(graph: GraphDocument): GraphDocument {
  const valid = parseGraphDocument(graph);
  const stored = { ...valid, id: `graph-${randomId()}` };
  const raw = JSON.stringify(stored);
  if (new TextEncoder().encode(raw).length > GRAPH_LIMITS.jsonBytes) throw new Error('저장할 그래프가 2MB 제한을 초과했습니다.');
  try { localStorage.setItem(prefix + stored.id, raw); } catch { throw new Error('브라우저 저장 공간이 부족하거나 차단되었습니다. 그래프를 저장하지 못했습니다.'); }
  return stored;
}

function browserGraphs(): GraphSummary[] {
  const result: GraphSummary[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try { const graph = parseGraphText(localStorage.getItem(key)!); result.push({ id: graph.id, title: graph.title, createdAt: graph.createdAt }); } catch { /* Ignore stale documents. */ }
    }
  } catch { /* Public examples remain usable without storage. */ }
  return result;
}
export async function recentGraphs(limit = 8): Promise<GraphSummary[]> {
  let saved: GraphSummary[];
  try { saved = (await apiRequest<{ graphs: GraphSummary[] }>('/api/graphs')).graphs; }
  catch (error) { if (!(error instanceof ApiUnavailableError)) throw error; saved = []; }
  const unique = new Map([...browserGraphs(), ...saved].map(graph => [graph.id, graph]));
  return [...unique.values()].sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || '')).slice(0, Math.max(1, Math.min(100, limit)));
}

export async function importGraphFile(file: File, browserOnly = false): Promise<GraphDocument> {
  if (file.size > GRAPH_LIMITS.jsonBytes) throw new Error('그래프 JSON은 2MB 이하여야 합니다.');
  const graph = { ...parseGraphText(await file.text()), origin: 'imported' as const };
  if (browserOnly) return saveGraph(graph);
  return parseGraphDocument((await apiRequest<{ graph: unknown }>('/api/graphs/import', { method: 'POST', body: JSON.stringify({ graph }) })).graph);
}

export function downloadGraph(graph: GraphDocument): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${graph.id}.graph.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function deleteCase(id: string, analysis: boolean, graphIds: string[]): Promise<string> {
  // Older cases may be outside the jobs-list page while a member graph is still listed.
  if (!analysis) {
    try {
      const collection = await apiRequest<{ jobId?: string; graphs: { id: string }[] }>(`/api/graphs/${encodeURIComponent(id)}/collection`);
      if (collection.jobId) { id = collection.jobId; analysis = true; graphIds = collection.graphs.map(graph => graph.id); }
    } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  }
  let deletedIds = graphIds;
  try {
    const result = await apiRequest<{ graphIds?: string[] }>(`/api/${analysis ? 'jobs' : 'graphs'}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result.graphIds) deletedIds = result.graphIds;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  try {
    for (const graphId of deletedIds) {
      localStorage.removeItem(prefix + graphId);
      for (const view of ['board', 'lanes', 'timeline']) localStorage.removeItem(`cluevia.positions.${graphId}.${view}`);
      localStorage.removeItem(`cluevia.case-panel.${graphId}`);
    }
    localStorage.removeItem(`cluevia.case-panel.case-${id}`);
    for (const view of ['board', 'lanes', 'timeline']) localStorage.removeItem(`cluevia.positions.case-${id}.${view}`);
    if (localStorage.getItem('cluevia.active-job') === id) localStorage.removeItem('cluevia.active-job');
  } catch { /* Server deletion is complete even if browser storage is unavailable. */ }
  window.dispatchEvent(new Event('cluevia:cases-changed'));
  return id;
}
