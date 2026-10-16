import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../../services/api-client';
import type { OverviewConfidenceSummary } from '../../types/why-not';

const empty = (goal: string, reason: string, state: OverviewConfidenceSummary['state'] = 'unassessed'): OverviewConfidenceSummary => ({
  state, confidence: null, goal, reason, unknownReasons: [reason], inputs: [],
  policyVersion: null, assessmentVersion: null, evaluatedAt: null,
  assumptions: [], coverageNote: '', accepted: false,
});

/** Reads deterministic assessment results; this endpoint never starts model work. */
export function useOverviewConfidence({ jobId, goal, active, pending, revision }: {
  jobId?: string; goal: string; active: boolean; pending: boolean; revision: string;
}): OverviewConfidenceSummary {
  const [loaded, setLoaded] = useState<{ key: string; value: OverviewConfidenceSummary } | null>(null);
  const key = `${jobId ?? ''}/${goal}/${revision}`;
  useEffect(() => {
    if (!jobId || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const value = await apiRequest<OverviewConfidenceSummary>(`/api/jobs/${encodeURIComponent(jobId!)}/confidence`, { signal: controller.signal });
        if (!value || !['ready', 'unassessed', 'pending', 'incomplete', 'stale'].includes(value.state) || !Array.isArray(value.unknownReasons) || !Array.isArray(value.inputs)) throw new Error('신뢰도 평가 응답을 확인하지 못했습니다.');
        if (controller.signal.aborted) return;
        setLoaded({ key, value });
        if (value.state === 'pending' || pending) timer = setTimeout(() => void load(), 3000);
      } catch (failure) {
        if (controller.signal.aborted) return;
        // A failed refresh must not leave an old numeric score looking current.
        setLoaded({ key, value: empty(goal, failure instanceof Error ? failure.message : '신뢰도 평가를 불러오지 못했습니다.', 'stale') });
        timer = setTimeout(() => void load(), 10000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, active, pending, key, goal]);
  return useMemo(() => {
    if (pending) return empty(goal, '자료 처리와 평가 상태를 확인하고 있습니다. 처리가 끝나면 계산 결과를 갱신합니다.', 'pending');
    if (!jobId) return empty(goal, '저장된 출처·자료 평가가 없어 점수를 계산하지 않았습니다.');
    return loaded?.key === key ? loaded.value : empty(goal, '현재 자료의 신뢰도 평가를 확인하고 있습니다.', 'pending');
  }, [goal, jobId, pending, loaded, key]);
}
