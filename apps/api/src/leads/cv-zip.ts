import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflate = promisify(inflateRaw);

/** A DOCX is a zip; these bound what it may inflate to before any parser sees it. */
export const MAX_ZIP_ENTRIES = 1000;
export const MAX_INFLATED_BYTES = 20 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Thrown for any zip that is malformed, too big, or inflates past the caps. */
export class ZipLimitError extends Error {}

const fail = (): never => {
  throw new ZipLimitError("zip rejected");
};

function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return fail();
}

type CentralRecord = {
  method: number;
  compressed: number;
  declared: number;
  localOffset: number;
};

/**
 * Reads every central-directory record the way a lenient parser (JSZip) does: while the signature
 * matches, ignoring the count in the end record. At most {@link MAX_ZIP_ENTRIES} + 1 records are
 * read, so a zip over the cap is detected without walking an unbounded list.
 */
function readCentralRecords(buf: Buffer, start: number): { records: CentralRecord[]; end: number } {
  const records: CentralRecord[] = [];
  let pos = start;
  while (
    records.length <= MAX_ZIP_ENTRIES &&
    pos + 46 <= buf.length &&
    buf.readUInt32LE(pos) === CENTRAL_SIG
  ) {
    records.push({
      method: buf.readUInt16LE(pos + 10),
      compressed: buf.readUInt32LE(pos + 20),
      declared: buf.readUInt32LE(pos + 24),
      localOffset: buf.readUInt32LE(pos + 42),
    });
    pos +=
      46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return { records, end: pos };
}

/**
 * Checks that a zip stays small when inflated, without trusting its declared sizes or counts.
 *
 * - The end record must describe a plain single-disk archive: disk numbers 0 and none of the
 *   fields JSZip treats as the zip64 trigger holds its maximum value. (The buffer is not scanned
 *   for zip64 signatures: compressed data can contain those bytes by chance, and without a trigger
 *   value the parser never looks for them.)
 * - The central directory must be exactly what the end record says: the records found by walking
 *   it (not the declared count) number at most {@link MAX_ZIP_ENTRIES}, equal the declared count,
 *   and end exactly where the end record begins.
 * - Every entry is actually inflated (with a hard output cap, so a bomb stops at the cap) and the
 *   running total is held to {@link MAX_INFLATED_BYTES}. Zip64 and methods other than
 *   stored/deflate are refused.
 *
 * Throws {@link ZipLimitError}. Nothing is written anywhere. This is a check of the entries the
 * central directory leads to, written against how JSZip 3.10 reads a zip (last end-record
 * signature, directory walked while the signature matches, zip64 only on the trigger values). It
 * is not a proof for every parser, so callers must still run the parser under a timeout and
 * memory cap.
 */
export async function assertZipWithinLimits(buf: Buffer): Promise<void> {
  const eocd = findEocd(buf);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const diskWithCentral = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  // Single-disk archives only. JSZip (used by mammoth) switches to zip64 when ANY of these six
  // fields holds its maximum value, and then takes the directory from a zip64 record found
  // elsewhere in the buffer, ignoring this one. Refusing the trigger values keeps the directory
  // checked below the one the parser reads.
  if (diskNumber !== 0 || diskWithCentral !== 0) return fail();
  if (entriesOnDisk === 0xffff || entryCount === 0xffff) return fail();
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) return fail();
  if (entriesOnDisk !== entryCount || entryCount > MAX_ZIP_ENTRIES) return fail();
  // Both are 32-bit values, so the sum is exact in a double.
  if (centralOffset + centralSize !== eocd) return fail();

  const { records, end } = readCentralRecords(buf, centralOffset);
  if (records.length !== entryCount || end !== eocd) return fail();

  let remaining = MAX_INFLATED_BYTES;
  for (const { method, compressed, declared, localOffset } of records) {
    if (compressed === 0xffffffff || declared === 0xffffffff || declared > remaining) return fail();

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) return fail();
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > buf.length) return fail();
    const data = buf.subarray(dataStart, dataStart + compressed);

    let actual: number;
    if (method === 0) actual = data.length;
    else if (method === 8) {
      try {
        actual = (await inflate(data, { maxOutputLength: Math.max(remaining, 1) })).length;
      } catch {
        return fail();
      }
    } else return fail();
    if (actual > remaining) return fail();
    remaining -= actual;
  }
}
