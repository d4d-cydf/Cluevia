'use client';

import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';


import { useId, useState } from 'react';
import { FigureFrame } from './research-figures';

export function SupportExplorer({number,language='ko'}: {number:string;language?:DocumentLanguage}) {
  const id=useId();
  const [a,setA]=useState(0.8),[b,setB]=useState(0.6);
  const [independent,setIndependent]=useState(true);
  const andLow=Math.max(0,a+b-1),andHigh=Math.min(a,b),orLow=Math.max(a,b),orHigh=Math.min(1,a+b);
  const results=[
    {name:'AND',low:independent?a*b:andLow,high:independent?a*b:andHigh,formula:independent?`${a.toFixed(2)} × ${b.toFixed(2)}`:'max(0, p₁+p₂−1) … min(p₁,p₂)'},
    {name:'OR',low:independent?1-(1-a)*(1-b):orLow,high:independent?1-(1-a)*(1-b):orHigh,formula:independent?`1 − (1−${a.toFixed(2)})(1−${b.toFixed(2)})`:'max(p₁,p₂) … min(1,p₁+p₂)'},
  ];
  return <FigureFrame language={language} number={number} title="입력과 독립성 가정을 바꾸어 보는 계산" caption="조절값은 설명용 모형 입력이다. 의존성 미상에서 표시하는 범위는 입력을 주변확률로 해석할 수 있을 때의 두 변수 경계다. 일반적인 제품 점수나 복잡한 DAG에 이 범위를 그대로 적용할 수 있다는 뜻은 아니다.">
    <div className="research-explorer">
      <div className="research-sliders">{[{name:'p₁',value:a,set:setA},{name:'p₂',value:b,set:setB}].map((p,i)=><label key={p.name} htmlFor={`${id}-${i}`}><span>{p.name}<output>{p.value.toFixed(2)}</output></span><input id={`${id}-${i}`} aria-label={`${p.name} ${translateText('입력값', language)}`} type="range" min={0} max={1} step={0.01} value={p.value} onChange={e=>p.set(Number(e.target.value))}/></label>)}</div>
      <fieldset className="research-switch"><legend>결합 모형</legend><label><input type="radio" name={`${id}-model`} checked={independent} onChange={()=>setIndependent(true)}/> 독립 가정</label><label><input type="radio" name={`${id}-model`} checked={!independent} onChange={()=>setIndependent(false)}/> 의존성 미상</label></fieldset>
      <div className="research-score-grid" aria-live="polite" aria-atomic="true">{results.map(r=><div className="research-score" key={r.name}>
        <span>{r.name}</span><output data-score={r.name}>{independent?r.low.toFixed(3):`${r.low.toFixed(3)} – ${r.high.toFixed(3)}`}</output>
        <div className="research-score-track" aria-hidden="true"><i style={{width:`${r.low*100}%`}}/>{!independent&&<b style={{left:`${r.low*100}%`,width:`${(r.high-r.low)*100}%`}}/>}</div>
        <small>{r.formula}</small>
      </div>)}</div>
      <p className="research-control-note">{independent?'두 입력의 독립성을 가정한 단일 계산값이다.':'음영은 가능한 범위다. 입력값만으로 그 안의 한 점을 확정할 수 없다.'}</p>
    </div>
  </FigureFrame>;
}

export function WitnessExplorer({number,language='ko'}: {number:string;language?:DocumentLanguage}) {
  const [available,setAvailable]=useState({a:true,b:true,c:true});
  const candidates=available.c?(['a','b'] as const).filter(key=>available[key]).map(key=>`{${key}, c}`):[];
  return <FigureFrame language={language} number={number} title="현재 자료만으로 후보 집합 구성하기" caption="AND(OR(a,b),c)의 자료 존재 여부를 바꾸어 볼 수 있다. c가 없으면 a와 b가 있어도 후보가 없다. 여기서 생성된 조합은 자료 존재 단계의 후보이며, 적합성·사건·출처 검사를 통과한 완성 체인이 아니다.">
    <div className="research-explorer">
      <div className="witness-expression"><span>H</span><i>=</i><span>(a ∨ b)</span><i>∧</i><span>c</span></div>
      <fieldset className="research-switch"><legend>현재 확보된 자료</legend>{(['a','b','c'] as const).map(key=><label key={key}><input type="checkbox" checked={available[key]} onChange={e=>setAvailable(previous=>({...previous,[key]:e.target.checked}))}/>{key}{key==='c'?' · 필수 연결':' · 대안'}</label>)}</fieldset>
      <div className={`witness-output ${candidates.length?'':'is-empty'}`} aria-live="polite" aria-atomic="true"><span>F(H) · 판정 전 후보</span><strong data-witness-count={candidates.length}>{candidates.length?candidates.join('   '):'∅'}</strong><p>{candidates.length?`${candidates.length} ${translateText('개 조합을 다음 관문에서 평가한다.', language)}`:'EVIDENCE_MISSING · 필수 요구를 유지하고 구체적인 자료를 요청한다.'}</p></div>
    </div>
  </FigureFrame>;
}
