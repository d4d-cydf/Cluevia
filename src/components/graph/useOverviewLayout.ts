import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../services/api-client';
import type { WhyOverviewLayout } from '../../types/why-not';

type Positions = WhyOverviewLayout['positions'];
interface Session {
  endpoint: string; controller: AbortController; layout: WhyOverviewLayout | null;
  pending: Positions | null; saving: boolean; failed: boolean;
}

/** Layout is persisted separately from immutable evidence and assessment history. */
export function useOverviewLayout(jobId?: string) {
  const [positions, setPositions] = useState<Positions>();
  const [status, setStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const current = useRef<Session | null>(null);
  async function flush(session: Session) {
    if (session.saving || !session.layout || session.failed || session.controller.signal.aborted) return;
    session.saving = true;
    while (session.pending && !session.controller.signal.aborted) {
      const next = session.pending; session.pending = null; setStatus('saving');
      try {
        const saved: WhyOverviewLayout = await apiRequest<WhyOverviewLayout>(session.endpoint, { method: 'PUT', signal: session.controller.signal,
          body: JSON.stringify({ revision: session.layout!.revision, positions: next }) });
        if (session.controller.signal.aborted) break;
        session.layout = saved; setStatus(session.pending ? 'saving' : 'saved'); setError('');
      } catch (failure) {
        if (session.controller.signal.aborted) break;
        session.pending ??= next; session.failed = true; setStatus('error');
        setError(failure instanceof Error ? failure.message : '노드 위치를 저장하지 못했습니다.'); break;
      }
    }
    session.saving = false;
  }
  async function read(session: Session) {
    try {
      const saved: WhyOverviewLayout = await apiRequest<WhyOverviewLayout>(session.endpoint, { signal: session.controller.signal });
      if (session.controller.signal.aborted) return;
      if (!saved || !Number.isSafeInteger(saved.revision) || !saved.positions || typeof saved.positions !== 'object') throw new Error('저장된 그래프 위치를 확인하지 못했습니다.');
      session.layout = saved; session.failed = false; setError('');
      if (session.pending) session.pending = { ...saved.positions, ...session.pending };
      else setPositions(saved.positions);
      setStatus(session.pending ? 'saving' : 'saved'); void flush(session);
    } catch (failure) {
      if (session.controller.signal.aborted) return;
      session.failed = true; setStatus('error'); setError(failure instanceof Error ? failure.message : '저장된 그래프 위치를 불러오지 못했습니다.');
    }
  }
  useEffect(() => {
    setPositions(undefined); setError(''); setStatus('loading');
    if (!jobId) { current.current = null; return; }
    const session: Session = { endpoint: `/api/jobs/${encodeURIComponent(jobId)}/why-not/layout`, controller: new AbortController(), layout: null, pending: null, saving: false, failed: false };
    current.current = session; void read(session);
    return () => { session.controller.abort(); };
  }, [jobId]);
  const save = (next: Positions) => {
    const session = current.current; if (!session || session.controller.signal.aborted) return;
    setPositions(next); session.pending = next; void flush(session);
  };
  const retry = () => { const session = current.current; if (session) void read(session); };
  return { positions, status, error, save, retry };
}
