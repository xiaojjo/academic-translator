/**
 * Skill discovery.
 *
 * The Host `skills` service only exposes the layer its own context can see, so a
 * host-level plugin can miss the user and project layers that a Session sees.
 * Skills on disk are plain `SKILL.md` files with YAML front matter, so this
 * module reads those roots directly and merges them with whatever the service
 * reports. The service stays the preferred loader, because it resolves layered
 * overrides; the filesystem is the fallback.
 *
 * @module @local/dsh-academic-translator/skills
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Largest accepted skill body. */
const MAX_SKILL_BYTES = 512 * 1024

/**
 * Roots that hold skill collections on this machine.
 * @param {{ cwd?: string, installDir?: string }} options
 * @returns {string[]} existing directories, most specific first
 */
export function skillRoots(options = {}) {
  const home = os.homedir()
  const candidates = []
  const cwd = options.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    candidates.push(path.join(cwd, '.dsh', 'skills'), path.join(cwd, '.agents', 'skills'))
  }
  candidates.push(
    path.join(home, '.dsh', 'skills'),
    path.join(home, '.agents', 'skills'),
  )
  const install = options.installDir
  if (typeof install === 'string' && install.length > 0) {
    candidates.push(
      path.join(install, 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'skills'),
    )
  }
  return candidates.filter((directory) => {
    try {
      return fs.statSync(directory).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * Parse the YAML front matter of a skill file.
 * Handles the plain `key: value` form, the folded `>-` block, and quoted values.
 * @param {string} text
 * @returns {{ name?: string, description?: string, whenToUse?: string }}
 */
export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (match === null) return {}
  const lines = match[1].split(/\r?\n/u)
  /** @type {Record<string, string>} */
  const fields = {}
  let currentKey = null
  let buffer = []
  const commit = () => {
    if (currentKey === null) return
    const joined = buffer.join(' ').replace(/\s+/gu, ' ').trim()
    if (joined.length > 0) fields[currentKey] = joined
    buffer = []
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/gu, '  ')
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line)
    if (keyMatch !== null) {
      commit()
      currentKey = keyMatch[1]
      const value = keyMatch[2].trim()
      if (value.length > 0 && !['>-', '>', '|-', '|'].includes(value)) {
        fields[currentKey] = value.replace(/^["'](.*)["']$/u, '$1')
        currentKey = null
      }
      continue
    }
    if (currentKey !== null && /^\s+\S/u.test(rawLine)) buffer.push(line.trim())
    else if (currentKey !== null && line.trim().length === 0) buffer.push('')
  }
  commit()
  return { name: fields.name, description: fields.description, whenToUse: fields.when_to_use ?? fields.whenToUse }
}

/**
 * Skill files under one root: `<root>/<name>/SKILL.md`.
 * @param {string} root
 * @returns {Array<{ name: string, description: string, path: string }>}
 */
function scanRoot(root) {
  /** @type {Array<{ name: string, description: string, path: string }>} */
  const skills = []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return skills
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'SKILL.md')
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue
      const head = fs.readFileSync(file, 'utf8')
      const meta = parseFrontMatter(head)
      skills.push({
        name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name,
        description: typeof meta.description === 'string' ? meta.description : '',
        path: file,
      })
    } catch {
      /* not a skill directory */
    }
  }
  return skills
}

/**
 * Every skill found on disk, deduplicated by name.
 * @param {{ cwd?: string, installDir?: string }} options
 * @returns {Array<{ name: string, description: string, path: string }>}
 */
export function discoverSkills(options = {}) {
  /** @type {Map<string, { name: string, description: string, path: string }>} */
  const found = new Map()
  for (const root of skillRoots(options)) {
    for (const skill of scanRoot(root)) {
      if (found.has(skill.name)) continue
      found.set(skill.name, skill)
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Load a skill body from disk.
 * @param {string} file
 * @returns {string | null}
 */
export function loadSkillBody(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}