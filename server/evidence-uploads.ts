import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EvidenceDocument } from '../src/types/graph.ts';

export const EVIDENCE_CHUNK_CHARS = 30_000;
export const EVIDENCE_OVERLAP_CHARS = 200;
const DECODE_BLOCK_BYTES = 64 * 1024;

export interface UploadedEvidence {
  id: string; name: string; bytes: number; characters: number; chunkCount: number; createdAt: string;
}
/** Character offsets are UTF-16 offsets, matching JavaScript substring and existing graph limits. */
export interface EvidenceTextChunk { text: string; start: number; end: number }
export class EvidenceUploadError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'EvidenceUploadError'; this.status = status; }
}

function safeBoundary(text: string, index: number): number {
  const current = text.charCodeAt(index); const previous = text.charCodeAt(index - 1);
  return current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index;
}
function cutLength(text: string): number {
  const limit = safeBoundary(text, EVIDENCE_CHUNK_CHARS);
  const newline = text.lastIndexOf('\n', limit - 1) + 1;
  return newline >= EVIDENCE_CHUNK_CHARS / 2 ? newline : limit;
}
function nextStart(text: string, end: number): number { return safeBoundary(text, end - EVIDENCE_OVERLAP_CHARS); }

/** Splits inline text with the same coverage and overlap contract as streamed uploads. */
export function* splitEvidenceText(text: string): Generator<EvidenceTextChunk> {
  let start = 0;
  while (text.length - start > EVIDENCE_CHUNK_CHARS) {
    const pending = text.slice(start, start + EVIDENCE_CHUNK_CHARS + 1);
    const length = cutLength(pending);
    yield { text: pending.slice(0, length), start, end: start + length };
    start += nextStart(pending, length);
  }
  if (start < text.length) yield { text: text.slice(start), start, end: text.length };
}

function nameOf(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 300 || /[\u0000-\u001f\u007f/\\]/u.test(value)) throw new EvidenceUploadError(400, '자료 이름은 경로 없이 1–300자로 입력해주세요.');
  const name = value.trim();
  return name;
}

/** Completed uploads are immutable. Staging rows never enter get/getChunk or model input. */
export class EvidenceUploads {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_uploads (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        characters INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('uploading','complete'))
      );
      CREATE TABLE IF NOT EXISTS evidence_upload_chunks (
        upload_id TEXT NOT NULL REFERENCES evidence_uploads(id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL, document_id TEXT NOT NULL UNIQUE,
        start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(upload_id, part_index)
      );
    `);
  }

  async receive(name: string, stream: AsyncIterable<Uint8Array>, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<UploadedEvidence> {
    const validName = nameOf(name);
    const maximum = options.maxBytes ?? 0;
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new EvidenceUploadError(500, '업로드 용량 설정이 올바르지 않습니다.');
    if (options.signal?.aborted) throw new EvidenceUploadError(499, '자료 업로드를 취소했습니다.');
    const id = `upload-${randomUUID()}`; const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO evidence_uploads(id,name,created_at,status) VALUES (?,?,?,?)').run(id, validName, createdAt, 'uploading');
    const insert = this.db.prepare('INSERT INTO evidence_upload_chunks VALUES (?,?,?,?,?,?)');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let bytes = 0; let characters = 0; let chunkCount = 0; let pending = ''; let offset = 0; let completed = false;
    let signature = Buffer.alloc(0);
    let rejectAbort!: (reason: EvidenceUploadError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => undefined);
    const abort = () => rejectAbort(new EvidenceUploadError(499, '자료 업로드를 취소했습니다.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let iterator: AsyncIterator<Uint8Array> | undefined;
    function checkAbort() { if (options.signal?.aborted) throw new EvidenceUploadError(499, '자료 업로드를 취소했습니다.'); }
    const persist = (text: string, start: number) => {
      insert.run(id, chunkCount, `${id}-part-${chunkCount + 1}`, start, start + text.length, text);
      chunkCount++;
    };
    const append = (text: string) => {
      // These controls are neither normal text whitespace nor usable model evidence.
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) throw new EvidenceUploadError(415, '텍스트로 직접 읽을 수 없는 파일입니다. PDF·Office·이미지·압축 파일은 텍스트를 추출한 뒤 첨부해주세요. JSONL·CSV·로그 등 UTF-8 텍스트는 확장자 제한 없이 지원합니다.');
      characters += text.length;
      pending += text;
      while (pending.length > EVIDENCE_CHUNK_CHARS) {
        checkAbort();
        const end = cutLength(pending); persist(pending.slice(0, end), offset);
        const next = nextStart(pending, end); pending = pending.slice(next); offset += next;
      }
    };
    const decode = (value?: Uint8Array, streaming = false) => {
      let text: string;
      try { text = decoder.decode(value, { stream: streaming }); }
      catch { throw new EvidenceUploadError(415, 'UTF-8 텍스트로 읽을 수 없습니다. 텍스트 파일은 UTF-8로 저장해주세요. PDF·Office·이미지·압축 파일은 별도 텍스트 추출이 필요합니다.'); }
      append(text);
    };
    try {
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        checkAbort();
        const item = await Promise.race([iterator.next(), aborted]);
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) throw new EvidenceUploadError(400, '자료 업로드 스트림이 올바르지 않습니다.');
        bytes += item.value.byteLength;
        if (!Number.isSafeInteger(bytes) || (maximum > 0 && bytes > maximum)) throw new EvidenceUploadError(413, '서버에 설정된 자료 업로드 용량을 초과했습니다.');
        // Some PDFs contain only ASCII bytes. Detect their container signature before treating them as evidence text.
        if (signature.length < 5) {
          signature = Buffer.concat([signature, item.value.subarray(0, 5 - signature.length)]);
          if (signature.toString('ascii') === '%PDF-') throw new EvidenceUploadError(415, 'PDF는 문서 내용 추출이 필요합니다. 텍스트를 추출한 뒤 TXT·JSONL 등으로 첨부해주세요.');
        }
        // A producer may yield one huge Buffer. Decode bounded slices, not that entire Buffer.
        for (let start = 0; start < item.value.byteLength; start += DECODE_BLOCK_BYTES) {
          checkAbort(); decode(item.value.subarray(start, start + DECODE_BLOCK_BYTES), true);
        }
      }
      checkAbort(); decode();
      if (!bytes) throw new EvidenceUploadError(400, '비어 있는 파일은 분석할 수 없습니다.');
      if (pending.length) persist(pending, offset);
      this.db.prepare("UPDATE evidence_uploads SET bytes=?,characters=?,chunk_count=?,status='complete' WHERE id=? AND status='uploading'").run(bytes, characters, chunkCount, id);
      completed = true;
      return { id, name: validName, bytes, characters, chunkCount, createdAt };
    } catch (error) {
      try { this.delete(id); } catch { /* A closed/unavailable database is already a failed upload. */ }
      if (error instanceof EvidenceUploadError) throw error;
      if (options.signal?.aborted) throw new EvidenceUploadError(499, '자료 업로드를 취소했습니다.');
      throw new EvidenceUploadError(500, '자료 업로드를 저장하지 못했습니다. 연결 상태와 서버 저장 공간을 확인해주세요.');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (!completed && iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }

  get(id: string): UploadedEvidence | undefined {
    const row = this.db.prepare("SELECT * FROM evidence_uploads WHERE id=? AND status='complete'").get(id);
    return row ? { id: String(row.id), name: String(row.name), bytes: Number(row.bytes), characters: Number(row.characters), chunkCount: Number(row.chunk_count), createdAt: String(row.created_at) } : undefined;
  }

  getChunk(uploadId: string, index: number): EvidenceDocument | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const row = this.db.prepare(`SELECT c.document_id,c.text,u.name FROM evidence_upload_chunks c
      JOIN evidence_uploads u ON u.id=c.upload_id WHERE c.upload_id=? AND c.part_index=? AND u.status='complete'`).get(uploadId, index);
    return row ? { id: String(row.document_id), name: `${String(row.name).slice(0, 260)} · part ${index + 1}`, text: String(row.text), identityScope: uploadId } : undefined;
  }

  getChunkRange(uploadId: string, index: number): { start: number; end: number } | undefined {
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    const row = this.db.prepare(`SELECT c.start_offset,c.end_offset FROM evidence_upload_chunks c
      JOIN evidence_uploads u ON u.id=c.upload_id WHERE c.upload_id=? AND c.part_index=? AND u.status='complete'`).get(uploadId, index);
    return row ? { start: Number(row.start_offset), end: Number(row.end_offset) } : undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM evidence_upload_chunks WHERE upload_id=?').run(id);
    this.db.prepare('DELETE FROM evidence_uploads WHERE id=?').run(id);
  }
}
