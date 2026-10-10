import type { Page } from '@playwright/test';
import type { AnalysisCase, AnalysisRecordDetail } from '../src/types/analysis-case';
import type { GraphDocument } from '../src/types/graph';

/** Explicit browser fixture; server integration tests cover real identity resolution. */
export async function mockCase(page: Page, jobId: string, graphs: () => GraphDocument[], counts: () => { total?: number; completed?: number } = () => ({})) {
  const value = (): AnalysisCase => {
    const parts = graphs(); const first = parts[0];
    const { total = parts.length, completed = parts.length } = counts();
    const result: AnalysisCase = { schemaVersion: 'case-1.0', jobId, status: completed >= total ? 'completed' : 'running', updatedAt: first.createdAt,
      graph: { ...first, id: `case-${jobId}`, title: first.question, nodes: [], edges: [], sources: [], findings: [], events: [] },
      records: Array.from({ length: total }, (_, i) => ({ number: i + 1, title: parts[i]?.title ?? `분석 기록 ${i + 1}`, status: i < parts.length ? 'saved' : i < completed ? 'empty' : 'pending', graphId: parts[i]?.id, nodeCount: parts[i]?.nodes.length ?? 0, edgeCount: parts[i]?.edges.length ?? 0, archived: true })), provenance: {}, conflicts: [] };
    parts.forEach((part, index) => {
      const prefix = `r${index + 1}-`;
      part.nodes.forEach(node => {
        if (!result.graph.nodes.some(item => item.id === node.id)) result.graph.nodes.push({ ...node, sourceIds: node.sourceIds.map(id => prefix + id) });
        (result.provenance[node.id] ??= []).push({ record: index + 1, localId: node.id });
      });
      result.graph.sources.push(...part.sources.map(source => ({ ...source, id: prefix + source.id })));
      part.sources.forEach(source => { result.provenance[prefix + source.id] = [{ record: index + 1, localId: source.id }]; });
      result.graph.edges.push(...part.edges.map(edge => ({ ...edge, id: prefix + edge.id, sourceIds: edge.sourceIds.map(id => prefix + id) })));
      part.edges.forEach(edge => { result.provenance[prefix + edge.id] = [{ record: index + 1, localId: edge.id }]; });
    });
    return result;
  };
  await page.route(`**/api/jobs/${jobId}/chat`, route => route.fulfill({ json: { turns: [], model: 'gpt-6.1-sol', effort: 'xhigh' } }));
  await page.route(`**/api/jobs/${jobId}/case`, route => route.fulfill({ json: value() }));
  await page.route(new RegExp(`/api/jobs/${jobId}/records/\\d+$`), route => {
    const number = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    const part = graphs()[number - 1]; const record = value().records[number - 1];
    const detail: AnalysisRecordDetail = { record, graph: part, summary: part?.summary ?? '객체·관계를 확인하지 못했습니다.', limitations: part?.limitations ?? [],
      documents: part?.sources.map(source => ({ id: source.id, name: source.title, text: source.excerpt ?? '', totalChars: source.excerpt?.length ?? 0, offset: 0 })) ?? [], claims: [], relationClaims: [] };
    return route.fulfill({ json: detail });
  });
}
