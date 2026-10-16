import IdentityCandidates from '../components/IdentityCandidates';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo';
import { CaseSidebarToggle } from '../components/CaseSidebar';
import { apiRequest, setWorkspaceToken } from '../services/api-client';
import type { SystemStatus } from '../services/api-client';
import type { OntologyDefinition, OntologyEntityDetail, OntologyEntitySummary, OntologySummary, PropertyDefinition } from '../types/ontology';
import './ontology.css';

const legacyTypeNames: Record<string, string> = { vessel: '선박', organization: '조직', person: '인물', place: '장소', event: '사건', document: '문서', asset: '자산' };
const legacyTypeColors: Record<string, string> = { vessel: '#337e87', organization: '#805e91', person: '#b9823b', place: '#668451', event: '#ac5d44', document: '#788394', asset: '#927247' };
type OntologyResponse = { definitions?: OntologyDefinition[]; summary: OntologySummary; schema: { version: string; entityTypes: { id: string; label: string; color: string }[]; relationTypes: { id: string; label: string }[] } };

export default function OntologyScreen() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('entity');
  const definitionId = params.get('definition') || '';
  const [requestedDefinition, setRequestedDefinition] = useState<OntologyDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState('');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [ontology, setOntology] = useState<OntologyResponse | null>(null);
  const [entities, setEntities] = useState<OntologyEntitySummary[]>([]);
  const [selected, setSelected] = useState<OntologyEntityDetail | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  const locked = status?.authRequired && !status.authenticated;
  const definitions = ontology?.definitions || [];
  const definition = definitions.find(item => item.id === definitionId) || (requestedDefinition?.id === definitionId ? requestedDefinition : null);
  const visibleTypes = definition?.objectTypes || definitions.flatMap(item => item.objectTypes);
  const typeNames = { ...legacyTypeNames, ...Object.fromEntries(visibleTypes.map(item => [item.apiName, item.displayName])) };
  const typeColors = { ...legacyTypeColors, ...Object.fromEntries(visibleTypes.map(item => [item.apiName, item.color])) };
  const typeOptions = definition ? definition.objectTypes.map(item => item.apiName) : [...new Set([...(ontology?.summary.types.map(item => item.type) || []), ...visibleTypes.map(item => item.apiName)])];

  useEffect(() => {
    const controller = new AbortController();
    setError(''); setLoading(true);
    void (async () => {
      const system = await apiRequest<SystemStatus>('/api/system/status', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setStatus(system);
      if (!system.authenticated) { setLoading(false); return; }
      const result = await apiRequest<OntologyResponse>('/api/ontology', { signal: controller.signal });
      if (!controller.signal.aborted) setOntology(result);
    })().catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '지식을 불러오지 못했습니다.'); setLoading(false); } });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!status?.authenticated) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams(); if (query.trim()) search.set('q', query.trim()); if (type) search.set('type', type); if (definitionId) search.set('ontologyId', definitionId);
      void apiRequest<{ entities: OntologyEntitySummary[] }>(`/api/ontology/entities?${search}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setEntities(result.entities); setLoading(false); setError(''); } }).catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '객체 검색에 실패했습니다.'); setLoading(false); } });
    }, query ? 250 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, type, status, refresh, definitionId]);

  useEffect(() => {
    setDefinitionError('');
    if (!definitionId || !ontology || definitions.some(item => item.id === definitionId) || !status?.authenticated) return;
    const controller = new AbortController();
    void apiRequest<{ definition: OntologyDefinition }>(`/api/ontology/definitions/${encodeURIComponent(definitionId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setRequestedDefinition(result.definition); }).catch(error => { if (!controller.signal.aborted) setDefinitionError(error instanceof Error ? error.message : '온톨로지를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [definitionId, ontology, status?.authenticated]);

  useEffect(() => {
    setSelected(null); setDetailError('');
    if (!selectedId || !status?.authenticated) { setDetailLoading(false); return; }
    const controller = new AbortController(); setDetailLoading(true);
    void apiRequest<{ entity: OntologyEntityDetail }>(`/api/ontology/entities/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setSelected(result.entity); setDetailLoading(false); } }).catch(error => { if (!controller.signal.aborted) { setDetailError(error instanceof Error ? error.message : '객체를 불러오지 못했습니다.'); setDetailLoading(false); } });
    return () => controller.abort();
  }, [selectedId, status, refresh]);

  async function unlock(event: FormEvent) {
    event.preventDefault(); setUnlocking(true); setError('');
    try { setWorkspaceToken(accessKey); const result = await apiRequest<SystemStatus>('/api/system/status'); if (!result.authenticated) throw new Error('접속 키를 확인해주세요.'); setAccessKey(''); setRefresh(value => value + 1); }
    catch (error) { setError(error instanceof Error ? error.message : '연결하지 못했습니다.'); }
    finally { setUnlocking(false); }
  }
  const choose = (id: string) => {
    setParams(previous => { const next = new URLSearchParams(previous); next.set('entity', id); return next; });
    if (window.matchMedia('(max-width: 800px)').matches) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const chooseDefinition = (id: string) => { setType(''); setQuery(''); setParams(id ? { definition: id } : {}); };

  return <div className="onto-screen">
    <header className="onto-header"><div className="onto-header-left"><CaseSidebarToggle /><Link to="/" className="onto-brand" aria-label="Cluevia home"><BrandLogo /></Link></div><span className="onto-header-title">WORKSPACE / ONTOLOGY</span><Link className="onto-new-case" to="/new">+ NEW CASE</Link></header>
    <main className="onto-main">
      <section className="onto-intro"><div><span className="onto-eyebrow">YOUR SHARED KNOWLEDGE</span><h1>Knowledge, connected.</h1><p>자료마다 설계한 객체 유형과 관계, 그 구조에 저장된 실제 근거를 함께 살펴보세요.</p></div><button type="button" className="onto-refresh" onClick={() => setRefresh(value => value + 1)}>새로고침 ↻</button></section>
      {locked && <form className="onto-unlock" onSubmit={event => void unlock(event)}><label htmlFor="ontology-workspace-key">워크스페이스 접속 키</label><div><input type="password" id="ontology-workspace-key" value={accessKey} onChange={event => setAccessKey(event.target.value)} required autoComplete="off" /><button type="submit" disabled={unlocking}>{unlocking ? '연결 중…' : '연결'}</button></div><small>접속 키는 현재 탭에서만 보관합니다.</small></form>}
      {error && <p className="onto-error" role="alert">{error}</p>}
      {ontology && <div className="onto-counts" aria-label="Ontology summary">{([{ key: 'entities', label: '객체', caption: 'OBJECTS' }, { key: 'relationships', label: '관계', caption: 'CONNECTIONS' }, { key: 'documents', label: '자료', caption: 'SOURCES' }, { key: 'graphs', label: '그래프', caption: 'CASE FILES' }] as const).map(item => <div key={item.key}><span>{item.caption}</span><strong>{ontology.summary[item.key].toLocaleString()}</strong><small>{item.label}</small></div>)}</div>}
      {!locked && ontology && <section className="onto-schema-catalog" aria-label="Ontology definitions">
        <div className="onto-schema-heading"><div><span className="onto-eyebrow">ONTOLOGY DEFINITIONS · {definitions.length}</span><h2>자료에 맞춰 설계한 구조</h2></div><label htmlFor="ontology-definition">온톨로지 선택<select id="ontology-definition" aria-label="온톨로지 선택" value={definitionId} onChange={event => chooseDefinition(event.target.value)}><option value="">전체 온톨로지의 객체</option>{definitions.map(item => <option key={item.id} value={item.id}>{item.displayName} · v{item.version}</option>)}{definition && !definitions.some(item => item.id === definition.id) && <option value={definition.id}>{definition.displayName} · v{definition.version}</option>}</select></label></div>
        {definitionError ? <p className="onto-error" role="alert">{definitionError}</p> : definition ? <DefinitionView definition={definition} /> : definitionId ? <p className="onto-muted" role="status">온톨로지를 불러오고 있습니다…</p> : definitions.length ? <div className="onto-definition-grid">{definitions.map(item => <button type="button" key={item.id} onClick={() => chooseDefinition(item.id)}><span>v{item.version} · {item.apiName}</span><strong>{item.displayName}</strong><p>{item.description}</p><small>객체 유형 {item.objectTypes.length} · 관계 유형 {item.linkTypes.length} ↗</small></button>)}</div> : <p className="onto-schema-empty">홈에서 자료나 질문을 입력하면 객체 유형·속성·관계를 설계해 여기에 저장합니다. 질문만으로 설계한 구조에는 실제 객체가 포함되지 않습니다.</p>}
      </section>}
      {!locked && <div className="onto-browser">
        <section className="onto-directory" aria-label="Ontology entities"><div className="onto-search"><label htmlFor="ontology-search">{definition ? `${definition.displayName}의 객체` : 'Search knowledge'}</label><input id="ontology-search" type="search" placeholder="이름 또는 설명으로 검색…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="onto-filters" aria-label="Entity types"><button type="button" aria-pressed={!type} onClick={() => setType('')}>전체</button>{typeOptions.map(key => <button type="button" key={key} aria-pressed={type === key} onClick={() => setType(key)}>{typeNames[key] || key}{ontology && !definition && <span>{ontology.summary.types.find(item => item.type === key)?.count || 0}</span>}</button>)}</div><div className="onto-list-heading"><span>OBJECT</span><span>CASES</span></div>
          {loading ? <p className="onto-list-message" role="status">지식을 불러오고 있습니다…</p> : entities.length ? <ul className="onto-entity-list">{entities.map(entity => <li key={entity.id}><button type="button" aria-pressed={selectedId === entity.id} onClick={() => choose(entity.id)}><i style={{ background: typeColors[entity.type] || '#8a7953' }} /><div><strong>{entity.label}</strong><span>{typeNames[entity.type] || entity.type} · {entity.description || '설명 없음'}</span></div><small>{entity.caseCount}</small><b aria-hidden="true">↗</b></button></li>)}</ul> : <div className="onto-list-message"><h2>{query || type ? '일치하는 객체가 없습니다.' : '아직 저장된 객체가 없습니다.'}</h2><p>{query || type ? '다른 검색어나 유형을 선택해보세요.' : definition ? '구조는 저장되어 있습니다. 이 분석에 근거 자료가 포함되면 실제 객체가 여기에 표시됩니다.' : '홈에서 자료로 그래프를 만들면 지식이 여기에 쌓입니다.'}</p></div>}
          <p className="onto-directory-note">온톨로지의 객체 유형과 기본 키를 기준으로 기록을 연결합니다. 서로 다른 온톨로지의 객체는 구분해 보관합니다.</p>
        </section>
        <aside className="onto-detail" ref={detailRef} aria-label="Ontology entity detail">
          {detailLoading ? <p className="onto-list-message" role="status">객체와 근거를 불러오고 있습니다…</p> : detailError ? <p className="onto-error" role="alert">{detailError}</p> : selected ? <>
            <div className="onto-detail-top"><span className="onto-type" style={{ color: typeColors[selected.type] }}>{typeNames[selected.type] || selected.type}</span><span>{selected.caseCount} CASES</span></div><h2>{selected.label}</h2><p className="onto-description">{selected.description}</p><Link className="onto-investigate" to={`/?question=${encodeURIComponent(`${selected.label}의 관계와 관련 사건을 근거와 함께 그래프로 만들어줘`)}`}>새 자료로 이 객체 분석하기 →</Link>
            <IdentityCandidates key={selected.id} entity={selected} onRefresh={() => setRefresh(value => value + 1)} onSelect={choose} />
            {!!selected.identifiers.length && <section className="onto-detail-section"><h3>IDENTIFIERS</h3><dl>{selected.identifiers.map(identifier => <div key={`${identifier.namespace}:${identifier.value}`}><dt>{identifier.namespace}</dt><dd>{identifier.value}</dd></div>)}</dl></section>}
            <section className="onto-detail-section"><h3>CONNECTIONS · {selected.relationships.length}</h3>{selected.relationships.length ? <ul className="onto-relations">{selected.relationships.map(relation => <li key={`${relation.graphId}:${relation.id}`}><div><span className={relation.status === 'inferred' ? 'is-inferred' : ''}>{relation.status === 'inferred' ? '추론' : '출처 보고'}</span><Link to={`/case/${encodeURIComponent(relation.graphId)}/board`}>그래프 ↗</Link></div><p><button type="button" onClick={() => choose(relation.source)}>{relation.sourceLabel}</button><span> {relation.label} → </span><button type="button" onClick={() => choose(relation.target)}>{relation.targetLabel}</button></p>{relation.evidence.slice(0, 1).map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}</li>)}</ul> : <p className="onto-muted">저장된 관계가 없습니다.</p>}</section>
            <section className="onto-detail-section"><h3>EVIDENCE & CASES · {selected.claims.length}</h3>{selected.claims.map((claim, index) => <article className="onto-claim" key={`${claim.graphId}:${claim.nodeId}:${index}`}><Link to={`/case/${encodeURIComponent(claim.graphId)}/board`}>{claim.graphTitle} ↗</Link><p>{claim.description}</p>{claim.ontologyId && <Link className="onto-claim-schema" to={`/ontology?definition=${encodeURIComponent(claim.ontologyId)}`}>온톨로지 v{claim.ontologyVersion || 1} 보기 ↗</Link>}{Object.keys(claim.properties).length > 0 && <dl>{Object.entries(claim.properties).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}{claim.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>{evidence.quote}<cite>출처 · {evidence.documentId}</cite></blockquote>)}<small>{claim.sourceIds.length}개 출처 · {new Date(claim.createdAt).toLocaleDateString('ko-KR')}</small></article>)}</section>
          </> : <div className="onto-detail-empty"><span aria-hidden="true">◎</span><h2>Follow the evidence.</h2><p>객체를 선택하면 관계, 식별자와<br />자료별 기록을 확인할 수 있습니다.</p></div>}
        </aside>
      </div>}
      <p className="onto-footer">이 워크스페이스에 저장된 자료와 그래프를 바탕으로 합니다. 생성된 관계의 의미는 원문과 함께 검토하세요.</p>
    </main>
  </div>;
}

function PropertyTable({ properties, primaryKey, titleProperty }: { properties: PropertyDefinition[]; primaryKey?: string; titleProperty?: string }) {
  if (!properties.length) return <p className="onto-muted">정의된 속성이 없습니다.</p>;
  return <div className="onto-property-scroll"><table className="onto-property-table"><thead><tr><th scope="col">속성</th><th scope="col">타입</th><th scope="col">조건·표시</th></tr></thead><tbody>{properties.map(property => <tr key={property.apiName}>
    <td><strong>{property.displayName}</strong><code>{property.apiName}</code>{property.description && <p>{property.description}</p>}</td>
    <td><code>{property.baseType}{property.elementType ? `<${property.elementType}>` : ''}</code>{property.valueType && <small>Value Type · {property.valueType}</small>}{property.sharedProperty && <small>Shared · {property.sharedProperty}</small>}</td>
    <td><div className="onto-schema-tags">{primaryKey === property.apiName && <span>기본 키</span>}{titleProperty === property.apiName && <span>표시 이름</span>}{property.required && <span>필수</span>}{property.visibility !== 'normal' && <span>{property.visibility === 'hidden' ? '숨김' : '주요 속성'}</span>}</div>{(property.constraints && Object.keys(property.constraints).length > 0 || property.fields?.length || property.renderHints.length > 0 || property.typeClasses.length > 0) && <details className="onto-property-metadata"><summary>검증·메타데이터</summary>{property.constraints && Object.keys(property.constraints).length > 0 && <pre>{JSON.stringify(property.constraints, null, 2)}</pre>}{!!property.fields?.length && <ul>{property.fields.map(field => <li key={field.apiName}>{field.displayName} · <code>{field.apiName}: {field.baseType}</code>{field.required ? ' · 필수' : ''}</li>)}</ul>}{property.renderHints.length > 0 && <p>표시 힌트: {property.renderHints.join(', ')}</p>}{property.typeClasses.length > 0 && <p>타입 분류: {property.typeClasses.map(item => `${item.kind}/${item.name}`).join(', ')}</p>}</details>}</td>
  </tr>)}</tbody></table></div>;
}

function DefinitionView({ definition }: { definition: OntologyDefinition }) {
  const names = Object.fromEntries(definition.objectTypes.map(item => [item.apiName, item.displayName]));
  return <div className="onto-definition">
    <div className="onto-definition-title"><div><span className="onto-eyebrow">{definition.apiName} · VERSION {definition.version}</span><h3>{definition.displayName}</h3><p>{definition.description}</p></div><span className="onto-definition-status">{definition.status === 'active' ? '사용 중' : definition.status === 'draft' ? '초안' : '이전 정의'}</span></div>
    <div className="onto-definition-overview"><span><strong>{definition.objectTypes.length}</strong> 객체 유형</span><span><strong>{definition.objectTypes.reduce((sum, item) => sum + item.properties.length, 0)}</strong> 속성</span><span><strong>{definition.linkTypes.length}</strong> 관계 유형</span><span><strong>{definition.interfaces.length}</strong> 인터페이스</span></div>
    <section className="onto-resource-section"><h4>객체 유형 <span>OBJECT TYPES</span></h4><div className="onto-object-types">{definition.objectTypes.map(object => <details className="onto-object-type" key={object.apiName} open={definition.objectTypes.length <= 3}>
      <summary><i style={{ background: object.color }} /><strong>{object.displayName}</strong><code>{object.apiName}</code><span>{object.properties.length}개 속성</span></summary><div className="onto-resource-body"><p>{object.description}</p><div className="onto-schema-tags"><span>기본 키 · {object.primaryKey}</span><span>표시 이름 · {object.titleProperty}</span><span>{object.identityScope === 'source' ? '자료 내부 식별' : '온톨로지 공통 식별'}</span>{object.implementsInterfaces.map(name => <span key={name}>Interface · {name}</span>)}{object.groups.map(name => <span key={name}>Group · {definition.groups.find(group => group.apiName === name)?.displayName || name}</span>)}</div><PropertyTable properties={object.properties} primaryKey={object.primaryKey} titleProperty={object.titleProperty} /><details className="onto-property-metadata"><summary>유형 메타데이터</summary><p>상태: {object.status} · 표시: {object.visibility} · 복수형: {object.pluralDisplayName} · 아이콘: {object.icon}</p></details></div>
    </details>)}</div></section>
    <section className="onto-resource-section"><h4>관계 유형 <span>LINK TYPES</span></h4>{definition.linkTypes.length ? <div className="onto-link-types">{definition.linkTypes.map(link => <article key={link.apiName}><div><strong>{link.displayName}</strong><code>{link.apiName}</code></div><p className="onto-link-endpoints"><span>{names[link.sourceType] || link.sourceType}<small>{link.sourceCardinality === 'one' ? '1' : 'N'}</small></span><b aria-hidden="true">→</b><span>{names[link.targetType] || link.targetType}<small>{link.targetCardinality === 'one' ? '1' : 'N'}</small></span></p><p>{link.description}</p><small>역방향 · {link.inverseDisplayName}</small></article>)}</div> : <p className="onto-muted">정의된 관계 유형이 없습니다.</p>}</section>
    <div className="onto-extension-sections">
      <details className="onto-extension"><summary>공유 속성 <span>{definition.sharedProperties.length}</span></summary><PropertyTable properties={definition.sharedProperties} /></details>
      <details className="onto-extension"><summary>인터페이스 <span>{definition.interfaces.length}</span></summary>{definition.interfaces.length ? definition.interfaces.map(contract => <article className="onto-extension-card" key={contract.apiName}><h5>{contract.displayName} <code>{contract.apiName}</code></h5><p>{contract.description}</p><div className="onto-schema-tags"><span>{contract.searchable ? '검색 가능 선언' : '검색 제외 선언'}</span>{contract.extendsInterfaces.map(name => <span key={name}>상속 · {name}</span>)}{contract.linkTypes.map(name => <span key={name}>관계 · {name}</span>)}</div><PropertyTable properties={contract.properties} /></article>) : <p className="onto-muted">정의된 인터페이스가 없습니다.</p>}</details>
      <details className="onto-extension"><summary>의미·검증 타입 <span>{definition.valueTypes.length}</span></summary>{definition.valueTypes.length ? definition.valueTypes.map(value => <article className="onto-extension-card" key={value.apiName}><h5>{value.displayName} <code>{value.apiName}</code></h5><p>{value.description}</p><span className="onto-muted">기본 타입 · {value.baseType}</span>{Object.keys(value.constraints).length > 0 && <pre>{JSON.stringify(value.constraints, null, 2)}</pre>}</article>) : <p className="onto-muted">정의된 Value Type이 없습니다.</p>}</details>
      <details className="onto-extension"><summary>객체 유형 그룹 <span>{definition.groups.length}</span></summary>{definition.groups.length ? definition.groups.map(group => <article className="onto-extension-card" key={group.apiName}><h5>{group.displayName} <code>{group.apiName}</code></h5><p>{group.description}</p></article>) : <p className="onto-muted">정의된 그룹이 없습니다.</p>}</details>
      <details className="onto-extension"><summary>액션·함수 선언 <span>{definition.actionTypes.length + definition.functions.length}</span></summary><p className="onto-capability-note">설계 초안입니다. 현재 액션과 함수는 실행되지 않으며 객체를 생성·수정·삭제하지 않습니다.</p>{[...definition.actionTypes.map(item => ({ ...item, kind: 'Action Type' })), ...definition.functions.map(item => ({ ...item, kind: 'Function' }))].map(item => <article className="onto-extension-card" key={`${item.kind}:${item.apiName}`}><h5>{item.displayName} <code>{item.apiName}</code></h5><div className="onto-schema-tags"><span>{item.kind}</span><span>초안 · 실행 미지원</span></div><p>{item.description}</p><p className="onto-muted">대상 · {item.objectTypes.map(name => names[name] || name).join(', ') || '미지정'}</p><PropertyTable properties={item.parameters} /></article>)}</details>
      {!!definition.sourceMappings.length && <details className="onto-extension"><summary>자료 컬럼 매핑 <span>{definition.sourceMappings.length}</span></summary>{definition.sourceMappings.map((mapping, index) => <article className="onto-extension-card" key={`${mapping.sourceName}:${mapping.objectType}:${index}`}><h5>{mapping.sourceName} → {names[mapping.objectType] || mapping.objectType}</h5><p className="onto-muted">식별 컬럼 · {mapping.identityColumns.join(', ')}</p><p className="onto-muted">원문에만 보관 · {mapping.retainedColumns?.join(', ') || '없음'}</p><dl className="onto-mapping-fields">{mapping.columns.map(column => <div key={`${column.column}:${column.property}`}><dt>{column.column}</dt><dd>→ {column.property}</dd></div>)}</dl></article>)}</details>}
    </div>
    <div className="onto-processing-policy"><strong>문서 분석 방식 · {definition.processing.textStrategy === 'jev-assisted' ? 'Codex + 선택적 Jev 판정' : 'Codex'}</strong><p>{definition.processing.rationale}</p>{definition.processing.textStrategy === 'jev-assisted' && <small>Jev 적용 가능 관계: {definition.processing.jevEligibleLinkTypes.map(name => definition.linkTypes.find(link => link.apiName === name)?.displayName || name).join(', ') || '없음'}. 적용 조건이 맞지 않거나 불확실하면 Codex로 분석합니다.</small>}</div>
  </div>;
}
