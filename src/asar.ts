// Replaces one file inside an Electron asar archive, keeping every other file and the header's bookkeeping right.
// Format (as @electron/asar writes it): 8 bytes of Pickle holding the header's size, the header — a Pickle holding a
// JSON string — then the files' bytes back to back; a file entry's offset counts from the end of the header.
// Unpacked files have no offset: their bytes live in the .unpacked folder next to the archive.
import { createHash } from 'node:crypto';

export type ReplaceOutcome =
  | { readonly kind: 'replaced'; readonly archive: Buffer }
  | { readonly kind: 'file-not-found'; readonly path: string };

type Json = { readonly [key: string]: unknown };

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

type PackedFile = { readonly offset: number; readonly size: number };

/** The header's entry for `path` ('/'-separated), when it is a file stored inside the archive. */
function packedFileAt(header: Json, path: string): PackedFile | undefined {
  let node: unknown = header;
  for (const name of path.split('/')) {
    if (!isJson(node) || !isJson(node.files)) return undefined;
    node = node.files[name];
  }
  if (!isJson(node) || typeof node.offset !== 'string' || typeof node.size !== 'number') return undefined;
  return { offset: Number(node.offset), size: node.size };
}

const integrityBlockSize = 4 * 1024 * 1024;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The integrity record @electron/asar writes: the file's hash and the hashes of its 4 MiB blocks. */
function integrityOf(content: Buffer) {
  const blocks = [];
  for (let start = 0; start === 0 || start < content.length; start += integrityBlockSize) {
    blocks.push(sha256(content.subarray(start, start + integrityBlockSize)));
  }
  return { algorithm: 'SHA256', hash: sha256(content), blockSize: integrityBlockSize, blocks };
}

/** A copy of the header with the replaced file's new content and every file stored after it moved by the difference. */
function resizedHeader(node: Json, replaced: PackedFile, content: Buffer): Json {
  const entries = Object.entries(node).map(([key, value]): [string, unknown] => {
    if (key === 'files' && isJson(value)) {
      return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, isJson(child) ? resizedHeader(child, replaced, content) : child]))];
    }
    return [key, value];
  });
  const copy = Object.fromEntries(entries);
  if (typeof copy.offset !== 'string') return copy;
  const offset = Number(copy.offset);
  if (offset === replaced.offset) {
    return { ...copy, size: content.length, ...('integrity' in copy ? { integrity: integrityOf(content) } : {}) };
  }
  if (offset > replaced.offset) return { ...copy, offset: String(offset + content.length - replaced.size) };
  return copy;
}

/** Pickle with one string: payload size, string length, the UTF-8 bytes padded to 4. */
function headerPickle(header: Json): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const payloadSize = 4 + Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(4 + payloadSize);
  pickle.writeUInt32LE(payloadSize, 0);
  pickle.writeInt32LE(json.length, 4);
  json.copy(pickle, 8);
  return pickle;
}

function sizePickle(headerSize: number): Buffer {
  const pickle = Buffer.alloc(8);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(headerSize, 4);
  return pickle;
}

/** The header and the files' bytes that follow it. */
function parseArchive(archive: Buffer): { readonly header: Json; readonly data: Buffer } {
  const headerSize = archive.readUInt32LE(4);
  const jsonLength = archive.readInt32LE(12);
  const header: unknown = JSON.parse(archive.toString('utf8', 16, 16 + jsonLength));
  if (!isJson(header)) throw new Error(`asar header is not a JSON object (header size ${headerSize})`);
  return { header, data: archive.subarray(8 + headerSize) };
}

/** A file stored inside the archive; unpacked files and missing paths have no content here. */
export function readAsarFile(archive: Buffer, path: string): Buffer | undefined {
  const { header, data } = parseArchive(archive);
  const file = packedFileAt(header, path);
  return file === undefined ? undefined : data.subarray(file.offset, file.offset + file.size);
}

export function replaceAsarFile(archive: Buffer, path: string, content: Buffer): ReplaceOutcome {
  const { header, data } = parseArchive(archive);
  const replaced = packedFileAt(header, path);
  if (replaced === undefined) return { kind: 'file-not-found', path };

  const newHeader = headerPickle(resizedHeader(header, replaced, content));
  return {
    kind: 'replaced',
    archive: Buffer.concat([
      sizePickle(newHeader.length),
      newHeader,
      data.subarray(0, replaced.offset),
      content,
      data.subarray(replaced.offset + replaced.size),
    ]),
  };
}
