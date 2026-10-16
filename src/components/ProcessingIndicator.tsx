import { useEffect, useState } from 'react';
import './processing-indicator.css';

const hints = {
  whyNot: ['주장을 구성하는 필수 조건과 원문 인용을 대조합니다.', '부족한 자료와 사건 연결 조건을 정리합니다.', '출처 등급과 점수가 미확정이면 판정을 보류합니다.'],
  connecting: ['서버에서 마지막으로 저장한 진행 상태를 불러옵니다.', '이 화면을 다시 열어도 서버의 분석 작업은 유지됩니다.'],
  queued: ['실행 순서가 되면 서버가 분석을 시작합니다.', '대기 시간은 자료량과 앞선 작업에 따라 달라집니다.'],
  designing: ['자료에 등장하는 객체·속성·관계의 구조를 정의하는 단계입니다.', '설계가 끝나면 원문의 근거를 그래프에 연결합니다.', '자료가 많거나 구조가 복잡하면 이 단계가 길어질 수 있습니다.'],
  preparing: ['원문을 분석 가능한 구간으로 준비하는 단계입니다.', '준비가 끝나면 실제로 처리한 구간 수를 표시합니다.'],
  extracting: ['원문에서 객체와 관계를 찾는 단계입니다.', '부분 결과는 검증과 저장을 마친 뒤 화면에 나타납니다.', '표시되는 처리량은 서버에서 확인한 구간 수입니다.'],
  validating: ['추출한 관계의 출처와 데이터 구조를 확인하는 단계입니다.', '근거 검증을 통과한 결과부터 그래프에 반영합니다.'],
  saving: ['검증한 분석 결과를 저장하는 단계입니다.', '자료 구간마다 분석·검증·저장을 반복합니다.'],
  clarification: ['확인 질문으로 분석 대상과 범위를 구체화합니다.', '아직 그래프 분석은 시작하지 않았습니다.', '원하는 기간과 결과를 구체적으로 정하면 분석에 도움이 됩니다.'],
  chat: ['저장된 그래프와 원문을 바탕으로 답변을 준비합니다.', '답변이 도착하면 인용된 기록을 열어 근거를 확인할 수 있습니다.', '자료량과 질문의 범위에 따라 응답 시간이 달라집니다.'],
} as const;

export type ProcessingPhase = keyof typeof hints;

/** Guidance rotates; actual stages and completion always come from the server. */
export default function ProcessingIndicator({ phase, since, title, compact = false }: { phase: ProcessingPhase; since?: string; title?: string; compact?: boolean }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const timestamp = since ? Date.parse(since) : NaN;
  const elapsed = Math.max(0, Math.floor((now - (Number.isFinite(timestamp) ? timestamp : mountedAt)) / 1000));
  const index = Math.floor(Math.max(0, now - mountedAt) / 8000) % hints[phase].length;
  const duration = elapsed < 60 ? `${elapsed}초` : elapsed < 3600 ? `${Math.floor(elapsed / 60)}분 ${String(elapsed % 60).padStart(2, '0')}초` : `${Math.floor(elapsed / 3600)}시간 ${Math.floor(elapsed % 3600 / 60)}분`;
  return <div className={`processing-indicator${compact ? ' is-compact' : ''}`} data-phase={phase}>
    {title && <strong className="processing-title" role="status">{title}</strong>}
    <div className="processing-meta"><span><i className="processing-dots" aria-hidden="true"><b /><b /><b /></i>처리 안내</span><span className="processing-elapsed" aria-live="off">{phase === 'queued' ? '대기' : '경과'} {duration}</span></div>
    <p className="processing-hint" key={`${phase}-${index}`}>{hints[phase][index]}</p>
    <div className="processing-track" aria-hidden="true"><span /></div>
  </div>;
}
