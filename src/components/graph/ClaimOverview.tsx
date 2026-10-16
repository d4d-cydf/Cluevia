import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphDocument, GraphSelection } from '../../types/graph';
import type { AnalysisRecord, AnalysisRecordDetail } from '../../types/analysis-case';
import { buildClaimOverview, overviewRelationLabels, overviewRelationState } from '../../lib/claim-overview';
import type { OverviewReportRecord } from '../../lib/claim-overview';
import { apiRequest } from '../../services/api-client';
import GraphRenderer from './GraphRenderer';
import './claim-overview.css';

interface Props {
  graph: GraphDocument;
  query?: string;
  pending?: boolean;
  active?: boolean;
  jobId?: string;
  records?: AnalysisRecord[];
  onSelect: (selection: GraphSelection) => void;
  onSource?: (id: string) => void;
  onRecord?: (number: number) => void;
}

interface ArchivedReport { key: string; records: OverviewReportRecord[]; loading: boolean; error: boolean }

/** Recorded relationships remain visible independently of proof review. */
export default function ClaimOverview({ graph, query = '', pending = false, active = true, jobId, records, onSelect, onSource, onRecord }: Props) {
  const basic = useMemo(() => buildClaimOverview(graph, { query, pending }), [graph, query, pending]);
  const [archive, setArchive] = useState<ArchivedReport>({ key: '', records: [], loading: false, error: false });
  const archiveCache = useRef<ArchivedReport | null>(null);
  const [archiveRetry, setArchiveRetry] = useState(0);
  const cited = basic.report && [basic.report.conclusion, ...basic.report.evidence].some(item => item.sourceIds.length || item.recordNumber);
  const available = useMemo(() => (records ?? []).filter(record => record.archived && record.status !== 'pending'), [records]);
  const numbers = useMemo(() => {
    const terms = graph.question.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const relevance = (record: AnalysisRecord) => terms.filter(term => record.title.normalize('NFKC').toLocaleLowerCase().includes(term)).length;
    return [...available].sort((a, b) => relevance(b) - relevance(a) || a.number - b.number).slice(0, 3).map(record => record.number);
  }, [available, graph.question]);
  const numbersKey = numbers.join(',');
  const fetchKey = jobId && !basic.nodes.length && basic.report && !cited && numbersKey ? `${jobId}/${numbersKey}/${archiveRetry}` : '';
  useEffect(() => {
    if (!active || !fetchKey || !jobId) return;
    if (archiveCache.current?.key === fetchKey) { setArchive(archiveCache.current); return; }
    const controller = new AbortController();
    setArchive({ key: fetchKey, records: [], loading: true, error: false });
    void Promise.allSettled(numbersKey.split(',').map(number => apiRequest<AnalysisRecordDetail>(`/api/jobs/${encodeURIComponent(jobId)}/records/${number}`, { signal: controller.signal }))).then(results => {
      if (controller.signal.aborted) return;
      const loaded: OverviewReportRecord[] = results.flatMap(result => result.status === 'fulfilled' && result.value.record.status !== 'pending' ? [{ number: result.value.record.number, summary: result.value.summary, limitations: result.value.limitations, documents: result.value.documents }] : []);
      const value = { key: fetchKey, records: loaded, loading: false, error: results.some(result => result.status === 'rejected') };
      archiveCache.current = value; setArchive(value);
    });
    return () => controller.abort();
  }, [active, fetchKey, jobId, numbersKey]);
  const reportRecords = archive.key === fetchKey ? archive.records : undefined;
  const model = useMemo(() => reportRecords?.length ? buildClaimOverview(graph, { query, pending, records: reportRecords }) : basic, [graph, query, pending, reportRecords, basic]);
  const report = model.report;
  const reading = Boolean(fetchKey && (archive.key !== fetchKey || archive.loading));
  const reportSources = report ? [...new Set([report.conclusion, ...report.evidence].flatMap(item => item.sourceIds))] : [];
  const reportNumbers = report ? [...new Set([report.conclusion, ...report.evidence].flatMap(item => item.recordNumber ? [item.recordNumber] : []))] : [];
  const [selection, setSelection] = useState<GraphSelection>(null);
  useEffect(() => { setSelection(null); }, [graph.id]);
  const context = useMemo(() => {
    const used = new Map<string, string>();
    if (model.edges.length) return { nodes: [], edges: [], sources: used };
    const documents = graph.sources.filter(source => model.nodes.some(node => node.sourceIds.includes(source.id)));
    const ids = new Set(model.nodes.map(node => node.id));
    const unique = (id: string) => { let value = id; while (ids.has(value)) value = `_${value}`; ids.add(value); return value; };
    const nodes = documents.map(source => {
      const id = unique(`overview-source:${source.id}`); used.set(id, source.id);
      return { id, label: source.title, type: 'Source', group: 'overview-sources', description: source.excerpt ?? '', sourceIds: [source.id], properties: {} };
    });
    const edges = nodes.flatMap(document => model.nodes.filter(node => node.sourceIds.includes(document.sourceIds[0])).map(node => {
      const id = unique(`overview-mention:${document.id}:${node.id}`); used.set(id, document.sourceIds[0]);
      return { id, source: node.id, target: document.id, label: '자료에 등장', description: '이 대상이 연결된 원자료입니다. 대상 사이의 사건 관계를 뜻하지 않습니다.', status: 'reported' as const, sourceIds: document.sourceIds };
    }));
    return { nodes, edges, sources: used };
  }, [graph.sources, model.nodes, model.edges.length]);
  const associated = useMemo<GraphDocument>(() => {
    const sources = new Set(graph.sources.map(source => source.id));
    return { ...graph, id: `${graph.id}:overview`, nodes: [...model.nodes, ...context.nodes],
      groups: context.nodes.length ? [...graph.groups, { id: 'overview-sources', label: 'Sources', color: '#a08b69' }] : graph.groups,
      edges: [...model.edges.map(edge => {
        const state = overviewRelationState(edge, sources);
        // Labels make uncertainty visible at rest. IDs still open the original saved claim.
        const alreadyLabelled = edge.claim && ['uncertain', 'denied', 'retracted'].includes(edge.claim.stance);
        return state === 'reported' ? edge : { ...edge,
          label: alreadyLabelled ? edge.label : `${overviewRelationLabels[state]} · ${edge.label}`,
          status: 'inferred' as const,
        };
      }), ...context.edges] };
  }, [graph, model.nodes, model.edges, context]);
  const select = (next: GraphSelection) => {
    setSelection(next);
    const source = next && context.sources.get(next.id);
    if (source) { onSelect(null); onSource?.(source); }
    else onSelect(next);
  };
  const contextSources = graph.sources.filter(source => model.nodes.some(node => node.sourceIds.includes(source.id))
    || model.edges.some(edge => edge.sourceIds.includes(source.id)));

  return <section className={`claim-overview${model.nodes.length ? ' has-associations' : ' is-empty'}`} aria-label="분석 결과 요약">
    {!model.nodes.length ? report && !reading ? <article className="co-report" aria-label="질문에 대한 짧은 보고서">
      <header className="co-report-heading"><span>BRIEF</span><p title={graph.question}>{graph.question}</p></header>
      <h2 className="co-report-conclusion">{report.conclusion.text}</h2>
      {!!report.evidence.length && <div className="co-report-evidence">{report.evidence.map((item, index) => <p key={index}>{item.text}</p>)}</div>}
      {report.limitation && <p className="co-report-limitation">{report.limitation}</p>}
      {(reportSources.length > 0 || reportNumbers.length > 0) && <footer className="co-report-sources"><span>Sources</span>{reportSources.map(id => {
        const title = graph.sources.find(source => source.id === id)?.title ?? id;
        return onSource ? <button type="button" key={id} aria-label={`출처 보기: ${title}`} title={title} onClick={() => onSource(id)}>{title}<span aria-hidden="true">↗</span></button> : <span key={id}>{title}</span>;
      })}{reportNumbers.map(number => onRecord ? <button type="button" key={number} aria-label={`기록 ${number} 열기`} onClick={() => onRecord(number)}>Record {number}<span aria-hidden="true">↗</span></button> : <span key={number}>Record {number}</span>)}</footer>}
      {reportNumbers.length > 0 && available.length > numbers.length && <small className="co-report-scope">보관된 기록 {available.length}개 중 {reportRecords?.length ?? 0}개를 참고했습니다.</small>}
      {archive.key === fetchKey && archive.error && <p className="co-report-scope">일부 기록을 불러오지 못해 확인 가능한 자료만 정리했습니다. <button type="button" onClick={() => setArchiveRetry(value => value + 1)}>Retry</button></p>}
    </article> : <div className="co-empty" role="status"><p>{pending && model.empty ? '질문에 맞는 결과를 찾고 있습니다.' : reading ? '자료에서 질문에 대한 답을 정리하고 있습니다.' : query.trim() && model.empty ? '검색어와 일치하는 결과가 없습니다.' : model.message}</p></div>
      : <div className="co-association-content">
        <header className="co-association-heading">
          <div><span>CONNECTIONS</span><p>{pending ? '자료가 도착하는 대로 연결하고 있습니다.' : model.message}</p></div>
          {!!contextSources.length && <div className="co-association-sources" aria-label="그래프 출처">{contextSources.slice(0, 3).map(source =>
            onSource ? <button type="button" key={source.id} title={source.title} aria-label={`출처 보기: ${source.title}`} onClick={() => onSource(source.id)}>{source.title}<span aria-hidden="true">↗</span></button> : <span key={source.id}>{source.title}</span>
          )}{contextSources.length > 3 && <span>+{contextSources.length - 3} sources</span>}</div>}
        </header>
        <GraphRenderer graph={associated} view="board" selection={selection} onSelect={select} showPath={false} query="" />
      </div>}
  </section>;
}
