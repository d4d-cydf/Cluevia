import { randomId } from '../lib/random-id';
import { GRAPH_LIMITS, parseGraphDocument, parseGraphText } from '../lib/graph-document';
import type { GraphDocument, GraphGenerationInput } from '../types/graph';

const prefix = 'cluevia.graph.v1.';
export const GFW_CASE_ID = 'gfw-galapagos';

export async function getGraph(id: string): Promise<GraphDocument | null> {
  if (id === GFW_CASE_ID) {
    const response = await fetch('/examples/gfw-galapagos.json');
    if (!response.ok) throw new Error('GFW 예제를 불러오지 못했습니다.');
    return parseGraphDocument(await response.json());
  }
  let raw: string | null;
  try { raw = localStorage.getItem(prefix + id); } catch { throw new Error('브라우저 저장소에 접근할 수 없습니다.'); }
  return raw ? parseGraphText(raw) : null;
}

export function saveGraph(graph: GraphDocument): GraphDocument {
  const valid = parseGraphDocument(graph);
  const stored = { ...valid, id: `graph-${randomId()}` };
  const raw = JSON.stringify(stored);
  if (new TextEncoder().encode(raw).length > GRAPH_LIMITS.jsonBytes) throw new Error('저장할 그래프가 2MB 제한을 초과했습니다.');
  try { localStorage.setItem(prefix + stored.id, raw); } catch { throw new Error('브라우저 저장 공간이 부족하거나 차단되었습니다. 그래프를 저장하지 못했습니다.'); }
  return stored;
}

export function recentGraphs(): Pick<GraphDocument, 'id' | 'title'>[] {
  const result: Pick<GraphDocument, 'id' | 'title'>[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try { const graph = parseGraphText(localStorage.getItem(key)!); result.push({ id: graph.id, title: graph.title }); } catch { /* Ignore unrelated or stale saved documents. */ }
    }
  } catch { /* Built-in examples remain usable without storage. */ }
  return result.reverse().slice(0, 8);
}

export async function importGraphFile(file: File): Promise<GraphDocument> {
  if (file.size > GRAPH_LIMITS.jsonBytes) throw new Error('그래프 JSON은 2MB 이하여야 합니다.');
  return saveGraph({ ...parseGraphText(await file.text()), origin: 'imported' });
}

export async function generateGraph(input: GraphGenerationInput, signal?: AbortSignal): Promise<GraphDocument> {
  const response = await fetch('/api/graphs/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const result = await response.json().catch(() => null) as { graph?: unknown; error?: string } | null;
  if (!response.ok) throw new Error(result?.error || '그래프 생성에 실패했습니다. AIP 설정과 자료를 확인해주세요.');
  if (!result?.graph) throw new Error('서버에서 그래프를 반환하지 않았습니다.');
  return saveGraph(parseGraphDocument(result.graph));
}

export function downloadGraph(graph: GraphDocument): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${graph.id}.graph.json`;
  document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
