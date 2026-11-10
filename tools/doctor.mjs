#!/usr/bin/env node
/**
 * doctor.mjs - read-only preflight checks for dsh-wallpaper-glass.
 *
 * Run it after `git clone` (before or after installing) when something does
 * not work:
 *
 *   node tools/doctor.mjs          human readable
 *   node tools/doctor.mjs --json   machine readable (good for bug reports)
 *
 * It never modifies anything: no writes to the profile, no patching, no
 * network calls. Exit code 0 = no blocking problem, 1 = at least one FAIL.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const NAME = PKG.name || 'dsh-wallpaper-glass'
const JSON_OUT = process.argv.includes('--json')

/** @type {{level:'ok'|'warn'|'fail', title:string, detail:string, hint:string}[]} */
const results = []
const add = (level, title, detail = '', hint = '') => results.push({ level, title, detail, hint })

// ---------------------------------------------------------------------------
// 1. Runtime
// ---------------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0])
add(
  nodeMajor >= 18 ? 'ok' : 'fail',
  `Node.js ${process.versions.node}`,
  nodeMajor >= 18 ? '' : '需要 18 或更高版本',
  nodeMajor >= 18 ? '' : '安装新版 Node.js: https://nodejs.org',
)

if (process.platform !== 'win32') {
  add('warn', `平台 ${process.platform}`, '插件只支持 Windows（acrylic 与 Wallpaper Engine 均为 Windows 特性）')
} else {
  add('ok', `平台 Windows ${os.release()}`)
}

// ---------------------------------------------------------------------------
// 2. DSH home + profile wiring
// ---------------------------------------------------------------------------
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
let profileDir = ''

if (!fs.existsSync(dshHome)) {
  add('fail', '找不到 DSH 数据目录', dshHome, '确认装过 DeepSeek Harness；自定义安装位置请先 set DSH_HOME=...')
} else {
  add('ok', 'DSH 数据目录', dshHome)
  const profilesDir = path.join(dshHome, 'profiles')
  if (!fs.existsSync(profilesDir)) {
    add('fail', '没有 profiles 目录', profilesDir, 'DSH 未初始化？先启动一次应用')
  } else {
    const available = fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(profilesDir, e.name, 'package.json')))
      .map((e) => e.name)

    const wanted = process.env.DSH_PROFILE || 'desktop'
    if (available.includes(wanted)) profileDir = path.join(profilesDir, wanted)
    else if (available.length === 1) profileDir = path.join(profilesDir, available[0])
    else if (available.length === 0) add('fail', '没有可用的 profile', profilesDir, '先启动一次 DeepSeek Harness')
    else add('fail', `无法确定 profile（候选: ${available.join(', ')}）`, '', 'set DSH_PROFILE=<名字> 后重跑')

    if (profileDir) {
      add('ok', 'Profile', profileDir)
      let profile = null
      try {
        profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
      } catch (error) {
        add('fail', 'profile/package.json 解析失败', error.message)
      }
      if (profile) {
        const dep = profile.dependencies && profile.dependencies[NAME]
        const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || []

        if (!dep) {
          add('fail', '插件未写入 profile 依赖', `dependencies["${NAME}"] 不存在`, `在仓库目录运行: node tools/install.mjs`)
        } else if (!String(dep).startsWith('link:')) {
          add('warn', '不是 link: 方式安装', `当前值 ${dep}`, '快照安装改了代码不会生效；建议 node tools/install.mjs --remove 后重新 install')
        } else {
          const target = path.resolve(String(dep).slice(5))
          const same = target.toLowerCase() === HERE.toLowerCase()
          add(
            same ? 'ok' : 'warn',
            same ? '依赖指向当前仓库' : '依赖指向另一个目录',
            `${dep}`,
            same ? '' : `当前仓库在 ${HERE}，profile 指向 ${target}；改代码请改 profile 指向的那份，或重新 install`,
          )
        }

        if (bundles.includes(NAME)) add('ok', '已加入 bundles', `共 ${bundles.length} 个 bundle`)
        else add('fail', '未加入 dsh.profile.bundles', '', `运行 node tools/install.mjs 会自动补上`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Plugin files and syntax
// ---------------------------------------------------------------------------
for (const rel of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  const file = path.join(HERE, rel)
  add(fs.existsSync(file) ? 'ok' : 'fail', `存在 ${rel}`, fs.existsSync(file) ? '' : '文件缺失，clone 不完整？')
}

for (const rel of ['lib/index.js', 'lib/client.js']) {
  const file = path.join(HERE, rel)
  if (!fs.existsSync(file)) continue
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (check.status === 0) add('ok', `语法检查通过 ${rel}`)
  else add('fail', `语法检查失败 ${rel}`, (check.stderr || '').split('\n').slice(0, 3).join(' '), '文件被改坏了，重新 clone 或 git checkout -- ' + rel)
}

try {
  const patch = fs.readFileSync(path.join(HERE, 'cordis.patch.yml'), 'utf8')
  const declared = (patch.match(/id:\s*(\S+)/) || [])[1]
  add(
    declared === NAME ? 'ok' : 'warn',
    'bundle id 与包名一致',
    declared === NAME ? '' : `cordis.patch.yml 写的是 ${declared}，package.json 是 ${NAME}`,
    declared === NAME ? '' : '两者不一致时设置页找不到条目',
  )
} catch {
  /* already reported above */
}

// ---------------------------------------------------------------------------
// 4. Wallpaper Engine
// ---------------------------------------------------------------------------
function regQuery(key, value) {
  const out = spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true })
  const text = `${out.stdout || ''}`
  const match = text.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`))
  return match ? match[1].trim() : ''
}

let weDir = ''
if (process.platform === 'win32') {
  const steamPath = regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath').replace(/\//g, '\\')
  const libraries = new Set()
  if (steamPath) libraries.add(steamPath)
  for (const candidate of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (fs.existsSync(candidate)) libraries.add(candidate)
  }
  for (const root of [...libraries]) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
    if (!fs.existsSync(vdf)) continue
    try {
      for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) {
        libraries.add(m[1].replace(/\\\\/g, '\\').replace(/\//g, '\\'))
      }
    } catch {
      /* ignore */
    }
  }
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', 'wallpaper_engine')
    if (fs.existsSync(dir)) {
      weDir = dir
      break
    }
  }
}

if (!weDir) {
  add('warn', '未检测到 Wallpaper Engine', '不影响使用：可在面板里选「自定义」填本地图片/视频', '想要跟随桌面壁纸，需要先装 Wallpaper Engine')
} else {
  add('ok', 'Wallpaper Engine', weDir)
  // steamapps\workshop\content\431960 (one level above common\wallpaper_engine)
  const steamApps = path.dirname(path.dirname(weDir))
  const workshopRoot = path.join(steamApps, 'workshop', 'content', '431960')
  const PLAYABLE = new Set(['.mp4', '.webm', '.mov', '.m4v', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
  let workshopCount = 0
  let playableCount = 0
  try {
    const dirs = fs.readdirSync(workshopRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
    workshopCount = dirs.length
    for (const entry of dirs.slice(0, 800)) {
      try {
        const project = JSON.parse(fs.readFileSync(path.join(workshopRoot, entry.name, 'project.json'), 'utf8').replace(/^\uFEFF/, ''))
        const ext = path.extname(String(project.file || '')).toLowerCase()
        if (PLAYABLE.has(ext)) playableCount += 1
      } catch {
        /* broken or missing project.json */
      }
    }
  } catch {
    /* no workshop content */
  }
  add(workshopCount > 0 ? 'ok' : 'warn', `创意工坊壁纸 ${workshopCount} 个`, workshopCount > 0 ? '' : '还没订阅任何创意工坊壁纸')
  if (workshopCount > 0) {
    const scene = workshopCount - playableCount
    add(
      playableCount > 0 ? 'ok' : 'warn',
      `其中浏览器可渲染 ${playableCount} 个`,
      scene > 0 ? `${scene} 个是场景/网页/程序类型，只能显示预览图（插件会自动隐藏它们）` : '全部可渲染',
    )
  }

  const projectDirs = [path.join(weDir, 'projects', 'myprojects')].filter((d) => fs.existsSync(d))
  let projectCount = 0
  for (const dir of projectDirs) {
    try {
      projectCount += fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    } catch {
      /* ignore */
    }
  }
  add('ok', `自制壁纸 ${projectCount} 个`, projectDirs.join('; '))
}

// ---------------------------------------------------------------------------
// 5. Desktop transparency patch (backup-based, no asar parsing)
// ---------------------------------------------------------------------------
try {
  const { findAsar } = await import('./find-dsh.mjs')
  const asar = findAsar()
  if (!asar) {
    add('warn', '没找到应用安装目录', '无法判断透明补丁状态', '想用透明窗口：node tools/transparency.mjs status')
  } else {
    const dir = path.dirname(asar)
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('app.asar.bak-'))
    add('ok', '应用目录', asar)
    add(
      backups.length ? 'ok' : 'ok',
      backups.length ? `透明补丁备份 ${backups.length} 份` : '未打过透明补丁',
      backups.length ? backups[backups.length - 1] : '内置壁纸层不需要补丁；要窗口透明再跑 node tools/transparency.mjs apply',
    )
  }
} catch (error) {
  add('warn', '跳过透明补丁检查', error.message)
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const icon = { ok: '✓', warn: '!', fail: '✗' }
const fatal = results.filter((r) => r.level === 'fail')

if (JSON_OUT) {
  console.log(JSON.stringify({ name: NAME, version: PKG.version, repo: HERE, node: process.versions.node, results, fails: fatal.length }, null, 2))
} else {
  console.log(`\n${NAME} v${PKG.version} · 自检\n${'─'.repeat(56)}`)
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.title}${r.detail ? `  —  ${r.detail}` : ''}`)
    if (r.hint) console.log(`    → ${r.hint}`)
  }
  console.log('─'.repeat(56))
  if (fatal.length === 0) {
    console.log('结论：没有阻断性问题。')
    console.log('如果界面上仍然看不到效果：重启 DeepSeek Harness，再点右下角齿轮打开面板。\n')
  } else {
    console.log(`结论：${fatal.length} 个阻断性问题，按上面的 → 提示处理后重跑本脚本。\n`)
  }
}

process.exitCode = fatal.length ? 1 : 0
