import { useState } from 'react';
import type { OntologyEntityDetail } from '../types/ontology';
import { apiRequest } from '../services/api-client';

export default function IdentityCandidates({ entity, onRefresh, onSelect }: { entity: OntologyEntityDetail; onRefresh: () => void; onSelect: (id: string) => void }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function review(target: string, status: string) {
    setBusy(true); setError('');
    try { await apiRequest(`/api/ontology/entities/${encodeURIComponent(entity.id)}/identity`, { method: 'POST', body: JSON.stringify({ target, status, note }) }); onRefresh(); }
    catch (error) { setError(error instanceof Error ? error.message : '판단을 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  if (!entity.identityCandidates?.length) return null;
  return <section className="onto-detail-section"><h3>다른 케이스의 동일 객체 후보</h3><p>일치하는 식별자가 있는 후보입니다. 식별자 발급 범위와 원문을 확인하세요. 연결해도 각 케이스의 원본 객체와 주장은 보존됩니다.</p><label>판단 근거<textarea rows={2} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
    {entity.identityCandidates.map(candidate => <article className="onto-claim" key={candidate.id}><button type="button" onClick={() => onSelect(candidate.id)}>{candidate.label} · {candidate.type} ↗</button><p>{candidate.reasons.join(' · ')}</p><p>{candidate.status === 'linked' ? '동일 객체 연결됨' : candidate.status === 'rejected' ? '다른 객체로 판단' : '미검토'}{candidate.note ? ` · ${candidate.note}` : ''}</p><button type="button" disabled={busy} onClick={() => void review(candidate.id, 'linked')}>같은 객체로 연결</button> <button type="button" disabled={busy} onClick={() => void review(candidate.id, 'rejected')}>다른 객체</button> <button type="button" disabled={busy} onClick={() => void review(candidate.id, 'unreviewed')}>판단 되돌리기</button></article>)}
    {error && <p role="alert">{error}</p>}</section>;
}
