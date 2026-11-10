/**
 * dsh-wallpaper-glass —— 宿主半侧。
 *
 * 干三件事：
 *   1. 读出本机 Wallpaper Engine 的当前壁纸与已安装壁纸库（workshop 431960 + myprojects）；
 *      WE 没开或没装时回退到 Windows 桌面壁纸。
 *   2. 把这些壁纸文件通过本机 HTTP 路由流给浏览器（支持 Range，视频才能拖动/循环播放）。
 *   3. 保存「壁纸源」与「界面外观」两套互不影响的偏好。
 *
 * 路由全部挂在 /wallpaper-glass/api 前缀下：
 *   GET  /state          当前壁纸 + 壁纸库 + 配置
 *   GET  /asset?id=&k=    壁纸媒体 / 预览图（Range 流式）
 *   POST /config          保存配置
 *   GET  /probe?path=     校验一个自定义文件路径
 *
 * 安全边界：只接受本机回环；写操作要求同源；媒体只能取服务端登记过的 id，
 * 不接受前端传来的任意路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const name = 'dsh-wallpaper-glass'
export const inject = ['webServer']

const API_PREFIX = '/wallpaper-glass/api'
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
}

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'builtin',            // builtin = 应用内壁纸层；transparent = 透出桌面（需窗口透明补丁）
  source: 'desktop',          // desktop = 跟随桌面当前壁纸；pinned = 固定在库中的一张；custom = 自定义文件
  pinnedId: '',
  customPath: '',
  mediaOn: true,              // 视频壁纸是否播放
  style: {
    preset: 'clear',          // clear = 原图直出；noir / frost / cyber / minimal = 各种柔化风格
    blur: 0,
    dim: 0.18,
    saturate: 1.04,
    zoom: 1,
    neon: '#8fe3ff',
    radius: 16,
    panelAlpha: 0.5,
    forceDark: true,
    particles: false,
    blurPanels: true,
    contrast: false,
    readScrim: 0.25,
  },
}

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const stateDir = () => path.join(dshHome(), 'wallpaper-glass')
const configFile = () => path.join(stateDir(), 'config.json')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

function readConfig() {
  const raw = readJson(configFile(), {})
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    style: { ...DEFAULT_CONFIG.style, ...(raw && typeof raw.style === 'object' ? raw.style : {}) },
  }
}

function saveConfig(patch) {
  const next = readConfig()
  if (patch && typeof patch === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key === 'style') continue
      if (patch[key] !== undefined) next[key] = patch[key]
    }
    if (patch.style && typeof patch.style === 'object') {
      for (const key of Object.keys(DEFAULT_CONFIG.style)) {
        if (patch.style[key] !== undefined) next.style[key] = patch.style[key]
      }
    }
  }
  fs.mkdirSync(stateDir(), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2))
  return next
}

// ── 小工具 ──────────────────────────────────────────────────────────────
const idOf = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16)
const extOf = (file) => path.extname(String(file || '')).toLowerCase()
const kindOf = (file) => (VIDEO_EXT.has(extOf(file)) ? 'video' : IMAGE_EXT.has(extOf(file)) ? 'image' : 'other')
const exists = (file) => { try { return !!file && fs.statSync(file).isFile() } catch { return false } }

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    const line = out.split(/\r?\n/).find((row) => row.toLowerCase().includes(value.toLowerCase()))
    const m = line && line.match(/REG_[A-Z_]+\s+(.+)$/i)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

function steamLibraries() {
  const libs = new Set()
  const steamPath = regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath').replace(/\//g, '\\')
  const roots = []
  if (steamPath) roots.push(steamPath)
  const candidates = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
  for (const letter of 'CDEFGH') candidates.push(`${letter}:\\Steam`, `${letter}:\\SteamLibrary`)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) roots.push(candidate)
  }
  for (const root of roots) {
    libs.add(root)
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
    if (!fs.existsSync(vdf)) continue
    try {
      const text = fs.readFileSync(vdf, 'utf8')
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\').replace(/\//g, '\\'))
    } catch {}
  }
  return [...libs].filter((lib) => { try { return fs.statSync(lib).isDirectory() } catch { return false } })
}

let weCache = { at: 0, value: null }
function wallpaperEngine() {
  if (Date.now() - weCache.at < 15000 && weCache.value) return weCache.value
  const result = { dir: '', configFile: '', workshop: [], local: [], libraries: [] }
  for (const lib of steamLibraries()) {
    const dir = path.join(lib, 'steamapps', 'common', 'wallpaper_engine')
    if (!fs.existsSync(path.join(dir, 'config.json'))) continue
    result.dir = dir
    result.configFile = path.join(dir, 'config.json')
    result.libraries.push(lib)
    const workshop = path.join(lib, 'steamapps', 'workshop', 'content', '431960')
    if (fs.existsSync(workshop)) result.workshop.push(workshop)
    if (result.workshop.length > 0) break
  }
  if (result.dir) {
    result.local = [path.join(result.dir, 'projects', 'myprojects')].filter((p) => fs.existsSync(p))
  }
  weCache = { at: Date.now(), value: result }
  return result
}

let procCache = { at: 0, running: false }
function wallpaperEngineRunning() {
  if (Date.now() - procCache.at < 5000) return procCache.running
  let running = false
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq wallpaper64.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    running = /wallpaper64\.exe/i.test(out)
  } catch {}
  procCache = { at: Date.now(), running }
  return running
}

// ── 壁纸库 ──────────────────────────────────────────────────────────────
const registry = new Map() // id -> { file, title, kind, dir }

function projectEntry(dir, project, source) {
  const mediaName = String(project.file || '')
  const mediaPath = mediaName ? path.join(dir, mediaName) : ''
  const previewCandidates = [
    project.preview ? path.join(dir, String(project.preview)) : '',
    path.join(dir, 'preview.jpg'),
    path.join(dir, 'preview.gif'),
    path.join(dir, 'preview.png'),
  ]
  const previewPath = previewCandidates.find((p) => exists(p) && extOf(p) !== '.pkg') || ''
  const playable = exists(mediaPath) && kindOf(mediaPath) !== 'other' ? mediaPath : ''
  const still = playable ? previewPath : (exists(mediaPath) && kindOf(mediaPath) === 'image' ? mediaPath : previewPath)
  const id = idOf(dir)
  const item = {
    id,
    title: String(project.title || path.basename(dir)),
    type: String(project.type || '').toLowerCase(),
    source,
    hasVideo: kindOf(playable) === 'video',
    media: playable || still || '',
    preview: still || '',
  }
  if (!item.media) return null
  item.previewOnly = !playable
  registry.set(id, { file: item.media, dir })
  if (item.preview && item.preview !== item.media) registry.set(`${id}#p`, { file: item.preview, dir })
  return item
}

function scanProjects(root, source, out) {
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)) } catch { return }
  for (const dir of dirs) {
    const project = readJson(path.join(dir, 'project.json'), null)
    if (!project) continue
    const entry = projectEntry(dir, project, source)
    if (entry) out.push(entry)
  }
}

function readWeConfig() {
  const we = wallpaperEngine()
  if (!we.configFile) return null
  const raw = readJson(we.configFile, null)
  if (!raw) return null
  // WE 按「机器名」分块存配置；wallpaperconfig 可能在块根部，也可能在 general 下面。
  const machineKey = Object.keys(raw).find((key) => {
    const block = raw[key]
    if (!block || typeof block !== 'object') return false
    const direct = block.wallpaperconfig && block.wallpaperconfig.selectedwallpapers
    const nested = block.general && block.general.wallpaperconfig && block.general.wallpaperconfig.selectedwallpapers
    return !!(direct || nested)
  })
  if (!machineKey) return null
  const machine = raw[machineKey]
  const wallpaperConfig = (machine.wallpaperconfig && machine.wallpaperconfig.selectedwallpapers)
    ? machine.wallpaperconfig
    : machine.general.wallpaperconfig
  const selected = wallpaperConfig && wallpaperConfig.selectedwallpapers
  const monitors = selected && typeof selected === 'object' ? Object.keys(selected) : []
  const monitor = monitors[0]
  const file = monitor ? String((selected[monitor] || {}).file || '') : ''
  const recent = Array.isArray(machine.wallpaperconfigrecent)
    ? machine.wallpaperconfigrecent
    : Array.isArray(machine.general && machine.general.wallpaperconfigrecent) ? machine.general.wallpaperconfigrecent : []
  const recentTitles = new Map()
  for (const row of recent) {
    const rowFile = row && row.config && row.config.selectedwallpapers
    const target = rowFile && Object.values(rowFile)[0]
    if (target && target.file && row.title) recentTitles.set(String(target.file), String(row.title))
  }
  return { file, recentTitles, machineKey }
}

function desktopItem() {
  const config = readConfig()
  const we = wallpaperEngine()
  const weState = readWeConfig()

  if (config.source === 'custom' && config.customPath) {
    const file = config.customPath
    if (exists(file)) {
      const id = 'custom'
      registry.set(id, { file, dir: path.dirname(file) })
      return {
        id, title: path.basename(file), type: 'custom', source: 'custom',
        hasVideo: kindOf(file) === 'video',
        media: file, preview: kindOf(file) === 'image' ? file : '',
      }
    }
  }

  if (weState && weState.file) {
    const file = String(weState.file).replace(/\//g, '\\')
    const dir = path.dirname(file)
    const project = readJson(path.join(dir, 'project.json'), {})
    const title = recentTitlesFor(weState, file) || project.title || path.basename(dir)
    const entry = projectEntry(dir, { ...project, title, file: path.basename(file) }, 'wallpaper-engine')
    if (entry) {
      entry.id = idOf(dir)
      entry.live = true
      return entry
    }
  }

  // 回退：Windows 桌面壁纸（WE 关闭时的静图）
  const wall = regQuery('HKCU\\Control Panel\\Desktop', 'Wallpaper').replace(/"/g, '')
  const fallback = exists(wall) ? wall : path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
  if (exists(fallback)) {
    const id = 'desktop-image'
    registry.set(id, { file: fallback, dir: path.dirname(fallback) })
    return { id, title: '桌面壁纸', type: 'image', source: 'windows', hasVideo: false, media: fallback, preview: fallback }
  }
  return null
}

function recentTitlesFor(weState, file) {
  const normalized = String(file).replace(/\\/g, '/')
  for (const [key, title] of weState.recentTitles) {
    if (String(key).replace(/\\/g, '/') === normalized) return title
  }
  return ''
}

let libraryCache = { at: 0, items: [], hidden: 0 }
function library(force = false) {
  if (!force && Date.now() - libraryCache.at < 20000 && libraryCache.items.length) return libraryCache.items
  const items = []
  const we = wallpaperEngine()
  for (const root of we.workshop) scanProjects(root, 'workshop', items)
  for (const root of we.local) scanProjects(root, 'myprojects', items)
  const seen = new Set()
  const unique = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
  // 只有预览图的项目（scene.pkg / web / application）浏览器端根本渲染不了，直接从库里去掉
  const usable = unique.filter((item) => !item.previewOnly)
  usable.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
  libraryCache = { at: Date.now(), items: usable, hidden: unique.length - usable.length }
  return usable
}

const assetUrl = (base, id, kind) => `${base}/asset?id=${encodeURIComponent(id)}&k=${kind}`

function serialize(item, base) {
  if (!item) return null
  const registered = registry.get(item.id)
  const hasPreview = item.preview && item.preview !== item.media && registry.has(`${item.id}#p`)
  const mediaUrl = item.media && registered ? assetUrl(base, item.id, 'media') : ''
  const previewUrl = hasPreview ? assetUrl(base, `${item.id}#p`, 'preview') : mediaUrl
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    source: item.source,
    live: !!item.live,
    hasVideo: !!item.hasVideo,
    mediaUrl,
    previewUrl,
  }
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = req.headers.host || ''
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function isLoopback(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '')
  return addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1' || addr === ''
}

function serveFile(req, res, file) {
  const stat = fs.statSync(file)
  const mime = MIME[extOf(file)] || 'application/octet-stream'
  const baseHeaders = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  }
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      let start = m[1] ? Number(m[1]) : 0
      let end = m[2] ? Number(m[2]) : stat.size - 1
      if (!m[1] && m[2]) { start = Math.max(0, stat.size - Number(m[2])); end = stat.size - 1 }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
        res.end()
        return
      }
      end = Math.min(end, stat.size - 1)
      res.writeHead(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 })
      if (req.method === 'HEAD') { res.end(); return }
      fs.createReadStream(file, { start, end }).pipe(res)
      return
    }
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': stat.size })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file).pipe(res)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── 插件 ────────────────────────────────────────────────────────────────
export function apply(ctx) {
  const log = (...args) => { try { (ctx.logger?.info || console.log)(...args) } catch {} }
  const disposers = []

  const we = wallpaperEngine()
  log(`[wallpaper-glass] Wallpaper Engine: ${we.dir || '未找到'}；壁纸库 ${library().length} 项`)

  const handler = async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: '只接受本机回环访问' }); return }
    const url = new URL(req.url, 'http://127.0.0.1')
    const rest = url.pathname.slice(API_PREFIX.length).replace(/^\//, '')
    const base = API_PREFIX

    if (req.method === 'GET' && (rest === 'state' || rest === '')) {
      const config = readConfig()
      if (url.searchParams.get('refresh') === '1') { library(true); weCache.at = 0 }
      const desktop = desktopItem()
      const items = library(!!url.searchParams.get('refresh'))
      sendJson(res, 200, {
        ok: true,
        version: '0.1.0',
        config,
        desktop: serialize(desktop, base),
        wallpaperEngine: { running: wallpaperEngineRunning(), dir: we.dir, connected: !!we.configFile },
        library: items.map((item) => serialize(item, base)),
        counts: { library: items.length, hidden: libraryCache.hidden || 0 },
      })
      return
    }

    if (req.method === 'GET' && rest === 'asset') {
      const id = String(url.searchParams.get('id') || '')
      const kind = String(url.searchParams.get('k') || 'media')
      const record = registry.get(id)
      if (!record) { sendJson(res, 404, { ok: false, error: '未知壁纸' }); return }
      if (!exists(record.file)) { sendJson(res, 404, { ok: false, error: '文件已不存在' }); return }
      serveFile(req, res, record.file)
      return
    }

    if (req.method === 'GET' && rest === 'probe') {
      const target = String(url.searchParams.get('path') || '').trim()
      if (!target) { sendJson(res, 400, { ok: false, error: '缺少路径' }); return }
      const kind = kindOf(target)
      const ok = exists(target) && kind !== 'other'
      sendJson(res, 200, {
        ok,
        kind,
        exists: exists(target),
        error: ok ? '' : exists(target) ? '不支持的格式（图片或视频）' : '文件不存在',
      })
      return
    }

    if (req.method === 'POST' && rest === 'config') {
      if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' }); return }
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        sendJson(res, 415, { ok: false, error: '需要 application/json' })
        return
      }
      try {
        const patch = JSON.parse((await readBody(req)) || '{}')
        const config = saveConfig(patch)
        sendJson(res, 200, { ok: true, config })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: `未知接口：${rest}` })
  }

  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  } else {
    log('[wallpaper-glass] 没有 webServer 服务，接口未注册（面板会显示离线）')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { for (const dispose of disposers) { try { dispose?.() } catch {} } })
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { for (const dispose of disposers) { try { dispose?.() } catch {} } })
  }
}

export default { name, inject, apply }

