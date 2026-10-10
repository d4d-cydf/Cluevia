import { stanceLabels } from '../lib/claim';
import type { OntologyEvidence } from '../types/ontology';
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../services/api-client';
import type { AnalysisCase, AnalysisRecordDetail, RecordDocument } from '../types/analysis-case';
import './analysis-records.css';

export function downloadCase(value: AnalysisCase) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${value.jobId}.case.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type EvidenceSeek = { id: string; offset: number; quote: string };
function SourceText({ jobId, number, document, seek }: { jobId: string; number: number; document: RecordDocument; seek?: EvidenceSeek }) {
  const [page, setPage] = useState(document);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(offset: number) {
    setBusy(true); setError('');
    try { setPage((await apiRequest<{ document: RecordDocument }>(`/api/jobs/${encodeURIComponent(jobId)}/records/${number}/document?id=${encodeURIComponent(document.id)}&offset=${offset}`)).document); }
    catch (error) { setError(error instanceof Error ? error.message : '원문을 불러오지 못했습니다.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (seek?.id === document.id) void load(Math.max(0, seek.offset - 200)); }, [seek]);
  const highlight = seek?.id === document.id ? page.text.indexOf(seek.quote) : -1;
  return <details className="cr-source" open={seek?.id === document.id ? true : undefined}><summary>{document.name} · 원문 {document.totalChars.toLocaleString()}자</summary><pre>{highlight < 0 ? page.text : <>{page.text.slice(0, highlight)}<mark>{seek!.quote}</mark>{page.text.slice(highlight + seek!.quote.length)}</>}</pre><div className="cr-pagination"><button type="button" disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - 12000))}>이전 원문</button><span>{page.offset + (page.totalChars ? 1 : 0)}–{page.offset + page.text.length} / {page.totalChars}</span><button type="button" disabled={busy || page.offset + page.text.length >= page.totalChars} onClick={() => void load(page.offset + page.text.length)}>다음 원문</button></div>{error && <p role="alert">{error}</p>}</details>;
}

export default function AnalysisRecords({ value, selected, onSelect, revision }: { value: AnalysisCase; selected: number | null; revision: number; onSelect: (record: number) => void }) {
  const [query, setQuery] = useState('');
  const [seek, setSeek] = useState<EvidenceSeek>();
  const [recordPage, setRecordPage] = useState(0);
  useEffect(() => { setSeek(undefined); }, [selected]);
  useEffect(() => { setRecordPage(0); }, [query]);
  function quotation(evidence: OntologyEvidence, index: number) {
    return <blockquote key={index}>{evidence.quote}{evidence.textHash && <small>분석 텍스트 SHA-256 · {evidence.textHash}</small>}{evidence.ambiguous && <small>같은 인용이 반복됩니다. 원문 위치를 확인하세요.</small>}{evidence.sourceId && evidence.spans?.map(span => <button key={span.start} type="button" onClick={() => setSeek({ id: evidence.sourceId!, offset: span.start, quote: evidence.quote })}>원문 위치 {span.start}–{span.end}</button>)}</blockquote>;
  }
  const [detail, setDetail] = useState<AnalysisRecordDetail>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const panel = useRef<HTMLDetailsElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const status = value.records.find(record => record.number === selected)?.status;
  useEffect(() => {
    if (selected === null) return;
    if (panel.current) panel.current.open = true;
    const controller = new AbortController(); setDetail(undefined); setError('');
    void apiRequest<AnalysisRecordDetail>(`/api/jobs/${encodeURIComponent(value.jobId)}/records/${selected}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setDetail(result);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '기록을 불러오지 못했습니다.'); });
    detailRef.current?.scrollIntoView({ block: 'nearest' });
    return () => controller.abort();
  }, [value.jobId, selected, status, refresh, revision]);
  const records = value.records.filter(record => `${record.number} ${record.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <details ref={panel} className="cr-records"><summary>분석 기록 · {value.records.length}</summary>
    <p>기록을 열어도 전체 그래프는 유지됩니다.</p>
    <input type="search" aria-label="분석 기록 검색" placeholder="기록 번호 또는 제목" value={query} onChange={event => setQuery(event.target.value)} />
    <ol className="cr-list" aria-label="분석 기록 목록">{records.slice(recordPage * 100, (recordPage + 1) * 100).map(record => <li key={record.number}><button type="button" aria-pressed={selected === record.number} onClick={() => onSelect(record.number)}><strong>기록 {record.number} · {record.title}</strong><small>{record.status === 'saved' ? `객체 ${record.nodeCount} · 관계 ${record.edgeCount}` : record.status === 'empty' ? '처리 완료 · 객체·관계 없음' : '처리 대기'}</small></button></li>)}</ol>
    {records.length > 100 && <div className="cr-pagination"><button type="button" disabled={!recordPage} onClick={() => setRecordPage(value => value - 1)}>이전 기록</button><span>{recordPage + 1} / {Math.ceil(records.length / 100)}</span><button type="button" disabled={(recordPage + 1) * 100 >= records.length} onClick={() => setRecordPage(value => value + 1)}>다음 기록</button></div>}
    {selected !== null && <div ref={detailRef} className="cr-detail" aria-label="분석 기록 상세"><h2>기록 {selected}</h2>
      {error ? <p role="alert">{error} <button type="button" onClick={() => setRefresh(count => count + 1)}>다시 불러오기</button></p> : !detail ? <p role="status">기록을 불러오는 중…</p> : <>
        <h3>{detail.record.title}</h3><p>{detail.summary}</p>{detail.limitations.map((text, index) => <p className="cr-limitation" key={index}>{text}</p>)}
        {detail.record.status === 'pending' && <p>아직 분석 결과가 저장되지 않았습니다.</p>}
        {detail.documents.map(document => <SourceText key={`${selected}-${document.id}`} jobId={value.jobId} number={selected} document={document} seek={seek} />)}
        {!!detail.claims.length && <details className="cr-claims"><summary>객체별 추출 근거 · {detail.claims.length}</summary>{detail.claims.map(claim => <article key={claim.nodeId}><h4>{detail.graph?.nodes.find(node => node.id === claim.nodeId)?.label ?? claim.nodeId}</h4><p>{claim.description}</p><dl>{Object.entries(claim.properties).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>{claim.evidence.map(quotation)}</article>)}</details>}
        {!!detail.graph?.edges.length && <details className="cr-claims"><summary>관계별 주장 · {detail.graph.edges.length}</summary>{detail.graph.edges.map(edge => <article key={edge.id}><h4>{edge.label} · {edge.claim ? stanceLabels[edge.claim.stance] : ''} · {edge.status === 'inferred' ? '추론' : '출처 보고'}</h4><p>{detail.graph!.nodes.find(node => node.id === edge.source)?.label} → {detail.graph!.nodes.find(node => node.id === edge.target)?.label}</p><p>{edge.description}</p>{detail.relationClaims.find(claim => claim.localId === edge.id)?.evidence.map(quotation)}</article>)}</details>}
      </>}
    </div>}
  </details>;
}
