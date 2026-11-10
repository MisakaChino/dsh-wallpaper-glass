#!/usr/bin/env node
/**
 * transparency.mjs — one-command desktop acrylic glass for DeepSeek Harness.
 *
 *   node tools/transparency.mjs apply    # close app -> patch -> relaunch
 *   node tools/transparency.mjs revert   # close app -> restore -> relaunch
 *   node tools/transparency.mjs status   # read-only report
 *
 * The heavy lifting (verified, reversible ASAR rewrite) lives in
 * asar-patch.mjs; this wrapper only resolves the install, closes the app,
 * and starts it again.
 *
 * `apply` requires the app to be closed. Closing it means this script kills
 * every "DeepSeek Harness.exe" process, so do not run it from inside a DSH
 * session that you still need.
 */
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { APP_EXE, exeFromAsar, findAsar } from './find-dsh.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCHER = path.join(HERE, 'asar-patch.mjs')
const ACTION = (process.argv[2] || '').toLowerCase()
const YES = process.argv.includes('--yes') || process.argv.includes('-y')
const ASAR_ARG = (() => {
  const i = process.argv.indexOf('--asar')
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
})()

/** Windows-friendly sleep without spawning anything. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function say(line = '') {
  console.log(line)
}

function fail(message) {
  console.error(`\n[失败] ${message}\n`)
  process.exitCode = 1
}

function runPatcher(args) {
  return spawnSync(process.execPath, [PATCHER, ...args], { stdio: 'inherit' })
}

function killApp() {
  const result = spawnSync('taskkill', ['/IM', APP_EXE, '/F'], { windowsHide: true, encoding: 'utf8' })
  const out = `${result.stdout || ''}${result.stderr || ''}`
  return /SUCCESS|成功/i.test(out)
}

function launchApp(exe) {
  if (!exe) return false
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
  child.unref()
  return true
}

function resolveOrFail() {
  const asar = ASAR_ARG || findAsar()
  if (!asar) {
    fail(
      '没有找到 DeepSeek Harness 的 app.asar。\n' +
        '  请用 --asar 指定，或设置 DSH_ASAR 环境变量，例如：\n' +
        '  node tools/transparency.mjs apply --asar "D:\\Apps\\DeepSeek Harness\\resources\\app.asar"',
    )
    return null
  }
  return { asar, exe: exeFromAsar(asar) }
}

if (!['apply', 'revert', 'status', 'check'].includes(ACTION)) {
  say('用法: node tools/transparency.mjs <apply|revert|status> [--asar <path>] [--yes]')
  process.exitCode = ACTION ? 1 : 0
} else {
  const target = resolveOrFail()
  if (target) {
    const { asar, exe } = target
    say(`归档: ${asar}`)
    say(`程序: ${exe || '(未找到，末尾不会自动重启)'}`)

    if (ACTION === 'status' || ACTION === 'check') {
      process.exitCode = runPatcher(['check', '--asar', asar]).status || 0
    } else if (ACTION === 'apply') {
      say('\n[1/3] 关闭 DeepSeek Harness ...')
      const killed = killApp()
      say(killed ? '      已关闭。' : '      没有正在运行的实例。')
      sleep(1500)

      say('[2/3] 备份并打补丁（首次会备份 app.asar，约 200+ MB）...')
      const patched = runPatcher(['apply', '--asar', asar])
      if (patched.status !== 0) {
        fail('补丁没有写入，原 app.asar 未被修改。正在原样重启。')
        launchApp(exe)
      } else {
        say('[3/3] 重启 DeepSeek Harness ...')
        if (!launchApp(exe)) say('      请手动启动 DeepSeek Harness。')
        say('\n完成。打开界面右下角齿轮 → 外观 → 行为 → 勾选「透出桌面（透明窗口）」。')
        say('想还原：node tools/transparency.mjs revert')
      }
    } else {
      say('\n[1/3] 关闭 DeepSeek Harness ...')
      const killed = killApp()
      say(killed ? '      已关闭。' : '      没有正在运行的实例。')
      sleep(1500)

      say('[2/3] 用备份还原 app.asar ...')
      const restored = runPatcher(['revert', '--asar', asar])
      if (restored.status !== 0) {
        fail('没有可用备份，或还原校验没通过。原 app.asar 未被修改。正在原样重启。')
        launchApp(exe)
      } else {
        say('[3/3] 重启 DeepSeek Harness ...')
        if (!launchApp(exe)) say('      请手动启动 DeepSeek Harness。')
        say('\n完成，窗口恢复成不透明背景。')
      }
    }
  }
}
