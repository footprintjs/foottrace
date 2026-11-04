'use strict';
const { gunzipSync, inflateRawSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const fail = () => {
  const e = new Error('invalid-archive');
  e.code = 'invalid-archive';
  throw e;
};
const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
function text(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}
function field(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((n) => n !== 0)) fail();
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail();
  return text(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes, { empty = false, checksum = false } = {}) {
  if (empty && bytes.every((n) => n === 0)) return 0;
  const value = bytes.toString('latin1');
  const shape = checksum
    ? /^[0-7]{6}(?:\0 | \0)$/
    : bytes.length === 8
    ? /^(?:[0-7]{7}\0|[0-7]{6} \0)$/
    : /^(?:[0-7]{11}\0|[0-7]{10} \0)$/;
  if (!shape.test(value)) fail();
  const n = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(n)) fail();
  return n;
}
function headerSize(header) {
  const magic = Buffer.from([117, 115, 116, 97, 114, 0, 48, 48]);
  if (!header.subarray(257, 265).equals(magic)) fail();
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  if (sum !== octal(header.subarray(148, 156), { checksum: true })) fail();
  octal(header.subarray(100, 108));
  for (const [start, end] of [
    [108, 116],
    [116, 124],
    [329, 337],
    [337, 345],
  ])
    if (octal(header.subarray(start, end), { empty: true }) !== 0) fail();
  octal(header.subarray(136, 148));
  // Portable regular-file packs have no link, owner, prefix or extension bytes.
  if (
    header[156] !== 48 ||
    header.subarray(157, 257).some((n) => n !== 0) ||
    header.subarray(265, 329).some((n) => n !== 0) ||
    header.subarray(345, 512).some((n) => n !== 0)
  )
    fail();
  return octal(header.subarray(124, 136));
}
function inspectArchive(bytes, expected) {
  try {
    const maxArchive = expected.maxArchiveBytes ?? 16 * 1024 * 1024;
    const maxExpanded = expected.maxExpandedBytes ?? 64 * 1024 * 1024;
    const maxFiles = expected.maxFiles ?? 10000;
    if (
      ![maxArchive, maxExpanded, maxFiles].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > maxArchive
    )
      fail();
    const tar = gunzipSync(bytes, { maxOutputLength: maxExpanded });
    if (tar.length % 512 !== 0) fail();
    const names = new Set(),
      files = [];
    let at = 0,
      identity = null,
      ended = false;
    while (at + 512 <= tar.length) {
      const header = tar.subarray(at, at + 512);
      at += 512;
      if (header.every((n) => n === 0)) {
        if (at + 512 > tar.length || !tar.subarray(at).every((n) => n === 0)) fail();
        ended = true;
        break;
      }
      const size = headerSize(header);
      const padded = Math.ceil(size / 512) * 512;
      if (at + padded > tar.length || tar.subarray(at + size, at + padded).some((n) => n !== 0)) fail();
      const data = tar.subarray(at, at + size);
      at += padded;
      const name = field(header.subarray(0, 100));
      if (
        !name.startsWith('package/') ||
        /[\\\x00-\x1f]/.test(name) ||
        name.split('/').some((p) => p === '..' || p === '.' || p === '') ||
        names.has(name)
      )
        fail();
      if (
        !['package/package.json', 'package/README.md', 'package/LICENSE'].includes(name) &&
        !name.startsWith('package/dist/')
      )
        fail();
      names.add(name);
      if (names.size > maxFiles) fail();
      files.push({ path: name, size, sha256: hash(data, 'sha256') });
      if (name === 'package/package.json') {
        if (size > 1024 * 1024) fail();
        identity = JSON.parse(text(data));
      }
    }
    if (
      !ended ||
      !identity ||
      identity.name !== expected.package ||
      identity.version !== expected.version ||
      Object.prototype.hasOwnProperty.call(identity, 'publishConfig') ||
      !files.some((f) => f.path.startsWith('package/dist/'))
    )
      fail();
    return {
      package: identity.name,
      version: identity.version,
      sha256: hash(bytes, 'sha256'),
      shasum: hash(bytes, 'sha1'),
      integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
      bytes: bytes.length,
      files,
    };
  } catch (e) {
    if (e?.code === 'invalid-archive') throw e;
    fail();
  }
}
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  }
  return (n ^ 0xffffffff) >>> 0;
}
function readArtifactZip(bytes, allowedNames) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 20 * 1024 * 1024 || bytes.length < 22 || !Array.isArray(allowedNames))
      fail();
    // GitHub artifact ZIPs may have a comment. No ZIP64, encryption, links or paths.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
      if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
        end = i;
        break;
      }
    if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail();
    const count = bytes.readUInt16LE(end + 10),
      size = bytes.readUInt32LE(end + 12),
      start = bytes.readUInt32LE(end + 16);
    if (count !== allowedNames.length || bytes.readUInt16LE(end + 8) !== count || start + size !== end) fail();
    const result = Object.create(null),
      ranges = [];
    let at = start,
      total = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
      const flags = bytes.readUInt16LE(at + 8),
        method = bytes.readUInt16LE(at + 10),
        crc = bytes.readUInt32LE(at + 16),
        packed = bytes.readUInt32LE(at + 20),
        expanded = bytes.readUInt32LE(at + 24),
        nl = bytes.readUInt16LE(at + 28),
        extra = bytes.readUInt16LE(at + 30),
        comment = bytes.readUInt16LE(at + 32),
        external = bytes.readUInt32LE(at + 38),
        local = bytes.readUInt32LE(at + 42);
      if (
        flags & ~0x808 ||
        ![0, 8].includes(method) ||
        bytes.readUInt16LE(at + 34) !== 0 ||
        at + 46 + nl + extra + comment > end ||
        expanded > 16 * 1024 * 1024 ||
        ((external >>> 16) & 0xf000) === 0xa000
      )
        fail();
      const name = text(bytes.subarray(at + 46, at + 46 + nl));
      at += 46 + nl + extra + comment;
      if (
        !allowedNames.includes(name) ||
        Object.prototype.hasOwnProperty.call(result, name) ||
        local + 30 > start ||
        bytes.readUInt32LE(local) !== 0x04034b50
      )
        fail();
      const localNameSize = bytes.readUInt16LE(local + 26),
        localExtra = bytes.readUInt16LE(local + 28),
        dataStart = local + 30 + localNameSize + localExtra,
        dataEnd = dataStart + packed;
      if (
        dataEnd > start ||
        bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== method ||
        text(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name
      )
        fail();
      if (ranges.some(([a, b]) => local < b && dataEnd > a)) fail();
      ranges.push([local, dataEnd]);
      const input = bytes.subarray(dataStart, dataEnd),
        output = method === 0 ? input : inflateRawSync(input, { maxOutputLength: 16 * 1024 * 1024 });
      if (output.length !== expanded || crc32(output) !== crc || (total += expanded) > 18 * 1024 * 1024) fail();
      result[name] = output;
    }
    if (at !== end || allowedNames.some((n) => !Object.prototype.hasOwnProperty.call(result, n))) fail();
    return result;
  } catch (e) {
    if (e?.code === 'invalid-archive') throw e;
    fail();
  }
}
module.exports = { inspectArchive, readArtifactZip };
