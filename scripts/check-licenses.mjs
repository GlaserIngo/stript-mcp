#!/usr/bin/env node
/**
 * Fail-closed license gate over the PRODUCTION dependency tree.
 *
 * Walks the runtime dependencies declared in package.json (recursively,
 * following node_modules resolution including nested trees), reads each
 * package's declared license, and asserts it against a permissive
 * allowlist. Any unknown, missing, or non-allowlisted license fails the
 * build with the offender list. The npm counterpart of the backend's
 * dependency-license gate (repo constraint 7).
 *
 * Dependency-free by design: node builtins only.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ALLOWED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  '(MIT OR Apache-2.0)',
  'MIT OR Apache-2.0',
]

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Resolve a dependency's package directory using node_modules resolution:
 * look in fromDir/node_modules/name, then walk up parent directories,
 * stopping at the package root's parent.
 */
function resolvePackageDir(fromDir, name) {
  let current = fromDir
  while (current.startsWith(packageRoot)) {
    const candidate = path.join(current, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function declaredLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim().length > 0) {
    return pkg.license.trim()
  }
  // Legacy shapes: license object or licenses array.
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') {
    return pkg.license.type.trim()
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses
      .map((entry) => (entry && typeof entry.type === 'string' ? entry.type.trim() : null))
      .filter(Boolean)
    if (types.length > 0) return types.join(' OR ')
  }
  return null
}

const rootPkg = readPackageJson(packageRoot)
if (rootPkg === null) {
  console.error('check-licenses: could not read package.json')
  process.exit(1)
}

const rootDeps = Object.keys(rootPkg.dependencies ?? {})
const visited = new Set()
const offenders = []
const checked = []
const queue = rootDeps.map((name) => ({ name, fromDir: packageRoot }))

while (queue.length > 0) {
  const { name, fromDir } = queue.shift()
  const dir = resolvePackageDir(fromDir, name)
  if (dir === null) {
    offenders.push({ name, version: '(unresolved)', license: 'NOT INSTALLED' })
    continue
  }
  const key = dir
  if (visited.has(key)) continue
  visited.add(key)

  const pkg = readPackageJson(dir)
  if (pkg === null) {
    offenders.push({ name, version: '(unreadable)', license: 'NO PACKAGE METADATA' })
    continue
  }
  const license = declaredLicense(pkg)
  const record = { name: pkg.name ?? name, version: pkg.version ?? '?', license: license ?? 'NONE DECLARED' }
  checked.push(record)
  if (license === null || !ALLOWED_LICENSES.includes(license)) {
    offenders.push(record)
  }

  // Production tree only: dependencies and optionalDependencies, never
  // devDependencies.
  const next = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }
  for (const depName of Object.keys(next)) {
    queue.push({ name: depName, fromDir: dir })
  }
}

if (offenders.length > 0) {
  console.error('check-licenses: FAIL. Non-allowlisted or missing licenses in the production tree:')
  for (const offender of offenders) {
    console.error(`  - ${offender.name}@${offender.version}: ${offender.license}`)
  }
  console.error(`Allowlist: ${ALLOWED_LICENSES.join(', ')}`)
  process.exit(1)
}

console.error(`check-licenses: OK. ${checked.length} production packages, all allowlisted.`)
