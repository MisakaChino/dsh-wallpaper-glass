#!/usr/bin/env node
/**
 * asar-patch.mjs - reversible, verified ASAR patcher for DeepSeek Harness.
 *
 * It adds Windows acrylic transparency to the primary BrowserWindow by patching
 * lib/main.js inside resources/app.asar:
 *   - backgroundColor: "#00000000" and backgroundMaterial: "acrylic"
 *     inside the `process.platform === "win32" && primary` options object
 *   - titleBarOverlay.color: chromeFallbackFill() -> "#00000000"
 *
 * The patch is idempotent and every produced archive is verified by re-reading
 * it: header framing, entry tree, per-entry metadata, a byte-for-byte comparison
 * of sampled (or all) entries, the patched file content/diff, integrity hashes,
 * and `node --check`.
 *
 * Usage:
 *   node asar-patch.mjs check
 *   node asar-patch.mjs build --out <path> [--verify-all]
 *   node asar-patch.mjs apply  [--verify-all]
 *   node asar-patch.mjs revert [--force]
 *
 * Options:
 *   --asar <path>   Target app.asar (auto-detected when omitted)
 *   --out <path>    Output path for build (required)
 *   --verify-all    Byte-compare every packed entry instead of a 72-entry sample
 *   --force         revert: allow restoring a backup that is itself patched
 *
 * apply/revert modify the target archive. Close the app first. Build never
 * writes to the source archive.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { findAsar } from './find-dsh.mjs'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_PATH = 'lib/main.js'

// The exact createWindow() win32/primary block of the unpatched app.
const BLOCK_OLD = [
  '\t\t...process.platform === "win32" && primary ? {',
  '\t\t\ttitleBarStyle: "hidden",',
  '\t\t\ttitleBarOverlay: {',
  '\t\t\t\theight: 40,',
  '\t\t\t\tcolor: chromeFallbackFill(),',
  '\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"',
  '\t\t\t}',
  '\t\t} : {},'
].join('\n')

// The same block after patching (only the intended lines differ).
const BLOCK_NEW = [
  '\t\t...process.platform === "win32" && primary ? {',
  '\t\t\ttitleBarStyle: "hidden",',
  '\t\t\ttitleBarOverlay: {',
  '\t\t\t\theight: 40,',
  '\t\t\t\tcolor: "#00000000",',
  '\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"',
  '\t\t\t},',
  '\t\t\tbackgroundColor: "#00000000",',
  '\t\t\tbackgroundMaterial: "acrylic"',
  '\t\t} : {},'
].join('\n')

const FUNC_SIG = 'function createWindow(preload, show = false, primary = false) {'
const EXPECTED_DELTA = 58
const WINDOW_SCAN = 8000
const MiB = 1024 * 1024

const OLD_LINES = BLOCK_OLD.split('\n')
const NEW_LINES = BLOCK_NEW.split('\n')
const EXPECTED_REMOVED = [OLD_LINES[4], OLD_LINES[5], OLD_LINES[6]]
const EXPECTED_ADDED = [NEW_LINES[4], NEW_LINES[5], NEW_LINES[6], NEW_LINES[7], NEW_LINES[8]]

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

class AlreadyPatchedError extends ToolError {
  constructor(message) {
    super(message, 2)
  }
}

const align4 = (n) => (n + 3) & ~3
const num = (n) => Number(n).toLocaleString('en-US')
const signed = (n) => (n >= 0 ? `+${num(n)}` : num(n))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

function readExact(fd, buffer, length, position) {
  let done = 0
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done)
    if (n <= 0) throw new ToolError(`unexpected EOF while reading ${length} bytes at offset ${position + done}`)
    done += n
  }
  return buffer
}

function writeAll(fd, buffer) {
  let done = 0
  while (done < buffer.length) {
    const n = writeSync(fd, buffer, done, buffer.length - done)
    if (n <= 0) throw new ToolError('short write while writing archive')
    done += n
  }
}

function samePath(a, b) {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// ASAR reader
// ---------------------------------------------------------------------------

// Pickle layout (verified against the live archive):
//   u32 @0  = 4                  (size of the outer size field)
//   u32 @4  = jsonLen + 8        (outer pickle body size)
//   u32 @8  = jsonLen + 4        (inner header body size)
//   u32 @12 = jsonLen            (exact JSON byte length)
//   bytes @16 .. 16+jsonLen     JSON header
//   zero padding to 4-byte alignment, then file data.
function readAsarHeader(fd, fileSize, label = 'archive') {
  if (fileSize < 16) throw new ToolError(`${label}: file is too small to be an ASAR archive`)
  const prefix = Buffer.alloc(16)
  readExact(fd, prefix, 16, 0)
  const marker = prefix.readUInt32LE(0)
  const headerSize = prefix.readUInt32LE(4)
  const jsonField = prefix.readUInt32LE(8)
  const jsonLen = prefix.readUInt32LE(12)
  if (marker !== 4) throw new ToolError(`${label}: unsupported ASAR prefix (u32@0=${marker}, expected 4)`)
  if (jsonLen <= 0 || 16 + jsonLen > fileSize) throw new ToolError(`${label}: invalid header JSON length ${jsonLen}`)
  if (headerSize !== jsonLen + 8 || jsonField !== jsonLen + 4) {
    throw new ToolError(
      `${label}: unsupported header framing (headerSize=${headerSize}, jsonField=${jsonField}, jsonLen=${jsonLen})`
    )
  }
  const jsonBuf = Buffer.alloc(jsonLen)
  readExact(fd, jsonBuf, jsonLen, 16)
  let header
  try {
    header = JSON.parse(jsonBuf.toString('utf8'))
  } catch (error) {
    throw new ToolError(`${label}: header JSON is invalid: ${error.message}`)
  }
  if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
    throw new ToolError(`${label}: header JSON has no "files" tree`)
  }
  const pad = align4(16 + jsonLen) - (16 + jsonLen)
  if (pad > 0) {
    const padBuf = Buffer.alloc(pad)
    readExact(fd, padBuf, pad, 16 + jsonLen)
    for (const byte of padBuf) if (byte !== 0) throw new ToolError(`${label}: header padding is not zero`)
  }
  const base = 16 + jsonLen + pad
  return { header, base, jsonLen, headerSize, pad }
}

function collectEntries(header) {
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      if (!entry || typeof entry !== 'object') continue
      const entryPath = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, entryPath)
      else files.push({ path: entryPath, entry })
    }
  }
  walk(header, '')
  return files
}

// Build the physical data layout in header order and enforce contiguity.
function buildLayout(files, base, fileSize, label = 'archive') {
  const items = []
  for (const file of files) {
    const entry = file.entry
    if (entry.link !== undefined) {
      items.push({ path: file.path, entry, kind: 'link' })
      continue
    }
    const size = Number(entry.size)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ToolError(`${label}: entry ${file.path} has an invalid size (${entry.size})`)
    }
    if (entry.unpacked) {
      items.push({ path: file.path, entry, size, kind: 'unpacked' })
      continue
    }
    if (entry.offset === undefined) throw new ToolError(`${label}: packed entry ${file.path} has no offset`)
    const offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ToolError(`${label}: entry ${file.path} has an invalid offset (${entry.offset})`)
    }
    items.push({ path: file.path, entry, size, offset, kind: 'packed' })
  }
  const packed = items.filter((item) => item.kind === 'packed')
  let cursor = 0
  for (const item of packed) {
    if (item.offset !== cursor) {
      throw new ToolError(
        `${label}: data region is not contiguous in header order at ${item.path} ` +
          `(offset ${item.offset}, expected ${cursor})`
      )
    }
    cursor += item.size
  }
  if (base + cursor !== fileSize) {
    throw new ToolError(`${label}: size mismatch: base ${base} + data ${cursor} != file size ${fileSize}`)
  }
  return { items, packed, dataBytes: cursor }
}

function readEntryBuffer(fd, base, entry) {
  const size = Number(entry.size)
  const buffer = Buffer.allocUnsafe(size)
  readExact(fd, buffer, size, base + Number(entry.offset))
  return buffer
}

function copyRange(srcFd, dstFd, start, length, buffer) {
  let done = 0
  while (done < length) {
    const n = Math.min(buffer.length, length - done)
    readExact(srcFd, buffer, n, start + done)
    writeAll(dstFd, buffer.subarray(0, n))
    done += n
  }
}

// ---------------------------------------------------------------------------
// Patch logic
// ---------------------------------------------------------------------------

function integrityFor(buffer, blockSize) {
  const size = blockSize > 0 ? blockSize : 4 * MiB
  const blocks = []
  for (let offset = 0; offset < buffer.length; offset += size) {
    blocks.push(sha256(buffer.subarray(offset, Math.min(offset + size, buffer.length))))
  }
  return { hash: sha256(buffer), blocks }
}

function locatePrimaryBlock(text) {
  const funcAt = text.indexOf(FUNC_SIG)
  if (funcAt < 0) throw new ToolError(`lib/main.js: "${FUNC_SIG}" not found; this app version is not supported`)
  if (text.indexOf(FUNC_SIG, funcAt + FUNC_SIG.length) >= 0) {
    throw new ToolError('lib/main.js: multiple createWindow() signatures found; refusing to guess')
  }
  const end = Math.min(text.length, funcAt + WINDOW_SCAN)
  const region = text.slice(funcAt, end)
  return {
    funcAt,
    end,
    region,
    oldCount: countOccurrences(region, BLOCK_OLD),
    newCount: countOccurrences(region, BLOCK_NEW)
  }
}

function patchState(text) {
  const loc = locatePrimaryBlock(text)
  if (loc.newCount === 1 && loc.oldCount === 0) return 'patched'
  if (loc.oldCount === 1 && loc.newCount === 0) return 'original'
  return 'unknown'
}

function patchMainSource(text) {
  const loc = locatePrimaryBlock(text)
  if (loc.newCount === 1 && loc.oldCount === 0) return { state: 'already-patched', text }
  if (loc.oldCount !== 1 || loc.newCount !== 0) {
    throw new ToolError(
      `lib/main.js: unexpected win32/primary block layout (old=${loc.oldCount}, new=${loc.newCount}); refusing to patch`
    )
  }
  if (countOccurrences(text, BLOCK_OLD) !== 1) {
    throw new ToolError('lib/main.js: target block is not unique in the whole file; refusing to patch')
  }
  if (countOccurrences(text, BLOCK_NEW) !== 0) {
    throw new ToolError('lib/main.js: patched block already exists elsewhere in the file; refusing to patch')
  }
  const at = loc.region.indexOf(BLOCK_OLD)
  const patchedRegion = loc.region.slice(0, at) + BLOCK_NEW + loc.region.slice(at + BLOCK_OLD.length)
  const patched = text.slice(0, loc.funcAt) + patchedRegion + text.slice(loc.end)
  const delta = Buffer.byteLength(patched, 'utf8') - Buffer.byteLength(text, 'utf8')
  if (delta !== EXPECTED_DELTA) {
    throw new ToolError(`internal: patch delta is ${delta} bytes, expected ${EXPECTED_DELTA}`)
  }
  if (patchState(patched) !== 'patched') throw new ToolError('internal: patched source failed self-detection')
  return { state: 'patched-now', text: patched }
}

function diffLines(oldText, newText) {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }
  return { start, removed: a.slice(start, endA + 1), added: b.slice(start, endB + 1) }
}

function assertExpectedDiff(oldText, newText) {
  const diff = diffLines(oldText, newText)
  if (JSON.stringify(diff.removed) !== JSON.stringify(EXPECTED_REMOVED)) {
    throw new ToolError(`unexpected removed lines: ${JSON.stringify(diff.removed)}`)
  }
  if (JSON.stringify(diff.added) !== JSON.stringify(EXPECTED_ADDED)) {
    throw new ToolError(`unexpected added lines: ${JSON.stringify(diff.added)}`)
  }
  return diff
}

// ---------------------------------------------------------------------------
// Archive writer
// ---------------------------------------------------------------------------

// JSON is padded with trailing spaces (legal JSON whitespace) so jsonLen is a
// multiple of 4; this reproduces the exact framing used by the live archive and
// makes the data offset independent of pickle padding rules.
function serializeHeader(header) {
  let json = JSON.stringify(header)
  const pad = (4 - (Buffer.byteLength(json, 'utf8') % 4)) % 4
  if (pad > 0) json += ' '.repeat(pad)
  const jsonBuf = Buffer.from(json, 'utf8')
  if (jsonBuf.length % 4 !== 0) throw new ToolError('internal: header JSON is not 4-byte aligned')
  return jsonBuf
}

function createPatchedArchive(srcPath, outPath) {
  const srcFd = openSync(srcPath, 'r')
  let tmpPath = null
  try {
    const srcSize = fstatSync(srcFd).size
    const parsed = readAsarHeader(srcFd, srcSize, 'source')
    const files = collectEntries(parsed.header)
    const layout = buildLayout(files, parsed.base, srcSize, 'source')
    const target = layout.items.find((item) => item.path === TARGET_PATH)
    if (!target) throw new ToolError(`${TARGET_PATH} not found in ${srcPath}`)
    if (target.kind !== 'packed') throw new ToolError(`${TARGET_PATH} is not a packed entry (kind=${target.kind})`)

    if (target.entry.integrity && target.entry.integrity.algorithm !== 'SHA256') {
      throw new ToolError(`${TARGET_PATH}: unsupported integrity algorithm ${target.entry.integrity.algorithm}`)
    }

    const originalMain = readEntryBuffer(srcFd, parsed.base, target.entry)
    if (target.entry.integrity && target.entry.integrity.hash) {
      const actual = sha256(originalMain)
      if (actual !== target.entry.integrity.hash) {
        throw new ToolError(
          `source ${TARGET_PATH} integrity mismatch (header ${target.entry.integrity.hash}, actual ${actual})`
        )
      }
    }

    const patch = patchMainSource(originalMain.toString('utf8'))
    if (patch.state === 'already-patched') {
      throw new AlreadyPatchedError(`${TARGET_PATH} is already patched; refusing to apply the patch twice`)
    }
    const patchedMain = Buffer.from(patch.text, 'utf8')
    if (patchedMain.length - originalMain.length !== EXPECTED_DELTA) {
      throw new ToolError(`internal: patched file delta is ${patchedMain.length - originalMain.length}, expected ${EXPECTED_DELTA}`)
    }

    // Update the one changed entry: size, hash and per-block hashes.
    target.entry.size = patchedMain.length
    target.size = patchedMain.length
    const blockSize = Number(target.entry.integrity && target.entry.integrity.blockSize) || 4 * MiB
    const integrity = integrityFor(patchedMain, blockSize)
    if (target.entry.integrity) {
      target.entry.integrity.algorithm = 'SHA256'
      target.entry.integrity.hash = integrity.hash
      target.entry.integrity.blockSize = blockSize
      target.entry.integrity.blocks = integrity.blocks
    } else {
      target.entry.integrity = {
        algorithm: 'SHA256',
        hash: integrity.hash,
        blockSize,
        blocks: integrity.blocks
      }
    }

    // Recompute every packed offset in header order.
    let cursor = 0
    for (const item of layout.packed) {
      item.newOffset = cursor
      item.entry.offset = typeof item.entry.offset === 'string' ? String(cursor) : cursor
      cursor += item.size
    }
    if (cursor !== layout.dataBytes + EXPECTED_DELTA) {
      throw new ToolError(`internal: data region grew by ${cursor - layout.dataBytes}, expected ${EXPECTED_DELTA}`)
    }

    const jsonBuf = serializeHeader(parsed.header)
    const base = 16 + jsonBuf.length
    const prefix = Buffer.alloc(16)
    prefix.writeUInt32LE(4, 0)
    prefix.writeUInt32LE(jsonBuf.length + 8, 4)
    prefix.writeUInt32LE(jsonBuf.length + 4, 8)
    prefix.writeUInt32LE(jsonBuf.length, 12)

    const expectedSize = base + cursor
    const outDir = path.dirname(path.resolve(outPath))
    mkdirSync(outDir, { recursive: true })
    tmpPath = path.join(outDir, `.${path.basename(outPath)}.tmp-${process.pid}-${Date.now()}`)
    const outFd = openSync(tmpPath, 'w')
    try {
      writeAll(outFd, prefix)
      writeAll(outFd, jsonBuf)
      const buffer = Buffer.allocUnsafe(4 * MiB)
      for (const item of layout.packed) {
        if (item === target) writeAll(outFd, patchedMain)
        else copyRange(srcFd, outFd, parsed.base + item.offset, item.size, buffer)
      }
      fsyncSync(outFd)
    } finally {
      closeSync(outFd)
    }

    const written = statSync(tmpPath).size
    if (written !== expectedSize) {
      throw new ToolError(`internal: wrote ${written} bytes, expected ${expectedSize}`)
    }
    renameSync(tmpPath, outPath)
    tmpPath = null

    return {
      srcSize,
      outSize: expectedSize,
      dataBytes: cursor,
      jsonLen: jsonBuf.length,
      base,
      entries: files.length,
      packed: layout.packed.length,
      unpacked: layout.items.filter((item) => item.kind === 'unpacked').length,
      mainSizeBefore: originalMain.length,
      mainSizeAfter: patchedMain.length,
      originalMain,
      patchedMain
    }
  } finally {
    closeSync(srcFd)
    if (tmpPath) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        /* ignore cleanup failure */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Verification of the produced archive (reads the output, not the intent)
// ---------------------------------------------------------------------------

function entryWithoutOffset(entry) {
  const copy = {}
  for (const [key, value] of Object.entries(entry)) if (key !== 'offset') copy[key] = value
  return JSON.stringify(copy)
}

function compareEntryBytes(srcFd, outFd, srcBase, outBase, srcItem, outItem, bufA, bufB) {
  let done = 0
  while (done < srcItem.size) {
    const n = Math.min(bufA.length, srcItem.size - done)
    readExact(srcFd, bufA, n, srcBase + srcItem.offset + done)
    readExact(outFd, bufB, n, outBase + outItem.offset + done)
    if (!bufA.subarray(0, n).equals(bufB.subarray(0, n))) return false
    done += n
  }
  return true
}

function pickComparisonIndices(packed, targetIndex, want) {
  const picked = new Set()
  const add = (index) => {
    if (index >= 0 && index < packed.length && index !== targetIndex) picked.add(index)
  }
  add(0)
  add(1)
  add(2)
  add(packed.length - 1)
  add(packed.length - 2)
  add(packed.length - 3)
  for (const fraction of [0.05, 0.1, 0.25, 0.33, 0.5, 0.66, 0.75, 0.9, 0.95]) {
    add(Math.floor((packed.length - 1) * fraction))
  }
  for (let delta = -5; delta <= 5; delta += 1) add(targetIndex + delta)
  const stride = Math.max(1, Math.floor(packed.length / (want * 2)))
  for (let i = 0; i < packed.length && picked.size < want; i += stride) {
    if (packed[i].size <= 2 * MiB) add(i)
  }
  for (let i = 0; i < packed.length && picked.size < want; i += 1) {
    if (packed[i].size <= 2 * MiB) add(i)
  }
  return [...picked].sort((a, b) => a - b)
}

function verifyOutput(srcPath, outPath, options = {}) {
  const log = options.log || (() => {})
  const stats = { checks: 0, compared: 0, comparedBytes: 0 }
  const ok = (name, detail = '') => {
    stats.checks += 1
    log(`  [OK] ${name}${detail ? ' - ' + detail : ''}`)
  }

  const srcFd = openSync(srcPath, 'r')
  const outFd = openSync(outPath, 'r')
  let tmpCheck = null
  try {
    const srcSize = fstatSync(srcFd).size
    const outSize = fstatSync(outFd).size
    const src = readAsarHeader(srcFd, srcSize, 'source')
    const out = readAsarHeader(outFd, outSize, 'output')

    ok('output header re-opened and JSON-parsed', `${num(out.jsonLen)} bytes`)

    if (out.jsonLen % 4 !== 0 || out.pad !== 0) {
      throw new ToolError(`output header is not 4-byte aligned (jsonLen=${out.jsonLen}, pad=${out.pad})`)
    }
    if (out.base !== 8 + out.headerSize) {
      throw new ToolError(`output data base ${out.base} does not equal 8 + headerSize ${8 + out.headerSize}`)
    }
    ok('header framing re-derived', `base=${num(out.base)}, headerSize=${num(out.headerSize)}, jsonLen=${num(out.jsonLen)}`)

    const srcFiles = collectEntries(src.header)
    const outFiles = collectEntries(out.header)
    if (srcFiles.length !== outFiles.length) {
      throw new ToolError(`entry count changed: ${srcFiles.length} -> ${outFiles.length}`)
    }
    const outMap = new Map(outFiles.map((file) => [file.path, file.entry]))
    for (const file of srcFiles) if (!outMap.has(file.path)) throw new ToolError(`entry disappeared: ${file.path}`)
    ok('entry tree preserved', `${num(srcFiles.length)} entries`)

    // Metadata for every entry other than the target must be untouched.
    let metadataMatched = 0
    let unpackedChecked = 0
    const srcMap = new Map(srcFiles.map((file) => [file.path, file.entry]))
    for (const file of srcFiles) {
      if (file.path === TARGET_PATH) continue
      const before = file.entry
      const after = outMap.get(file.path)
      if (entryWithoutOffset(before) !== entryWithoutOffset(after)) {
        throw new ToolError(`entry metadata changed unexpectedly: ${file.path}`)
      }
      if (before.unpacked) {
        if ('offset' in before || 'offset' in after) throw new ToolError(`unpacked entry has an offset: ${file.path}`)
        unpackedChecked += 1
      } else if (before.link === undefined && 'offset' in before !== 'offset' in after) {
        throw new ToolError(`entry offset presence changed: ${file.path}`)
      }
      metadataMatched += 1
    }
    ok('metadata identical for every other entry', `${num(metadataMatched)} entries (${num(unpackedChecked)} unpacked)`)

    const outLayout = buildLayout(outFiles, out.base, outSize, 'output')
    const srcLayout = buildLayout(srcFiles, src.base, srcSize, 'source')
    ok('output data layout contiguous', `${num(outLayout.packed.length)} packed entries, data ${num(outLayout.dataBytes)} bytes`)

    if (out.base + outLayout.dataBytes !== outSize) throw new ToolError('archive size != base + sum(entry sizes)')
    ok('archive size = base + sum(sizes)', `${num(out.base)} + ${num(outLayout.dataBytes)} = ${num(outSize)}`)

    const lastHeaderEntry = outFiles[outFiles.length - 1].entry
    if (lastHeaderEntry.unpacked || lastHeaderEntry.link !== undefined || lastHeaderEntry.offset === undefined) {
      throw new ToolError('last header entry is not a packed file')
    }
    if (Number(lastHeaderEntry.offset) + Number(lastHeaderEntry.size) !== outLayout.dataBytes) {
      throw new ToolError('last header entry does not end exactly at EOF')
    }
    ok('last header entry ends exactly at EOF', outFiles[outFiles.length - 1].path)

    // The changed file: exact bytes, marker, and a real line diff.
    const srcMainEntry = srcMap.get(TARGET_PATH)
    const outMainEntry = outMap.get(TARGET_PATH)
    if (!srcMainEntry || !outMainEntry) throw new ToolError(`${TARGET_PATH} missing after rebuild`)
    if (srcMainEntry.unpacked || outMainEntry.unpacked) throw new ToolError(`${TARGET_PATH} is unexpectedly unpacked`)
    const srcMain = readEntryBuffer(srcFd, src.base, srcMainEntry)
    const outMain = readEntryBuffer(outFd, out.base, outMainEntry)
    const patch = patchMainSource(srcMain.toString('utf8'))
    if (patch.state !== 'patched-now') throw new ToolError('source file is not in the expected original state')
    const expectedMain = Buffer.from(patch.text, 'utf8')
    if (!outMain.equals(expectedMain)) throw new ToolError('output lib/main.js is not byte-identical to the expected patch')
    const mainDelta = outMain.length - srcMain.length
    ok(
      'patched lib/main.js matches expected bytes exactly',
      `${num(srcMain.length)} -> ${num(outMain.length)} bytes (${signed(mainDelta)})`
    )

    const outText = outMain.toString('utf8')
    if (countOccurrences(outText, BLOCK_NEW) !== 1) throw new ToolError('patched block marker is not present exactly once')
    if (countOccurrences(outText, BLOCK_OLD) !== 0) throw new ToolError('original block is still present in the output')
    const diff = assertExpectedDiff(srcMain.toString('utf8'), outText)
    ok(
      'diff contains only the intended hunks',
      `${diff.removed.length} removed lines, ${diff.added.length} added lines, ${signed(mainDelta)} bytes`
    )

    const blockSize = Number(srcMainEntry.integrity && srcMainEntry.integrity.blockSize) || 4 * MiB
    const expectedIntegrity = integrityFor(outMain, blockSize)
    if (Number(outMainEntry.size) !== outMain.length) throw new ToolError('output lib/main.js size field is wrong')
    if (!outMainEntry.integrity || outMainEntry.integrity.hash !== expectedIntegrity.hash) {
      throw new ToolError('output lib/main.js integrity.hash does not match the patched bytes')
    }
    if (JSON.stringify(outMainEntry.integrity.blocks) !== JSON.stringify(expectedIntegrity.blocks)) {
      throw new ToolError('output lib/main.js integrity.blocks do not match the patched bytes')
    }
    if (outMainEntry.integrity.algorithm !== 'SHA256' || Number(outMainEntry.integrity.blockSize) !== blockSize) {
      throw new ToolError('output lib/main.js integrity algorithm/blockSize changed unexpectedly')
    }
    ok(
      'integrity hash + blocks recomputed',
      `SHA256 ${expectedIntegrity.hash.slice(0, 16)}... (${expectedIntegrity.blocks.length} block of ${num(blockSize)} bytes)`
    )

    tmpCheck = path.join(os.tmpdir(), `asar-patch-check-${process.pid}-${Date.now()}.mjs`)
    writeFileSync(tmpCheck, outMain)
    const check = spawnSync(process.execPath, ['--check', tmpCheck], { encoding: 'utf8' })
    if (check.status !== 0) {
      throw new ToolError(`node --check failed (exit ${check.status}): ${(check.stderr || '').trim()}`)
    }
    ok('node --check on patched lib/main.js', `exit 0 (Node ${process.version})`)

    // Byte comparison of untouched entries.
    const targetIndex = srcLayout.packed.findIndex((item) => item.path === TARGET_PATH)
    const outPackedByPath = new Map(outLayout.packed.map((item) => [item.path, item]))
    const indices = options.verifyAll
      ? srcLayout.packed.map((_, index) => index).filter((index) => index !== targetIndex)
      : pickComparisonIndices(srcLayout.packed, targetIndex, 72)
    const bufA = Buffer.allocUnsafe(MiB)
    const bufB = Buffer.allocUnsafe(MiB)
    for (const index of indices) {
      const srcItem = srcLayout.packed[index]
      const outItem = outPackedByPath.get(srcItem.path)
      if (!outItem) throw new ToolError(`entry missing from output layout: ${srcItem.path}`)
      if (srcItem.size !== outItem.size) throw new ToolError(`entry size changed: ${srcItem.path}`)
      if (!compareEntryBytes(srcFd, outFd, src.base, out.base, srcItem, outItem, bufA, bufB)) {
        throw new ToolError(`byte mismatch for unchanged entry: ${srcItem.path}`)
      }
      stats.compared += 1
      stats.comparedBytes += srcItem.size
    }
    if (stats.compared < 40) {
      throw new ToolError(`only ${stats.compared} entries compared; at least 40 are required`)
    }
    ok(
      'byte-for-byte comparison of untouched entries',
      `${num(stats.compared)} entries, ${num(stats.comparedBytes)} bytes identical${options.verifyAll ? ' (all)' : ' (sample)'}`
    )

    // One unpacked entry: metadata plus, when present, the bytes on disk.
    const unpackedEntry = srcFiles.find((file) => file.entry.unpacked)
    if (unpackedEntry) {
      const after = outMap.get(unpackedEntry.path)
      if (!after || entryWithoutOffset(unpackedEntry.entry) !== entryWithoutOffset(after)) {
        throw new ToolError(`unpacked entry metadata mismatch: ${unpackedEntry.path}`)
      }
      let detail = `metadata identical: ${unpackedEntry.path}`
      const diskPath = path.join(`${srcPath}.unpacked`, unpackedEntry.path)
      if (existsSync(diskPath)) {
        const diskHash = sha256File(diskPath)
        const headerHash = unpackedEntry.entry.integrity && unpackedEntry.entry.integrity.hash
        if (headerHash && diskHash !== headerHash) throw new ToolError(`unpacked file hash mismatch: ${diskPath}`)
        detail += '; on-disk bytes match integrity hash'
      } else {
        detail += '; unpacked file not present next to source (metadata-only check)'
      }
      ok('unpacked entry metadata preserved', detail)
    }

    const delta = outSize - srcSize
    ok('size delta', `${signed(delta)} bytes (${num(srcSize)} -> ${num(outSize)})`)

    stats.srcSize = srcSize
    stats.outSize = outSize
    stats.delta = delta
    stats.mainSizeBefore = srcMain.length
    stats.mainSizeAfter = outMain.length
    stats.entries = srcFiles.length
    stats.packed = srcLayout.packed.length
    stats.unpacked = srcLayout.items.filter((item) => item.kind === 'unpacked').length
    return stats
  } finally {
    closeSync(srcFd)
    closeSync(outFd)
    if (tmpCheck) {
      try {
        rmSync(tmpCheck, { force: true })
      } catch {
        /* ignore cleanup failure */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers for apply/revert
// ---------------------------------------------------------------------------

function sha256File(filePath) {
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.allocUnsafe(4 * MiB)
    const hash = createHash('sha256')
    let position = 0
    while (position < size) {
      const n = Math.min(buffer.length, size - position)
      readExact(fd, buffer, n, position)
      hash.update(buffer.subarray(0, n))
      position += n
    }
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function copyFileStream(srcPath, dstPath) {
  const srcFd = openSync(srcPath, 'r')
  try {
    const size = fstatSync(srcFd).size
    const dstFd = openSync(dstPath, 'w')
    try {
      const buffer = Buffer.allocUnsafe(4 * MiB)
      let position = 0
      while (position < size) {
        const n = Math.min(buffer.length, size - position)
        readExact(srcFd, buffer, n, position)
        writeAll(dstFd, buffer.subarray(0, n))
        position += n
      }
      fsyncSync(dstFd)
    } finally {
      closeSync(dstFd)
    }
    return size
  } finally {
    closeSync(srcFd)
  }
}

function listBackups(asarPath) {
  const dir = path.dirname(asarPath)
  const prefix = `${path.basename(asarPath)}.bak-`
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const backups = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    // Only real backup names: <stamp> or <stamp>-<n>, never partial .tmp-* copies.
    if (!/^\d{8}-\d{6}(-\d+)?$/.test(name.slice(prefix.length))) continue
    const full = path.join(dir, name)
    try {
      const info = statSync(full)
      if (!info.isFile()) continue
      backups.push({ name, path: full, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      /* skip unreadable */
    }
  }
  return backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
}

function uniqueBackupPath(asarPath) {
  const dir = path.dirname(asarPath)
  const base = path.basename(asarPath)
  const stamp = timestamp()
  let candidate = path.join(dir, `${base}.bak-${stamp}`)
  for (let i = 2; existsSync(candidate); i += 1) candidate = path.join(dir, `${base}.bak-${stamp}-${i}`)
  return candidate
}

function inspectArchive(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const size = fstatSync(fd).size
    const parsed = readAsarHeader(fd, size, asarPath)
    const files = collectEntries(parsed.header)
    const target = files.find((file) => file.path === TARGET_PATH)
    if (!target) throw new ToolError(`${TARGET_PATH} not found in ${asarPath}`)
    if (target.entry.unpacked) throw new ToolError(`${TARGET_PATH} is unpacked; only packed entries are supported`)
    const targetBuffer = readEntryBuffer(fd, parsed.base, target.entry)
    let state = 'unknown'
    try {
      state = patchState(targetBuffer.toString('utf8'))
    } catch {
      state = 'unknown'
    }
    let dataBytes = null
    try {
      dataBytes = buildLayout(files, parsed.base, size, asarPath).dataBytes
    } catch {
      dataBytes = null
    }
    return { path: asarPath, size, parsed, files, target, targetBuffer, state, dataBytes }
  } finally {
    closeSync(fd)
  }
}

function electronVersionLine(asarPath) {
  const resources = path.dirname(path.resolve(asarPath))
  const appRoot = path.dirname(resources)
  for (const candidate of [path.join(appRoot, 'version'), path.join(resources, 'version')]) {
    try {
      if (existsSync(candidate)) return `${readFileSync(candidate, 'utf8').trim()} (from ${candidate})`
    } catch {
      /* keep looking */
    }
  }
  return 'version file not found beside the app'
}

// Reads Electron's fuse wire from the app executable (read-only) to report
// whether embedded ASAR integrity validation is enforced.
function readAsarIntegrityFuse(asarPath) {
  try {
    const appRoot = path.dirname(path.dirname(path.resolve(asarPath)))
    let exe = null
    for (const name of readdirSync(appRoot)) {
      if (!/\.exe$/i.test(name) || /^uninstall/i.test(name)) continue
      const full = path.join(appRoot, name)
      try {
        if (statSync(full).isFile()) {
          exe = full
          break
        }
      } catch {
        /* skip */
      }
    }
    if (!exe) return null
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')
    const fd = openSync(exe, 'r')
    try {
      const size = fstatSync(fd).size
      const chunk = 8 * MiB
      const buffer = Buffer.allocUnsafe(chunk + sentinel.length)
      let found = -1
      let position = 0
      while (position < size) {
        const n = readSync(fd, buffer, 0, Math.min(chunk + sentinel.length, size - position), position)
        if (n <= 0) break
        const index = buffer.subarray(0, n).indexOf(sentinel)
        if (index >= 0) {
          found = position + index
          break
        }
        position += chunk
      }
      if (found < 0) return null
      const available = Math.min(12, size - found - sentinel.length)
      if (available < 2) return null
      const wire = Buffer.alloc(available)
      readExact(fd, wire, available, found + sentinel.length)
      const version = wire[0]
      const count = wire[1]
      const names = [
        'RunAsNode',
        'EnableCookieEncryption',
        'EnableNodeOptionsEnvironmentVariable',
        'EnableNodeCliInspectArguments',
        'EnableEmbeddedAsarIntegrityValidation',
        'OnlyLoadAppFromAsar',
        'LoadBrowserProcessSpecificV8Snapshot',
        'GrantFileProtocolExtraPrivileges'
      ]
      const states = { 0x30: 'DISABLED', 0x31: 'ENABLED', 0x72: 'REMOVED' }
      const fuseIndex = 4
      const raw = fuseIndex < count ? wire[2 + fuseIndex] : null
      return {
        exe,
        version,
        count,
        state: raw === null ? 'UNKNOWN' : states[raw] || `UNKNOWN(0x${raw.toString(16)})`,
        name: names[fuseIndex]
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCheck(options) {
  const asar = path.resolve(options.asar)
  console.log('asar-patch check')
  console.log(`  archive:        ${asar}`)
  if (!existsSync(asar)) throw new ToolError(`archive not found: ${asar}`)
  const info = inspectArchive(asar)
  const blockCount = info.target.entry.integrity && Array.isArray(info.target.entry.integrity.blocks)
    ? info.target.entry.integrity.blocks.length
    : 0
  console.log(`  size:           ${num(info.size)} bytes`)
  console.log(`  entries:        ${num(info.files.length)}`)
  console.log(`  lib/main.js:    ${num(info.targetBuffer.length)} bytes, ${blockCount} integrity block(s)`)
  const stateText =
    info.state === 'patched'
      ? 'PATCHED (acrylic marker present in createWindow)'
      : info.state === 'original'
        ? 'not patched (original block)'
        : 'UNKNOWN (unexpected createWindow layout)'
  console.log(`  patch state:    ${stateText}`)
  console.log(`  electron:       ${electronVersionLine(asar)}`)
  const backups = listBackups(asar)
  if (backups.length === 0) console.log('  backups:        none')
  else console.log(`  backups:        ${backups.length}, newest ${backups[0].path} (${num(backups[0].size)} bytes)`)
  const fuse = readAsarIntegrityFuse(asar)
  if (fuse) {
    console.log(`  asar integrity: ${fuse.name} = ${fuse.state} (${fuse.exe})`)
  } else {
    console.log('  asar integrity: unknown (fuse marker not found)')
  }
}

function cmdBuild(options) {
  if (!options.out) throw new ToolError('build requires --out <path>')
  const asar = path.resolve(options.asar)
  const out = path.resolve(options.out)
  if (samePath(asar, out)) throw new ToolError('--out must not be the source archive')
  if (!existsSync(asar)) throw new ToolError(`source archive not found: ${asar}`)

  console.log('asar-patch build')
  console.log(`  source: ${asar}`)
  console.log(`  output: ${out}`)
  const result = createPatchedArchive(asar, out)
  console.log(`  source size: ${num(result.srcSize)} bytes`)
  console.log(`  output size: ${num(result.outSize)} bytes (delta ${signed(result.outSize - result.srcSize)})`)
  console.log(`  lib/main.js: ${num(result.mainSizeBefore)} -> ${num(result.mainSizeAfter)} bytes`)
  console.log(`  header JSON: ${num(result.jsonLen)} bytes, data base ${num(result.base)}`)
  console.log('  verifying the written archive ...')
  const verified = verifyOutput(asar, out, {
    verifyAll: options.verifyAll,
    log: (line) => console.log(line)
  })
  console.log(
    `RESULT: PASS - ${verified.checks} checks, ${num(verified.compared)} entries byte-compared ` +
      `(${num(verified.comparedBytes)} bytes)`
  )
  console.log(`  size delta: ${signed(verified.delta)} bytes`)
  console.log(`  patched archive ready: ${out}`)
}

function cmdApply(options) {
  const asar = path.resolve(options.asar)
  if (!existsSync(asar)) throw new ToolError(`archive not found: ${asar}`)
  const before = inspectArchive(asar)
  if (before.state === 'patched') throw new AlreadyPatchedError('archive is already patched; nothing to do')
  if (before.state !== 'original') {
    throw new ToolError(`cannot apply: ${TARGET_PATH} patch state is '${before.state}', expected the original block`)
  }

  const dir = path.dirname(asar)
  const tempPath = path.join(dir, `${path.basename(asar)}.new-${timestamp()}-${process.pid}`)
  if (existsSync(tempPath)) throw new ToolError(`temporary path already exists: ${tempPath}`)

  console.log('asar-patch apply')
  console.log(`  archive: ${asar}`)
  console.log('  building a verified patched archive in a temp file next to the original ...')

  let verified
  try {
    createPatchedArchive(asar, tempPath)
    verified = verifyOutput(asar, tempPath, {
      verifyAll: options.verifyAll,
      log: (line) => console.log(line)
    })
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
  console.log(`  verified temp archive: ${num(verified.outSize)} bytes (delta ${signed(verified.delta)})`)

  // One-time backup. Never overwrite an existing backup.
  const backups = listBackups(asar)
  let backupPath
  if (backups.length > 0) {
    backupPath = backups[0].path
    const backupInfo = inspectArchive(backupPath)
    if (backupInfo.state !== 'original') {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ToolError(
        `existing backup is not a pristine original (state=${backupInfo.state}): ${backupPath}\n` +
          `Move it away and re-run apply (the tool never overwrites a backup).`
      )
    }
    if (backupInfo.size !== before.size) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ToolError(
        `existing backup size (${num(backupInfo.size)}) differs from the current archive ` +
          `(${num(before.size)}): ${backupPath}\nMove it away and re-run apply.`
      )
    }
    if (sha256File(backupPath) !== sha256File(asar)) {
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ToolError(
        `existing backup content differs from the current archive: ${backupPath}\n` +
          `Move it away and re-run apply (the tool never overwrites a backup).`
      )
    }
    console.log(`  existing backup kept (not overwritten): ${backupPath}`)
  } else {
    backupPath = uniqueBackupPath(asar)
    const backupTemp = `${backupPath}.tmp-${process.pid}`
    console.log('  creating one-time backup ...')
    try {
      copyFileStream(asar, backupTemp)
      const sourceHash = sha256File(asar)
      const backupHash = sha256File(backupTemp)
      if (sourceHash !== backupHash) throw new ToolError('backup checksum mismatch; aborting before touching the original')
      renameSync(backupTemp, backupPath)
      inspectArchive(backupPath)
    } catch (error) {
      try {
        rmSync(backupTemp, { force: true })
      } catch {
        /* ignore */
      }
      try {
        rmSync(tempPath, { force: true })
      } catch {
        /* ignore */
      }
      throw new ToolError(`failed to create backup: ${error.message}`)
    }
    console.log(`  backup created: ${backupPath}`)
  }

  // Atomic replace.
  try {
    renameSync(tempPath, asar)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* ignore */
    }
    throw new ToolError(
      `atomic replace failed (${error.code || error.message}). The original was not modified; backup: ${backupPath}`
    )
  }

  const after = inspectArchive(asar)
  if (after.state !== 'patched') {
    throw new ToolError(`post-replace verification failed (state=${after.state}); run: revert`)
  }
  if (after.size !== verified.outSize) throw new ToolError('post-replace size mismatch; run: revert')
  console.log(`  atomic replace: OK (${num(after.size)} bytes, state=patched)`)
  console.log(`  backup: ${backupPath}`)
  console.log('  restart DeepSeek Harness to see the acrylic window.')
}

function cmdRevert(options) {
  const asar = path.resolve(options.asar)
  const backups = listBackups(asar)
  if (backups.length === 0) throw new ToolError(`no ${path.basename(asar)}.bak-* backup found next to ${asar}`)
  const backup = backups[0]

  console.log('asar-patch revert')
  console.log(`  archive: ${asar}`)
  console.log(`  backup:  ${backup.path} (${num(backup.size)} bytes)`)

  const info = inspectArchive(backup.path)
  if (info.state !== 'original' && !options.force) {
    throw new ToolError(
      `newest backup is not a pristine original (state=${info.state}); refusing. ` +
        `Use --force only if you are certain this backup is safe.`
    )
  }
  if (info.state !== 'original') console.log(`  WARNING: restoring a backup whose state is '${info.state}' (--force)`)

  const tempPath = path.join(
    path.dirname(asar),
    `${path.basename(asar)}.revert-${timestamp()}-${process.pid}`
  )
  if (existsSync(tempPath)) throw new ToolError(`temporary path already exists: ${tempPath}`)

  try {
    copyFileStream(backup.path, tempPath)
    const copyHash = sha256File(tempPath)
    const backupHash = sha256File(backup.path)
    if (copyHash !== backupHash) throw new ToolError('restore copy checksum mismatch; original untouched')
    inspectArchive(tempPath) // re-parse the copy before replacing anything
    renameSync(tempPath, asar)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }

  const after = inspectArchive(asar)
  console.log(`  restored: ${num(after.size)} bytes, state=${after.state}`)
  console.log(`  backup kept (not deleted): ${backup.path}`)
  console.log('  restart DeepSeek Harness to load the restored archive.')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    asar: process.env.DSH_ASAR || findAsar(),
    out: null,
    force: false,
    verifyAll: false,
    help: false
  }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--asar') {
      const value = argv[++i]
      if (!value) throw new ToolError('--asar requires a path')
      options.asar = value
    } else if (arg === '--out' || arg === '-o') {
      const value = argv[++i]
      if (!value) throw new ToolError('--out requires a path')
      options.out = value
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--verify-all') {
      options.verifyAll = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg.startsWith('--')) {
      throw new ToolError(`unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  return { command: positional[0] || null, options }
}

function usage() {
  console.log(`asar-patch.mjs - Windows acrylic patch for DeepSeek Harness

Usage:
  node asar-patch.mjs check
  node asar-patch.mjs build --out <path> [--verify-all] [--asar <path>]
  node asar-patch.mjs apply  [--verify-all] [--asar <path>]
  node asar-patch.mjs revert [--force] [--asar <path>]

The archive is auto-detected from the running app or the usual install
locations; override with --asar <path> or the DSH_ASAR environment variable.

check   Read-only report: electron version file, patch state, backups, ASAR fuse.
build   Write a fully verified patched copy to --out; never modifies the source.
apply   Build+verify a temp next to the original, create a one-time backup,
        then atomically replace the original. Refuses if already patched.
revert  Restore the newest app.asar.bak-* over the original, atomically,
        after verifying the backup parses. Never deletes the backup.

Close DeepSeek Harness before running apply or revert.`)
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (options.help || !command) {
    usage()
    if (!command && !options.help) process.exitCode = 1
    return
  }
  if (!options.asar) {
    throw new ToolError('DeepSeek Harness not found. Pass --asar <path to resources/app.asar> or set DSH_ASAR.')
  }
  if (command === 'check') return cmdCheck(options)
  if (command === 'build') return cmdBuild(options)
  if (command === 'apply') return cmdApply(options)
  if (command === 'revert') return cmdRevert(options)
  throw new ToolError(`unknown command: ${command}\nRun with --help for usage.`)
}

try {
  await main()
} catch (error) {
  if (error instanceof ToolError) {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = error.exitCode
  } else {
    console.error(`ERROR: ${error && error.stack ? error.stack : error}`)
    process.exitCode = 1
  }
}
