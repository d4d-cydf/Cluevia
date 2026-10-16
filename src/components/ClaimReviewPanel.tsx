import { useEffect, useState } from 'react';
import type { GraphEdge } from '../types/graph';
import type { ClaimReview } from '../types/claims';
import { stanceLabels } from '../lib/claim';
import { apiRequest } from '../services/api-client';

export default function ClaimReviewPanel({ edge, jobId, onSaved }: { edge: GraphEdge; jobId?: string; onSaved?: (review: ClaimReview) => void }) {
  const [review, setReview] = useState<ClaimReview['status']>('unreviewed');
  const [note, setNote] = useState(''); const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => { setReview(edge.review?.status ?? 'unreviewed'); setNote(edge.review?.note ?? ''); }, [edge.id, edge.review?.status, edge.review?.note]);
  async function save() {
    if (!jobId) return; setSaving(true); setMessage('');
    try { const result = await apiRequest<{ review: ClaimReview }>(`/api/jobs/${encodeURIComponent(jobId)}/claims/${encodeURIComponent(edge.id)}/review`, { method: 'POST', body: JSON.stringify({ status: review, note }) }); onSaved?.(result.review); setMessage('검토 기록을 저장했습니다. 이전 기록도 보존됩니다.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }
  return <section className="claim-review" aria-label="관계 주장과 검토"><h2>주장과 검토</h2><dl>
    <div><dt>원문의 태도</dt><dd>{edge.claim ? stanceLabels[edge.claim.stance] : '미분류 · 원문 확인 필요'}</dd></div>
    <div><dt>주장 주체</dt><dd>{edge.claim?.attributedTo ?? '원문에 명시되지 않음'}</dd></div>
    <div><dt>관계 유효 기간</dt><dd>{edge.claim?.validFrom ?? '시작 불명'} → {edge.claim?.validTo ?? '종료 불명'}</dd></div>
    <div><dt>발행일</dt><dd>{edge.claim?.publishedAt ?? '불명'}</dd></div>
    <div><dt>재인용 출처</dt><dd>{edge.claim?.derivedFrom ?? '명시되지 않음 · 독립 출처로 확정하지 않음'}</dd></div>
  </dl>{jobId && <><label>분석가 검토 <select value={review} disabled={saving} onChange={event => setReview(event.target.value as ClaimReview['status'])}><option value="unreviewed">미검토 / 기존 판단 되돌리기</option><option value="supported">근거 지지</option><option value="disputed">이견 있음</option><option value="needs-review">추가 확인 필요</option></select></label><label>판단 근거<textarea value={note} maxLength={2000} disabled={saving} onChange={event => setNote(event.target.value)} rows={2} /></label><button type="button" disabled={saving} onClick={() => void save()}>{saving ? '저장 중…' : '검토 저장'}</button><p role="status">{message}</p></>}</section>;
}
