import '../api/_suppress-warnings.js'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

let cachedClient = null
let clientCreatedAt = null
const CLIENT_MAX_AGE = 5 * 60 * 1000 // 5 分鐘後重新建立 client
let localEnvCache = null

function normalizeEnvValue(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
}

function parseEnvText(text) {
  const parsed = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex).trim()
    const value = normalizeEnvValue(line.slice(eqIndex + 1))
    if (!key || !value) continue
    parsed[key] = value
  }
  return parsed
}

function loadLocalEnvCache() {
  if (localEnvCache) return localEnvCache

  const cache = {}
  const candidates = ['.env.local', '.env']
  for (const fileName of candidates) {
    const filePath = path.join(process.cwd(), fileName)
    if (!fs.existsSync(filePath)) continue
    try {
      const text = fs.readFileSync(filePath, 'utf8')
      const parsed = parseEnvText(text)
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in cache)) {
          cache[key] = value
        }
      }
    } catch {
      // ignore malformed or unreadable local env file
    }
  }

  localEnvCache = cache
  return localEnvCache
}

function getRuntimeEnv(name) {
  const direct = normalizeEnvValue(process.env[name])
  if (direct) return direct
  return loadLocalEnvCache()[name] || ''
}

/**
 * 獲取 Supabase Admin Client
 *
 * 後端始終使用 service_role key 來操作 Supabase，可以繞過 RLS。
 * 權限控制在後端 API 層面進行（透過 getAuthUser 認證 + owner_id 過濾）。
 *
 * 為什麼不需要 user client？
 * - 前端不直接連接 Supabase（安全）
 * - 後端已經有認證機制（getAuthUser）
 * - 後端使用 owner_id 來控制資料存取
 * - RLS 會干擾後端操作，造成不必要的錯誤
 */
export function getSupabaseAdmin() {
  const supabaseUrl = getRuntimeEnv('SUPABASE_URL')
  const serviceRoleKey = getRuntimeEnv('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase server credentials are missing')
  }

  // 如果 client 太舊，重新建立
  const now = Date.now()
  if (cachedClient && clientCreatedAt && (now - clientCreatedAt > CLIENT_MAX_AGE)) {
    console.log('🔄 Supabase client 已超過 5 分鐘，重新建立')
    cachedClient = null
    clientCreatedAt = null
  }

  if (!cachedClient) {
    console.log('🆕 建立新的 Supabase admin client')
    cachedClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      },
      db: {
        schema: 'public'
      },
      global: {
        headers: {
          'X-Client-Info': 'redpen-ai-server'
        }
      }
    })
    clientCreatedAt = now
  }

  return cachedClient
}

/**
 * 強制重新建立 Supabase client（當發生連線錯誤時使用）
 */
export function resetSupabaseClient() {
  console.log('♻️ 強制重置 Supabase client')
  cachedClient = null
  clientCreatedAt = null
}

export function getSupabaseUrl() {
  return getRuntimeEnv('SUPABASE_URL')
}

export function getSupabaseServiceRoleKey() {
  return getRuntimeEnv('SUPABASE_SERVICE_ROLE_KEY')
}
