import type { GraphDocument, GraphEdge, GraphEvent, GraphFinding, GraphGroup, GraphNode, GraphSource } from '../types/graph.ts';

export const GRAPH_LIMITS = { nodes: 200, edges: 500, events: 300, sources: 30, groups: 12, documents: 10, documentChars: 50_000, totalDocumentChars: 150_000, jsonBytes: 2_000_000 } as const;

export class GraphValidationError extends Error {
  issues: string[];
  constructor(message: string, issues: string[] = [message]) { super(message); this.name = 'GraphValidationError'; this.issues = issues; }
}

type JsonObject = Record<string, unknown>;
function fail(path: string, message: string): never { throw new GraphValidationError(`${path}: ${message}`); }
function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path, '객체가 필요합니다.');
  return value as JsonObject;
}
function text(value: unknown, path: string, max = 2000, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) return fail(path, `1–${max}자 문자열이 필요합니다.`);
  return value.trim();
}
function id(value: unknown, path: string): string {
  const result = text(value, path, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result)) return fail(path, 'ID는 영문·숫자로 시작하고 영문·숫자·점·밑줄·콜론·하이픈만 사용할 수 있습니다.');
  return result;
}
function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length > max || value.length < min) return fail(path, `${min}–${max}개 항목의 배열이 필요합니다.`);
  return value;
}
function refs(value: unknown, path: string, min = 1): string[] {
  const result = list(value, path, 200, min).map((entry, index) => id(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) return fail(path, '중복 참조가 있습니다.');
  return result;
}
function date(value: unknown, path: string): string {
  const result = text(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(result) || !Number.isFinite(Date.parse(result))) return fail(path, 'ISO 날짜 또는 시간대가 포함된 ISO 시각이 필요합니다.');
  const day = result.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return fail(path, '존재하지 않는 날짜입니다.');
  return result;
}
function unique<T extends { id: string }>(values: T[], path: string): Set<string> {
  const ids = new Set(values.map(value => value.id));
  if (ids.size !== values.length) return fail(path, '중복 ID가 있습니다.');
  return ids;
}
function assertRefs(values: string[], ids: Set<string>, path: string) {
  for (const value of values) if (!ids.has(value)) fail(path, `존재하지 않는 ID: ${value}`);
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

/** Validate and rebuild the document; unknown fields never enter the renderer. */
export function parseGraphDocument(input: unknown): GraphDocument {
  const root = object(input, 'graph');
  if (root.schemaVersion !== '1.0') fail('schemaVersion', '지원하는 버전은 1.0입니다.');
  if (!['published-source', 'imported', 'aip', 'demo'].includes(String(root.origin))) fail('origin', '유효하지 않은 데이터 유형입니다.');
  const graphId = id(root.id, 'id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(graphId)) fail('id', '그래프 ID에는 콜론을 사용할 수 없습니다.');
  const groups: GraphGroup[] = list(root.groups, 'groups', GRAPH_LIMITS.groups, 1).map((entry, index) => {
    const item = object(entry, `groups[${index}]`);
    const color = text(item.color, `groups[${index}].color`, 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail(`groups[${index}].color`, '#RRGGBB 색상이 필요합니다.');
    return { id: id(item.id, 'group.id'), label: text(item.label, 'group.label', 100), color };
  });
  const sources: GraphSource[] = list(root.sources, 'sources', GRAPH_LIMITS.sources, 1).map((entry, index) => {
    const item = object(entry, `sources[${index}]`);
    const source: GraphSource = { id: id(item.id, 'source.id'), title: text(item.title, 'source.title', 300) };
    if (item.url !== undefined) { const url = safeSourceUrl(item.url); if (!url) fail('source.url', 'http(s) 출처 URL이 필요합니다.'); source.url = url; }
    if (item.publisher !== undefined) source.publisher = text(item.publisher, 'source.publisher', 150);
    if (item.publishedAt !== undefined) source.publishedAt = date(item.publishedAt, 'source.publishedAt');
    if (item.accessedAt !== undefined) source.accessedAt = date(item.accessedAt, 'source.accessedAt');
    if (item.excerpt !== undefined) source.excerpt = text(item.excerpt, 'source.excerpt', 1200);
    return source;
  });
  const nodes: GraphNode[] = list(root.nodes, 'nodes', GRAPH_LIMITS.nodes, 1).map((entry, index) => {
    const item = object(entry, `nodes[${index}]`);
    const properties = Object.entries(object(item.properties, 'node.properties'));
    if (properties.length > 25) fail('node.properties', '속성은 25개까지 사용할 수 있습니다.');
    return { id: id(item.id, 'node.id'), label: text(item.label, 'node.label', 180), type: text(item.type, 'node.type', 80), group: id(item.group, 'node.group'), description: text(item.description, 'node.description', 2000, true), sourceIds: refs(item.sourceIds, 'node.sourceIds'), properties: Object.fromEntries(properties.map(([key, value]) => [text(key, 'property.key', 100), text(value, 'property.value', 500, true)])) };
  });
  const edges: GraphEdge[] = list(root.edges, 'edges', GRAPH_LIMITS.edges).map((entry, index) => {
    const item = object(entry, `edges[${index}]`);
    if (!['reported', 'inferred'].includes(String(item.status))) fail('edge.status', 'reported 또는 inferred가 필요합니다.');
    if (item.highlighted !== undefined && typeof item.highlighted !== 'boolean') fail('edge.highlighted', 'boolean이 필요합니다.');
    return { id: id(item.id, 'edge.id'), source: id(item.source, 'edge.source'), target: id(item.target, 'edge.target'), label: text(item.label, 'edge.label', 150), description: text(item.description, 'edge.description', 2000, true), status: item.status as GraphEdge['status'], sourceIds: refs(item.sourceIds, 'edge.sourceIds'), ...(item.highlighted === undefined ? {} : { highlighted: item.highlighted as boolean }) };
  });
  const events: GraphEvent[] = list(root.events, 'events', GRAPH_LIMITS.events).map((entry, index) => {
    const item = object(entry, `events[${index}]`);
    const start = date(item.date, 'event.date');
    const end = item.endDate === undefined ? undefined : date(item.endDate, 'event.endDate');
    if (end && Date.parse(end) < Date.parse(start)) fail('event.endDate', '시작일 이후여야 합니다.');
    return { id: id(item.id, 'event.id'), label: text(item.label, 'event.label', 180), date: start, ...(end ? { endDate: end } : {}), description: text(item.description, 'event.description', 2000, true), nodeIds: refs(item.nodeIds, 'event.nodeIds'), sourceIds: refs(item.sourceIds, 'event.sourceIds') };
  });
  const findings: GraphFinding[] = list(root.findings, 'findings', 30).map((entry, index) => {
    const item = object(entry, `findings[${index}]`);
    return { text: text(item.text, 'finding.text', 2000), sourceIds: refs(item.sourceIds, 'finding.sourceIds'), nodeIds: refs(item.nodeIds, 'finding.nodeIds', 0), ...(item.edgeIds === undefined ? {} : { edgeIds: refs(item.edgeIds, 'finding.edgeIds', 0) }) };
  });
  const groupIds = unique(groups, 'groups'); const sourceIds = unique(sources, 'sources'); const nodeIds = unique(nodes, 'nodes'); const edgeIds = unique(edges, 'edges'); unique(events, 'events');
  for (const node of nodes) { assertRefs([node.group], groupIds, `node ${node.id}.group`); assertRefs(node.sourceIds, sourceIds, `node ${node.id}.sourceIds`); }
  for (const edge of edges) { assertRefs([edge.source, edge.target], nodeIds, `edge ${edge.id}`); assertRefs(edge.sourceIds, sourceIds, `edge ${edge.id}.sourceIds`); }
  for (const event of events) { assertRefs(event.nodeIds, nodeIds, `event ${event.id}.nodeIds`); assertRefs(event.sourceIds, sourceIds, `event ${event.id}.sourceIds`); }
  for (const finding of findings) { assertRefs(finding.nodeIds, nodeIds, 'finding.nodeIds'); assertRefs(finding.edgeIds ?? [], edgeIds, 'finding.edgeIds'); assertRefs(finding.sourceIds, sourceIds, 'finding.sourceIds'); }
  return { schemaVersion: '1.0', id: graphId, title: text(root.title, 'title', 200), question: text(root.question, 'question', 2000), summary: text(root.summary, 'summary', 5000), origin: root.origin as GraphDocument['origin'], createdAt: date(root.createdAt, 'createdAt'), limitations: list(root.limitations, 'limitations', 20).map((entry, index) => text(entry, `limitations[${index}]`, 1000)), groups, sources, nodes, edges, events, findings };
}

export function parseGraphText(contents: string): GraphDocument {
  if (new TextEncoder().encode(contents).length > GRAPH_LIMITS.jsonBytes) throw new GraphValidationError('그래프 JSON은 2MB 이하여야 합니다.');
  let input: unknown;
  try { input = JSON.parse(contents); } catch { throw new GraphValidationError('올바른 그래프 JSON 파일이 아닙니다.'); }
  return parseGraphDocument(input);
}
