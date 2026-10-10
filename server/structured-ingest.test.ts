import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredBatches, isStructuredName } from './structured-ingest.ts';
import type { StructuredBatch } from './structured-ingest.ts';
import { compileExtraction } from './ontology.ts';
import { OntologyStore } from './ontology-store.ts';

function* pieces(text: string, length = 7): Generator<string> { for (let at = 0; at < text.length; at += length) yield text.slice(at, at + length); }
async function collect(name: string, text: string, length = 7): Promise<StructuredBatch[]> {
  const batches: StructuredBatch[] = [];
  for await (const batch of structuredBatches({ id: 'original-file', name }, pieces(text, length))) {
    compileExtraction(batch.extraction, { question: '전체 자료를 변환해주세요.', documents: batch.documents });
    batches.push(batch);
  }
  return batches;
}
const entities = (batches: StructuredBatch[]) => batches.flatMap(batch => batch.extraction.entities);

test('recognizes only structured file extensions', () => {
  for (const name of ['records.CSV', 'ships.tsv', 'data.jsonl', 'data.ndjson', 'data.json']) assert.ok(isStructuredName(name));
  for (const name of ['source.txt', 'data.json.txt', 'csv']) assert.equal(isStructuredName(name), false);
});

test('CSV preserves quoted newlines, escaped quotes, CRLF and a split BOM', async () => {
  const raw = '\uFEFFship_name,owner_company,imo,note\r\n"Ocean, Star","ACME ""Marine""",9074729,"첫 줄\r\n다음 줄"\r\n';
  const batches = await collect('ships.csv', raw, 1);
  assert.equal(batches.length, 1); assert.equal(batches[0].records, 1);
  assert.deepEqual(entities(batches).map(entity => [entity.label, entity.type]), [['Ocean, Star', 'vessel'], ['ACME "Marine"', 'organization']]);
  const ship = entities(batches)[0];
  assert.equal(ship.properties.find(property => property.key === 'note')?.value, '첫 줄\r\n다음 줄');
  assert.equal(batches[0].extraction.relationships[0].type, 'owns');
  assert.ok(batches[0].documents[0].text.includes('"Ocean, Star","ACME ""Marine""",9074729,"첫 줄\r\n다음 줄"\r\n'));
});

test('TSV keeps unknown records and repeated ids as distinct rows', async () => {
  const batches = await collect('records.tsv', 'id\tname\tvalue\n7\tAlpha\t12\n7\tAlpha\t13\n');
  const rows = entities(batches);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows.every(row => row.type === 'asset')); assert.equal(batches[0].extraction.relationships.length, 0);
  assert.equal(rows[1].properties.find(property => property.key === 'value')?.value, '13');
});

test('JSON arrays parse nesting, escapes and primitives across every boundary', async () => {
  const input = '[{"ship_name":"Ocean Star", "operator_company":"ACME Marine", "data":[1,{"x":"a}\\\"b"}]},true,0,null,"a",[]]';
  const batches = await collect('records.json', input, 1);
  assert.equal(batches.reduce((sum, batch) => sum + batch.records, 0), 6);
  assert.equal(entities(batches)[0].label, 'Ocean Star');
  assert.equal(batches[0].extraction.relationships[0].type, 'operates');
  assert.ok(entities(batches).some(entity => entity.properties.some(property => property.value === 'null')));
});

test('JSON wrapped arrays stream every array and preserve metadata', async () => {
  const input = '{"name":"sample dataset", "data":[{"ship_name":"Ocean Star"},{"ship_name":"Moon Star"}], "total":2,"other":[{"person_name":"Jane Doe"}]}';
  const batches = await collect('records.json', input, 3);
  assert.equal(batches.reduce((sum, batch) => sum + batch.records, 0), 4);
  assert.deepEqual(entities(batches).slice(0, 3).map(entity => entity.label), ['Ocean Star', 'Moon Star', 'Jane Doe']);
  const metadata = entities(batches).at(-1)!;
  assert.equal(metadata.properties.find(property => property.key === 'name')?.value, 'sample dataset');
  assert.equal(metadata.properties.find(property => property.key === 'total')?.value, '2');
});

test('flat root JSON object retains its complete exact source record', async () => {
  const input = '{ "ship_name": "Ocean Star", "owner_company":"Acme", "number":12 }';
  const batches = await collect('record.json', input, 1);
  assert.equal(batches[0].records, 1);
  assert.equal(batches[0].documents[0].text, input);
  assert.equal(batches[0].extraction.relationships[0].type, 'owns');
});

test('JSONL supports BOM, CRLF, blanks, final unterminated line and clear parse errors', async () => {
  const batches = await collect('records.ndjson', '\uFEFF{"person_name":"Jane Doe"}\r\n\n{"person_name":"John Doe"}', 1);
  assert.equal(batches[0].records, 2);
  await assert.rejects(() => collect('records.jsonl', '{"id":1}\n\n{bad}\n'), /JSONL 3번째 줄/);
});

test('malformed data is explicit and never falls back or silently drops trailing input', async () => {
  for (const text of ['[{"a":1},]', '[{"a":1}', '[1] garbage', '{"data":[1],}', '{"x":1,"x":2}', '["unterminated]', '{"data":[1],"other":[2]']) {
    await assert.rejects(() => collect('broken.json', text, 1), /JSON/);
  }
  for (const text of ['x,y\n"unfinished,2', 'x,y\n1,2,3\n', 'x,y\n"foo"bar,2', 'x,y\na"b,2']) {
    await assert.rejects(() => collect('broken.csv', text, 1), /CSV 레코드/);
  }
});

test('a field larger than prior upload cap remains complete in raw evidence, with visible display truncation', async () => {
  const huge = '한'.repeat(750_000);
  const input = `id,note\n1,${huge}\n`;
  assert.ok(Buffer.byteLength(input) > 2 * 1024 * 1024);
  const batches = await collect('large.csv', input, 8192);
  assert.equal(batches[0].records, 1);
  assert.ok(batches[0].documents[0].text.includes(huge));
  assert.match(entities(batches)[0].properties.find(property => property.key === 'note')!.value, /생략/);
  assert.ok(batches[0].extraction.limitations.some(value => value.includes('전체 값')));
});

test('more than 2 MB of rows are covered exactly once in bounded deterministic batches without model access', async () => {
  const rowCount = 16_000; const note = 'source detail '.repeat(12);
  const input = `record_id,note\n${Array.from({ length: rowCount }, (_, index) => `${index},${note}\n`).join('')}`;
  assert.ok(Buffer.byteLength(input) > 2 * 1024 * 1024);
  let covered = 0; let graphCount = 0; const ids = new Set<string>();
  for await (const batch of structuredBatches({ id: 'large-source', name: 'large.csv' }, pieces(input, 30_000))) {
    compileExtraction(batch.extraction, { question: '모든 레코드를 처리해주세요.', documents: batch.documents });
    covered += batch.records; graphCount++;
    assert.ok(batch.extraction.entities.length <= 180); assert.equal(batch.documents.length, 1);
    for (const entity of batch.extraction.entities) { assert.ok(!ids.has(entity.id)); ids.add(entity.id); }
  }
  assert.equal(covered, rowCount); assert.equal(ids.size, rowCount); assert.ok(graphCount > 1);
});

test('stable replay and separate file scopes do not reuse document ids', async () => {
  const first = await collect('same.csv', 'id,name\n1,Same Name\n'); const second = await collect('same.csv', 'id,name\n1,Same Name\n');
  assert.deepEqual(first, second);
  const other: StructuredBatch[] = [];
  for await (const batch of structuredBatches({ id: 'another-file', name: 'same.csv' }, ['id,name\n1,Same Name\n'])) other.push(batch);
  assert.notEqual(first[0].documents[0].id, other[0].documents[0].id);
});

test('cancellation interrupts ongoing parsing before the rest of the file is consumed', async () => {
  const controller = new AbortController(); let read = 0;
  async function* source() {
    yield 'id,name\n';
    for (let index = 0; index < 100_000; index++) { read++; if (index === 500) controller.abort(); yield `${index},Record ${index}\n`; }
  }
  await assert.rejects(async () => { for await (const _batch of structuredBatches({ id: 'abort', name: 'data.csv' }, source(), { signal: controller.signal })) { /* consume */ } }, /취소/);
  assert.ok(read < 1000);
});

test('display property keys cannot collide with server metadata or empty JSON keys', async () => {
  const batches = await collect('record.json', '{"원본 레코드 번호":"user value","생략 필드 수":"user count","":"empty key","ship_name":{"nested":"not a ship label"}}');
  const record = entities(batches)[0];
  assert.equal(record.type, 'asset');
  assert.equal(new Set(record.properties.map(property => property.key)).size, record.properties.length);
  assert.ok(record.properties.some(property => property.value === 'user value'));
});

test('long CSV rows quote mapped values beyond the first excerpt, including escaped names', async () => {
  const batches = await collect('ships.csv', `note,ship_name,owner_company\n${'x'.repeat(4000)},Ocean Star,"ACME ""Marine"""\n`, 19);
  const owner = entities(batches)[1];
  assert.ok(owner.evidence.some(item => item.quote.includes('ACME ""Marine""')));
  assert.ok(entities(batches)[0].evidence.some(item => item.quote.includes('Ocean Star')));
});


test('long filenames cannot collapse separate generic records in the ontology store', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  const padding = 'source record detail '.repeat(14_000);
  const batches = await collect(`${'긴자료이름'.repeat(45)}.csv`, `id,note\n1,first ${padding}\n2,second ${padding}\n`, 8192);
  assert.equal(batches.length, 2);
  const labels = entities(batches).map(entity => entity.label);
  assert.equal(new Set(labels).size, 2); assert.ok(labels.every(label => label.length <= 180));
  assert.ok(labels[0].startsWith('레코드 1')); assert.ok(labels[1].startsWith('레코드 2'));
  for (const batch of batches) {
    const graph = compileExtraction(batch.extraction, { question: '전체 레코드', documents: batch.documents });
    store.saveGraph({ ...graph, origin: 'structured' }, batch.documents, batch.extraction);
  }
  assert.equal(store.summary().entities, 2);
});

test('long semantic labels preserve tail identity and repeated full values still join', async t => {
  const store = new OntologyStore(':memory:'); t.after(() => store.close());
  const vessel = 'Very long vessel name '.repeat(12); const owner = 'Very long owner company '.repeat(12); const operator = 'Very long operator company '.repeat(12);
  const padding = 'source record detail '.repeat(14_000);
  const row = (tail: string) => `${vessel}${tail},${owner}${tail},${operator}${tail},${padding}\n`;
  const batches = await collect('ships.csv', `ship_name,owner_company,operator_company,note\n${row('A')}${row('B')}${row('A')}`, 8192);
  assert.equal(batches.length, 3);
  const labels = entities(batches).map(entity => entity.label);
  assert.equal(new Set(labels).size, 6); assert.ok(labels.every(label => label.length <= 180 && label.includes('생략')));
  assert.equal(labels[0], labels[6]); assert.notEqual(labels[0], labels[3]);
  for (const batch of batches) {
    const graph = compileExtraction(batch.extraction, { question: '전체 선박과 회사', documents: batch.documents });
    store.saveGraph({ ...graph, origin: 'structured' }, batch.documents, batch.extraction);
  }
  assert.equal(store.summary().entities, 6);
});
