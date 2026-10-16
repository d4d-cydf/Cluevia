import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode } from '../types/graph.ts';
import type { ReportRun } from '../types/report.ts';
import { renderReportGraphSvg, renderReportHtml, renderReportMarkdown, reportFilename } from './report-export.ts';

function fixture(): ReportRun {
  const node = (id: string, label: string, type: string, properties: Record<string, string> = {}): GraphNode => ({ id, label, type, properties, group: 'saved', description: '', sourceIds: [] });
  return {
    id: 'report-1', jobId: 'case-1', status: 'completed', stage: 'completed', createdAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:02:00Z', model: 'saved-model', effort: 'low', inputHash: 'saved-fingerprint',
    snapshot: {
      question: '질문 H를 확인할 수 있나요?', caseTitle: '한글 케이스', analysisUpdatedAt: '2026-10-11T09:00:00Z', whyRunId: 'why-1',
      graph: {
        schemaVersion: '1.0', id: 'saved-graph', title: '저장된 입증 구조', question: '질문 H를 확인할 수 있나요?', summary: '', origin: 'structured', createdAt: '2026-10-11T09:00:00Z', limitations: ['하루의 자료만 포함합니다.'], groups: [], sources: [], events: [], findings: [],
        nodes: [node('h', '질문 H', 'Goal', { role: 'review-goal' }), node('r', '조건 R', 'Condition'), node('e', '자료 E', 'Evidence'), node('g', '빠진 날짜', 'Gap', { gapType: 'EVIDENCE_MISSING' })],
        edges: [
          { id: 'h-r', source: 'h', target: 'r', label: '필요 조건', description: '저장된 조건', status: 'inferred', sourceIds: [] },
          { id: 'r-e', source: 'r', target: 'e', label: '자료 연결', description: '직접 인용 구간', status: 'inferred', sourceIds: [] },
          { id: 'g-r', source: 'g', target: 'r', label: '검토 대상 조건', description: '사실 관계가 아닌 검토 범위', status: 'inferred', sourceIds: [] },
        ],
      },
      confidence: { score: 61.54, baselineScore: 70, grade: 'B', accepted: false, status: 'PARTIAL', note: '날짜가 확인되지 않았습니다.' },
      gaps: [{ id: 'missing-date', type: 'EVIDENCE_MISSING', title: '사건 날짜 확인', explanation: '해당 날짜의 원자료가 없습니다.', evaluationState: 'CONFIRMED', blockingScope: 'ROOT', requirements: ['조건 R'], recommendations: ['날짜가 명시된 원문을 보완하세요.'] }],
      citations: [{ id: 'quote-1', evidenceId: 'e', sourceName: '공식 발표', url: 'https://example.org/source?lang=ko&v=1', quote: '부대의 배치를 확인했다.\n전투 날짜는 언급하지 않았다.', sourceGrade: 'B', record: 2 }],
      coverage: { sources: 1, citations: 1, nodes: 4, edges: 3, notes: ['번역 표현은 별도 검토가 필요합니다.'] },
    },
    content: {
      title: '배치와 전투를 구분한 검토', subtitle: '저장된 자료에 근거한 짧은 보고서',
      conclusion: [{ text: '배치는 확인되지만 해당 날짜의 전투 참여는 확인되지 않습니다.', citationIds: ['quote-1'] }],
      sections: [{ heading: 'Evidence', paragraphs: [{ text: '출처는 배치 사실만 설명합니다.', citationIds: ['quote-1', 'quote-1'] }] }],
      gapAnalysis: [{ gapId: 'missing-date', analysis: '배치 사실을 전투 사실로 확대할 수 없습니다.', recommendation: '당일 작전 기록을 확인하세요.' }],
      limitations: ['현재 인용만으로 참여 시점을 확정할 수 없습니다.'], nextSteps: ['추가 원문을 확보하세요.'],
    },
  };
}

test('standalone HTML preserves saved narrative, exact quotations, grades, gaps, actions and archival identity', () => {
  const report = fixture(); const html = renderReportHtml(report);
  for (const text of ['배치와 전투를 구분한 검토', '전투 참여는 확인되지 않습니다.', '61.5', 'GRADE B', '70 / 100', '날짜가 명시된 원문', '당일 작전 기록', '부대의 배치를 확인했다.\n전투 날짜는 언급하지 않았다.', 'saved-fingerprint', 'why-1']) assert.ok(html.includes(text), text);
  assert.match(html, /href="#source-1"/);
  assert.match(html, /id="source-1"/);
  assert.match(html, /@page\{size:A4/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /진실 확률이나 통계적 확신도가 아닙니다/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<link\b|<img\b|@import\b/i);
  assert.equal(renderReportHtml(report), html);
});

test('all prose and SVG labels are text, not executable markup, and only safe HTTP links are active', () => {
  const report = fixture();
  const attack = '</title><script>alert(1)</script><img src=x onerror="boom">';
  report.content!.title = attack;
  report.content!.conclusion[0].text = attack;
  report.content!.sections[0].heading = attack;
  report.content!.limitations = [attack];
  report.snapshot.graph.nodes[0].label = attack;
  report.snapshot.graph.nodes[1].description = attack;
  report.snapshot.graph.nodes[3].properties.gapType = attack;
  report.snapshot.graph.edges[0].label = attack;
  report.snapshot.gaps[0].explanation = attack;
  report.snapshot.citations[0].sourceName = attack;
  report.snapshot.citations[0].quote = attack;
  report.model = attack;
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', '//evil.test/source', 'file:///etc/passwd', 'https://user:secret@example.org', 'https://example.org/\nattack']) {
    report.snapshot.citations[0].url = url;
    const html = renderReportHtml(report);
    assert.doesNotMatch(html, /<script\b|<img\b|href="(?:javascript|data|file):|href="\/\//i);
    assert.ok(!html.includes(attack));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('안전한 웹 링크 형식이 아니므로'));
  }
  report.snapshot.citations[0].url = 'https://example.org/path><script>alert(1)</script>';
  const html = renderReportHtml(report);
  assert.match(html, /href="https:\/\/example\.org\/path%3E%3Cscript%3E/);
  assert.doesNotMatch(renderReportGraphSvg(report), /<script\b|<img\b|<foreignObject\b/i);
});

test('diagram draws only the saved real edges, keeps the goal and contextual gap, and adds no gap-to-root edge', () => {
  const report = fixture(); const svg = renderReportGraphSvg(report);
  assert.equal((svg.match(/data-node-index=/g) || []).length, 4);
  assert.equal((svg.match(/data-edge-index=/g) || []).length, 3);
  assert.match(svg, /data-node-kind="goal"/);
  assert.match(svg, /빠진 날짜 → 조건 R: 검토 대상 조건/);
  assert.doesNotMatch(svg, /빠진 날짜 → 질문 H/);
  assert.match(svg, /data-gap-type="EVIDENCE_MISSING"/);
  assert.match(svg, /노드 4\/4 · 연결 3\/3/);
  assert.equal(renderReportGraphSvg(report), svg);
  report.snapshot.graph.edges.push({ id: 'dangling', source: 'not-saved', target: 'h', label: '없는 연결', description: '', status: 'inferred', sourceIds: [] });
  const invalid = renderReportGraphSvg(report);
  assert.match(invalid, /연결 3\/4/);
  assert.doesNotMatch(invalid, /없는 연결/);
});

test('normal diagrams keep all 60 nodes; oversized diagrams disclose omissions and Markdown preserves every node and edge', () => {
  const report = fixture();
  report.snapshot.graph.nodes = Array.from({ length: 60 }, (_, index) => ({ id: `e-${index}`, label: `자료 ${index}`, type: 'Evidence', group: '', description: '', sourceIds: [], properties: {} }));
  report.snapshot.graph.edges = [];
  assert.equal((renderReportGraphSvg(report).match(/data-node-index=/g) || []).length, 60);
  report.snapshot.graph.nodes.push({ id: 'root-last', label: '보존할 목표', type: 'Goal', group: '', description: '', sourceIds: [], properties: {} });
  report.snapshot.graph.edges.push({ id: 'actual-last', source: 'root-last', target: 'e-59', label: '마지막 실제 연결', description: '', status: 'inferred', sourceIds: [] });
  const svg = renderReportGraphSvg(report);
  assert.equal((svg.match(/data-node-index=/g) || []).length, 11);
  assert.match(svg, /보존할 목표/);
  assert.match(svg, /노드 11\/61 · 연결 0\/1/);
  assert.match(svg, /공간상 일부 생략/);
  const md = renderReportMarkdown(report);
  assert.match(md, /노드 61\/61 · 연결 1\/1/);
  assert.match(md, /자료 59/);
  assert.match(md, /마지막 실제 연결/);
});

test('Markdown preserves citation footnotes, exact quotes, gaps and real graph references without executable markdown payloads', () => {
  const report = fixture();
  const md = renderReportMarkdown(report);
  assert.match(md, /확인되지 않습니다\.\[\^1\]/);
  assert.match(md, /\[\^1\]: 공식 발표/);
  assert.match(md, /> 부대의 배치를 확인했다\.\n    > 전투 날짜는 언급하지 않았다\./);
  assert.match(md, /N4 → N2: 검토 대상 조건/);
  assert.doesNotMatch(md, /N4 → N1/);
  assert.match(md, /당일 작전 기록을 확인하세요/);
  assert.match(md, /<https:\/\/example.org\/source\?lang=ko&v=1>/);
  report.content!.conclusion[0].text = '<script>evil()</script> ![image](https://bad.test/track)\n# new heading';
  report.snapshot.citations[0].url = 'javascript:alert(1)';
  const safe = renderReportMarkdown(report);
  assert.doesNotMatch(safe, /<script>|!\[image\]\(|\n# new heading|<javascript:/);
  assert.match(safe, /&lt;script&gt;/);
});

test('missing values stay unknown, near certainty is not rounded to 100 and unknown citations are disclosed', () => {
  const report = fixture();
  report.snapshot.confidence.score = null;
  report.snapshot.confidence.baselineScore = null;
  report.snapshot.confidence.grade = null;
  report.content!.conclusion[0].citationIds.push('missing-source');
  const unknown = renderReportHtml(report);
  assert.match(unknown, /class="score">—/);
  assert.match(unknown, /NOT RATED/);
  assert.match(unknown, /인용 연결 확인 필요/);
  assert.doesNotMatch(unknown, /class="score">50/);
  report.snapshot.confidence.score = 99.999999999;
  assert.match(renderReportHtml(report), /class="score">&gt;99\.9/);
  report.snapshot.confidence.score = 100;
  assert.match(renderReportHtml(report), /class="score">100 /);
  report.snapshot.confidence.score = 100.5;
  assert.match(renderReportHtml(report), /class="score">—/);
});

test('absent saved content or graph yields a transparent empty state without inventing conclusions or edges', () => {
  const report = fixture();
  delete report.content;
  report.status = 'failed'; report.error = '모델 응답 없음';
  report.snapshot.graph.nodes = []; report.snapshot.graph.edges = [];
  report.snapshot.gaps = []; report.snapshot.citations = [];
  const html = renderReportHtml(report);
  assert.match(html, /완료된 보고서가 아닙니다/);
  assert.match(html, /저장된 보고서 결론이 없습니다/);
  assert.match(html, /저장된 그래프가 없습니다/);
  assert.match(html, /공백이 없다는 사실만으로 결론이 입증되지는 않습니다/);
  assert.doesNotMatch(renderReportGraphSvg(report), /data-edge-index=/);
});

test('download filenames retain Unicode but remove path, control, bidi and reserved filename hazards', () => {
  const report = fixture();
  report.content!.title = '../북한군\\쿠르스크: 보고서?\u0000\u202e/../../';
  const filename = reportFilename(report, '../HTML');
  assert.match(filename, /북한군/);
  assert.ok(filename.endsWith('-2026-10-11.html'));
  assert.doesNotMatch(filename, /[\\/:*?"<>|\u0000-\u001f\u202e]|\.\./);
  report.content!.title = 'CON';
  assert.ok(reportFilename(report, 'md').startsWith('Cluevia-CON-'));
  report.content!.title = '\u0000/../';
  assert.equal(reportFilename(report, ''), 'Cluevia-report-2026-10-11.txt');
});
