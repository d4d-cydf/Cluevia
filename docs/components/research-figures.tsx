import { localizeNode, translateText } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';
import type { ReactNode } from 'react';

type Node = { id: string; x: number; y: number; width?: number; title: string; detail: string; tone?: 'claim' | 'evidence' | 'gap' | 'neutral'; dashed?: boolean };
type Edge = { from: string; to: string; label?: string; path?: string; dashed?: boolean };
type Diagram = { title: string; caption: string; height: number; nodes: Node[]; edges: Edge[] };

const diagrams: Record<string, Diagram> = {
  'early-overview': {
    title: '기본 그래프의 조기 표시와 진단 시작 조건', height: 570,
    caption: '원문 저장 후 기본 그래프 생성과 주 분석을 병렬 실행한다. 기본 그래프는 준비되는 즉시 표시하지만, Cluevia 진단은 두 작업이 모두 완료되어야 시작한다. 어느 작업이 먼저 끝나는지는 응답 시간에 따라 달라진다.',
    nodes: [
      { id: 'input', x: 205, y: 15, width: 310, title: '입력 원문·URL 읽기 결과 저장', detail: 'onInputsReady · 실제 자료만 전달', tone: 'evidence' },
      { id: 'base', x: 20, y: 125, width: 310, title: '기본 Why-not 그래프 생성', detail: '논리·인용 연결 · 판정은 UNREVIEWED', tone: 'claim' },
      { id: 'main', x: 390, y: 125, width: 310, title: '주 분석 실행', detail: '온톨로지 설계 · 객체·관계 추출', tone: 'neutral' },
      { id: 'saved', x: 20, y: 245, width: 310, title: '기본 그래프 저장·즉시 표시', detail: 'graph-ready · Overview ready', tone: 'evidence' },
      { id: 'completed', x: 390, y: 245, width: 310, title: '주 분석 완료 확인', detail: 'completed · 동일 입력 확인', tone: 'neutral' },
      { id: 'review', x: 205, y: 365, width: 310, title: '자료 판정·Claude Low·공백 계산', detail: '두 조건 충족 → Cluevia loading', tone: 'claim' },
      { id: 'ready', x: 205, y: 485, width: 310, title: '공백·점수·애니메이션 저장', detail: 'preparation.ready → Cluevia on', tone: 'evidence' },
    ],
    edges: [
      { from: 'input', to: 'base', path: 'M 310 75 V 100 H 175 V 125' },
      { from: 'input', to: 'main', path: 'M 410 75 V 100 H 545 V 125' },
      { from: 'base', to: 'saved' }, { from: 'main', to: 'completed' },
      { from: 'saved', to: 'review', path: 'M 175 305 V 335 H 310 V 365' },
      { from: 'completed', to: 'review', path: 'M 545 305 V 335 H 410 V 365' },
      { from: 'review', to: 'ready' },
    ],
  },
  tree: {
    title: '주장, 논리 조건, 실제 증거의 구분', height: 345,
    caption: 'H는 C1과 C2를 모두 요구한다. C1에는 수령증과 로그라는 대안이 있지만 C2의 자료는 아직 없다. 점선 상자는 확보된 증거가 아니라 보존해야 할 증거 요구를 나타낸다.',
    nodes: [
      {id:'h',x:255,y:15,width:210,title:'H · 주문 O-17의 인도',detail:'AND · 두 조건 모두 필요',tone:'claim'},
      {id:'c1',x:135,y:125,width:210,title:'C1 · 인도 행위의 발생',detail:'OR · 적격 대안 하나 이상',tone:'claim'},
      {id:'c2',x:490,y:125,width:210,title:'C2 · 주문과 기록의 연결',detail:'필수 증거 요구',tone:'claim'},
      {id:'a',x:20,y:260,width:200,title:'서명 수령증',detail:'DOCUMENT · 실제 원문',tone:'evidence'},
      {id:'b',x:250,y:260,width:200,title:'창고 입고 로그',detail:'STRUCTURED_RECORD',tone:'evidence'},
      {id:'missing',x:490,y:260,width:210,title:'O-17 ↔ 입고 번호',detail:'EVIDENCE_MISSING',tone:'gap',dashed:true},
    ],
    edges: [{from:'h',to:'c1'},{from:'h',to:'c2'},{from:'c1',to:'a'},{from:'c1',to:'b'},{from:'c2',to:'missing',dashed:true}],
  },
  binding: {
    title: '하나의 자료, 서로 다른 연결 판정', height: 340,
    caption: '“10월 5일 배송 예정”이라는 동일 구간도 예정 통지의 존재는 지지하지만 실제 인도 완료까지 입증하지는 못한다. 판정의 단위는 문서 전체가 아니라 자료 구간과 요구의 연결이다.',
    nodes: [
      {id:'e',x:20,y:130,width:195,title:'배송 예정 메일',detail:'같은 원문 구간',tone:'evidence'},
      {id:'b1',x:260,y:30,width:195,title:'Binding 1',detail:'SUPPORTED',tone:'evidence'},
      {id:'b2',x:260,y:235,width:195,title:'Binding 2',detail:'INSUFFICIENT',tone:'gap'},
      {id:'c1',x:500,y:30,width:200,title:'예정 통지가 존재한다',detail:'원문과 주장 강도 일치',tone:'claim'},
      {id:'c2',x:500,y:235,width:200,title:'실제 인도가 완료됐다',detail:'예정만으로 입증 불가',tone:'claim'},
    ],
    edges:[{from:'e',to:'b1'},{from:'e',to:'b2'},{from:'b1',to:'c1'},{from:'b2',to:'c2',dashed:true}],
  },
  negative: {
    title: '부정 주장에도 필요한 적극적인 근거', height: 340,
    caption: 'NOT_SUPPORT는 부정 주장을 지지하는 필수 조건의 AND다. 일부 기록에서 취소 항목을 찾지 못했다는 사실만으로 기록의 완전성이나 확인 기간을 충족했다고 볼 수 없다.',
    nodes:[
      {id:'h',x:245,y:15,width:230,title:'마감 전에 취소되지 않았다',detail:'입증할 부정 주장',tone:'claim'},
      {id:'and',x:265,y:130,width:190,title:'NOT_SUPPORT → AND',detail:'모든 필수 조건의 지지',tone:'claim'},
      {id:'id',x:15,y:265,width:160,title:'대상 일치',detail:'동일 주문의 식별',tone:'evidence'},
      {id:'time',x:190,y:265,width:160,title:'확인 구간 충족',detail:'시작부터 마감까지',tone:'evidence'},
      {id:'complete',x:365,y:265,width:160,title:'기록 완전성',detail:'누락 범위의 확인',tone:'evidence'},
      {id:'absence',x:540,y:265,width:165,title:'취소 없음의 근거',detail:'해당 구간의 기록',tone:'evidence'},
    ],edges:[{from:'h',to:'and'},...['id','time','complete','absence'].map(to=>({from:'and',to}))],
  },
  gates: {
    title: 'Gap Find의 관문과 공백 사유', height: 640,
    caption: '아래 방향은 후보 평가의 진행, 오른쪽 방향은 해당 관문에서 기록하는 공백이다. 한 대안이 탈락해도 다른 OR 대안은 계속 평가한다. 미검토·호출 실패·메타데이터 미상은 완료된 부적격 판정과 구분한다.',
    nodes:[
      ...[
        ['exist','1-3 · 실제 자료','필수 요구에 binding이 있는가'],
        ['fit','1-4 · 주장 적합성','SUPPORTED인가'],
        ['event','1-5 · 사건 일치','후보 전체의 연결이 가능한가'],
        ['source','1-6·1-7 · 중복·계보','공유 관측과 출처를 확인했는가'],
        ['trust','1-8 · 지지 수준','가정 아래 기준을 충족하는가'],
        ['final','최종 · 체인 확인','평가 완료 후 적격 경로가 있는가'],
      ].map(([id,title,detail],i)=>({id,title,detail,x:20,y:20+i*102,width:270,tone:'claim' as const})),
      ...[
        ['missing','EVIDENCE_MISSING','필수 자료 없음'],
        ['insufficient','EVIDENCE_INSUFFICIENT','지지 불충분 · 판정 사유 보존'],
        ['mismatch','EVENT_MISMATCH','실제 메타데이터 충돌'],
        ['unknown','PROVENANCE_UNKNOWN','D/E 출처 · 해당 대안 부적격'],
        ['weak','TRUST_WEAK','부족·미상·의존성 미해결'],
        ['chain','CHAIN_UNKNOWN','평가 완료 + 완성 체인 없음'],
      ].map(([id,title,detail],i)=>({id,title,detail,x:380,y:20+i*102,width:320,tone:'gap' as const})),
    ],edges:[...['exist','fit','event','source','trust'].map((from,i)=>({from,to:['fit','event','source','trust','final'][i]})),...['exist','fit','event','source','trust','final'].map((from,i)=>({from,to:['missing','insufficient','mismatch','unknown','weak','chain'][i],dashed:true}))],
  },
  provenance: {
    title: '문서의 개수와 관측의 개수', height: 375,
    caption: '두 재인용 문서의 원출처가 같은 입고 로그라면 세 문서는 하나의 관측 atom a를 공유한다. 별도의 수령 기록 c는 독립성이 확인된 경우에만 추가 관측으로 취급한다. 화살표의 방향과 설명을 함께 읽는다.',
    nodes:[
      {id:'origin',x:245,y:15,width:230,title:'원본 입고 로그',detail:'동일 관측 a의 생성 기록',tone:'evidence'},
      {id:'copy1',x:20,y:145,width:220,title:'재게시 문서 1',detail:'원본 로그를 인용',tone:'neutral'},
      {id:'copy2',x:470,y:145,width:230,title:'재게시 문서 2',detail:'같은 원본 로그를 인용',tone:'neutral'},
      {id:'atom',x:70,y:285,width:260,title:'공유 atom a · 한 번만 집계',detail:'원문 + 재인용 두 건',tone:'claim'},
      {id:'independent',x:425,y:285,width:275,title:'별도 수령 기록 · atom c',detail:'독립 관측이라는 근거가 필요',tone:'evidence'},
    ],edges:[{from:'copy1',to:'origin'},{from:'copy2',to:'origin'},{from:'copy1',to:'atom',dashed:true},{from:'copy2',to:'atom',dashed:true,path:'M 585 205 L 585 240 L 200 240 L 200 285'}],
  },
  shared: {
    title: '두 경로에 공유된 증거 변수', height: 355,
    caption: '왼쪽 경로 a∧b와 오른쪽 경로 a∧c는 a를 공유한다. a·b·c가 서로 독립이어도 두 경로 자체가 독립인 것은 아니다. 원래 구조를 a∧(b∨c)로 정리하면 a를 두 번 집계하는 오류를 피할 수 있다.',
    nodes:[
      {id:'or',x:260,y:15,width:200,title:'목표 H · OR',detail:'두 입증 경로 중 하나',tone:'claim'},
      {id:'left',x:80,y:135,width:200,title:'경로 1 · AND',detail:'a ∧ b',tone:'claim'},
      {id:'right',x:440,y:135,width:200,title:'경로 2 · AND',detail:'a ∧ c',tone:'claim'},
      {id:'b',x:20,y:275,width:175,title:'관측 b',detail:'0.70 · 예제 가정',tone:'evidence'},
      {id:'a',x:260,y:275,width:200,title:'공유 관측 a',detail:'0.80 · 하나의 변수',tone:'gap'},
      {id:'c',x:525,y:275,width:175,title:'관측 c',detail:'0.60 · 예제 가정',tone:'evidence'},
    ],edges:[{from:'or',to:'left'},{from:'or',to:'right'},{from:'left',to:'a'},{from:'left',to:'b'},{from:'right',to:'a'},{from:'right',to:'c'}],
  },
  bottleneck: {
    title: '대안을 추가해도 남아 있는 필수 연결의 병목', height: 345,
    caption: '전체 실행 예제의 실행 C다. 독립 수령 기록을 보완하여 C1은 0.975가 되었지만 주문 연결 C2는 0.80이다. 루트는 0.975×0.80=0.78이므로 예제 기준 0.80에 미달한다. 점수를 임의로 올리는 대신 해당 연결의 원문과 계보를 보완한다.',
    nodes:[
      {id:'h',x:245,y:15,width:250,title:'H · 0.780 / 기준 0.800',detail:'AND · TRUST_WEAK',tone:'gap'},
      {id:'c1',x:135,y:125,width:210,title:'C1 · 인도 행위 0.975',detail:'OR · 두 관측의 결합',tone:'claim'},
      {id:'c2',x:490,y:125,width:210,title:'C2 · 주문 연결 0.800',detail:'필수 연결 · 보완 대상',tone:'gap'},
      {id:'a',x:20,y:260,width:200,title:'E1 · 입고 로그',detail:'관측 a · 0.90',tone:'evidence'},
      {id:'c',x:250,y:260,width:200,title:'E2 · 독립 수령 기록',detail:'관측 c · 0.75',tone:'evidence'},
      {id:'b',x:490,y:260,width:210,title:'E3 · 주문–입고 대조',detail:'관측 b · 0.80',tone:'evidence'},
    ],edges:[{from:'h',to:'c1'},{from:'h',to:'c2'},{from:'c1',to:'a'},{from:'c1',to:'c'},{from:'c2',to:'b'}],
  },
  cycle: {
    title: '공백 진단에서 새 버전의 검증까지', height: 330,
    caption: '보완 액션의 완료는 자료 확보 상태의 변화다. 공백 해소 여부는 새 snapshot에서 다시 검사한다. 반복 예산에 도달하거나 사용자 자료가 필요하면 상태와 미평가 범위를 남기고 대기한다.',
    nodes:[
      {id:'gap',x:20,y:25,width:270,title:'① 원인과 영향 범위',detail:'어느 필수 연결이 막혔는가',tone:'gap'},
      {id:'action',x:420,y:25,width:280,title:'② 구체적인 보완 액션',detail:'검색 · 설명 · 요청 · 전략',tone:'claim'},
      {id:'snapshot',x:420,y:190,width:280,title:'③ 새 자료와 새 snapshot',detail:'원문 · 판정 · 정책 버전 보존',tone:'evidence'},
      {id:'evaluate',x:20,y:190,width:270,title:'④ 동일 관문으로 재평가',detail:'통과 여부와 남은 공백 비교',tone:'claim'},
    ],edges:[{from:'gap',to:'action'},{from:'action',to:'snapshot'},{from:'snapshot',to:'evaluate'},{from:'evaluate',to:'gap',dashed:true}],
  },
  architecture: {
    title: '의미 판단, 계약 검사, 수치 계산의 분리', height: 405,
    caption: 'LLM의 논리·인용 제안은 코드의 계약 검사를 거쳐야 한다. 공백과 점수는 고정된 자료·판정·정책에 대해 계산하고, 사용자에게는 결과와 함께 추적 가능한 근거를 반환한다.',
    nodes:[
      {id:'input',x:20,y:20,width:280,title:'입력 snapshot',detail:'목표 · 자료 · 범위 · 정책',tone:'evidence'},
      {id:'llm',x:420,y:20,width:280,title:'LLM의 의미 판단',detail:'논리 후보 · binding · 인용 판정',tone:'claim'},
      {id:'validate',x:420,y:165,width:280,title:'코드의 계약 검사',detail:'ID · 인용 · 순환 · 필수 조건',tone:'claim'},
      {id:'engine',x:20,y:165,width:280,title:'Gap Find 계산',detail:'후보 · 사건 · 중복 · 계보 · 점수',tone:'claim'},
      {id:'result',x:20,y:315,width:280,title:'결과와 설명',detail:'공백 · 계산식 · 근거 위치',tone:'evidence'},
      {id:'revision',x:420,y:315,width:280,title:'보완과 재평가',detail:'새 버전에서 계약 검사 반복',tone:'neutral'},
    ],edges:[{from:'input',to:'llm'},{from:'llm',to:'validate'},{from:'validate',to:'engine'},{from:'engine',to:'result'},{from:'result',to:'revision'}],
  },
};

export function FigureFrame({number,title,caption,children,language='ko'}: {number:string;title:string;caption:string;children:ReactNode;language?:DocumentLanguage}) {
  return localizeNode(<figure className="research-figure not-prose">
    <div className="research-figure-heading"><span>FIGURE {number}</span><strong>{title}</strong></div>
    {children}
    <figcaption><strong>{{ko:'그림',en:'Figure',ja:'図',zh:'图'}[language]} {number}.</strong> {caption}</figcaption>
  </figure>, language);
}

function edgePath(a: Node, b: Node) {
  const aw=a.width??200, bw=b.width??200;
  if (Math.abs(a.y-b.y)<65 || (Math.abs(a.x-b.x)>200 && Math.abs(a.y-b.y)<220)) {
    const right=b.x>a.x, sx=right?a.x+aw:a.x, tx=right?b.x:b.x+bw;
    const sy=a.y+30, ty=b.y+30, mx=(sx+tx)/2;
    return `M ${sx} ${sy} H ${mx} V ${ty} H ${tx}`;
  }
  const down=b.y>a.y, sx=a.x+aw/2, tx=b.x+bw/2, sy=down?a.y+60:a.y, ty=down?b.y:b.y+60;
  return `M ${sx} ${sy} V ${(sy+ty)/2} H ${tx} V ${ty}`;
}

export function ResearchDiagram({kind,number,language='ko'}: {language?:DocumentLanguage;kind:keyof typeof diagrams;number:string}) {
  const d=diagrams[kind];
  if (!d) throw new Error(`Unknown research diagram: ${kind}`);
  const marker=`arrow-${kind}-${number.replace(/\W/g,'')}`;
  return <FigureFrame language={language} number={number} title={d.title} caption={d.caption}>
    <div className="research-visual-scroll" tabIndex={0} role="region" aria-label={translateText(d.title, language)}>
      <svg className="research-diagram" viewBox={`0 0 720 ${d.height}`} role="img" aria-label={d.title}>
        <desc>{d.caption}</desc>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {d.edges.map((e,i)=>{const a=d.nodes.find(n=>n.id===e.from)!,b=d.nodes.find(n=>n.id===e.to)!;return <path key={i} d={e.path??edgePath(a,b)} className={`research-edge ${e.dashed?'is-dashed':''}`} markerEnd={`url(#${marker})`}/>;})}
        {d.nodes.map(n=><g key={n.id} className={`research-node tone-${n.tone??'neutral'}`}>
          <rect x={n.x} y={n.y} width={n.width??200} height={60} rx={4} strokeDasharray={n.dashed?'5 4':undefined}/>
          <DiagramLabel node={n} language={language} />
        </g>)}
      </svg>
    </div>
    <div className="research-legend"><span><i className="legend-claim"/> 주장·연산</span><span><i className="legend-evidence"/> 자료·관측</span><span><i className="legend-gap"/> 공백·주의 조건</span></div>
    <p className="research-pan-hint">작은 화면에서는 그림을 좌우로 이동할 수 있다.</p>
  </FigureFrame>;
}

export function CandidateMatrix({number,language='ko'}: {number:string;language?:DocumentLanguage}) {
  return <FigureFrame language={language} number={number} title="AND가 만드는 조합, OR이 남기는 대안" caption="AND(OR(a,b), OR(c,d))의 네 후보다. 행·열 중 적격 대안이 남은 조합만 유지한다. 오른쪽 요구의 자료 c와 d가 모두 없으면 부분 후보 a나 b만으로 부모를 통과시킬 수 없다.">
    <div className="candidate-matrix">
      <div className="matrix-axis">왼쪽 요구 ↓ / 오른쪽 요구 →</div><div className="matrix-axis">c</div><div className="matrix-axis">d</div>
      {['a','b'].map(a=><div className="matrix-row" key={a}><div className="matrix-axis">{a}</div>{['c','d'].map(b=><div className="matrix-cell" key={b}><span>{a}</span><i>∧</i><span>{b}</span><small>후보 / {'{'}{a}, {b}{'}'}</small></div>)}</div>)}
    </div>
    <div className="research-figure-note">2개 대안 × 2개 대안 = 4개 후보 · 필수 요구 한쪽이 ∅이면 전체 후보도 ∅</div>
  </FigureFrame>;
}

export function EventIntervals({number,language='ko'}: {number:string;language?:DocumentLanguage}) {
  return <FigureFrame language={language} number={number} title="쌍별 시간 접촉과 전체 사건 일치의 차이" caption="A=[1,3], B=[3,5], C=[5,7]이면 A와 B, B와 C는 각각 접하지만 세 구간에 동시에 포함되는 시각은 없다. SAME_EVENT가 전체 공통 시각을 요구한다면 이 조합은 통과할 수 없다. 선후 사건 규칙에는 별도의 순서 검사를 적용한다.">
    <div className="research-visual-scroll" tabIndex={0} role="region" aria-label="세 자료의 시간 구간 비교">
      <svg className="research-diagram interval-diagram" viewBox="0 0 720 270" role="img" aria-label="시간 구간 A 1부터 3, B 3부터 5, C 5부터 7; 전체 교집합 없음">
        {[1,2,3,4,5,6,7].map(t=><g key={t}><line x1={100+(t-1)*90} x2={100+(t-1)*90} y1={25} y2={205} className="interval-grid"/><text x={100+(t-1)*90} y={235} textAnchor="middle">{t}</text></g>)}
        {[[1,3],[3,5],[5,7]].map(([start,end],i)=><g key={i} className={`interval-series series-${i}`}><text x={30} y={58+i*65}>{['A','B','C'][i]}</text><line x1={100+(start-1)*90} x2={100+(end-1)*90} y1={52+i*65} y2={52+i*65}/><circle cx={100+(start-1)*90} cy={52+i*65} r={6}/><circle cx={100+(end-1)*90} cy={52+i*65} r={6}/></g>)}
        <text x={665} y={235}>시각</text>
      </svg>
    </div>
    <div className="research-figure-note">공통 구간의 시작 = max(1, 3, 5) = 5 &gt; 종료 = min(3, 5, 7) = 3 → 전체 교집합 없음</div>
  </FigureFrame>;
}

export function ResultMatrix({number,language='ko'}: {number:string;language?:DocumentLanguage}) {
  return <FigureFrame language={language} number={number} title="체인 상태, 점수, 평가 완결성의 구분" caption="확인된 체인의 존재는 다른 대안의 평가가 미완료여도 보고할 수 있다. 반대로 체인이 없다는 확정에는 필요한 범위의 평가 완료가 전제된다. 공백이 있다는 사실을 목표 주장의 거짓과 동일시하지 않는다.">
    <div className="result-matrix">
      <div><span>경로 미확인 · 평가 미완료</span><strong>판단 보류</strong><p>UNDETERMINED<br/>예산·미검토 범위를 보고한다.</p></div>
      <div><span>경로 없음 · 평가 완료</span><strong>체인 공백</strong><p>CHAIN_UNKNOWN<br/>세부 원인 공백을 연결한다.</p></div>
      <div><span>경로 있음 · 지지 부족</span><strong>병목 보완</strong><p>TRUST_WEAK<br/>부족한 근거 또는 가정을 설명한다.</p></div>
      <div><span>경로 있음 · 기준 충족</span><strong>모형 내 충분</strong><p>사용한 정책·가정을 함께 보고한다.<br/>자동으로 진실 확률이 되지는 않는다.</p></div>
    </div>
  </FigureFrame>;
}

const plots = {
  'support-curves': {title:'AND와 OR의 응답 곡선', caption:'두 번째 지지 점수를 0.60으로 고정하고 첫 번째 점수를 변화시킨 계산이다. 독립 모형에서 AND는 필수 조건의 병목을, OR은 대안 경로의 결합을 반영한다. 실측 정확도가 아닌 수식의 해석용 곡선이다.'},
  'shared-evidence': {title:'공유 증거를 독립 경로로 오인했을 때의 차이', caption:'b=0.70, c=0.60인 독립 atom 모형에서 a만 변화시켰다. a=0.80이면 공유 변수를 보존한 점수는 0.704이고 잘못된 경로 독립 계산은 0.7712다. 음영은 두 계산의 차이이며 통계적 신뢰구간이 아니다.'},
  'dependence-bounds': {title:'의존성을 모를 때 남는 확률 범위', caption:'확률로 해석 가능한 주변값 p₂=0.60을 고정한 AND의 Fréchet 범위다. 점선은 독립이라는 추가 가정을 둔 한 모형일 뿐이다. 음영은 가능한 결합 확률의 범위이며 추정 오차나 신뢰구간을 나타내지 않는다.'},
  'likelihood-update': {title:'조건부 우도비와 가설의 상대 지지', caption:'사전확률 0.20을 가정한 설명용 Bayesian odds 갱신이다. 가로축은 로그 척도이며 LR=1에서 값이 유지된다. 출처 계수 1.0과는 다른 개념이고, 실제 LR을 추정할 모형이 없는 자료에는 이 수치를 대입하지 않는다.'},
  'candidate-growth': {title:'필수 조건과 대안 수에 따른 후보 증가', caption:'m개 필수 요구마다 k개 대안이 있고 후보가 서로 구별될 때 kᵐ개의 조합이 발생한다. 세로축은 로그 척도다. 실행 시간의 실측 그래프가 아니며, 가지치기·지연 생성·예산 관리가 필요한 조합 구조를 보여준다.'},
  'worked-example': {title:'자료 보완에 따른 네 번의 평가', caption:'문서의 구성 사례 A–D를 같은 축에 놓았다. A는 계산 불가이므로 0점 막대를 그리지 않는다. B=0.72, C=0.78, D=0.92625이며 임계값 0.80도 설명용이다. D의 계수 변경은 원출처 확인과 새 버전 재평가를 전제로 한다.'},
} as const;

export function ResearchPlot({kind,number,language='ko'}: {language?:DocumentLanguage;kind:keyof typeof plots;number:string}) {
  const p=plots[kind];
  return <FigureFrame language={language} number={number} title={p.title} caption={p.caption}>
    <div className="research-visual-scroll research-plot" tabIndex={0} role="region" aria-label={translateText(p.title, language)}>
      {/* Static analytical plots are generated with Matplotlib; keep export resolution. */}
      <img className="plot-light" src={`/figures/${kind}.svg`} width={720} height={450} alt={p.caption} loading="lazy"/>
      <img className="plot-dark" src={`/figures/${kind}.dark.svg`} width={720} height={450} alt={p.caption} loading="lazy"/>
    </div>
    <div className="research-figure-tools"><a href={`/figures/${kind}.svg`} target="_blank" rel="noreferrer" aria-label={`${translateText(p.title, language)} — ${translateText('크게 보기 ↗', language)}`}>크게 보기 ↗</a><div><a href={`/figures/${kind}.svg`} download>SVG</a><a href={`/figures/${kind}.png`} download>PNG</a><a href={`/figures/${kind}.pdf`} download>PDF</a></div></div>
    <p className="research-pan-hint">축과 범례는 ‘크게 보기’에서 확대해 읽을 수 있다.</p>
  </FigureFrame>;
}

function DiagramLabel({ node, language }: { node: Node; language: DocumentLanguage }) {
  const width = (node.width ?? 200) - 28;
  const title = translateText(node.title, language);
  const detail = translateText(node.detail ?? '', language);
  // Approximate Latin/CJK advance; long labels keep their full accessible text.
  const length = (text: string, size: number) => Array.from(text).reduce((n, ch) => n + (/[\u3000-\u9fff\uac00-\ud7af]/.test(ch) ? size : size * 0.58), 0);
  const size = Math.max(11, Math.min(14, 14 * width / Math.max(width, length(title, 14))));
  const words = language === 'en' ? title.split(' ') : Array.from(title);
  const separator = language === 'en' ? ' ' : '';
  const lines: string[] = [''];
  for (const word of words) {
    const index = lines.length - 1;
    const next = lines[index] ? `${lines[index]}${separator}${word}` : word;
    if (length(next, size) > width && lines[index] && lines.length < 2) lines.push(word);
    else lines[index] = next;
  }
  return <>
    <text className="research-node-title" style={{ fontSize: size }} aria-label={title}>{lines.map((line, index) => <tspan key={index} x={node.x + 14} y={node.y + (lines.length > 1 ? 19 + index * 14 : 25)} textLength={length(line, size) > width ? width : undefined} lengthAdjust="spacingAndGlyphs">{line}</tspan>)}</text>
    <text x={node.x + 14} y={node.y + (lines.length > 1 ? 50 : 45)} className="research-node-detail" textLength={length(detail, 11) > width ? width : undefined} lengthAdjust="spacingAndGlyphs">{detail}</text>
  </>;
}
