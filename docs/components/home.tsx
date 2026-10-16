import { localizeNode } from '@/lib/localize';
import type { DocumentLanguage } from '@/lib/document-language';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, BookOpen, Braces, Cable, Clock3, Fingerprint, Github, Layers3, Network, Terminal } from 'lucide-react';
import { Brand } from '@/components/brand';
import { SearchButton } from '@/components/search-button';
import { EvidencePreview } from '@/components/evidence-preview';
import { appUrl, repositoryUrl } from '@/lib/site';

const chapters = [
  { number: '01', icon: Network, label: 'WHY-NOT TREE', title: '자료와 논리를 연결하기', description: '목표 주장, 논리 연산자와 증거 leaf로 결론에 필요한 연결을 정의합니다.', href: '/docs/main-algorithm/model', foot: '트리와 데이터 계약' },
  { number: '02', icon: Braces, label: 'GAP FIND', title: '연결이 끊긴 이유 찾기', description: '존재하는 자료의 조합을 만들고 지지 판정·사건 일치·중복을 검사합니다.', href: '/docs/main-algorithm/gap-find', foot: '공백 탐지 단계 읽기' },
  { number: '03', icon: Clock3, label: 'PROVENANCE & TRUST', title: '출처와 신뢰도 평가하기', description: '원출처를 추적하고 공유 근거를 구분해 전체 지지 점수와 한계를 계산합니다.', href: '/docs/main-algorithm/confidence', foot: '신뢰도 계산 규칙' },
  { number: '04', icon: Cable, label: 'GAP FILL', title: '공백에 맞는 근거 보완하기', description: '여섯 공백 유형에 따라 자료 검색·추가 증거 요청·체인 완성 전략을 정합니다.', href: '/docs/main-algorithm/gap-fill', foot: '보완 액션 지침' },
];

export function Home({ language = 'ko' }: { language?: DocumentLanguage }) {
  return localizeNode(
    <div className="field-guide">
      <a href="#main" className="skip-link">본문으로 건너뛰기</a>
      <header className="landing-header"><Link href="/" aria-label="Cluevia 문서 홈"><Brand /></Link><nav aria-label="주 메뉴"><Link className="header-docs" href="/docs">문서</Link><SearchButton language={language} /><a className="header-github" href={repositoryUrl} aria-label="GitHub 저장소"><Github size={19} /></a><a className="header-app" href={appUrl}>Cluevia 열기 <ArrowUpRight size={14} /></a></nav></header>
      <main id="main">
        <section className="hero">
          <div className="hero-copy"><div className="hero-kicker"><span className="status-dot" /><span>ALGORITHM RESEARCH NOTES</span><span className="edition">VOL. 01 / v0.1</span></div><h1>From evidence.<br /><em>To a graph.</em></h1><p className="hero-lead">결론까지 이어지는 근거,<br />그 사이의 공백을 찾습니다.</p><p className="hero-description">Why-not Tree, Gap Find, Gap Fill.<br className="desktop-break" /> 주장과 증거의 연결, 판정의 가정, 공백의 원인을 기술한 연구·구현 문서입니다.</p><div className="hero-actions"><a className="action-primary" href={appUrl}>Cluevia 시작하기 <ArrowRight size={16} /></a><Link className="action-secondary" href="/docs/main-algorithm/worked-example">알고리즘 예제 읽기 <ArrowUpRight size={15} /></Link></div><div className="hero-note"><Fingerprint size={15} /><span>Every finding links back to its evidence.</span></div></div>
          <div className="hero-visual"><div className="visual-annotation"><span>EXPLORE THE CONNECTIONS</span><span>↙ 객체를 눌러 탐색해 보세요</span></div><EvidencePreview language={language} /><div className="visual-footnote"><span>FIG. 01 — EVIDENCE IN CONTEXT</span><span>현재 앱 공개 예제 · 실시간 위치 아님</span></div></div>
        </section>
        <div className="principles-strip"><span><Fingerprint size={15} /> 자료와 논리를 연결하고</span><i /><span><Braces size={15} /> 공백을 찾고</span><i /><span><Layers3 size={15} /> 필요한 근거를 보완합니다</span></div>
        <section className="chapters" aria-labelledby="chapters-title"><div className="section-heading"><div><p className="eyebrow">INSIDE THE PIPELINE</p><h2 id="chapters-title">어떤 근거가 더 필요할까요?</h2></div><Link href="/docs">전체 처리 흐름 <ArrowRight size={15} /></Link></div><div className="chapter-grid">{chapters.map(({ number, icon: Icon, label, title, description, href, foot }) => <Link className="chapter-card" href={href} key={number}><div className="chapter-top"><span>{number} /</span><Icon size={22} strokeWidth={1.4} /></div><p className="eyebrow">{label}</p><h3>{title}</h3><p className="chapter-description">{description}</p><span className="chapter-link">{foot}<ArrowUpRight size={16} /></span></Link>)}</div></section>
        <section className="reference-section" aria-labelledby="reference-title"><div className="reference-copy"><p className="eyebrow">BUILT TO BE TRACEABLE</p><h2 id="reference-title">결론보다 먼저,<br /> 근거를 확인하세요.</h2><p>보고된 관계와 추론을 구분하고,<br /> 각 객체와 발견에서 원문으로 돌아갑니다.</p><Link href="/docs/concepts/evidence-model">Cluevia의 근거 모델 <ArrowRight size={15} /></Link></div><div className="reference-links"><Link href="/docs/reference/graph-document"><Braces size={20} /><span><strong>GraphDocument</strong><small>현재 앱의 객체 · 관계 · 사건 · 출처 계약</small></span><ArrowUpRight size={17} /></Link><Link href="/docs/reference/api"><Cable size={20} /><span><strong>API Reference</strong><small>분석 작업 · 그래프 · 온톨로지 API</small></span><ArrowUpRight size={17} /></Link><Link href="/docs/development/local"><Terminal size={20} /><span><strong>Local Development</strong><small>로컬 실행, 테스트, 문서 작성 방법</small></span><ArrowUpRight size={17} /></Link><Link href="/docs/guide/troubleshooting"><BookOpen size={20} /><span><strong>Troubleshooting</strong><small>실행 오류부터 분석·저장 문제까지</small></span><ArrowUpRight size={17} /></Link></div></section>
        <section className="search-section"><p className="eyebrow">LOOKING FOR SOMETHING SPECIFIC?</p><SearchButton large language={language} /></section>
      </main>
      <footer className="landing-footer"><Link href="/" aria-label="Cluevia 문서 홈"><Brand compact /></Link><span>자료를 연결하다. 맥락을 발견하다.</span><div><a href="https://www.fumadocs.dev">Built with Fumadocs <ArrowUpRight size={12} /></a><span>CLUEVIA / TECHNICAL NOTES</span></div></footer>
    </div>, language
  );
}
