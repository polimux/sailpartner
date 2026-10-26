#!/usr/bin/env node
'use strict'

// Installs or updates both Sailpartner plugins into the local Signal K server.
// Works on Windows, macOS, Linux and the Raspberry Pi — anything with Node.js.
//
//   node scripts/install.js            (from the repository folder)
//
// Options (environment variables):
//   SIGNALK_DIR   Signal K configuration folder, default <home>/.signalk
//   NO_PULL=1     don't run "git pull" first

const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(__dirname, '..')
const SK_DIR = process.env.SIGNALK_DIR || path.join(os.homedir(), '.signalk')
const PACKAGES = ['sailwarnings', 'sailpartner']

function run (cmd, cwd, { quiet = false, allowFail = false } = {}) {
  try {
    return execSync(cmd, { cwd, stdio: quiet ? 'pipe' : 'inherit', shell: true, encoding: 'utf8' })
  } catch (e) {
    if (allowFail) return null
    console.error(`\nCommand failed: ${cmd}`)
    process.exit(1)
  }
}
const q = p => `"${p}"`

if (!fs.existsSync(SK_DIR)) {
  console.error(`Signal K folder not found: ${SK_DIR}`)
  console.error('')
  console.error('Signal K may keep its settings somewhere else when started with sample data.')
  console.error('Start it with this folder as its configuration folder, then run this script again:')
  console.error('')
  console.error(process.platform === 'win32'
    ? `  mkdir "${SK_DIR}"\n  signalk-server -c "${SK_DIR}" --sample-n2k-data --override-timestamps`
    : `  mkdir -p "${SK_DIR}"\n  signalk-server -c "${SK_DIR}" --sample-n2k-data --override-timestamps`)
  console.error('')
  console.error('Or point this script at another folder: SIGNALK_DIR=<folder> node scripts/install.js')
  process.exit(1)
}

if (!process.env.NO_PULL) {
  console.log('== Updating repository')
  if (run('git pull --ff-only', REPO, { allowFail: true }) === null) {
    console.log('(could not pull — continuing with the files as they are)')
  }
}

// The packed plugins stay in a fixed folder: <SK_DIR>/package.json refers to
// them, and the Signal K App Store re-runs npm install with that file.
const PKG_DIR = path.join(SK_DIR, 'sailpartner-packages')
fs.mkdirSync(PKG_DIR, { recursive: true })
for (const f of fs.readdirSync(PKG_DIR)) if (f.endsWith('.tgz')) fs.unlinkSync(path.join(PKG_DIR, f))

const tarballs = []
for (const pkg of PACKAGES) {
  console.log(`== Packing ${pkg}`)
  const out = run(`npm pack --silent --pack-destination ${q(PKG_DIR)}`, path.join(REPO, 'packages', pkg), { quiet: true })
  const name = out.trim().split(/\r?\n/).pop()
  tarballs.push(path.join(PKG_DIR, name))
}

if (!fs.existsSync(path.join(SK_DIR, 'package.json'))) {
  fs.writeFileSync(path.join(SK_DIR, 'package.json'), JSON.stringify({ name: 'signalk-server-config', version: '0.0.1', private: true, dependencies: {} }, null, 2))
}

// The warnings plugin used to be called signalk-baltic-warnings — remove the old one.
try {
  const deps = JSON.parse(fs.readFileSync(path.join(SK_DIR, 'package.json'), 'utf8')).dependencies || {}
  if (deps['signalk-baltic-warnings']) {
    console.log('== Removing the old signalk-baltic-warnings (now called sailwarnings)')
    run('npm uninstall --no-audit --no-fund signalk-baltic-warnings', SK_DIR, { allowFail: true })
  }
} catch (e) { /* no package.json yet */ }

console.log(`== Installing into ${SK_DIR}`)
run(`npm install --no-audit --no-fund ${tarballs.map(q).join(' ')}`, SK_DIR)

console.log('== Restarting Signal K')
let restarted = false
if (process.platform === 'linux') {
  const units = run('systemctl list-unit-files', REPO, { quiet: true, allowFail: true }) || ''
  if (/^signalk\.service/m.test(units)) {
    restarted = run('sudo systemctl restart signalk', REPO, { allowFail: true }) !== null
  }
}
console.log(restarted ? 'Signal K restarted.' : 'Restart the Signal K server yourself now (Ctrl+C in its window, then start it again).')

console.log('\nDone. Next:')
console.log('  1. In Signal K: Server -> Plugin Config -> enable "Sailwarnings" and "Sailpartner"')
console.log('  2. Open http://localhost:3000/sailpartner/')
