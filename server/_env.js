import fs from 'fs'
import path from 'path'

let cachedEnvMap = null

function sanitizeEnvValue(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
}

function parseEnvText(text) {
  const map = new Map()
  const lines = String(text || '').split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const index = trimmed.indexOf('=')
    if (index <= 0) continue

    const key = trimmed.slice(0, index).trim()
    const rawValue = trimmed.slice(index + 1)
    if (!key) continue

    map.set(key, sanitizeEnvValue(rawValue))
  }

  return map
}

function readEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Map()
    const text = fs.readFileSync(filePath, 'utf8')
    return parseEnvText(text)
  } catch {
    return new Map()
  }
}

function getLocalEnvMap() {
  if (cachedEnvMap) return cachedEnvMap

  const cwd = process.cwd()
  const envPath = path.join(cwd, '.env')
  const envLocalPath = path.join(cwd, '.env.local')

  const envMap = readEnvFile(envPath)
  const envLocalMap = readEnvFile(envLocalPath)

  for (const [key, value] of envLocalMap.entries()) {
    envMap.set(key, value)
  }

  cachedEnvMap = envMap
  return cachedEnvMap
}

export function getEnvValue(key) {
  const fromProcess = sanitizeEnvValue(process.env[key])
  if (fromProcess) return fromProcess

  const localMap = getLocalEnvMap()
  return sanitizeEnvValue(localMap.get(key))
}

