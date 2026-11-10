/**
 * find-dsh.mjs — locate the DeepSeek Harness installation on this machine.
 *
 * The plugin itself never needs this; only the optional desktop-transparency
 * patch does, because it has to rewrite `<install>\resources\app.asar`.
 *
 * Resolution order for the archive:
 *   1. explicit `--asar <path>` (handled by the caller)
 *   2. DSH_ASAR environment variable
 *   3. the running "DeepSeek Harness.exe" process image
 *   4. common install roots on every fixed drive
 */
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const APP_EXE = 'DeepSeek Harness.exe'

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** Absolute path of the running app executable, or '' when not detectable. */
export function findAppExe() {
  try {
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    )
    const found = (out.stdout || '').trim().split(/\r?\n/).pop().trim()
    if (found && existsSync(found)) return found
  } catch {
    /* ignore */
  }
  return ''
}

function driveRoots() {
  const roots = []
  for (const letter of 'CDEFGHIJ') {
    const root = `${letter}:\\`
    try {
      if (existsSync(root)) roots.push(root)
    } catch {
      /* ignore */
    }
  }
  return roots
}

function candidateDirs() {
  const list = []
  const appExe = findAppExe()
  if (appExe) list.push(path.dirname(appExe))
  for (const env of ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[env]
    if (!base) continue
    list.push(path.join(base, 'DeepSeek Harness'))
    list.push(path.join(base, 'Programs', 'DeepSeek Harness'))
    list.push(path.join(base, 'DeepSeek'))
  }
  for (const root of driveRoots()) {
    list.push(path.join(root, 'DeepSeek'))
    list.push(path.join(root, 'DeepSeek Harness'))
    list.push(path.join(root, 'Program Files', 'DeepSeek Harness'))
  }
  return [...new Set(list)]
}

/** Absolute path of resources/app.asar, or '' when the install cannot be found. */
export function findAsar() {
  if (process.env.DSH_ASAR && existsSync(process.env.DSH_ASAR)) return process.env.DSH_ASAR
  for (const dir of candidateDirs()) {
    for (const archive of [path.join(dir, 'resources', 'app.asar'), path.join(dir, 'app.asar')]) {
      if (existsSync(archive)) return archive
    }
  }
  return ''
}

/**
 * Install root (the directory holding the executable) for an app.asar path.
 * electron-builder layout is <root>/resources/app.asar, so the root is one
 * level above the archive's directory - not two.
 */
export function appRootFromAsar(asar) {
  const resources = path.dirname(asar)
  const root = path.resolve(resources, '..')
  // tolerate a bare <root>/app.asar layout as well
  return path.basename(resources).toLowerCase() === 'resources' ? root : resources
}

/** The executable that owns this archive, or '' when it is not where we expect. */
export function exeFromAsar(asar) {
  const exe = path.join(appRootFromAsar(asar), APP_EXE)
  return existsSync(exe) ? exe : ''
}

export { APP_EXE, isFile }
