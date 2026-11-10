#!/usr/bin/env node
/**
 * install.mjs — register this clone as a DSH plugin in the local profile.
 *
 * What it does (nothing else):
 *   1. finds the DSH home (DSH_HOME, else ~/.dsh) and the active profile
 *   2. adds `"dsh-wallpaper-glass": "link:<this folder>"` to the profile's
 *      dependencies
 *   3. appends `dsh-wallpaper-glass` to `dsh.profile.bundles`
 *
 * It never touches the app binary and never deletes anything. Restart DSH
 * afterwards; the plugin shows up in 设置 → 插件 and in the floating panel.
 *
 *   node tools/install.mjs            # install / update the link
 *   node tools/install.mjs --remove   # unlink again
 *   node tools/install.mjs --profile desktop
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const NAME = PKG.name || 'dsh-wallpaper-glass'
const REMOVE = process.argv.includes('--remove')
const PROFILE_ARG = (() => {
  const i = process.argv.indexOf('--profile')
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
})()

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profilesDir = path.join(home, 'profiles')

function fail(message) {
  console.error(`\n[error] ${message}\n`)
  process.exitCode = 1
}

function pickProfile() {
  if (PROFILE_ARG) {
    const dir = path.join(profilesDir, PROFILE_ARG)
    if (!fs.existsSync(path.join(dir, 'package.json'))) fail(`profile not found: ${dir}`)
    return dir
  }
  const preferred = process.env.DSH_PROFILE || 'desktop'
  const preferredDir = path.join(profilesDir, preferred)
  if (fs.existsSync(path.join(preferredDir, 'package.json'))) return preferredDir
  const found = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(profilesDir, e.name, 'package.json')))
    .map((e) => path.join(profilesDir, e.name))
  if (found.length === 1) return found[0]
  fail(`cannot tell which profile to edit; pass --profile <name>. Candidates: ${found.map((p) => path.basename(p)).join(', ') || 'none'}`)
  return null
}

if (!fs.existsSync(profilesDir)) {
  fail(`DSH home looks wrong (no profiles/ directory): ${home}\n  Set DSH_HOME if the app lives elsewhere.`)
} else {
  const profileDir = pickProfile()
  if (profileDir) {
    const file = path.join(profileDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    pkg.dependencies = pkg.dependencies || {}
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []

    if (REMOVE) {
      delete pkg.dependencies[NAME]
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== NAME)
    } else {
      const link = `link:${HERE.replace(/\\/g, '/')}`
      pkg.dependencies[NAME] = link
      if (!bundles.includes(NAME)) bundles.push(NAME)
      pkg.dsh.profile.bundles = bundles
    }

    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    console.log(`${REMOVE ? 'unlinked' : 'linked'} ${NAME}`)
    console.log(`  profile: ${profileDir}`)
    if (!REMOVE) console.log(`  source:  ${HERE}`)
    console.log(`\n${REMOVE ? 'Restart' : 'Restart'} DeepSeek Harness to apply.`)
  }
}
