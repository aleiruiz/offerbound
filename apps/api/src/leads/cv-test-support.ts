import { crc32, deflateRawSync, deflateSync } from "node:zlib";

/** Test helpers that build hostile CV files in memory. Not imported by production code. */

type ZipEntry = { name: string; data: Buffer; declaredSize?: number };

/** A zip with deflated entries; `declaredSize` lets a test make the header lie. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Rewrites fields of the end-of-central-directory record of a zip built by {@link buildZip}. */
export function patchEnd(
  zip: Buffer,
  fields: {
    diskNumber?: number;
    diskWithCentralDir?: number;
    entriesOnDisk?: number;
    entryCount?: number;
    centralSize?: number;
    centralOffset?: number;
  },
): Buffer {
  const copy = Buffer.from(zip);
  const eocd = copy.length - 22;
  if (fields.diskNumber !== undefined) copy.writeUInt16LE(fields.diskNumber, eocd + 4);
  if (fields.diskWithCentralDir !== undefined) {
    copy.writeUInt16LE(fields.diskWithCentralDir, eocd + 6);
  }
  if (fields.centralOffset !== undefined) copy.writeUInt32LE(fields.centralOffset, eocd + 16);
  if (fields.entriesOnDisk !== undefined) copy.writeUInt16LE(fields.entriesOnDisk, eocd + 8);
  if (fields.entryCount !== undefined) copy.writeUInt16LE(fields.entryCount, eocd + 10);
  if (fields.centralSize !== undefined) copy.writeUInt32LE(fields.centralSize, eocd + 12);
  return copy;
}

/** Inserts `gap` bytes between the central directory and the end record. */
export function withGapBeforeEnd(zip: Buffer, gap: Buffer): Buffer {
  const eocd = zip.length - 22;
  return Buffer.concat([zip.subarray(0, eocd), gap, zip.subarray(eocd)]);
}

/** A DOCX-shaped zip whose `word/document.xml` inflates to `inflatedBytes` while its header claims 1 KB. */
export function zipBomb(inflatedBytes: number): Buffer {
  return buildZip([
    { name: "word/document.xml", data: Buffer.alloc(inflatedBytes, 0x20), declaredSize: 1024 },
  ]);
}

/** A PDF whose single content stream inflates to `inflatedBytes` of whitespace. */
export function pdfBomb(inflatedBytes: number): Buffer {
  const stream = deflateSync(Buffer.alloc(inflatedBytes, 0x20), { level: 9 });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  ];
  const body: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let offset = body[0]?.length ?? 0;
  const offsets: number[] = [];
  const push = (b: Buffer): void => {
    body.push(b);
    offset += b.length;
  };
  objects.forEach((o, i) => {
    offsets.push(offset);
    push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`));
  });
  offsets.push(offset);
  push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`));
  push(stream);
  push(Buffer.from("\nendstream\nendobj\n"));
  const xref = offset;
  let table = `xref\n0 5\n0000000000 65535 f \n`;
  for (const o of offsets) table += `${String(o).padStart(10, "0")} 00000 n \n`;
  push(Buffer.from(`${table}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(body);
}

function rawLocal(
  name: string,
  data: Buffer,
): { bytes: Buffer; name: Buffer; packed: Buffer; crc: number } {
  const nameBytes = Buffer.from(name);
  const packed = deflateRawSync(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return {
    bytes: Buffer.concat([header, nameBytes, packed]),
    name: nameBytes,
    packed,
    crc: crc32(data),
  };
}

function rawCentral(entry: ReturnType<typeof rawLocal>, size: number, localOffset: number): Buffer {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(8, 10);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.packed.length, 20);
  record.writeUInt32LE(size, 24);
  record.writeUInt16LE(entry.name.length, 28);
  record.writeUInt32LE(localOffset, 42);
  return Buffer.concat([record, entry.name]);
}

/**
 * A zip that looks honest to a plain end-record reader (one tiny entry, count 1, directory ending
 * exactly at the end record) but whose end record has disk number 0xFFFF and carries a zip64
 * record and locator in its comment. A reader that honours zip64 (JSZip does) follows them to a
 * different central directory that lists `word/document.xml`, inflating to `hiddenBytes`.
 */
export function zip64RedirectZip(hiddenBytes: number): Buffer {
  const visible = rawLocal("a.txt", Buffer.from("x"));
  const hidden = rawLocal("word/document.xml", Buffer.alloc(hiddenBytes, 0x20));
  const body = Buffer.concat([visible.bytes, hidden.bytes]);
  const hiddenDirectory = rawCentral(hidden, hiddenBytes, visible.bytes.length);
  const visibleDirectory = rawCentral(visible, 1, 0);
  const padding = Buffer.alloc(76 - visibleDirectory.length, 0x41);
  const eocdAt = body.length + hiddenDirectory.length + padding.length + visibleDirectory.length;

  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(hiddenDirectory.length), 40);
  record.writeBigUInt64LE(BigInt(body.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(eocdAt + 22), 8);
  locator.writeUInt32LE(1, 16);
  const comment = Buffer.concat([record, locator]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 4);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(visibleDirectory.length, 12);
  end.writeUInt32LE(eocdAt - visibleDirectory.length, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([body, hiddenDirectory, padding, visibleDirectory, end, comment]);
}
