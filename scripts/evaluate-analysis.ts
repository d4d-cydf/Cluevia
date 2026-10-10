import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { goldCases, scoreExtraction } from '../server/analysis-evaluation.ts';
import { relevantPassages, searchTerms } from '../server/evidence-search.ts';
import { WorkPool } from '../server/work-pool.ts';
import { extractionSchema, parseExtraction } from '../server/ontology.ts';
import { runCodex, effectiveCodexConfig } from '../server/codex.ts';
import { readProductConfig } from '../server/product-config.ts';

const live = process.argv.includes('--live');
const query = 'Aster 자금 흐름';
const text = 'Unrelated administrative background. '.repeat(2000) + '\nAster 송금: 지급 참조 TX-778, 수취인은 Boreal입니다.\n';
const passages = relevantPassages(text, searchTerms(query));
async function schedule(limit: number) {
  const pool = new WorkPool(limit); const start = performance.now();
  await Promise.all(Array.from({ length: 8 }, async () => { const release = await pool.acquire(new AbortController().signal); try { await delay(20); } finally { release(); } }));
  return performance.now() - start;
}
const report: Record<string, unknown> = {
  schemaVersion: 'analysis-eval-1', createdAt: new Date().toISOString(), mode: live ? 'live-synthetic-corpus' : 'offline-harness',
  retrieval: { baselineFirst8000FindsGold: text.slice(0, 8000).includes('TX-778'), relevantPassagesFindGold: passages.some(item => item.text.includes('TX-778')), excerptsAreExact: passages.every(item => item.text === text.slice(item.start, item.end)) },
  simulatedScheduling: { note: 'Eight synthetic 20 ms tasks; this does not estimate model latency or production speedup.', serialMs: await schedule(1), concurrent2Ms: await schedule(2) },
};
if (live) {
  const config = effectiveCodexConfig(readProductConfig(process.cwd()).codex);
  const results = [];
  for (const gold of goldCases) {
    const input = { question: 'Extract all explicitly stated objects and relationship claims, including denials/retractions. Preserve every registry identifier in identifiers with namespace registry. Use only owns, part_of, located_in as appropriate. No extra documentary objects. Never merge the different Alex identities.', documents: [{ id: 'source-1', name: `${gold.id}.txt`, text: gold.text }] };
    process.stderr.write(`Evaluating ${gold.id} with ${config.effort}\n`);
    const started = performance.now(); let usage: unknown;
    try {
      const candidate = await runCodex({ ...input, schema: extractionSchema }, config, { onUsage: value => { usage = value; } });
      const extraction = parseExtraction(candidate, input);
      results.push({ id: gold.id, elapsedMs: performance.now() - started, usage, validEvidence: true, ...scoreExtraction(gold, extraction) });
    } catch (error) { results.push({ id: gold.id, elapsedMs: performance.now() - started, validEvidence: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  report.model = config.model; report.effort = config.effort; report.cases = results;
  const times = results.map(result => result.elapsedMs).sort((a, b) => a - b);
  report.latency = { p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1] };
  report.note = 'Small synthetic regression corpus, not a claim about real-world OSINT accuracy. Compare reports under identical model/settings before lowering effort.';
  if (results.some(result => !result.validEvidence || ('relationRecall' in result && (result.relationRecall !== 1 || result.relationPrecision !== 1 || result.entityRecall !== 1 || result.entityPrecision !== 1 || result.wrongMerges)))) process.exitCode = 1;
} else report.note = 'No model was called. Run with --live to measure extraction quality and latency; offline checks cannot establish LLM accuracy.';
console.log(JSON.stringify(report, null, 2));
