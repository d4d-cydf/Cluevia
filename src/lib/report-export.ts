import type { GraphEdge, GraphNode } from '../types/graph.ts';
import type { ReportParagraph, ReportRun } from '../types/report.ts';

const MAX_GRAPH_NODES = 60;
const MAX_GRAPH_EDGES = 400;
const gapLabels: Record<string, string> = {
  EVIDENCE_MISSING: '필요한 자료', EVIDENCE_INSUFFICIENT: '근거 불충분', EVENT_MISMATCH: '사건 불일치',
  TRUST_WEAK: '지지 수준 검토', PROVENANCE_UNKNOWN: '원출처 확인', CHAIN_UNKNOWN: '입증 경로 미완성',
};
const cleanText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const escape = (value: string | number) => cleanText(String(value)).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const markdown = (value: string) => escape(value).replace(/[\\`*_[\]{}()#!|~]/g, '\\$&');
const short = (value: string, length: number) => [...value].length > length ? [...value].slice(0, length - 1).join('') + '…' : value;
const score = (value: number | null) => value === null || !Number.isFinite(value) || value < 0 || value > 100 ? '—'
  : value > 99.9 && value < 100 ? '>99.9' : value > 0 && value < .1 ? '<0.1' : String(Math.round(value * 10) / 10);

/** Links may navigate when clicked; exports never fetch or embed remote assets. */
function safeUrl(value: string | null): string | null {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href.replace(/</g, '%3C').replace(/>/g, '%3E') : null;
  } catch { return null; }
}

function column(node: GraphNode): number {
  if (node.type === 'Gap' || node.properties.gapType) return 3;
  if (node.type === 'Goal' || node.properties.role === 'review-goal' || node.properties.role === 'conclusion') return 0;
  if (node.type === 'Evidence' || node.properties.role === 'evidence') return 2;
  return 1;
}

function graphSelection(report: ReportRun, limit = true) {
  const graph = report.snapshot.graph;
  // Keep original order inside each lane. Sorting only prioritizes the saved
  // goal and review context when the archival diagram needs a size limit.
  const oversized = limit && graph.nodes.length > MAX_GRAPH_NODES;
  const candidates = oversized
    ? [...graph.nodes].sort((a, b) => (column(a) === 0 ? 0 : column(a) === 3 ? 1 : 2) - (column(b) === 0 ? 0 : column(b) === 3 ? 1 : 2))
    : graph.nodes;
  const seen = new Set<string>();
  const counts = [0, 0, 0, 0];
  const nodes = candidates.filter(node => {
    if (seen.has(node.id) || (oversized && counts[column(node)] >= 10)) return false;
    seen.add(node.id); counts[column(node)] += 1; return true;
  });
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, limit ? MAX_GRAPH_EDGES : Infinity);
  return { graph, nodes, edges, omittedNodes: graph.nodes.length - nodes.length, omittedEdges: graph.edges.length - edges.length };
}

/** SVG uses text/tspan only: no HTML, remote fonts/images, or invented edges. */
export function renderReportGraphSvg(report: ReportRun): string {
  const { graph, nodes, edges, omittedNodes, omittedEdges } = graphSelection(report);
  const lanes = [0, 1, 2, 3].map(lane => nodes.filter(node => column(node) === lane));
  const rowHeight = 120;
  const height = Math.max(290, Math.max(...lanes.map(lane => lane.length), 1) * rowHeight + 120);
  const width = 1120;
  const positions = new Map<string, { x: number; y: number; node: GraphNode }>();
  lanes.forEach((lane, laneIndex) => lane.forEach((node, index) => positions.set(node.id, {
    x: 22 + laneIndex * 279, y: 66 + index * rowHeight + (height - 120 - lane.length * rowHeight) / 2, node,
  })));
  const wrapped = (value: string, capacity = 24, maxLines = 3) => {
    const lines: string[] = [];
    let line = ''; let units = 0;
    for (const character of cleanText(value).replace(/\s+/g, ' ').trim()) {
      const unit = /[\u0000-\u00ff]/.test(character) ? .55 : 1;
      if (units + unit > capacity) { lines.push(line.trim()); line = ''; units = 0; }
      line += character; units += unit;
    }
    if (line) lines.push(line.trim());
    return lines.slice(0, maxLines).map((value, index) => index === maxLines - 1 && lines.length > maxLines ? short(value, Math.max(2, [...value].length - 1)) + '…' : value);
  };
  const edgeSvg = (edge: GraphEdge, index: number) => {
    const source = positions.get(edge.source)!; const target = positions.get(edge.target)!;
    const gapType = source.node.properties.gapType || target.node.properties.gapType;
    const diagnostic = column(source.node) === 3 || column(target.node) === 3;
    const sameLane = source.x === target.x;
    const forward = source.x < target.x;
    const startX = source.x + (sameLane || forward ? 238 : 0);
    const endX = target.x + (sameLane ? 238 : forward ? 0 : 238);
    const startY = source.y + 47; const endY = target.y + 47;
    const bend = sameLane ? 24 + (index % 3) * 8 : Math.max(25, Math.abs(endX - startX) * .44);
    const direction = sameLane || forward ? 1 : -1;
    const path = `M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX + (sameLane ? 1 : -direction) * bend} ${endY}, ${endX} ${endY}`;
    const dash = diagnostic ? gapType === 'EVENT_MISMATCH' ? '' : gapType === 'PROVENANCE_UNKNOWN' ? '2 5' : '7 5' : edge.status === 'inferred' ? '4 4' : '';
    return `<g data-edge-index="${index}" data-gap-type="${escape(gapType || '')}"><title>${escape(`${source.node.label} → ${target.node.label}: ${edge.label}${edge.description ? '\n' + edge.description : ''}`)}</title><path d="${path}" fill="none" stroke="${diagnostic ? '#ba7b72' : '#a69b8e'}" stroke-width="${diagnostic ? '1.6' : '1.25'}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#report-${diagnostic ? 'gap-' : ''}arrow)"/>${sameLane ? '' : `<text x="${(startX + endX) / 2}" y="${(startY + endY) / 2 - 5}" text-anchor="middle" fill="${diagnostic ? '#a16259' : '#887d6d'}" font-size="10" stroke="#fbf8f1" stroke-width="4" paint-order="stroke">${escape(short(edge.label, 18))}</text>`}</g>`;
  };
  const nodeSvg = (node: GraphNode, index: number) => {
    const position = positions.get(node.id)!; const lane = column(node);
    const fill = lane === 0 ? '#eee5d5' : lane === 3 ? '#faeeee' : '#fffdf8';
    const label = lane === 3 ? gapLabels[node.properties.gapType] || '검토 공백' : lane === 0 ? 'QUESTION' : lane === 2 ? 'EVIDENCE' : node.type === 'Condition' ? 'CONDITION' : 'CLAIM / OBJECT';
    const lines = wrapped(node.label);
    return `<g data-node-index="${index}" data-node-kind="${['goal', 'claim', 'evidence', 'gap'][lane]}" data-gap-type="${escape(node.properties.gapType || '')}"><title>${escape(`${node.label}${node.description ? '\n' + node.description : ''}`)}</title><rect x="${position.x}" y="${position.y}" width="238" height="96" rx="12" fill="${fill}" stroke="${lane === 3 ? '#d9a9a1' : '#d6c9b6'}"${lane === 3 ? ' stroke-dasharray="5 4"' : ''}/><text x="${position.x + 15}" y="${position.y + 23}" font-size="10" letter-spacing="1" fill="${lane === 3 ? '#a45f56' : '#8f7f67'}">${escape(label)}</text><text x="${position.x + 15}" y="${position.y + 45}" font-size="13" fill="#443a2e">${lines.map((line, lineIndex) => `<tspan x="${position.x + 15}" dy="${lineIndex ? 17 : 0}">${escape(line)}</tspan>`).join('')}</text></g>`;
  };
  const count = `노드 ${nodes.length}/${graph.nodes.length} · 연결 ${edges.length}/${graph.edges.length}`;
  const limited = omittedNodes || omittedEdges ? ' · 공간상 일부 생략 — 전체 연결은 원본 케이스에서 확인하세요.' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="report-graph-title report-graph-description" font-family="Arial, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif"><title id="report-graph-title">${escape(graph.title || report.snapshot.question)}</title><desc id="report-graph-description">${escape(`저장된 그래프의 실제 연결입니다. 붉은 공백 연결은 검토 범위이며 사건 관계가 아닙니다. ${count}${limited}`)}</desc><defs><marker id="report-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="#a69b8e"/></marker><marker id="report-gap-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="#ba7b72"/></marker></defs><rect width="${width}" height="${height}" rx="16" fill="#fbf8f1"/>${['Goal', 'Conditions / Objects', 'Evidence', 'Gaps'].map((title, index) => `<text x="${22 + index * 279}" y="33" fill="#8f7f67" font-size="12" letter-spacing="1.2">${title}</text>`).join('')}${edges.map(edgeSvg).join('')}${nodes.map(nodeSvg).join('')}${nodes.length ? '' : '<text x="560" y="140" text-anchor="middle" fill="#8f7f67" font-size="16">저장된 그래프가 없습니다.</text>'}<text x="22" y="${height - 18}" fill="#8f7f67" font-size="11">${escape(count + limited)}</text></svg>`;
}

const reportTitle = (report: ReportRun) => report.content?.title || report.snapshot.caseTitle || 'Cluevia 보고서';
const citations = (report: ReportRun) => {
  const positions = new Map<string, number>();
  report.snapshot.citations.forEach((citation, index) => { if (!positions.has(citation.id)) positions.set(citation.id, index + 1); });
  return positions;
};
const htmlList = (items: string[]) => items.length ? `<ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';

/** A self-contained, offline archival document suitable for browser Save as PDF. */
export function renderReportHtml(report: ReportRun): string {
  const { snapshot, content } = report;
  const citationNumbers = citations(report);
  const paragraph = (item: ReportParagraph) => {
    const ids = [...new Set(item.citationIds)];
    const references = ids.map(id => citationNumbers.has(id) ? `<a class="cite" href="#source-${citationNumbers.get(id)}" aria-label="출처 ${citationNumbers.get(id)}">[${citationNumbers.get(id)}]</a>` : '<span class="citation-warning">[인용 연결 확인 필요]</span>').join(' ');
    return `<p>${escape(item.text)}${references ? ' ' + references : ''}</p>`;
  };
  const confidence = snapshot.confidence;
  const scoreLabel = score(confidence.score);
  const sourceHtml = snapshot.citations.map((citation, index) => {
    const url = safeUrl(citation.url);
    return `<li id="source-${index + 1}" class="source"><div class="source-head"><span class="source-number">${index + 1}</span><h3>${escape(citation.sourceName)}</h3><span class="source-grade">${citation.sourceGrade ? `Grade ${escape(citation.sourceGrade)}` : 'Not rated'}${citation.record !== null ? ` · Record ${escape(citation.record)}` : ''}</span></div>${url ? `<a class="source-url" href="${escape(url)}" rel="noopener noreferrer">${escape(url)}</a>` : citation.url ? '<p class="muted">안전한 웹 링크 형식이 아니므로 연결을 생략했습니다.</p>' : ''}${citation.quote ? `<blockquote>${escape(citation.quote)}</blockquote>` : '<p class="muted">저장된 직접 인용이 없습니다.</p>'}</li>`;
  }).join('');
  const gapsHtml = snapshot.gaps.map(gap => {
    const narrative = content?.gapAnalysis.find(item => item.gapId === gap.id);
    return `<article class="gap"><div class="eyebrow gap-label">${escape(gap.type)} · ${escape(gap.evaluationState)}</div><h3>${escape(gap.title || gapLabels[gap.type] || gap.type)}</h3><p>${escape(gap.explanation)}</p>${narrative?.analysis ? `<p>${escape(narrative.analysis)}</p>` : ''}${gap.requirements.length ? `<p class="muted">관련 조건: ${gap.requirements.map(escape).join(' · ')}</p>` : ''}${htmlList([...new Set([...(narrative?.recommendation ? [narrative.recommendation] : []), ...gap.recommendations])])}<p class="scope">검토 범위: ${escape(gap.blockingScope)}</p></article>`;
  }).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(reportTitle(report))} · Cluevia</title><style>
:root{color-scheme:light;font-family:Georgia,'Noto Serif KR','Batang',serif;color:#3f362c;background:#eae3d8;font-synthesis:none}*{box-sizing:border-box}body{margin:0;line-height:1.85}a{color:#805c3e;text-underline-offset:3px;overflow-wrap:anywhere}main{max-width:980px;margin:42px auto;padding:72px 78px;background:#fffdf7;box-shadow:0 20px 80px #6a594414;border:1px solid #ded2bf}.masthead{display:flex;justify-content:space-between;border-bottom:1px solid #d7c9b5;padding-bottom:19px;font:11px/1.5 Arial,sans-serif;letter-spacing:2px;color:#8b775d}.brand{font-size:16px;font-weight:700;letter-spacing:3px}.eyebrow{font:10px/1.6 Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase;color:#957e60}.cover{padding:42px 0 28px}h1{font-size:36px;line-height:1.45;letter-spacing:-1.3px;margin:14px 0 18px;overflow-wrap:anywhere}.subtitle{font-size:16px;color:#80705c;margin:0}.question{border-left:2px solid #ba9e76;padding:8px 0 8px 19px;margin:26px 0 0;white-space:pre-wrap}.metadata{display:flex;flex-wrap:wrap;gap:8px 22px;font:11px/1.7 Arial,'Malgun Gothic',sans-serif;color:#93816b;margin-top:26px}.confidence{border-top:1px solid #e5dac9;border-bottom:1px solid #e5dac9;padding:21px 0;display:grid;grid-template-columns:190px 1fr;gap:24px}.score{font:34px/1.25 Georgia,serif;color:#765d40}.score small{font-size:13px;color:#958570}.confidence p{margin:5px 0;font-size:12px;color:#88765e}.grade{font:11px/1.6 Arial,sans-serif;letter-spacing:1px;margin-top:7px}section{margin-top:36px}h2{font:12px/1.5 Arial,sans-serif;text-transform:uppercase;letter-spacing:2px;color:#897254;border-bottom:1px solid #e8dfd0;padding-bottom:12px;margin:0 0 21px}h3{font-size:18px;line-height:1.6;margin:0 0 9px}p{font-size:15px;margin:0 0 15px;white-space:pre-wrap;overflow-wrap:anywhere}.lead p{font-size:17px;line-height:1.95}.cite{font:10px Arial,sans-serif;vertical-align:super;text-decoration:none;white-space:nowrap}.citation-warning{font-size:11px;color:#a9695c}.muted,.scope{color:#8c7c67;font-size:12px}.graph-section{margin:38px -32px 0}.graph-section h2,.graph-section figcaption{margin-left:32px;margin-right:32px}figure{margin:0}.graph-sheet{border:1px solid #e6dccd;border-radius:14px;overflow:hidden}.graph-sheet svg{display:block;width:100%;height:auto}figcaption{font:11px/1.75 Arial,'Malgun Gothic',sans-serif;color:#93806a;padding-top:12px}.gap{background:#faf1ec;border-left:2px solid #cc9c91;padding:19px 23px;margin-bottom:15px;break-inside:avoid}.gap-label{color:#af786d;font-size:9px;letter-spacing:.6px}.gap p,.gap li{font-size:13px}.gap .scope{margin-bottom:0}.source-list{padding:0;list-style:none;counter-reset:none}.source{padding:20px 0;border-bottom:1px solid #eee5d8;break-inside:avoid}.source-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.source-head h3{font-size:15px;flex:1;margin:0;overflow-wrap:anywhere}.source-number{font:10px Arial,sans-serif;color:#b0926a}.source-grade{font:10px Arial,sans-serif;color:#9a8468}.source-url{display:block;font:11px/1.8 Arial,sans-serif;margin-top:6px}blockquote{font-size:13px;color:#766551;padding:10px 0 0 17px;border-left:1px solid #d4c4ab;margin:11px 0 0;white-space:normal;overflow-wrap:anywhere}ul,ol{padding-left:22px}li{padding-left:3px;font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}.archive{border-top:1px solid #d7c9b5;padding-top:17px;margin-top:45px;font:10px/1.9 Arial,'Malgun Gothic',sans-serif;color:#a18c71;overflow-wrap:anywhere}.empty{color:#998875;font-size:14px}.draft{padding:13px 18px;background:#f8eee3;color:#9e744d;font-size:13px;margin-bottom:25px}
@media(max-width:700px){main{margin:0;padding:34px 24px;border:0}h1{font-size:29px}.confidence{grid-template-columns:1fr;gap:9px}.graph-section{margin-left:-12px;margin-right:-12px}.graph-section h2,.graph-section figcaption{margin-left:12px;margin-right:12px}.masthead{font-size:9px;letter-spacing:1px}}
@page{size:A4;margin:17mm 16mm 19mm}@media print{:root,body{background:#fff;color:#342c24;-webkit-print-color-adjust:exact;print-color-adjust:exact}main{max-width:none;margin:0;padding:0;box-shadow:none;border:0}.masthead{padding-bottom:12px}.cover{padding:25px 0 20px}h1{font-size:27px}.subtitle{font-size:13px}p{font-size:10.5pt}.lead p{font-size:11.5pt}h2,h3{break-after:avoid}p{orphans:3;widows:3}.graph-section{margin:25px 0 0;break-before:page;break-inside:avoid}.graph-section h2,.graph-section figcaption{margin-left:0;margin-right:0}.graph-sheet svg{max-height:235mm;object-fit:contain;overflow:visible}.confidence,.gap,.source{break-inside:avoid}.source blockquote{font-size:9pt}.archive{font-size:8pt}a{text-decoration:none}.metadata{font-size:9px}.source-url{font-size:8pt}.gap{padding:12px 16px}.gap p,.gap li{font-size:9pt}.scope{font-size:8pt}}
</style></head><body><main><div class="masthead"><span class="brand">CLUEVIA</span><span>RESEARCH REPORT · SAVED EDITION</span></div><header class="cover"><div class="eyebrow">Evidence &amp; reasoning</div><h1>${escape(reportTitle(report))}</h1>${content?.subtitle ? `<p class="subtitle">${escape(content.subtitle)}</p>` : ''}<p class="question">${escape(snapshot.question)}</p><div class="metadata"><span>Created ${escape(report.createdAt)}</span><span>Analysis ${escape(snapshot.analysisUpdatedAt)}</span><span>${snapshot.coverage.sources} sources · ${snapshot.coverage.citations} citations</span></div></header>${report.status !== 'completed' ? `<p class="draft">완료된 보고서가 아닙니다. 저장 상태: ${escape(report.status)}${report.error ? ` · ${escape(report.error)}` : ''}</p>` : ''}<div class="confidence"><div><div class="eyebrow">Confidence</div><div class="score">${escape(scoreLabel)} <small>/ 100</small></div><div class="grade">${confidence.grade ? `GRADE ${escape(confidence.grade)}` : 'NOT RATED'} · ${confidence.accepted ? '조건 충족' : '검토 필요'}</div></div><div><p>저장된 근거 지지 점수입니다. 관측으로 확인된 사건의 진실 확률이나 통계적 확신도가 아닙니다.</p><p>보정 전 ${escape(score(confidence.baselineScore))} / 100 · 상태 ${escape(confidence.status)}</p>${confidence.note ? `<p>${escape(confidence.note)}</p>` : ''}</div></div><section class="lead"><h2>Conclusion</h2>${content?.conclusion.length ? content.conclusion.map(paragraph).join('') : '<p class="empty">저장된 보고서 결론이 없습니다.</p>'}</section>${content?.sections.map(section => `<section><h2>${escape(section.heading)}</h2>${section.paragraphs.map(paragraph).join('')}</section>`).join('') || ''}<section class="graph-section"><h2>Evidence map</h2><figure><div class="graph-sheet">${renderReportGraphSvg(report)}</div><figcaption>저장된 질문·조건·자료·공백을 배치한 도식입니다. 화살표는 원본에 존재하는 연결만 표시합니다. 붉은 연결은 검토 범위이며 사실 관계가 아닙니다. 긴 제목과 연결 설명은 화면에서 도식에 마우스를 올려 확인할 수 있습니다.</figcaption></figure></section><section><h2>Gaps &amp; next evidence</h2>${gapsHtml || '<p class="empty">이 보고서에 저장된 공백은 없습니다. 공백이 없다는 사실만으로 결론이 입증되지는 않습니다.</p>'}</section>${content?.nextSteps.length ? `<section><h2>Next steps</h2>${htmlList(content.nextSteps)}</section>` : ''}<section><h2>Limits</h2>${htmlList([...new Set([...(content?.limitations || []), ...snapshot.coverage.notes, ...snapshot.graph.limitations])]) || '<p class="empty">추가로 저장된 한계 설명이 없습니다.</p>'}</section><section><h2>Sources</h2><ol class="source-list">${sourceHtml || '<li class="empty">저장된 인용 자료가 없습니다.</li>'}</ol></section><div class="archive">이 문서는 생성 시점의 저장 결과를 보존합니다. 이후 케이스 변경은 반영되지 않습니다.<br>Report ${escape(report.id)} · Case ${escape(report.jobId)} · Review ${escape(snapshot.whyRunId)}<br>Model ${escape(report.model)} · Effort ${escape(report.effort)} · Fingerprint ${escape(report.inputHash)}</div></main></body></html>`;
}

/** Plain Markdown keeps the saved narrative, exact quotations and real links. */
export function renderReportMarkdown(report: ReportRun): string {
  const { snapshot, content } = report;
  const numbers = citations(report);
  const paragraph = (item: ReportParagraph) => `${markdown(item.text)}${[...new Set(item.citationIds)].map(id => numbers.has(id) ? `[^${numbers.get(id)}]` : ' \\[인용 연결 확인 필요\\]').join('')}`;
  const sections = [`# ${markdown(reportTitle(report))}`, content?.subtitle ? markdown(content.subtitle) : '',
    `> ${markdown(snapshot.question).replace(/\n/g, '\n> ')}`,
    `Created: ${markdown(report.createdAt)}  \nAnalysis: ${markdown(snapshot.analysisUpdatedAt)}  \nStatus: ${markdown(report.status)}`,
    '## Confidence', `${markdown(score(snapshot.confidence.score))} / 100 · Grade ${markdown(snapshot.confidence.grade || 'Not rated')}  \n보정 전: ${markdown(score(snapshot.confidence.baselineScore))} / 100 · ${snapshot.confidence.accepted ? '조건 충족' : '검토 필요'} · ${markdown(snapshot.confidence.status)}`,
    '저장된 근거 지지 점수입니다. 관측으로 확인된 사건의 진실 확률이나 통계적 확신도가 아닙니다.', markdown(snapshot.confidence.note),
    '## Conclusion', content?.conclusion.map(paragraph).join('\n\n') || '저장된 보고서 결론이 없습니다.',
    ...(content?.sections.flatMap(section => [`## ${markdown(section.heading)}`, ...section.paragraphs.map(paragraph)]) || []),
    '## Evidence map', '아래 목록은 저장된 노드와 연결입니다. 붉은 공백에 해당하는 검토 연결은 사실 관계가 아닙니다. HTML 내보내기에 동일한 그래프의 도식이 포함됩니다.'];
  const selection = graphSelection(report, false);
  const labels = new Map(selection.nodes.map((node, index) => [node.id, { number: index + 1, label: node.label }]));
  sections.push(`노드 ${selection.nodes.length}/${selection.graph.nodes.length} · 연결 ${selection.edges.length}/${selection.graph.edges.length}${selection.omittedNodes || selection.omittedEdges ? ' · 공간상 일부 생략' : ''}`);
  sections.push(selection.nodes.map((node, index) => `- N${index + 1} · ${markdown(node.type)}: ${markdown(node.label)} · ID ${markdown(node.id)}${node.properties.gapType ? ` · ${markdown(node.properties.gapType)}` : ''}${node.description ? ` — ${markdown(node.description).replace(/\n/g, ' ')}` : ''}`).join('\n'));
  sections.push(selection.edges.map(edge => `- N${labels.get(edge.source)!.number} → N${labels.get(edge.target)!.number}: ${markdown(edge.label)} · ID ${markdown(edge.id)} · ${markdown(edge.status)}${edge.description ? ` — ${markdown(edge.description).replace(/\n/g, ' ')}` : ''}`).join('\n'));
  sections.push('## Gaps & next evidence');
  if (!snapshot.gaps.length) sections.push('저장된 공백은 없습니다. 공백이 없다는 사실만으로 결론이 입증되지는 않습니다.');
  snapshot.gaps.forEach(gap => {
    const narrative = content?.gapAnalysis.find(item => item.gapId === gap.id);
    sections.push(`### ${markdown(gap.title || gapLabels[gap.type] || gap.type)}`, `${markdown(gap.type)} · ${markdown(gap.evaluationState)} · ${markdown(gap.blockingScope)}`, markdown(gap.explanation));
    if (narrative?.analysis) sections.push(markdown(narrative.analysis));
    if (gap.requirements.length) sections.push(`관련 조건: ${gap.requirements.map(markdown).join(' · ')}`);
    const recommendations = [...new Set([...(narrative?.recommendation ? [narrative.recommendation] : []), ...gap.recommendations])];
    if (recommendations.length) sections.push(recommendations.map(item => `- ${markdown(item).replace(/\n/g, '\n  ')}`).join('\n'));
  });
  if (content?.nextSteps.length) sections.push('## Next steps', content.nextSteps.map(item => `- ${markdown(item).replace(/\n/g, '\n  ')}`).join('\n'));
  sections.push('## Limits', [...new Set([...(content?.limitations || []), ...snapshot.coverage.notes, ...snapshot.graph.limitations])].map(item => `- ${markdown(item).replace(/\n/g, '\n  ')}`).join('\n') || '추가로 저장된 한계 설명이 없습니다.', '## Sources');
  snapshot.citations.forEach((citation, index) => {
    const url = safeUrl(citation.url);
    sections.push(`[^${index + 1}]: ${markdown(citation.sourceName)} · Grade ${markdown(citation.sourceGrade || 'Not rated')}${citation.record !== null ? ` · Record ${citation.record}` : ''}${url ? `  \n    <${url}>` : citation.url ? '  \n    안전한 웹 링크 형식이 아니므로 연결을 생략했습니다.' : ''}${citation.quote ? `\n\n    > ${markdown(citation.quote).replace(/\n/g, '\n    > ')}` : '\n\n    저장된 직접 인용이 없습니다.'}`);
  });
  sections.push('---', '이 문서는 생성 시점의 저장 결과를 보존하며 이후 케이스 변경은 반영하지 않습니다.', `Report: ${markdown(report.id)}  \nCase: ${markdown(report.jobId)}  \nReview: ${markdown(snapshot.whyRunId)}  \nModel: ${markdown(report.model)} · Effort: ${markdown(report.effort)}  \nFingerprint: ${markdown(report.inputHash)}`);
  return sections.filter(Boolean).join('\n\n') + '\n';
}

export function reportFilename(report: ReportRun, extension: string): string {
  const normalized = reportTitle(report).normalize('NFKC').replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  let title = [...normalized].slice(0, 80).join('').replace(/[. ]+$/g, '') || 'Cluevia-report';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = 'Cluevia-' + title;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(report.createdAt)?.[0] || 'saved';
  const suffix = extension.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'txt';
  return `${title}-${date}.${suffix}`;
}
