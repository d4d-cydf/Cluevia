import { useState } from 'react';
import type { WhySnapshot } from '../types/why-not';

type Edit = (change: (snapshot: WhySnapshot) => void) => void;
const numberOrNull = (value: string) => value.trim() === '' ? null : Number(value);
export const estimateBasisLabels = { MODEL_ESTIMATE: 'AI estimate', EXPERT_ESTIMATE: 'Manual estimate', CALIBRATED: 'Calibrated', UNASSESSED: 'Not rated' };

/** Explicit inputs with the product's disclosed neutral LR and prior defaults. */
export default function BayesReviewFields({ snapshot, locked, edit }: { snapshot: WhySnapshot; locked: boolean; edit: Edit }) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const requirements = snapshot.nodes.filter(node => node.id === snapshot.rootId);
  const goalEdit: Edit = change => edit(copy => {
    if (copy.policy.bayes?.target !== 'GOAL' && new Set(copy.bindings.map(binding => binding.requirementId)).size > 1) {
      copy.bindings.forEach(binding => { binding.likelihood = { ratio: 1, basis: 'UNASSESSED', reason: '이전 조건별 우도비는 전체 결론에 자동 재사용하지 않고 중립값으로 시작합니다.' }; });
    }
    copy.policy.bayes ??= { priors: [], conditionalIndependence: [] };
    copy.policy.bayes.target = 'GOAL';
    change(copy);
  });
  function prior(nodeId: string, change: { probability?: number | null; reason?: string }) {
    goalEdit(copy => {
      copy.policy.bayes ??= { priors: [], conditionalIndependence: [] };
      const existing = copy.policy.bayes.priors.find(item => item.nodeId === nodeId);
      if (existing) {
        Object.assign(existing, change, { basis: existing.basis === 'CALIBRATED' ? 'CALIBRATED' : 'EXPERT_ESTIMATE' });
        delete existing.estimation;
      } else copy.policy.bayes.priors.push({ nodeId, probability: .5, reason: '', ...change, basis: 'EXPERT_ESTIMATE' });
    });
  }
  function likelihood(index: number, change: { ratio?: number | null; reason?: string }) {
    goalEdit(copy => {
      const value = copy.bindings[index].likelihood;
      copy.bindings[index].likelihood = { ...value, ratio: value?.ratio ?? 1, reason: value?.reason ?? '', ...change, basis: value?.basis === 'CALIBRATED' ? 'CALIBRATED' : 'EXPERT_ESTIMATE', hypothesisId: copy.rootId };
      delete copy.bindings[index].likelihood!.estimation;
    });
  }
  return <fieldset disabled={locked} className="wn-bayes-fields"><legend>Likelihood model <span>우도비 보정</span></legend>
    <p>LR′ = r × LR + (1 − r). 출처 등급의 고정 계수 r로 우도비를 보정합니다. A 1.0 · B 0.8 · C 0.6 · D 0.4 · E 0.2 · F 0.0이며, 미평가는 r=0으로 반영합니다. LR은 1이 중립, 1보다 크면 지지, 1보다 작으면 반증입니다. 별도 입력이 없으면 LR 1, 사전확률 0.5를 사용하며 가정으로 기록합니다.</p>
    <p>AI estimate는 모델의 추정, Manual estimate는 사용자의 추정, Calibrated는 관측 데이터로 보정한 값입니다. 모델이 제안한 값이나 산정 근거를 직접 수정하면 Manual estimate로 기록합니다.</p>
    {snapshot.policy.bayes?.target !== 'GOAL' && new Set(snapshot.bindings.map(binding => binding.requirementId)).size > 1 && <p>이전 조건별 우도비는 전체 결론의 값으로 재사용하지 않습니다. 수정할 때 중립값 1로 전환한 뒤, 결론 H에 맞는 우도비를 다시 입력합니다.</p>}
    {snapshot.bindings.map((binding, index) => <article key={binding.id}>
      <h4>{snapshot.goal}</h4><blockquote>{binding.quote}</blockquote>
      {binding.likelihood?.hypothesisId && binding.likelihood.hypothesisId !== snapshot.rootId && <p>이 값은 이전 하위 조건에 대한 추정입니다. 수치나 산정 근거를 수정하면 전체 결론 기준으로 저장됩니다.</p>}
      <div className="wn-fields"><label>원 우도비 LR<input aria-label={`${binding.id} 우도비`} type="number" min="0" step="any" value={binding.likelihood?.ratio ?? 1} onChange={event => likelihood(index, { ratio: numberOrNull(event.target.value) })} /></label>
      <label>산정 방식<select aria-label={`${binding.id} 우도비 산정 방식`} value={binding.likelihood?.basis ?? 'UNASSESSED'} onChange={event => goalEdit(copy => {
        const basis = event.target.value as NonNullable<typeof binding.likelihood>['basis'];
        const value = copy.bindings[index].likelihood;
        copy.bindings[index].likelihood = { ...value, ratio: basis === 'UNASSESSED' ? null : value?.ratio ?? 1, reason: value?.reason ?? '', basis, hypothesisId: copy.rootId };
        if (basis !== value?.basis) delete copy.bindings[index].likelihood!.estimation;
      })}>{Object.entries(estimateBasisLabels).map(([basis, label]) => <option key={basis} value={basis} disabled={basis === 'MODEL_ESTIMATE'}>{label}</option>)}</select></label>
      <label className="wn-wide">우도비 산정 근거<textarea aria-label={`${binding.id} 우도비 근거`} value={binding.likelihood?.reason ?? ''} maxLength={2000} onChange={event => likelihood(index, { reason: event.target.value })} /></label></div>
    </article>)}
    <h4>Prior · 결론의 사전확률</h4><p>전체 결론 H에 대한 하나의 사전확률입니다. 각 우도비도 같은 결론 H를 기준으로 입력하고, 자료를 반영하기 전의 판단 근거를 기록합니다.</p>
    {requirements.map(node => {
      const value = snapshot.policy.bayes?.priors.find(item => item.nodeId === node.id);
      const bindings = snapshot.bindings;
      const independence = snapshot.policy.bayes?.conditionalIndependence.find(item => item.requirementId === node.id);
      return <article key={node.id}><h4>{node.statement}</h4><div className="wn-fields">
        <label>사전확률 (0–1)<input aria-label={`${node.id} 사전확률`} type="number" min="0" max="1" step="0.01" value={value?.probability ?? .5} onChange={event => prior(node.id, { probability: numberOrNull(event.target.value) })} /><small aria-label={`${node.id} 사전확률 산정 방식`}>{estimateBasisLabels[value?.basis ?? (value?.probability != null ? 'EXPERT_ESTIMATE' : 'UNASSESSED')]}</small></label>
        <label className="wn-wide">사전확률 근거<textarea aria-label={`${node.id} 사전확률 근거`} value={value?.reason ?? ''} maxLength={2000} onChange={event => prior(node.id, { reason: event.target.value })} /></label>
      </div>{bindings.length > 1 && <div className="wn-bayes-independence"><p>서로 다른 관측의 LR을 곱하려면 전체 결론 H가 참일 때와 거짓일 때 모두 자료들이 공동으로 조건부 독립이라는 근거가 필요합니다. 같은 원자료·공유 관측은 이 설정으로도 중복 가산하지 않습니다.</p>
        <label>조건부 독립 근거<textarea aria-label={`${node.id} 조건부 독립 근거`} value={reasons[node.id] ?? independence?.reason ?? ''} maxLength={2000} onChange={event => setReasons(old => ({ ...old, [node.id]: event.target.value }))} /></label>
        <div className="wn-actions"><button type="button" disabled={!(reasons[node.id] ?? independence?.reason)?.trim()} onClick={() => goalEdit(copy => {
          copy.policy.bayes ??= { priors: [], conditionalIndependence: [] };
          copy.policy.bayes.conditionalIndependence = [...copy.policy.bayes.conditionalIndependence.filter(item => item.requirementId !== node.id), { requirementId: node.id, bindingIds: bindings.map(binding => binding.id), reason: (reasons[node.id] ?? independence?.reason ?? '').trim() }];
        })}>Apply assumption</button>{independence && <button type="button" onClick={() => goalEdit(copy => { copy.policy.bayes!.conditionalIndependence = copy.policy.bayes!.conditionalIndependence.filter(item => item.requirementId !== node.id); })}>Remove</button>}</div>
        {independence && <small>저장 대상 자료 {independence.bindingIds.length}개 · 새로운 자료는 다시 확인해야 합니다.</small>}
      </div>}</article>;
    })}
  </fieldset>;
}
