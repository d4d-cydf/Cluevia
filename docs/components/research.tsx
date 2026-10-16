import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';
import type { ReactNode } from 'react';
import katex from 'katex';

export function Abstract({ children, keywords, language = 'ko' }: { children: ReactNode; keywords: string; language?: DocumentLanguage }) {
  return localizeNode(<section className="paper-abstract" aria-label="초록">
    <div className="paper-section-label"><span>ABSTRACT</span>{language !== 'en' && <span>초록</span>}</div>
    <div className="paper-abstract-body">{children}</div>
    <p className="paper-keywords"><strong>주제어</strong>{keywords}</p>
  </section>, language);
}

export function Equation({ number, label, expression, tex, language = 'ko' }: { language?: DocumentLanguage; number: string; label: string; expression?: string; tex?: string }) {
  const html = tex ? katex.renderToString(tex, { displayMode: true, output: 'htmlAndMathml', throwOnError: true, strict: 'error', trust: false }) : null;
  return localizeNode(<figure className="paper-equation not-prose" aria-label={`${label}, (${number})`}>
    <div className="paper-equation-content"><div className="paper-equation-label">{label}</div>
      {html ? <div className="paper-math-scroll notranslate" translate="no" tabIndex={0} role="region" aria-label={label} dangerouslySetInnerHTML={{ __html: html }}/> : <div className="paper-equation-expression notranslate" translate="no">{expression}</div>}
    </div>
    <figcaption>({number})</figcaption>
  </figure>, language);
}

export function ResearchPipeline({ language = 'ko' }: { language?: DocumentLanguage }) {
  const steps = [
    { number: '01', name: '문제의 형식화', english: 'FORMULATION', text: '목표 주장 · 사건 범위\n현재 자료의 고정' },
    { number: '02', name: '논리와 증거 연결', english: 'WHY-NOT TREE', text: '필수 조건 · 대안 경로\n실제 인용 연결 · 먼저 저장' },
    { number: '03', name: '공백의 진단', english: 'GAP FIND', text: '적합성 · 사건 · 계보\n공유 근거와 지지 수준' },
    { number: '04', name: '근거의 보완', english: 'GAP FILL', text: '검색 · 요청 · 설명\n새 버전에서 재평가' },
  ];
  return localizeNode(<figure className="paper-pipeline">
    <ol aria-label="Cluevia 알고리즘의 네 단계">{steps.map(step => <li key={step.number}>
      <span className="paper-pipeline-number">{step.number}</span><small>{step.english}</small>
      <strong>{step.name}</strong><p>{step.text}</p>
    </li>)}</ol>
    <div className="paper-feedback"><span aria-hidden="true">↳</span> 자료·판정·정책이 변경되면 새로운 snapshot으로 돌아가 재평가한다.</div>
    <figcaption><strong>그림 1.</strong> 목표 주장으로부터 공백을 도출하고 추가 자료를 평가에 환류시키는 처리 구조. 보완 액션의 수행과 공백의 해소는 별개의 사건이다.</figcaption>
  </figure>, language);
}
