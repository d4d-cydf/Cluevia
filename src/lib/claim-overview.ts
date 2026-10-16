import type { GraphDocument, GraphEdge, GraphNode } from '../types/graph.ts';

export interface OverviewReportStatement {
  text: string;
  sourceIds: string[];
  recordNumber?: number;
}
export interface OverviewReportRecord {
  number: number;
  summary: string;
  limitations: string[];
  documents?: { id: string; name: string; text: string }[];
}
export interface OverviewReport {
  conclusion: OverviewReportStatement;
  evidence: OverviewReportStatement[];
  limitation: string | null;
}
export interface ClaimOverviewModel {
  question: string;
  status: 'found' | 'empty';
  message: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Recorded relationship count before the optional UI search. */
  total: number;
  sourceCount: number;
  /** No recorded objects or relationships, rather than no search matches. */
  empty: boolean;
  /** A short, cited answer when the saved answer cannot be expressed as a relation. */
  report: OverviewReport | null;
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
const relationKinds = [
  { name: '환적', pattern: /환적|\btrans[ -]?ship(?:ment|ments|ped|ping|s)?\b|\btranship(?:ment|ments|ped|ping|s)?\b|\bship[- ]to[- ]ship transfer\b|\bcargo transfer\b|화물(?:을)?\s*(?:이전|이송|인계|전달|넘김|옮김)/, vessels: true },
  { name: '조우', pattern: /조우|\bencounters?\b|\brendezvous\b|근접 운항/ },
  { name: '소유', pattern: /소유|보유|지분|\b(?:ownership|owns?|owned|shareholders?)\b/ },
  { name: '계약', pattern: /계약|\bcontracts?\b|\bagreements?\b/ },
  { name: '자금 이전', pattern: /송금|지급|결제|자금|\b(?:payments?|paid|pays?|funding|remittances?)\b/ },
  { name: '투자', pattern: /투자|\binvest(?:s|ed|ing|ment|ments|ors?)?\b/ },
  { name: '공급', pattern: /공급|납품|\b(?:supply|supplies|supplied|suppliers?)\b/ },
  { name: '나포·체포', pattern: /나포|체포|압류|\b(?:arrests?|arrested|intercept(?:ed|ion|s)?|seizures?|seized)\b/ },
  { name: '소속', pattern: /소속|고용|근무|\b(?:employ(?:s|ed|ment|ees?|ers?)?|works? for|affiliat(?:ed|ion|ions))\b/ },
  { name: '인용', pattern: /인용|\b(?:citations?|cites?|quoted?)\b/ },
] as const;
type RelationKind = typeof relationKinds[number];
const genericWords = new Set('what which who whom where when why how about between among whether find show list tell me please the a an of to and or in on for from is are was were does do did have has with that this these those relation relations relationship relationships related connection connections connected graph overview 자료 관계 연결 그래프 결과 찾아 찾아줘 찾아주세요 알려줘 보여줘 보여주세요 어떤 무슨 누구 누가 어디 언제 무엇 어떻게 서로 대한 관한 있는 했는가 하는가 여부 확인 정리 분석 진짜 실제 모두 전체 것 부분 및 와 과 의 을 를 은 는 에 배 선박 회사 기관 사람 인물 사건 source target document object vessel ship company organization'.split(' '));
const uncertainty = /가능성|추정|추론|의혹|의심|불확실|미확인|미입증|잠정|없음|아님|아니다|불명|확인 불가|배제할 수 없|예정|계획|확인(?:되|하|할|된)?지\s*(?:않|못)|입증(?:되|하|할)?지\s*(?:않|못)|근거(?:가|는)?\s*없|알\s*수\s*없|부인|철회|(?:하지|하지는|하지도|한 적이|사실이)\s*없|(?:하지|되지|인 것은)\s*않|\b(?:possible|possibly|potential|potentially|suspected|uncertain|unconfirmed|unverified|inferred|alleged|denied|denies|retracted|planned|planning|proposed|might)\b|\bmay\s+(?:have|be|transfer|transship|tranship|own|pay|supply|indicate|suggest)\b|\b(?:did|does|do|is|was|were|has|have|had|could|would)\s+not\b(?!\s+only\b)|\bno\s+(?:evidence|proof|transfer|contract|payment)\b|\bcannot\s+(?:confirm|verify|establish)\b|n[’']t\b(?!\s+only\b)|\bnot\s+(?:confirmed|verified|transfer|transship|tranship|paid|owned)\b/i;
function meaningfulTokens(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu)?.filter(word => word.length >= 2
    && !genericWords.has(word)
    && !genericWords.has(word.replace(/(?:에서는|에서|으로|인지|인가요|인가|의|은|는|을|를|이|가|와|과|도|에|로|야)$/, ''))) ?? [];
}
function relationMatches(edge: GraphEdge, kind: RelationKind): boolean {
  // Relation labels are predicates; a mention in an unrelated description is not an answer.
  return kind.pattern.test(normalize(edge.label));
}
function mentions(question: string, label: string): boolean {
  const value = normalize(label).trim();
  if (!value) return false;
  if (/^[a-z0-9]+$/.test(value)) return question.split(/[^a-z0-9]+/).includes(value);
  return value.length >= 2 && question.includes(value);
}
function uncertainRelation(edge: GraphEdge, kinds: readonly RelationKind[]): boolean {
  if (uncertainty.test(edge.label)) return true;
  const sentences = edge.description.split(/[.!?。\n]+/).map(text => text.trim()).filter(Boolean);
  const tokens = meaningfulTokens(edge.label);
  // Ignore uncertainty about other topics, including source-level caveats.
  return sentences.some(sentence => uncertainty.test(sentence) && (sentences.length === 1
    || kinds.some(kind => kind.pattern.test(normalize(sentence)))
    || tokens.some(token => normalize(sentence).includes(token))));
}
const processText = /(?:\d+\s*\/\s*\d+\s*개?\s*기록|객체.{0,30}관계.{0,30}통합|구조화했습니다|분석했습니다|분석하였습니다|분석한 상세 요약|찾아야 합니다|확인해야 합니다|질문에 답하기 위해|아직 연결된 근거가 없)/;
const stem = (word: string) => word.replace(/(?:에서는|에서|에게|으로|인지|인가요|인가|의|은|는|을|를|이|가|와|과|도|에|로|야)$/, '');
const statementKey = (text: string) => normalize(text).replace(/[\s\p{P}]+/gu, '');

/** Keep complete sentences: clipping a qualification can turn an uncertain result into a fact. */
function shortStatements(text: string): string[] {
  const clean = text.replace(/^기록\s+\d+\s*[·:—-]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!clean || processText.test(clean)) return [];
  if (clean.length <= 180) return [clean];
  const sentences = clean.split(/(?<=[.!?。])\s+/u).filter(sentence => sentence.length <= 180 && !processText.test(sentence));
  return uncertainty.test(clean) ? sentences.filter(sentence => uncertainty.test(sentence)) : sentences;
}

function buildReport(graph: GraphDocument, context: {
  question: string; kinds: readonly RelationKind[]; mentioned: Set<string>; relevant: GraphEdge[];
  records: OverviewReportRecord[]; message: string;
}): OverviewReport {
  const { question, kinds, mentioned, relevant, records, message } = context;
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const sourceIds = new Set(graph.sources.map(source => source.id));
  const validSources = (ids: string[]) => [...new Set(ids.filter(id => sourceIds.has(id)))];
  const questionWithoutEntities = graph.nodes.reduce((text, node) => {
    const label = normalize(node.label); return label.length >= 2 ? text.split(label).join(' ') : text;
  }, normalize(question));
  const tokens = meaningfulTokens(questionWithoutEntities).map(stem);
  const quantity = /몇|얼마|수량|개수|갯수|수치|how many|how much|quantity|count/i.test(question);
  const date = /언제|날짜|시기|when|date/i.test(question);
  const summary = /요약|핵심|summary|summarize|overview/i.test(question);
  const topicTokens = [...tokens, ...(questionWithoutEntities.match(/사건|\bevents?\b|\bincidents?\b/g) ?? [])]
    .filter(token => !/^(?:몇.*|얼마.*|언제.*|수량|개수|갯수|수치|마리.*|포대.*|날짜|시기|many|much|quantity|count|number|date|time|year|month|day)$/.test(token));
  const score = (text: string, nodeIds: string[] = []) => {
    const normalized = normalize(text);
    const mentionsEntity = [...mentioned].some(id => nodeIds.includes(id) || mentions(normalized, byId.get(id)?.label ?? ''));
    if (mentioned.size && !mentionsEntity) return 0;
    const contentTokens = meaningfulTokens(text).map(stem);
    const overlap = new Set(tokens.filter(token => contentTokens.some(word => word === token || (/[가-힣]/.test(token) && token.length >= 2 && (word.startsWith(token) || token.startsWith(word)))))).size;
    const topicOverlap = topicTokens.some(token => mentions(normalized, token)
      || contentTokens.some(word => word === token || (/[가-힣]/.test(token) && token.length >= 2 && (word.startsWith(token) || token.startsWith(word)))));
    const relationMatch = kinds.some(kind => kind.pattern.test(normalized));
    // A number or date is useful only after the topic or entity matches the question.
    if ((quantity || date) && !mentionsEntity && !topicOverlap && !relationMatch) return 0;
    const specific = (relationMatch ? 5 : 0) + overlap
      + (quantity && /\d/.test(text) ? 3 : 0) + (date && /\d{4}|\d+월|\d+일/.test(text) ? 3 : 0) + (summary ? 1 : 0);
    if (quantity && !/\d/.test(text) && !uncertainty.test(text)) return 0;
    return specific || (mentionsEntity && !tokens.length) ? specific + (mentionsEntity ? 2 : 0) : 0;
  };
  const contested = (edge: GraphEdge) => edge.claim?.stance === 'denied' || edge.claim?.stance === 'retracted'
    || edge.claim?.stance === 'uncertain' || edge.status === 'inferred'
    || edge.review?.status === 'disputed' || edge.review?.status === 'needs-review' || uncertainRelation(edge, kinds);
  const cautions = relevant.filter(contested);
  const sameSubject = (nodeIds: string[], edgeIds: string[], text: string, edge: GraphEdge) => edgeIds.includes(edge.id)
    || (nodeIds.includes(edge.source) && nodeIds.includes(edge.target))
    || (mentions(normalize(text), byId.get(edge.source)?.label ?? '') && mentions(normalize(text), byId.get(edge.target)?.label ?? ''));
  type Candidate = OverviewReportStatement & { rank: number };
  const candidates: Candidate[] = [];
  const add = (text: string, ids: string[], priority: number, nodeIds: string[] = [], edgeIds: string[] = [], recordNumber?: number) => {
    const sources = validSources(ids);
    if (!sources.length && recordNumber === undefined) return;
    for (const sentence of shortStatements(text)) {
      const relevance = score(sentence, nodeIds);
      if (!relevance) continue;
      // A prose finding must not bypass the graph's denied, withdrawn or uncertain claim.
      if (cautions.some(edge => sameSubject(nodeIds, edgeIds, sentence, edge)
        && !uncertainRelation({ ...edge, description: sentence, label: kinds.find(kind => relationMatches(edge, kind))?.name ?? edge.label }, kinds))) continue;
      candidates.push({ text: sentence, sourceIds: sources, ...(recordNumber === undefined ? {} : { recordNumber }), rank: priority + relevance });
    }
  };
  for (const finding of graph.findings) add(finding.text, finding.sourceIds, 100, finding.nodeIds, finding.edgeIds);
  for (const edge of cautions) {
    const source = byId.get(edge.source)?.label; const target = byId.get(edge.target)?.label;
    if (!source || !target) continue;
    const subject = `${source} → ${target}의 ${edge.label}`;
    const text = edge.review?.status === 'disputed' ? `${subject}에 대한 자료가 상충합니다.`
      : edge.claim?.stance === 'denied' ? `${subject} 주장은 자료에서 부인되었습니다.`
        : edge.claim?.stance === 'retracted' ? `${subject} 주장은 철회되었습니다.`
          : edge.review?.status === 'needs-review' ? `${subject}은 추가 검토가 필요합니다.`
            : edge.status === 'inferred' ? `${subject}은 추정이며, 확인된 사실이 아닙니다.`
              : edge.claim?.stance === 'uncertain' ? `${subject} 여부는 불확실합니다.` : edge.description;
    // These sentences directly encode stored claim state; no new relation is inferred.
    for (const sentence of shortStatements(text)) if (validSources(edge.sourceIds).length) {
      candidates.push({ text: sentence, sourceIds: validSources(edge.sourceIds), rank: 90 + score(sentence, [edge.source, edge.target]) });
    }
  }
  for (const record of records.slice(0, 3)) {
    if (!record.documents?.some(document => document.text.trim())) continue;
    add(record.summary, [], 80, [], [], record.number);
  }
  // A source's actual excerpt can answer a quantity/date/text question even without an edge.
  for (const source of graph.sources) if (source.excerpt) add(source.excerpt, [source.id], 60);
  // Graph summaries carry no citation field; use them only when the same statement is in a source.
  for (const sentence of shortStatements(graph.summary)) {
    const sources = graph.sources.filter(source => source.excerpt && statementKey(source.excerpt).includes(statementKey(sentence))).map(source => source.id);
    add(sentence, sources, 70);
  }
  const ranked = candidates.sort((a, b) => b.rank - a.rank);
  const unique = ranked.filter((candidate, index) => !ranked.slice(0, index).some(previous => statementKey(previous.text) === statementKey(candidate.text)));
  const toStatement = ({ text, sourceIds: ids, recordNumber }: Candidate): OverviewReportStatement => ({ text, sourceIds: ids, ...(recordNumber === undefined ? {} : { recordNumber }) });
  const conclusion = unique[0] ? toStatement(unique[0]) : { text: message, sourceIds: [] };
  const evidence = unique.slice(1, 3).map(toStatement);
  const usedText = [conclusion.text, ...evidence.map(item => item.text)];
  const limitations = [...graph.limitations, ...records.flatMap(record => record.limitations)].flatMap(shortStatements)
    .map(text => ({ text, rank: score(text) })).filter(item => item.rank > 0 && !usedText.some(text => statementKey(text).includes(statementKey(item.text))))
    .sort((a, b) => b.rank - a.rank);
  const limitation = limitations[0]?.text ?? (!unique.length
    ? kinds.length === 1 && 'vessels' in kinds[0]
      ? '선박명과 실제 화물 이전을 확인할 수 있는 기록이 필요합니다.'
      : '질문을 확인할 수 있는 관련 자료가 필요합니다.'
    : null);
  while (evidence.length && conclusion.text.length + evidence.reduce((length, item) => length + item.text.length, 0) + (limitation?.length ?? 0) > 600) evidence.pop();
  return { conclusion, evidence, limitation };
}

export type OverviewRelationState = 'reported' | 'inferred' | 'uncertain' | 'denied' | 'retracted' | 'disputed' | 'needs-review' | 'source-missing';
export const overviewRelationLabels: Record<OverviewRelationState, string> = {
  reported: '자료에 명시', inferred: '추정', uncertain: '불확실', denied: '부인', retracted: '철회',
  disputed: '자료 상충', 'needs-review': '검토 필요', 'source-missing': '출처 확인 필요',
};

/** Graph visibility and the truth of an assertion are separate decisions. */
export function overviewRelationState(edge: GraphEdge, sourceIds: ReadonlySet<string>): OverviewRelationState {
  if (edge.claim?.stance === 'denied' || edge.claim?.stance === 'retracted') return edge.claim.stance;
  if (edge.review?.status === 'disputed') return 'disputed';
  if (edge.claim?.stance === 'uncertain') return 'uncertain';
  if (edge.status === 'inferred') return 'inferred';
  if (edge.review?.status === 'needs-review') return 'needs-review';
  if (uncertainRelation(edge, relationKinds.filter(kind => relationMatches(edge, kind)))) return 'uncertain';
  if (!edge.sourceIds.some(id => sourceIds.has(id))) return 'source-missing';
  return 'reported';
}

/** Show recorded associations first. Question relevance orders the map; it does not
 * require an accepted proof or turn a path/co-mention into a new relationship. */
export function buildClaimOverview(graph: GraphDocument, options: { query?: string; pending?: boolean; records?: OverviewReportRecord[] } = {}): ClaimOverviewModel {
  const question = graph.question || graph.title;
  const normalizedQuestion = normalize(question);
  const kinds = relationKinds.filter(kind => kind.pattern.test(normalizedQuestion));
  const recordedNodes = graph.nodes.filter(node => node.id && node.label.trim());
  const byId = new Map(recordedNodes.map(node => [node.id, node]));
  const sourceIds = new Set(graph.sources.map(source => source.id));
  const mentioned = new Set(recordedNodes.filter(node => mentions(normalizedQuestion, node.label)).map(node => node.id));
  const questionTokens = meaningfulTokens(question).map(stem);
  const valid = graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target));
  const relevance = (edge: GraphEdge) => {
    const text = normalize([edge.label, edge.description, byId.get(edge.source)?.label, byId.get(edge.target)?.label].join(' '));
    return (mentioned.has(edge.source) ? 4 : 0) + (mentioned.has(edge.target) ? 4 : 0)
      + (kinds.some(kind => relationMatches(edge, kind)) ? 6 : 0)
      + questionTokens.filter(token => text.includes(token)).length;
  };
  const associations = valid.map((edge, index) => ({ edge, index, score: relevance(edge) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.edge);
  const query = normalize(options.query?.trim() ?? '');
  const nodeMatches = (node: GraphNode) => normalize([node.label, node.type, node.description, ...Object.values(node.properties)].join(' ')).includes(query);
  const edges = query ? associations.filter(edge => normalize([edge.label, edge.description, byId.get(edge.source)?.label, byId.get(edge.target)?.label,
    overviewRelationLabels[overviewRelationState(edge, sourceIds)]].join(' ')).includes(query)) : associations;
  const visibleIds = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  const nodes = recordedNodes.filter(node => !query || visibleIds.has(node.id) || nodeMatches(node));
  const total = associations.length;
  const empty = recordedNodes.length === 0;
  const sourceCount = new Set([...associations.flatMap(edge => edge.sourceIds), ...recordedNodes.flatMap(node => node.sourceIds)].filter(id => sourceIds.has(id))).size;
  const qualified = associations.some(edge => overviewRelationState(edge, sourceIds) !== 'reported');
  const message = query && !nodes.length ? '검색어와 일치하는 결과가 없습니다.'
    : total ? `자료에 담긴 관계 ${edges.length}개를 연결했습니다.${qualified ? ' 추정·부인 등은 원래 상태로 표시합니다.' : ''}`
      : recordedNodes.length ? `자료에 등장한 대상 ${nodes.length}개입니다. 아직 기록된 관계는 없습니다.`
        : '제공된 자료에서 질문에 답할 수 있는 관계를 찾지 못했습니다.';
  const report = total === 0 && !query && !options.pending ? buildReport(graph, { question, kinds, mentioned, relevant: valid, records: options.records ?? [], message }) : null;
  return { question, status: empty ? 'empty' : 'found', message, nodes, edges, total, sourceCount, empty, report };
}
