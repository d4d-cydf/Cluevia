import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EVIDENCE_CHUNK_CHARS, EvidenceUploadError, EvidenceUploads, splitEvidenceText } from './evidence-uploads.ts';
import type { UploadedEvidence } from './evidence-uploads.ts';

async function* bytes(input: Buffer, step = 1021) {
  for (let offset = 0; offset < input.length; offset += step) yield input.subarray(offset, offset + step);
}
function reconstruct(uploads: EvidenceUploads, upload: UploadedEvidence) {
  let text = ''; let previousEnd = 0;
  for (let index = 0; index < upload.chunkCount; index++) {
    const chunk = uploads.getChunk(upload.id, index)!; const range = uploads.getChunkRange(upload.id, index)!;
    assert.ok(chunk.text.length <= EVIDENCE_CHUNK_CHARS);
    assert.equal(chunk.text.length, range.end - range.start);
    assert.ok(range.start <= previousEnd, 'Consecutive ranges must leave no gaps.');
    if (index) assert.ok(previousEnd - range.start >= 200, 'Every boundary has contextual overlap.');
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk.text), 'Chunk cannot start inside a surrogate pair.');
    assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk.text), 'Chunk cannot end inside a surrogate pair.');
    assert.equal(chunk.identityScope, upload.id);
    assert.ok(chunk.id.length <= 80); assert.ok(chunk.name.length <= 300);
    text += chunk.text.slice(previousEnd - range.start); previousEnd = range.end;
  }
  assert.equal(previousEnd, upload.characters);
  return text;
}
function empty(db: DatabaseSync) {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_uploads').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_upload_chunks').get()!.n, 0);
}

test('UTF-8 streaming preserves BOM, Unicode, newlines and exact full-file coverage with overlap', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    const original = `\uFEFF${'선박 Ocean Star 😀와 항구\r\n기록은 그대로 보존합니다.\n'.repeat(4000)}끝\n`;
    const buffer = Buffer.from(original, 'utf8');
    const result = await uploads.receive('기록.TXT', bytes(buffer, 257));
    assert.equal(result.bytes, buffer.byteLength); assert.equal(result.characters, original.length);
    assert.ok(result.chunkCount > 1); assert.equal(reconstruct(uploads, result), original);
    assert.deepEqual([...splitEvidenceText(original)].map(chunk => chunk.text), Array.from({ length: result.chunkCount }, (_, i) => uploads.getChunk(result.id, i)!.text));
    assert.equal(uploads.getChunk(result.id, -1), undefined); assert.equal(uploads.getChunk(result.id, result.chunkCount), undefined);
  } finally { db.close(); }
});

test('files larger than 2MB are accepted by default even when the producer yields one large Buffer', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    const original = 'id,선박,내용\n1,Ocean Star,원본 전체를 순서대로 읽습니다.\n'.repeat(45_000);
    const buffer = Buffer.from(original); assert.ok(buffer.byteLength > 2_000_000);
    const result = await uploads.receive('large.csv', bytes(buffer, buffer.length));
    assert.equal(result.bytes, buffer.length); assert.equal(reconstruct(uploads, result), original);
  } finally { db.close(); }
});

test('staging rows and their chunks remain unavailable until upload completion', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    async function* stream() {
      yield Buffer.from('a'.repeat(40_000));
      const row = db.prepare('SELECT id FROM evidence_uploads').get()!;
      assert.equal(uploads.get(String(row.id)), undefined); assert.equal(uploads.getChunk(String(row.id), 0), undefined);
      assert.equal(uploads.getChunkRange(String(row.id), 0), undefined);
      assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM evidence_upload_chunks').get()!.n) > 0);
      yield Buffer.from(' completed');
    }
    const result = await uploads.receive('staging.md', stream());
    assert.ok(uploads.get(result.id)); assert.equal(reconstruct(uploads, result), 'a'.repeat(40_000) + ' completed');
  } finally { db.close(); }
});

test('cancellation while waiting for another chunk deletes every partial row promptly', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db); const controller = new AbortController();
  try {
    let notify!: () => void; const waiting = new Promise<void>(resolve => { notify = resolve; });
    let calls = 0;
    const stream: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
      next() { if (!calls++) return Promise.resolve({ done: false, value: Buffer.from('a'.repeat(40_000)) }); notify(); return new Promise<IteratorResult<Uint8Array>>(() => undefined); },
      return() { return Promise.resolve({ done: true, value: undefined }); },
    }; } };
    const result = uploads.receive('cancel.txt', stream, { signal: controller.signal });
    await waiting; controller.abort();
    await assert.rejects(result, (error: unknown) => error instanceof EvidenceUploadError && error.status === 499);
    empty(db);
  } finally { db.close(); }
});

test('malformed UTF-8 including a truncated final sequence and binary controls delete partial uploads', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    for (const invalid of [Buffer.from([0xc3]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0])]) {
      async function* stream() { yield Buffer.from('a'.repeat(40_000)); yield invalid; }
      await assert.rejects(uploads.receive('invalid.txt', stream()), (error: unknown) => error instanceof EvidenceUploadError && error.status === 415);
      empty(db);
    }
  } finally { db.close(); }
});

test('an explicit optional byte cap and source stream failures clean up previously persisted chunks', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    await assert.rejects(uploads.receive('bounded.txt', bytes(Buffer.from('a'.repeat(50_000)), 40_000), { maxBytes: 45_000 }), (error: unknown) => error instanceof EvidenceUploadError && error.status === 413);
    empty(db);
    async function* broken() { yield Buffer.from('a'.repeat(40_000)); throw new Error('Raw connection failure details.'); }
    await assert.rejects(uploads.receive('broken.txt', broken()), (error: unknown) => error instanceof EvidenceUploadError && error.status === 500 && !error.message.includes('Raw connection'));
    empty(db);
  } finally { db.close(); }
});

test('invalid filenames, empty files and pre-cancelled requests leave no stored evidence', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    for (const name of ['../report.txt', 'bad\nname.txt']) await assert.rejects(uploads.receive(name, bytes(Buffer.from('data'))), EvidenceUploadError);
    await assert.rejects(uploads.receive('empty.txt', bytes(Buffer.alloc(0))), /비어 있는 파일/);
    await assert.rejects(uploads.receive('aborted.txt', bytes(Buffer.from('data')), { signal: AbortSignal.abort() }), (error: unknown) => error instanceof EvidenceUploadError && error.status === 499);
    empty(db);
  } finally { db.close(); }
});

test('completed upload metadata and exact original text survive restart and can be deleted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cluevia-upload-')); const filename = join(directory, 'evidence.sqlite');
  const original = '원문 🛳️\r\n'.repeat(9000);
  let db = new DatabaseSync(filename);
  try {
    const saved = await new EvidenceUploads(db).receive('durable.json', bytes(Buffer.from(original)));
    db.close(); db = new DatabaseSync(filename);
    const uploads = new EvidenceUploads(db);
    assert.deepEqual(uploads.get(saved.id), saved); assert.equal(reconstruct(uploads, saved), original);
    uploads.delete(saved.id); assert.equal(uploads.get(saved.id), undefined); empty(db);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reports.jsonl and other text formats preserve every record regardless of extension', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    const records = Array.from({ length: 15_000 }, (_, index) => JSON.stringify({ id: index, vessel: 'Ocean Star', report: '원문 기록 🛳️' })).join('\n') + '\n';
    for (const name of ['reports.jsonl', 'reports.NDJSON', 'table.tsv', 'report.xml', 'config.yaml', 'events.log', 'source.py', 'custom.data', 'README']) {
      const original = name === 'reports.jsonl' ? records : 'Original UTF-8 evidence: 선박 기록.\n';
      const result = await uploads.receive(name, bytes(Buffer.from(original), 4093));
      assert.equal(result.name, name);
      assert.equal(reconstruct(uploads, result), original);
      uploads.delete(result.id);
    }
    empty(db);
  } finally { db.close(); }
});

test('ASCII-only PDF containers are rejected by content even when renamed as JSONL', async () => {
  const db = new DatabaseSync(':memory:'); const uploads = new EvidenceUploads(db);
  try {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    for (const name of ['report.pdf', 'renamed.jsonl']) {
      await assert.rejects(uploads.receive(name, bytes(pdf, 1)), (error: unknown) => error instanceof EvidenceUploadError && error.status === 415 && error.message.includes('PDF'));
      empty(db);
    }
  } finally { db.close(); }
});
