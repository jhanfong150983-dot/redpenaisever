import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import { runAiPipeline } from '../../server/ai/orchestrator.js'
import { MODEL_FLASH } from '../../server/ai/model-config.js'

const PENDING_TTL_MINUTES = 30
const TAG_QUIET_MINUTES = 5
const TAG_MAX_WAIT_MINUTES = 30
const TAG_MIN_SAMPLE_COUNT = 5
const TAG_TOP_ISSUES = 50
const TAG_LIMIT = 8
// 2026-05-21: model 由 model-config.js 統一管理（admin tag aggregation 用 FLASH 即可）
// orchestrator 內 executeSinglePipelineCall 會依 routeKey 再查一次、這裡只是 label
const TAG_MODEL = MODEL_FLASH
const TAG_PROMPT_VERSION = 'v1.0'
const DICT_MERGE_QUIET_MINUTES = 10
const DICT_MERGE_MIN_LABELS = 4
const DICT_MERGE_MAX_LABELS = 120
const DICT_MERGE_MODEL = TAG_MODEL
const DICT_MERGE_PROMPT_VERSION = 'v1.0'
const DOMAIN_AGG_MODEL = 'rule'
const DOMAIN_AGG_PROMPT_VERSION = 'v1.0'
const ABILITY_MODEL = TAG_MODEL
const ABILITY_PROMPT_VERSION = 'v1.0'
const ABILITY_TAG_LIMIT = 60
const ABILITY_MIN_TAGS = 4

function parseJsonBody(req, res) {
  const body = req.body
  if (!body) return null
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' })
      return null
    }
  }
  return body
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return null
  if (parsed <= 0) return null
  return parsed
}

function parseOptionalInt(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function parseNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return null
  if (parsed < 0) return null
  return parsed
}

function parseOptionalDateTime(value) {
  if (value === null || value === undefined || value === '') return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function parseBooleanParam(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
    if (normalized === '0' || normalized === 'false') return false
  }
  return fallback
}

/**
 * Supabase 預設每次查詢最多回傳 1000 筆。
 * 此函式自動分頁撈取所有資料。
 * @param {Function} queryFn - 接收 (from, to) 並回傳 supabase query builder 的函式
 * @param {number} pageSize - 每頁筆數，預設 1000
 * @returns {Promise<Array>} 所有資料
 */
async function fetchAllRows(queryFn, pageSize = 1000) {
  const all = []
  let from = 0
  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await queryFn(from, to)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return all
}

function resolveAction(req) {
  const actionParam = req.query?.action
  if (Array.isArray(actionParam)) {
    return actionParam[0] || ''
  }
  if (typeof actionParam === 'string') return actionParam
  const pathname = req.url ? req.url.split('?')[0] : ''
  const segments = pathname.split('/').filter(Boolean)
  return segments[segments.length - 1] || ''
}

function getPendingCutoffIso() {
  return new Date(Date.now() - PENDING_TTL_MINUTES * 60 * 1000).toISOString()
}

function normalizePermissionTier(value) {
  if (value === 'basic' || value === 'advanced') return value
  return null
}

function normalizeRole(value) {
  if (value === 'admin' || value === 'user') return value
  return null
}

function normalizeTagLabel(label) {
  if (!label) return ''
  return String(label).replace(/\s+/g, '').trim().toLowerCase()
}

function normalizeAbilityLabel(label) {
  if (!label) return ''
  return String(label).replace(/\s+/g, '').trim().toLowerCase()
}

function normalizeIssueText(text) {
  if (!text) return ''
  return String(text).replace(/\s+/g, ' ').trim()
}

function addMinutesIso(date, minutes) {
  const base = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(base.getTime())) return null
  return new Date(base.getTime() + minutes * 60 * 1000).toISOString()
}

function logTagAggregation(message, meta) {
  if (meta !== undefined) {
    console.log(`[tag-agg] ${message}`, meta)
    return
  }
  console.log(`[tag-agg] ${message}`)
}

function extractJsonFromText(text) {
  const match = String(text).match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function parseGradingResult(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') return raw
  return null
}

function extractIssuesFromGrading(grading) {
  if (!grading) return []
  const mistakes = Array.isArray(grading.mistakes) ? grading.mistakes : []
  if (mistakes.length > 0) {
    return mistakes
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const reason = item.reason || ''
        const question = item.question || ''
        return [reason, question].filter(Boolean).join(' ')
      })
      .map(normalizeIssueText)
      .filter((text) => text.length > 0)
  }
  const weaknesses = Array.isArray(grading.weaknesses) ? grading.weaknesses : []
  return weaknesses.map(normalizeIssueText).filter((text) => text.length > 0)
}

function buildIssueStats(submissions) {
  const issueMap = new Map()

  submissions.forEach((submission) => {
    const grading = parseGradingResult(submission.grading_result)
    const issues = extractIssuesFromGrading(grading)
    if (!issues.length) return

    const ownerKey = submission.student_id || submission.id
    const uniqueIssues = new Set(issues)
    uniqueIssues.forEach((issue) => {
      if (!issueMap.has(issue)) issueMap.set(issue, new Set())
      const bucket = issueMap.get(issue)
      if (bucket && ownerKey) bucket.add(ownerKey)
    })
  })

  return Array.from(issueMap.entries())
    .map(([issue, set]) => ({ issue, count: set.size }))
    .sort((a, b) => b.count - a.count)
}

function getSystemApiKey() {
  const normalized =
    getEnvValue('SYSTEM_GEMINI_API_KEY') || getEnvValue('SECRET_API_KEY')
  if (!normalized) {
    console.error('[admin] API key missing diagnostics:', {
      cwd: process.cwd(),
      hasSecretApiKeyEnv: typeof process.env.SECRET_API_KEY === 'string',
      secretApiKeyLength: String(process.env.SECRET_API_KEY || '').length,
      hasSystemApiKeyEnv: typeof process.env.SYSTEM_GEMINI_API_KEY === 'string',
      systemApiKeyLength: String(process.env.SYSTEM_GEMINI_API_KEY || '').length,
      hasSecretApiKeyLocal: Boolean(getEnvValue('SECRET_API_KEY')),
      hasSystemApiKeyLocal: Boolean(getEnvValue('SYSTEM_GEMINI_API_KEY'))
    })
  }
  return normalized
}

async function callGeminiText(prompt, options = {}) {
  const apiKey = getSystemApiKey()
  if (!apiKey) {
    throw new Error('Server API Key missing')
  }

  const routeKey = typeof options.routeKey === 'string'
    ? options.routeKey
    : 'admin.tag_aggregation'
  const model = typeof options.model === 'string' && options.model.trim()
    ? options.model.trim()
    : TAG_MODEL
  const pipelineResult = await runAiPipeline({
    apiKey,
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    requestedRouteKey: routeKey,
    routeHint: {
      source: 'admin'
    }
  })

  const data = pipelineResult.data
  const ok = Number(pipelineResult.status) >= 200 && Number(pipelineResult.status) < 300

  if (!ok) {
    const message = data?.error?.message || data?.error || 'Gemini request failed'
    throw new Error(message)
  }

  const output = (data?.candidates ?? [])
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()

  if (!output) {
    throw new Error('Gemini response empty')
  }

  return output
}

function buildTagPrompt(issueStats, dictionaryLabels) {
  const issueLines = issueStats
    .map((item) => `- ${item.issue}｜${item.count}人`)
    .join('\n')
  const dictionaryText = dictionaryLabels.length
    ? dictionaryLabels.join('、')
    : '（尚無）'

  return `你是教學分析助理。請根據以下「錯誤現象清單」聚類成 4~8 個高階錯誤標籤，標籤需為繁體中文且 2~6 字，不要包含題目細節。
若與既有標籤相近，請沿用既有標籤字樣；若沒有適合者可新增。
請只輸出 JSON，格式如下：
{"tags":[{"label":"標籤","count":12,"examples":["示例1","示例2"]}]}

既有標籤：
${dictionaryText}

錯誤現象清單：
${issueLines}
`
}

function buildDictionaryMergePrompt(items) {
  const lines = items
    .map(
      (item) => `- ${item.label}｜${item.total}次｜${item.assignments}份作業`
    )
    .join('\n')

  return `你是教學標籤整理助理。請將下列標籤中「相同或非常相似」者合併為同一群組，避免合併不同概念。
合併時請選擇清楚、通用且存在清單中的標籤作為 canonical。
若沒有可合併者，請輸出空陣列。
請只輸出 JSON，格式如下：
{"groups":[{"canonical":"標籤","members":["標籤A","標籤B"]}]}

標籤清單（格式：標籤｜總次數｜作業數）：
${lines}
`
}

function buildAbilityPrompt(tags, abilityLabels) {
  const tagLines = tags
    .map((item) => `- ${item.label}｜${item.total}次｜${item.assignments}份作業`)
    .join('\n')
  const abilityText = abilityLabels.length
    ? abilityLabels.join('、')
    : '（尚無）'

  return `你是教學能力分類助理。請將以下標籤歸類到「能力類別」(2~6 字)，每個標籤請對應 1 個能力類別。
若與既有能力類別相近，請沿用既有名稱；若沒有適合者可新增。
請只輸出 JSON，格式如下：
{"abilities":[{"label":"能力"}],"mappings":[{"tag":"標籤","ability":"能力","confidence":0.82}]}

既有能力類別：
${abilityText}

標籤清單（標籤｜總次數｜作業數）：
${tagLines}
`
}

async function requireAdmin(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }

  const supabaseAdmin = getSupabaseAdmin()
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (error) {
    res.status(500).json({ error: '讀取使用者權限失敗' })
    return null
  }

  if (profile?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }

  return { user, supabaseAdmin }
}

async function requireAdminOrCron(req, res) {
  const cronSecret = process.env.CRON_SECRET
  const headerSecret = req.headers['x-cron-secret']
  const authHeader = req.headers.authorization || req.headers.Authorization

  const bearerToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : ''

  if (
    cronSecret &&
    ((headerSecret && headerSecret === cronSecret) ||
      (bearerToken && bearerToken === cronSecret))
  ) {
    return { user: null, supabaseAdmin: getSupabaseAdmin(), isCron: true }
  }

  return requireAdmin(req, res)
}

async function hasOrderLedger(supabaseAdmin, userId, orderId) {
  const { data, error } = await supabaseAdmin
    .from('ink_ledger')
    .select('id')
    .eq('user_id', userId)
    .eq('reason', 'order_paid')
    .contains('metadata', { orderId })
    .limit(1)

  if (error) {
    throw new Error('讀取點數紀錄失敗')
  }

  return (data ?? []).length > 0
}

// ========== USERS ==========
async function handleUsers(req, res, supabaseAdmin) {
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, name, avatar_url, role, permission_tier, ink_balance, admin_note, created_at, updated_at')
      .order('created_at', { ascending: false })

    if (error) {
      res.status(500).json({ error: '讀取使用者清單失敗' })
      return
    }

    res.status(200).json({ users: data ?? [] })
    return
  }

  if (req.method === 'PATCH') {
    const payload = parseJsonBody(req, res)
    if (!payload) return

    const {
      userId,
      role,
      role_manual: roleManual,
      permission_tier: permissionTier,
      ink_balance: inkBalance,
      ink_balance_delta: inkBalanceDelta,
      admin_note: adminNote
    } = payload

    if (!userId) {
      res.status(400).json({ error: 'Missing userId' })
      return
    }

    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance')
      .eq('id', userId)
      .maybeSingle()

    if (fetchError) {
      res.status(500).json({ error: '讀取使用者資料失敗' })
      return
    }

    if (!profile) {
      res.status(404).json({ error: '使用者不存在' })
      return
    }

    const updates = { updated_at: new Date().toISOString() }
    const nextRole = normalizeRole(role)
    const nextTier = normalizePermissionTier(permissionTier)

    if (nextRole) updates.role = nextRole
    if (nextTier) updates.permission_tier = nextTier
    if (typeof adminNote === 'string') updates.admin_note = adminNote

    // role_manual：admin 手動指定身分（teacher/student/both/parent/...）。傳空字串或 null 清除覆寫
    if (roleManual !== undefined) {
      const allowed = ['admin', 'teacher', 'student', 'both', 'parent', 'school_admin', 'registered_inactive', 'unknown_inert']
      if (roleManual === null || roleManual === '') {
        updates.role_manual = null
      } else if (typeof roleManual === 'string' && allowed.includes(roleManual)) {
        updates.role_manual = roleManual
      } else {
        res.status(400).json({ error: '無效的 role_manual 值' })
        return
      }
    }

    let ledgerEntry = null
    const currentBalance = typeof profile.ink_balance === 'number' ? profile.ink_balance : 0

    if (typeof inkBalanceDelta === 'number' && Number.isFinite(inkBalanceDelta)) {
      const nextBalance = Math.max(0, currentBalance + inkBalanceDelta)
      updates.ink_balance = nextBalance
      ledgerEntry = {
        user_id: userId,
        delta: nextBalance - currentBalance,
        reason: 'admin_adjustment',
        metadata: { before: currentBalance, after: nextBalance }
      }
    } else if (typeof inkBalance === 'number' && Number.isFinite(inkBalance)) {
      const nextBalance = Math.max(0, Math.floor(inkBalance))
      updates.ink_balance = nextBalance
      ledgerEntry = {
        user_id: userId,
        delta: nextBalance - currentBalance,
        reason: 'admin_set_balance',
        metadata: { before: currentBalance, after: nextBalance }
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)

    if (updateError) {
      res.status(500).json({ error: '更新使用者資料失敗' })
      return
    }

    if (ledgerEntry && ledgerEntry.delta !== 0) {
      const { error: ledgerError } = await supabaseAdmin
        .from('ink_ledger')
        .insert(ledgerEntry)
      if (ledgerError) {
        res.status(500).json({ error: '寫入點數紀錄失敗' })
        return
      }
    }

    res.status(200).json({ success: true })
    return
  }

  if (req.method === 'DELETE') {
    const payload = parseJsonBody(req, res)
    if (!payload) return

    const { userId } = payload
    if (!userId) {
      res.status(400).json({ error: 'Missing userId' })
      return
    }

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (error) {
      res.status(500).json({ error: error.message || '刪除使用者失敗' })
      return
    }

    res.status(200).json({ success: true })
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

// ========== INK-ORDERS - PACKAGES ==========
async function handlePackages(req, res, supabaseAdmin) {
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('ink_packages')
      .select(
        'id, drops, label, description, bonus_drops, starts_at, ends_at, sort_order, is_active, created_at, updated_at'
      )
      .order('sort_order', { ascending: true })
      .order('drops', { ascending: true })

    if (error) {
      res.status(500).json({ error: '讀取方案失敗' })
      return
    }

    res.status(200).json({ packages: data ?? [] })
    return
  }

  const payload = parseJsonBody(req, res)
  if (!payload && req.method !== 'DELETE') return

  if (req.method === 'POST') {
    const drops = parsePositiveInt(payload.drops)
    const label =
      typeof payload.label === 'string' ? payload.label.trim() : ''
    const description =
      typeof payload.description === 'string' ? payload.description.trim() : null
    const sortOrder = parseOptionalInt(payload.sortOrder) ?? 0
    const bonusInput = payload.bonusDrops ?? ''
    const bonusDrops =
      bonusInput === '' || bonusInput === null ? 0 : parseNonNegativeInt(bonusInput)
    const startsAt = parseOptionalDateTime(payload.startsAt)
    const endsAt = parseOptionalDateTime(payload.endsAt)
    const isActive = parseBoolean(payload.isActive, true)

    if (!drops) {
      res.status(400).json({ error: '請輸入有效的滴數' })
      return
    }
    if (!label) {
      res.status(400).json({ error: '請輸入方案名稱' })
      return
    }
    if (bonusDrops === null) {
      res.status(400).json({ error: '請輸入有效的贈送滴數' })
      return
    }
    if (startsAt === undefined || endsAt === undefined) {
      res.status(400).json({ error: '請輸入有效的方案期間' })
      return
    }
    if (startsAt && endsAt && new Date(startsAt) >= new Date(endsAt)) {
      res.status(400).json({ error: '開始時間不可晚於結束時間' })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('ink_packages')
      .insert({
        drops,
        label,
        description,
        bonus_drops: bonusDrops,
        starts_at: startsAt,
        ends_at: endsAt,
        sort_order: sortOrder,
        is_active: isActive
      })
      .select(
        'id, drops, label, description, bonus_drops, starts_at, ends_at, sort_order, is_active, created_at, updated_at'
      )
      .single()

    if (error) {
      res.status(500).json({ error: '建立方案失敗' })
      return
    }

    res.status(200).json({ package: data })
    return
  }

  if (req.method === 'PATCH') {
    const id = parsePositiveInt(payload.id)
    if (!id) {
      res.status(400).json({ error: 'Missing package id' })
      return
    }

    const updates = {}
    if (payload.drops !== undefined) {
      const drops = parsePositiveInt(payload.drops)
      if (!drops) {
        res.status(400).json({ error: '請輸入有效的滴數' })
        return
      }
      updates.drops = drops
    }
    if (payload.label !== undefined) {
      const label = typeof payload.label === 'string' ? payload.label.trim() : ''
      if (!label) {
        res.status(400).json({ error: '請輸入方案名稱' })
        return
      }
      updates.label = label
    }
    if (payload.description !== undefined) {
      updates.description =
        typeof payload.description === 'string'
          ? payload.description.trim()
          : null
    }
    if (payload.bonusDrops !== undefined) {
      const bonusInput = payload.bonusDrops
      const bonusDrops =
        bonusInput === '' || bonusInput === null ? 0 : parseNonNegativeInt(bonusInput)
      if (bonusDrops === null) {
        res.status(400).json({ error: '請輸入有效的贈送滴數' })
        return
      }
      updates.bonus_drops = bonusDrops
    }
    if (payload.startsAt !== undefined) {
      const startsAt = parseOptionalDateTime(payload.startsAt)
      if (startsAt === undefined) {
        res.status(400).json({ error: '請輸入有效的開始時間' })
        return
      }
      updates.starts_at = startsAt
    }
    if (payload.endsAt !== undefined) {
      const endsAt = parseOptionalDateTime(payload.endsAt)
      if (endsAt === undefined) {
        res.status(400).json({ error: '請輸入有效的結束時間' })
        return
      }
      updates.ends_at = endsAt
    }
    if (payload.sortOrder !== undefined) {
      const sortOrder = parseOptionalInt(payload.sortOrder)
      if (sortOrder === null) {
        res.status(400).json({ error: '請輸入有效的排序' })
        return
      }
      updates.sort_order = sortOrder
    }
    if (payload.isActive !== undefined) {
      updates.is_active = parseBoolean(payload.isActive, true)
    }

    if (
      updates.starts_at !== undefined ||
      updates.ends_at !== undefined
    ) {
      const { data: current, error: currentError } = await supabaseAdmin
        .from('ink_packages')
        .select('starts_at, ends_at')
        .eq('id', id)
        .maybeSingle()
      if (currentError) {
        res.status(500).json({ error: '讀取方案失敗' })
        return
      }
      const nextStartsAt =
        updates.starts_at !== undefined ? updates.starts_at : current?.starts_at
      const nextEndsAt =
        updates.ends_at !== undefined ? updates.ends_at : current?.ends_at
      if (nextStartsAt && nextEndsAt && new Date(nextStartsAt) >= new Date(nextEndsAt)) {
        res.status(400).json({ error: '開始時間不可晚於結束時間' })
        return
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: '沒有可更新的欄位' })
      return
    }

    const { data, error } = await supabaseAdmin
      .from('ink_packages')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select(
        'id, drops, label, description, bonus_drops, starts_at, ends_at, sort_order, is_active, created_at, updated_at'
      )
      .single()

    if (error) {
      res.status(500).json({ error: '更新方案失敗' })
      return
    }

    res.status(200).json({ package: data })
    return
  }

  if (req.method === 'DELETE') {
    const queryId = Array.isArray(req.query?.id) ? req.query?.id[0] : req.query?.id
    let targetId = parsePositiveInt(queryId)
    if (!targetId) {
      const body = parseJsonBody(req, res)
      targetId = parsePositiveInt(body?.id)
    }
    if (!targetId) {
      res.status(400).json({ error: 'Missing package id' })
      return
    }

    const { error } = await supabaseAdmin
      .from('ink_packages')
      .delete()
      .eq('id', targetId)

    if (error) {
      res.status(500).json({ error: '刪除方案失敗' })
      return
    }

    res.status(200).json({ success: true })
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

// ========== INK-ORDERS ==========
async function handleInkOrders(req, res, supabaseAdmin, adminUser) {
  if (req.method === 'GET') {
    const cutoffIso = getPendingCutoffIso()
    const nowIso = new Date().toISOString()
    const { error: expireError } = await supabaseAdmin
      .from('ink_orders')
      .update({ status: 'cancelled', updated_at: nowIso })
      .eq('status', 'pending')
      .lt('created_at', cutoffIso)

    if (expireError) {
      console.warn('Expire pending orders failed:', expireError)
    }

    const { data, error } = await supabaseAdmin
      .from('ink_orders')
      .select(
        'id, user_id, drops, bonus_drops, amount_twd, status, provider, provider_txn_id, package_id, package_label, package_description, created_at, updated_at'
      )
      .order('created_at', { ascending: false })

    if (error) {
      res.status(500).json({ error: '讀取訂單失敗' })
      return
    }

    const orders = data ?? []
    const userIds = Array.from(new Set(orders.map((order) => order.user_id))).filter(
      Boolean
    )

    const profilesMap = new Map()
    if (userIds.length > 0) {
      const { data: profiles, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id, email, name, ink_balance')
        .in('id', userIds)

      if (profileError) {
        res.status(500).json({ error: '讀取使用者資料失敗' })
        return
      }

      for (const profile of profiles || []) {
        profilesMap.set(profile.id, profile)
      }
    }

    const payload = orders.map((order) => ({
      ...order,
      user: profilesMap.get(order.user_id) || null
    }))

    res.status(200).json({ orders: payload })
    return
  }

  if (req.method === 'PATCH') {
    const payload = parseJsonBody(req, res)
    if (!payload) return

    const orderId = parsePositiveInt(payload.orderId)
    const status = typeof payload.status === 'string' ? payload.status : null

    if (!orderId) {
      res.status(400).json({ error: 'Missing orderId' })
      return
    }

    if (!status || !['paid', 'cancelled'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' })
      return
    }

    const { data: order, error } = await supabaseAdmin
      .from('ink_orders')
      .select(
        'id, user_id, drops, bonus_drops, status, amount_twd, provider, provider_txn_id, package_id, package_label, package_description'
      )
      .eq('id', orderId)
      .maybeSingle()

    if (error) {
      res.status(500).json({ error: '讀取訂單失敗' })
      return
    }

    if (!order) {
      res.status(404).json({ error: '訂單不存在' })
      return
    }

    const hasLedger = await hasOrderLedger(supabaseAdmin, order.user_id, order.id)

    if (status === 'cancelled') {
      if (hasLedger) {
        res.status(400).json({ error: '訂單已加點,不可取消' })
        return
      }

      if (order.status !== 'cancelled') {
        const { error: cancelError } = await supabaseAdmin
          .from('ink_orders')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', order.id)

        if (cancelError) {
          res.status(500).json({ error: '更新訂單狀態失敗' })
          return
        }
      }

      res.status(200).json({ success: true })
      return
    }

    let balanceAfter = null
    if (!hasLedger) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('ink_balance')
        .eq('id', order.user_id)
        .maybeSingle()

      if (profileError) {
        res.status(500).json({ error: '讀取使用者點數失敗' })
        return
      }

      const currentBalance =
        typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0
      const bonusDrops =
        typeof order.bonus_drops === 'number' && order.bonus_drops > 0
          ? order.bonus_drops
          : 0
      const totalDrops = order.drops + bonusDrops
      balanceAfter = currentBalance + totalDrops

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
          ink_balance: balanceAfter,
          updated_at: new Date().toISOString()
        })
        .eq('id', order.user_id)

      if (updateError) {
        res.status(500).json({ error: '更新使用者點數失敗' })
        return
      }

      const { error: ledgerError } = await supabaseAdmin.from('ink_ledger').insert({
        user_id: order.user_id,
        delta: totalDrops,
        reason: 'order_paid',
        metadata: {
          orderId: order.id,
          provider: order.provider,
          amountTwd: order.amount_twd,
          baseDrops: order.drops,
          bonusDrops,
          totalDrops,
          packageId: order.package_id,
          packageLabel: order.package_label,
          packageDescription: order.package_description,
          adminId: adminUser.id,
          balanceBefore: currentBalance,
          balanceAfter
        }
      })

      if (ledgerError) {
        res.status(500).json({ error: '寫入點數紀錄失敗' })
        return
      }
    }

    if (order.status !== 'paid') {
      const { error: paidError } = await supabaseAdmin
        .from('ink_orders')
        .update({ status: 'paid', updated_at: new Date().toISOString() })
        .eq('id', order.id)

      if (paidError) {
        res.status(500).json({ error: '更新訂單狀態失敗' })
        return
      }
    }

    res.status(200).json({ success: true, balanceAfter })
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

// ========== TAG DICTIONARY / OVERRIDES ==========
async function handleTags(req, res, supabaseAdmin) {
  const ownerIdParam = Array.isArray(req.query?.ownerId)
    ? req.query?.ownerId[0]
    : req.query?.ownerId
  const assignmentIdParam = Array.isArray(req.query?.assignmentId)
    ? req.query?.assignmentId[0]
    : req.query?.assignmentId
  const ownerId =
    typeof ownerIdParam === 'string' && ownerIdParam.trim()
      ? ownerIdParam.trim()
      : null
  const assignmentId =
    typeof assignmentIdParam === 'string' && assignmentIdParam.trim()
      ? assignmentIdParam.trim()
      : null

  if (req.method === 'GET') {
    try {
      const dictionaryQuery = supabaseAdmin
        .from('tag_dictionary')
        .select(
          'id, owner_id, label, normalized_label, status, merged_to_tag_id, created_at, updated_at'
        )
        .order('updated_at', { ascending: false })
      if (ownerId) dictionaryQuery.eq('owner_id', ownerId)

      const stateQuery = supabaseAdmin
        .from('assignment_tag_state')
        .select(
          'owner_id, assignment_id, status, sample_count, last_event_at, next_run_at, last_generated_at, manual_locked, updated_at'
        )
        .order('last_event_at', { ascending: false })
      if (ownerId) stateQuery.eq('owner_id', ownerId)
      if (assignmentId) stateQuery.eq('assignment_id', assignmentId)

      const [dictionaryResult, stateResult] = await Promise.all([
        dictionaryQuery,
        stateQuery
      ])

      if (dictionaryResult.error) {
        throw new Error(dictionaryResult.error.message)
      }
      if (stateResult.error) {
        throw new Error(stateResult.error.message)
      }

      const states = stateResult.data ?? []
      const assignmentIds = Array.from(
        new Set(states.map((row) => row.assignment_id).filter(Boolean))
      )

      const assignmentsResult =
        assignmentIds.length > 0
          ? await supabaseAdmin
              .from('assignments')
              .select('id, title, domain, owner_id, updated_at')
              .in('id', assignmentIds)
          : { data: [], error: null }

      if (assignmentsResult.error) {
        throw new Error(assignmentsResult.error.message)
      }

      const aggregatesResult =
        assignmentIds.length > 0
          ? await supabaseAdmin
              .from('assignment_tag_aggregates')
              .select(
                'owner_id, assignment_id, tag_label, tag_count, examples, model, prompt_version, generated_at'
              )
              .in('assignment_id', assignmentIds)
          : { data: [], error: null }

      if (aggregatesResult.error) {
        throw new Error(aggregatesResult.error.message)
      }

      const dictionaryRows = dictionaryResult.data ?? []
      const dictionaryById = new Map(
        dictionaryRows.map((row) => [row.id, row])
      )
      const canonicalByNormalized = new Map()

      dictionaryRows.forEach((row) => {
        const normalized = row.normalized_label || normalizeTagLabel(row.label)
        if (!normalized) return
        let canonicalNormalized = normalized
        if (row.merged_to_tag_id) {
          const canonicalRow = dictionaryById.get(row.merged_to_tag_id)
          if (canonicalRow) {
            canonicalNormalized =
              canonicalRow.normalized_label ||
              normalizeTagLabel(canonicalRow.label)
          }
        }
        canonicalByNormalized.set(normalized, canonicalNormalized)
      })

      const aggregates = aggregatesResult.data ?? []
      const usageMap = new Map()
      const aggregatesByAssignment = {}

      aggregates.forEach((row) => {
        const assignmentKey = row.assignment_id
        if (!assignmentKey) return
        if (!aggregatesByAssignment[assignmentKey]) {
          aggregatesByAssignment[assignmentKey] = []
        }
        aggregatesByAssignment[assignmentKey].push({
          label: row.tag_label,
          count: Number(row.tag_count) || 0,
          examples: Array.isArray(row.examples) ? row.examples : undefined,
          source: row.model === 'manual' ? 'manual' : 'ai',
          generatedAt: row.generated_at
        })

        const normalized = normalizeTagLabel(row.tag_label)
        if (!normalized) return
        const canonicalNormalized =
          canonicalByNormalized.get(normalized) || normalized
        const ownerKey = row.owner_id
          ? `${row.owner_id}:${canonicalNormalized}`
          : canonicalNormalized
        if (!usageMap.has(ownerKey)) {
          usageMap.set(ownerKey, { assignments: new Set(), total: 0 })
        }
        const entry = usageMap.get(ownerKey)
        entry.assignments.add(assignmentKey)
        entry.total += Number(row.tag_count) || 0
      })

      const dictionary = dictionaryRows.map((row) => {
        const normalized = row.normalized_label || normalizeTagLabel(row.label)
        const canonicalNormalized =
          canonicalByNormalized.get(normalized) || normalized
        const ownerKey = row.owner_id
          ? `${row.owner_id}:${canonicalNormalized}`
          : canonicalNormalized
        const usage = usageMap.get(ownerKey)
        const canonicalRow = row.merged_to_tag_id
          ? dictionaryById.get(row.merged_to_tag_id)
          : null
        const isMerged = row.status === 'merged'
        return {
          ...row,
          merged_to_label: canonicalRow?.label ?? null,
          usage_count: isMerged ? 0 : usage ? usage.assignments.size : 0,
          total_count: isMerged ? 0 : usage ? usage.total : 0
        }
      })

      const assignmentMap = new Map(
        (assignmentsResult.data ?? []).map((row) => [row.id, row])
      )

      const assignments = states.map((row) => {
        const assignment = assignmentMap.get(row.assignment_id)
        return {
          owner_id: row.owner_id,
          assignment_id: row.assignment_id,
          title: assignment?.title ?? '',
          domain: assignment?.domain ?? '',
          status: row.status,
          sample_count: row.sample_count ?? 0,
          last_event_at: row.last_event_at,
          next_run_at: row.next_run_at,
          last_generated_at: row.last_generated_at,
          manual_locked: row.manual_locked ?? false,
          updated_at: row.updated_at,
          assignment_updated_at: assignment?.updated_at ?? null
        }
      })

      res.status(200).json({
        dictionary,
        assignments,
        aggregates: aggregatesByAssignment
      })
      return
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取標籤資料失敗'
      })
      return
    }
  }

  const payload = parseJsonBody(req, res)
  if (!payload) return

  if (req.method === 'PATCH') {
    const id = payload.id
    if (!id) {
      res.status(400).json({ error: 'Missing tag id' })
      return
    }

    const updates = { updated_at: new Date().toISOString() }
    const label =
      typeof payload.label === 'string' ? payload.label.trim() : ''
    const status =
      typeof payload.status === 'string' ? payload.status.trim() : ''
    const hasMergeField =
      Object.prototype.hasOwnProperty.call(payload, 'mergedToTagId') ||
      Object.prototype.hasOwnProperty.call(payload, 'merged_to_tag_id')
    let mergedToTagId = null
    if (typeof payload.mergedToTagId === 'string') {
      mergedToTagId = payload.mergedToTagId.trim() || null
    } else if (typeof payload.merged_to_tag_id === 'string') {
      mergedToTagId = payload.merged_to_tag_id.trim() || null
    }

    if (label) {
      updates.label = label
      updates.normalized_label = normalizeTagLabel(label)
    }
    if (status) {
      updates.status = status
    }
    if (hasMergeField) {
      updates.merged_to_tag_id = mergedToTagId
    }

    const { data, error } = await supabaseAdmin
      .from('tag_dictionary')
      .update(updates)
      .eq('id', id)
      .select(
        'id, owner_id, label, normalized_label, status, merged_to_tag_id, created_at, updated_at'
      )
      .single()

    if (error) {
      res.status(500).json({ error: error.message || '更新標籤失敗' })
      return
    }

    res.status(200).json({ tag: data })
    return
  }

  if (req.method === 'POST') {
    const intent =
      typeof payload.intent === 'string' ? payload.intent.trim() : ''

    if (intent === 'override') {
      const ownerIdValue =
        typeof payload.ownerId === 'string' ? payload.ownerId.trim() : ''
      const assignmentIdValue =
        typeof payload.assignmentId === 'string'
          ? payload.assignmentId.trim()
          : ''
      if (!ownerIdValue || !assignmentIdValue) {
        res.status(400).json({ error: 'Missing ownerId or assignmentId' })
        return
      }

      const tags = Array.isArray(payload.tags) ? payload.tags : []
      const normalizedTags = tags
        .map((tag) => {
          const label =
            typeof tag?.label === 'string'
              ? tag.label.trim()
              : typeof tag?.tag === 'string'
                ? tag.tag.trim()
                : ''
          if (!label) return null
          const count = Number.parseInt(String(tag?.count ?? tag?.value ?? 0), 10)
          if (!Number.isFinite(count) || count <= 0) return null
          const examples = Array.isArray(tag?.examples)
            ? tag.examples
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter((item) => item.length > 0)
                .slice(0, 2)
            : undefined
          return { label, count, examples }
        })
        .filter(Boolean)

      if (!normalizedTags.length) {
        res.status(400).json({ error: '請輸入至少一個標籤' })
        return
      }

      const manualLocked = parseBooleanParam(
        payload.manualLocked ?? payload.locked,
        true
      )
      const nowIso = new Date().toISOString()

      const { data: stateRow } = await supabaseAdmin
        .from('assignment_tag_state')
        .select('sample_count')
        .eq('owner_id', ownerIdValue)
        .eq('assignment_id', assignmentIdValue)
        .maybeSingle()

      const sampleCount = stateRow?.sample_count ?? null

      const { data: dictionaryRows, error: dictionaryError } =
        await supabaseAdmin
          .from('tag_dictionary')
          .select('id, label, normalized_label')
          .eq('owner_id', ownerIdValue)

      if (dictionaryError) {
        res.status(500).json({ error: dictionaryError.message })
        return
      }

      const dictionaryMap = new Map(
        (dictionaryRows ?? []).map((row) => [
          row.normalized_label || normalizeTagLabel(row.label),
          row
        ])
      )

      const newDictionaryRows = []
      normalizedTags.forEach((tag) => {
        const normalizedLabel = normalizeTagLabel(tag.label)
        if (!dictionaryMap.has(normalizedLabel)) {
          newDictionaryRows.push({
            owner_id: ownerIdValue,
            label: tag.label,
            normalized_label: normalizedLabel,
            status: 'active',
            created_at: nowIso,
            updated_at: nowIso
          })
        }
      })

      if (newDictionaryRows.length > 0) {
        const insertResult = await supabaseAdmin
          .from('tag_dictionary')
          .insert(newDictionaryRows)

        if (insertResult.error) {
          res.status(500).json({ error: insertResult.error.message })
          return
        }
      }

      await supabaseAdmin
        .from('assignment_tag_aggregates')
        .delete()
        .eq('owner_id', ownerIdValue)
        .eq('assignment_id', assignmentIdValue)

      const aggregateRows = normalizedTags.map((tag) => ({
        owner_id: ownerIdValue,
        assignment_id: assignmentIdValue,
        tag_label: tag.label,
        tag_count: tag.count,
        examples: tag.examples ?? null,
        generated_at: nowIso,
        model: 'manual',
        prompt_version: 'manual',
        updated_at: nowIso
      }))

      const insertResult = await supabaseAdmin
        .from('assignment_tag_aggregates')
        .insert(aggregateRows)

      if (insertResult.error) {
        res.status(500).json({ error: insertResult.error.message })
        return
      }

      const stateUpdate = {
        owner_id: ownerIdValue,
        assignment_id: assignmentIdValue,
        status: 'ready',
        sample_count: sampleCount,
        last_generated_at: nowIso,
        manual_locked: manualLocked,
        dirty: false,
        model: 'manual',
        prompt_version: 'manual',
        updated_at: nowIso,
        next_run_at: manualLocked ? null : undefined
      }

      const { error: stateError } = await supabaseAdmin
        .from('assignment_tag_state')
        .upsert(stateUpdate, { onConflict: 'owner_id,assignment_id' })

      if (stateError) {
        res.status(500).json({ error: stateError.message })
        return
      }

      try {
        const { data: assignmentRow, error: assignmentError } =
          await supabaseAdmin
            .from('assignments')
            .select('domain')
            .eq('id', assignmentIdValue)
            .eq('owner_id', ownerIdValue)
            .maybeSingle()

        if (assignmentError) {
          throw new Error(assignmentError.message)
        }

        const domain = assignmentRow?.domain || 'uncategorized'
        await refreshDomainTagAggregates(supabaseAdmin, ownerIdValue, domain)
      } catch (err) {
        console.error('[tag-agg] domain aggregate error', {
          assignmentId: assignmentIdValue,
          message: err instanceof Error ? err.message : 'domain aggregate failed'
        })
      }

      res.status(200).json({ success: true })
      return
    }

    if (intent === 'aggregate_layers') {
      const ownerIdValue =
        typeof payload.ownerId === 'string' ? payload.ownerId.trim() : ''
      const scope =
        typeof payload.scope === 'string' ? payload.scope.trim() : ''
      const includeReady =
        scope === 'all' ||
        parseBooleanParam(payload.forceAll ?? payload.rebuild, false)
      const ownerIds = new Set()
      if (ownerIdValue) ownerIds.add(ownerIdValue)

      const stateQuery = supabaseAdmin
        .from('assignment_tag_state')
        .select('*')

      if (ownerIdValue) stateQuery.eq('owner_id', ownerIdValue)
      if (includeReady) {
        stateQuery.in('status', [
          'pending',
          'ready',
          'failed',
          'insufficient_samples'
        ])
      } else {
        stateQuery.eq('status', 'pending')
      }

      const { data: pendingStates, error: pendingError } = await stateQuery
      if (pendingError) {
        res.status(500).json({ error: pendingError.message })
        return
      }

      const assignmentResults = []
      for (const stateRow of pendingStates || []) {
        if (stateRow.owner_id) ownerIds.add(stateRow.owner_id)
        try {
          const result = await aggregateAssignmentTags(supabaseAdmin, stateRow)
          assignmentResults.push({
            assignmentId: stateRow.assignment_id,
            ok: true,
            ...result
          })
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : 'aggregate failed'
          await supabaseAdmin
            .from('assignment_tag_state')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('owner_id', stateRow.owner_id)
            .eq('assignment_id', stateRow.assignment_id)

          assignmentResults.push({
            assignmentId: stateRow.assignment_id,
            ok: false,
            error: errorMessage
          })
        }
      }

      if (!ownerIdValue && ownerIds.size === 0) {
        const { data: ownerRows, error: ownerError } = await supabaseAdmin
          .from('tag_dictionary')
          .select('owner_id')

        if (ownerError) {
          res.status(500).json({ error: ownerError.message })
          return
        }

        ;(ownerRows || []).forEach((row) => {
          if (row.owner_id) ownerIds.add(row.owner_id)
        })
      }

      if (!ownerIdValue && ownerIds.size === 0) {
        const { data: stateOwners, error: stateOwnerError } =
          await supabaseAdmin.from('assignment_tag_state').select('owner_id')

        if (stateOwnerError) {
          res.status(500).json({ error: stateOwnerError.message })
          return
        }

        ;(stateOwners || []).forEach((row) => {
          if (row.owner_id) ownerIds.add(row.owner_id)
        })
      }

      const ownerList = Array.from(ownerIds)
      const domainResults = []
      for (const ownerIdEntry of ownerList) {
        try {
          const result = await refreshDomainAggregatesForOwner(
            supabaseAdmin,
            ownerIdEntry
          )
          domainResults.push({ ownerId: ownerIdEntry, ok: true, ...result })
        } catch (err) {
          domainResults.push({
            ownerId: ownerIdEntry,
            ok: false,
            error: err instanceof Error ? err.message : 'domain aggregate failed'
          })
        }
      }

      const abilityResults = []
      for (const ownerIdEntry of ownerList) {
        try {
          const result = await updateAbilityMappingForOwner(
            supabaseAdmin,
            ownerIdEntry
          )
          abilityResults.push({ ownerId: ownerIdEntry, ok: true, ...result })
        } catch (err) {
          abilityResults.push({
            ownerId: ownerIdEntry,
            ok: false,
            error: err instanceof Error ? err.message : 'ability aggregate failed'
          })
        }
      }

      res.status(200).json({
        success: true,
        processedAssignments: assignmentResults.length,
        assignments: assignmentResults,
        owners: ownerList,
        domainResults,
        abilityResults
      })
      return
    }

    if (intent === 'unlock') {
      const ownerIdValue =
        typeof payload.ownerId === 'string' ? payload.ownerId.trim() : ''
      const assignmentIdValue =
        typeof payload.assignmentId === 'string'
          ? payload.assignmentId.trim()
          : ''
      if (!ownerIdValue || !assignmentIdValue) {
        res.status(400).json({ error: 'Missing ownerId or assignmentId' })
        return
      }

      const { error } = await supabaseAdmin
        .from('assignment_tag_state')
        .update({ manual_locked: false, updated_at: new Date().toISOString() })
        .eq('owner_id', ownerIdValue)
        .eq('assignment_id', assignmentIdValue)

      if (error) {
        res.status(500).json({ error: error.message })
        return
      }

      res.status(200).json({ success: true })
      return
    }

    res.status(400).json({ error: 'Unknown intent' })
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

// ========== USER STATS ==========
async function handleUserStats(req, res, supabaseAdmin) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // 1. 從 profiles_with_inferred_role view 撈取（含 inferred_role / effective_role / 訊號旗標）
    //    分類規則的 SSoT 在 view，這裡只負責 join 統計
    const allProfiles = await fetchAllRows((from, to) =>
      supabaseAdmin
        .from('profiles_with_inferred_role')
        .select('id, email, name, avatar_url, role, role_manual, permission_tier, ink_balance, created_at, updated_at, inferred_role, effective_role, owns_classroom, owns_assignment, has_teacher_pref, imported_students, synced_campus, bound_as_student, acted_as_student, has_external_identity')
        .order('created_at', { ascending: false })
        .range(from, to)
    )

    // 2-6. 批量查詢統計資料（平行執行）— 全部使用分頁撈取
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const [
      classroomStatsData,
      studentListData,
      assignmentStatsData,
      submissionStatsData,
      inkStatsData,
      classroomNamesData,
    ] = await Promise.all([
      fetchAllRows((from, to) => supabaseAdmin.from('classrooms').select('owner_id').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('students').select('id, name, owner_id, classroom_id').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('assignments').select('owner_id').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('submissions').select('owner_id, student_id, graded_at, created_at').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('ink_ledger').select('user_id, delta').lt('delta', 0).gte('created_at', thirtyDaysAgo).range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('classrooms').select('id, name').range(from, to)),
    ])

    // 全部 profile 都回傳，讓前端依 effective_role 切 tab
    const users = allProfiles

    // 班級數
    const classroomCountMap = {}
    classroomStatsData.forEach(row => {
      classroomCountMap[row.owner_id] = (classroomCountMap[row.owner_id] || 0) + 1
    })

    // 作業數
    const assignmentCountMap = {}
    assignmentStatsData.forEach(row => {
      assignmentCountMap[row.owner_id] = (assignmentCountMap[row.owner_id] || 0) + 1
    })

    // 繳交數 / 批改數（以 teacher owner_id 和 student_id 分別統計）
    const submissionCountMap = {}   // by owner_id
    const gradedCountMap = {}       // by owner_id
    const studentSubCountMap = {}   // by student_id
    const studentGradedCountMap = {} // by student_id
    const studentLastActiveMap = {}  // by student_id
    submissionStatsData.forEach(row => {
      submissionCountMap[row.owner_id] = (submissionCountMap[row.owner_id] || 0) + 1
      if (row.graded_at) gradedCountMap[row.owner_id] = (gradedCountMap[row.owner_id] || 0) + 1
      if (row.student_id) {
        studentSubCountMap[row.student_id] = (studentSubCountMap[row.student_id] || 0) + 1
        if (row.graded_at) studentGradedCountMap[row.student_id] = (studentGradedCountMap[row.student_id] || 0) + 1
        const ts = row.created_at || row.graded_at
        if (ts && (!studentLastActiveMap[row.student_id] || ts > studentLastActiveMap[row.student_id])) {
          studentLastActiveMap[row.student_id] = ts
        }
      }
    })

    // 墨水消耗
    const inkUsedMap = {}
    inkStatsData.forEach(row => {
      inkUsedMap[row.user_id] = (inkUsedMap[row.user_id] || 0) + Math.abs(row.delta)
    })

    // 班級名稱 map
    const classroomNameMap = {}
    classroomNamesData.forEach(c => { classroomNameMap[c.id] = c.name })

    // 學生列表 by owner_id
    const studentsByOwner = {}
    studentListData.forEach(s => {
      if (!studentsByOwner[s.owner_id]) studentsByOwner[s.owner_id] = []
      studentsByOwner[s.owner_id].push({
        studentId: s.id,
        studentName: s.name || '未命名',
        classroomName: classroomNameMap[s.classroom_id] || '',
        submissionCount: studentSubCountMap[s.id] || 0,
        gradedCount: studentGradedCountMap[s.id] || 0,
        lastActiveAt: studentLastActiveMap[s.id] || null,
      })
    })

    // 組合 user 資料（全部非 admin 帳號 + 角色推導）
    const userStats = (users || [])
      .map(user => {
        const classroomCount = classroomCountMap[user.id] || 0
        const students = (studentsByOwner[user.id] || [])
          .sort((a, b) => b.submissionCount - a.submissionCount)
        const submissionCount = submissionCountMap[user.id] || 0
        const gradedCount = gradedCountMap[user.id] || 0

        // status: active=有班級的教師, new=尚未建立班級的新註冊用戶
        const status = classroomCount > 0 ? 'active' : 'new'

        return {
          userId: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatar_url,
          inkBalance: user.ink_balance || 0,
          role: user.role || 'user',
          roleManual: user.role_manual || null,
          inferredRole: user.inferred_role,
          effectiveRole: user.effective_role,
          permissionTier: user.permission_tier || 'basic',
          createdAt: user.created_at,
          updatedAt: user.updated_at,
          classroomCount,
          studentCount: students.length,
          assignmentCount: assignmentCountMap[user.id] || 0,
          submissionCount,
          gradedCount,
          gradingProgress: submissionCount > 0 ? Math.round((gradedCount / submissionCount) * 100) : 0,
          totalInkUsed: inkUsedMap[user.id] || 0,
          lastActiveAt: user.updated_at,
          students,
          status,
          isAlsoStudent: user.effective_role === 'both',
          roleSignals: {
            ownsClassroom: user.owns_classroom,
            ownsAssignment: user.owns_assignment,
            hasTeacherPref: user.has_teacher_pref,
            importedStudents: user.imported_students,
            syncedCampus: user.synced_campus,
            boundAsStudent: user.bound_as_student,
            actedAsStudent: user.acted_as_student,
            hasExternalIdentity: user.has_external_identity,
          },
        }
      })

    res.status(200).json({ users: userStats })
  } catch (err) {
    console.error('Error fetching user stats:', err)
    res.status(500).json({ error: '取得使用者統計資料失敗' })
  }
}

// ========== USER DETAIL ==========
async function handleUserDetail(req, res, supabaseAdmin) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const userId = req.query.userId
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' })
  }

  try {
    // 1. 用户基本信息
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (profileError) throw profileError
    if (!profile) {
      return res.status(404).json({ error: 'User not found' })
    }

    // 2. 班级列表（带学生数统计）
    const { data: classrooms, error: classroomsError } = await supabaseAdmin
      .from('classrooms')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })

    if (classroomsError) throw classroomsError

    const classroomIds = classrooms?.map(c => c.id) || []

    let studentCountMap = {}
    if (classroomIds.length > 0) {
      const { data: studentCounts } = await supabaseAdmin
        .from('students')
        .select('classroom_id')
        .in('classroom_id', classroomIds)

      studentCounts?.forEach(s => {
        studentCountMap[s.classroom_id] = (studentCountMap[s.classroom_id] || 0) + 1
      })
    }

    const classroomsWithStats = classrooms?.map(c => ({
      ...c,
      studentCount: studentCountMap[c.id] || 0
    }))

    // 3. 作业列表（带提交统计）
    const { data: assignments, error: assignmentsError } = await supabaseAdmin
      .from('assignments')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(100)  // 限制返回最近100个作业

    if (assignmentsError) throw assignmentsError

    const assignmentIds = assignments?.map(a => a.id) || []

    let submissionStats = {}
    if (assignmentIds.length > 0) {
      const { data: submissions } = await supabaseAdmin
        .from('submissions')
        .select('assignment_id, graded_at')
        .in('assignment_id', assignmentIds)

      submissions?.forEach(sub => {
        if (!submissionStats[sub.assignment_id]) {
          submissionStats[sub.assignment_id] = { total: 0, graded: 0 }
        }
        submissionStats[sub.assignment_id].total++
        if (sub.graded_at) {
          submissionStats[sub.assignment_id].graded++
        }
      })
    }

    const assignmentsWithStats = assignments?.map(a => ({
      ...a,
      submissionCount: submissionStats[a.id]?.total || 0,
      gradedCount: submissionStats[a.id]?.graded || 0,
      gradingProgress: submissionStats[a.id]?.total > 0
        ? Math.round((submissionStats[a.id].graded / submissionStats[a.id].total) * 100)
        : 0
    }))

    // 4. 墨水消耗记录（最近50条）
    const { data: inkLedger, error: inkLedgerError } = await supabaseAdmin
      .from('ink_ledger')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (inkLedgerError) throw inkLedgerError

    res.status(200).json({
      profile,
      classrooms: classroomsWithStats || [],
      assignments: assignmentsWithStats || [],
      inkLedger: inkLedger || []
    })
  } catch (err) {
    console.error('Error fetching user detail:', err)
    res.status(500).json({ error: '获取用户详细信息失败' })
  }
}

// ========== ANALYTICS ==========
async function handleAnalytics(req, res, supabaseAdmin) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // ── 平行批次撈取所有原始資料（分頁撈取，避免 1000 筆上限） ──────────────
    const [
      allProfiles,
      allClassrooms,
      allStudents,
      allSubmissions,
      inkLedgerAll,
      inkLedger30d,
      allOrders,
      packageStatsData,
      recentInkLedgerResult,
      studentAuthUserData,
    ] = await Promise.all([
      fetchAllRows((from, to) => supabaseAdmin.from('profiles').select('id, email, name, avatar_url, ink_balance, permission_tier, created_at').neq('role', 'admin').order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('classrooms').select('id, name, owner_id').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('students').select('id, name, owner_id, classroom_id').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('submissions').select('student_id, owner_id, graded_at, created_at').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('ink_ledger').select('user_id, delta, reason, created_at').range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('ink_ledger').select('user_id, delta, reason, created_at').gte('created_at', thirtyDaysAgo).range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('ink_orders').select('id, user_id, status, amount_twd, package_id, package_label, drops, bonus_drops, created_at').order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabaseAdmin.from('ink_orders').select('package_id, package_label, drops, bonus_drops').eq('status', 'paid').not('package_id', 'is', null).range(from, to)),
      // 最近 50 筆 ink_ledger 不需分頁（已有 limit）
      supabaseAdmin.from('ink_ledger').select('id, user_id, delta, reason, metadata, created_at, profiles:user_id(email,name)').order('created_at', { ascending: false }).limit(50),
      // 撈取學生帳號 ID，用於區分教師與學生
      fetchAllRows((from, to) => supabaseAdmin.from('students').select('auth_user_id').not('auth_user_id', 'is', null).range(from, to)),
    ])

    // 只過濾「純學生」：在 students.auth_user_id 中、且沒任何教師訊號
    // 雙重身份（老師＋學生）保留為老師統計
    const studentAuthUserIds = new Set(studentAuthUserData.map(s => s.auth_user_id))
    const teacherActivityIds = new Set()
    allClassrooms.forEach(c => { if (c.owner_id) teacherActivityIds.add(c.owner_id) })
    allSubmissions.forEach(s => { if (s.owner_id) teacherActivityIds.add(s.owner_id) })
    const allTeachers = allProfiles.filter(p => {
      if (!studentAuthUserIds.has(p.id)) return true
      if (teacherActivityIds.has(p.id)) return true
      if (p.permission_tier === 'advanced') return true
      return false
    })

    // ── 基礎 map ─────────────────────────────────────────────────────────────
    const teacherNameMap = {}
    allTeachers.forEach(t => { teacherNameMap[t.id] = t.name })
    const classroomNameMap = {}
    const classroomOwnerMap = {}
    allClassrooms.forEach(c => { classroomNameMap[c.id] = c.name; classroomOwnerMap[c.id] = c.owner_id })

    // 教師有哪些班級
    const teacherClassroomCountMap = {}
    allClassrooms.forEach(c => {
      teacherClassroomCountMap[c.owner_id] = (teacherClassroomCountMap[c.owner_id] || 0) + 1
    })

    // 教師有哪些學生
    const teacherStudentCountMap = {}
    allStudents.forEach(s => {
      teacherStudentCountMap[s.owner_id] = (teacherStudentCountMap[s.owner_id] || 0) + 1
    })

    // 教師有哪些作業（需再撈一次或從 submissions 推算）
    // 用 submissions 推算每位教師的作業數（assignment 層面無資料，略）

    // ── ═══════════════ 教師儀表板 ═══════════════ ──

    // 教師成長趨勢（30天）
    const teacherGrowthMap = {}
    allTeachers.filter(t => t.created_at >= thirtyDaysAgo).forEach(t => {
      const date = t.created_at.split('T')[0]
      teacherGrowthMap[date] = (teacherGrowthMap[date] || 0) + 1
    })
    const dailyTeacherGrowth = Object.entries(teacherGrowthMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 每日活躍教師數（有 AI 使用扣點：delta < 0，30天）
    const dailyActiveTeacherMap = {}
    inkLedger30d.filter(r => r.delta < 0).forEach(r => {
      const date = r.created_at.split('T')[0]
      if (!dailyActiveTeacherMap[date]) dailyActiveTeacherMap[date] = new Set()
      dailyActiveTeacherMap[date].add(r.user_id)
    })
    const dailyActiveTeachers = Object.entries(dailyActiveTeacherMap)
      .map(([date, set]) => ({ date, count: set.size }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 教師參與率（曾有 AI 使用扣點 / 總教師數）
    const teachersWhoGraded = new Set(inkLedgerAll.filter(r => r.delta < 0).map(r => r.user_id))
    const teachersWithClassrooms = allTeachers.filter(t => (teacherClassroomCountMap[t.id] || 0) > 0)
    const teacherParticipationRate = teachersWithClassrooms.length > 0
      ? Math.round((teachersWhoGraded.size / teachersWithClassrooms.length) * 100) : 0

    // 活躍度排名（30天墨水消耗）
    const teacherInkUsed30d = {}
    inkLedger30d.filter(r => r.delta < 0).forEach(r => {
      teacherInkUsed30d[r.user_id] = (teacherInkUsed30d[r.user_id] || 0) + Math.abs(r.delta)
    })
    const topActiveTeachers = allTeachers
      .map(t => ({ id: t.id, name: t.name, email: t.email, inkUsed30d: teacherInkUsed30d[t.id] || 0 }))
      .filter(t => t.inkUsed30d > 0)
      .sort((a, b) => b.inkUsed30d - a.inkUsed30d)
      .slice(0, 10)

    // 最近註冊教師（只含有班級的帳號）
    const recentTeachers = allTeachers
      .filter(t => t.created_at >= thirtyDaysAgo && (teacherClassroomCountMap[t.id] || 0) > 0)
      .slice(0, 10)

    // 平均每位教師的班級/學生數
    const teacherCount = teachersWithClassrooms.length || 1
    const avgClassroomsPerTeacher = Math.round((allClassrooms.length / teacherCount) * 10) / 10
    const avgStudentsPerTeacher = Math.round((allStudents.length / teacherCount) * 10) / 10

    // ── ═══════════════ 學生儀表板 ═══════════════ ──

    // 學生繳交統計 maps
    const stuSubCountMap = {}
    const stuGradedCountMap = {}
    allSubmissions.forEach(row => {
      if (!row.student_id) return
      stuSubCountMap[row.student_id] = (stuSubCountMap[row.student_id] || 0) + 1
      if (row.graded_at) stuGradedCountMap[row.student_id] = (stuGradedCountMap[row.student_id] || 0) + 1
    })

    const totalStudents = allStudents.length
    const activeStudents = allStudents.filter(s => (stuSubCountMap[s.id] || 0) > 0).length
    const neverSubmitted = totalStudents - activeStudents
    const totalSubCount = Object.values(stuSubCountMap).reduce((a, b) => a + b, 0)
    const totalGradedCount = Object.values(stuGradedCountMap).reduce((a, b) => a + b, 0)
    const avgSubmissionsPerStudent = totalStudents > 0 ? Math.round((totalSubCount / totalStudents) * 10) / 10 : 0
    const submissionRate = totalStudents > 0 ? Math.round((activeStudents / totalStudents) * 100) : 0
    const gradingCompletionRate = totalSubCount > 0 ? Math.round((totalGradedCount / totalSubCount) * 100) : 0

    // 每日活躍學生趨勢（30天，distinct student per day）
    const dailyStudentMap = {}
    allSubmissions
      .filter(s => s.student_id && s.created_at >= thirtyDaysAgo)
      .forEach(s => {
        const date = s.created_at.split('T')[0]
        if (!dailyStudentMap[date]) dailyStudentMap[date] = new Set()
        dailyStudentMap[date].add(s.student_id)
      })
    const dailyActiveStudents = Object.entries(dailyStudentMap)
      .map(([date, set]) => ({ date, count: set.size }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 繳交峰值時段（24h，UTC+8）
    const submissionByHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }))
    allSubmissions.forEach(s => {
      if (!s.created_at) return
      const utcHour = new Date(s.created_at).getUTCHours()
      const localHour = (utcHour + 8) % 24
      submissionByHour[localHour].count++
    })

    // Top 10 活躍學生
    const topActiveStudents = allStudents
      .map(s => ({
        name: s.name || '未命名',
        teacherName: teacherNameMap[s.owner_id] || '',
        classroomName: classroomNameMap[s.classroom_id] || '',
        submissionCount: stuSubCountMap[s.id] || 0,
        gradedCount: stuGradedCountMap[s.id] || 0,
      }))
      .filter(s => s.submissionCount > 0)
      .sort((a, b) => b.submissionCount - a.submissionCount)
      .slice(0, 10)

    // ── ═══════════════ 墨水儀表板 ═══════════════ ──

    // 每日墨水消耗趨勢（30天）
    const dailyInkMap = {}
    inkLedger30d.filter(r => r.delta < 0).forEach(r => {
      const date = r.created_at.split('T')[0]
      dailyInkMap[date] = (dailyInkMap[date] || 0) + Math.abs(r.delta)
    })
    const dailyInkConsumption = Object.entries(dailyInkMap)
      .map(([date, consumed]) => ({ date, consumed }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 累計發放 vs 消耗
    const totalInkDistributed = inkLedgerAll.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0)
    const totalInkConsumed = inkLedgerAll.filter(r => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0)
    const totalInkBalance = totalInkDistributed - totalInkConsumed

    // 訂單處理
    const paidOrders = allOrders.filter(o => o.status === 'paid')
    const recentOrders30d = allOrders.filter(o => o.created_at >= thirtyDaysAgo)
    const totalRevenue = paidOrders.reduce((s, o) => s + (o.amount_twd || 0), 0)
    const recentRevenue = recentOrders30d.filter(o => o.status === 'paid').reduce((s, o) => s + (o.amount_twd || 0), 0)

    const ordersByStatus = {
      paid: recentOrders30d.filter(o => o.status === 'paid').length,
      pending: recentOrders30d.filter(o => o.status === 'pending').length,
      cancelled: recentOrders30d.filter(o => o.status === 'cancelled').length,
    }

    const dailyOrderMap = {}
    recentOrders30d.filter(o => o.status === 'paid').forEach(o => {
      const date = o.created_at.split('T')[0]
      if (!dailyOrderMap[date]) dailyOrderMap[date] = { count: 0, revenue: 0 }
      dailyOrderMap[date].count++
      dailyOrderMap[date].revenue += o.amount_twd || 0
    })
    const dailyOrderTrend = Object.entries(dailyOrderMap)
      .map(([date, d]) => ({ date, ...d }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 熱門方案
    const packageSalesMap = {}
    packageStatsData.forEach(o => {
      const key = o.package_id
      if (!packageSalesMap[key]) packageSalesMap[key] = { package_id: o.package_id, package_label: o.package_label, drops: o.drops, bonus_drops: o.bonus_drops, sales_count: 0 }
      packageSalesMap[key].sales_count++
    })
    const topPackages = Object.values(packageSalesMap).sort((a, b) => b.sales_count - a.sales_count).slice(0, 5)

    // 付費轉換率、平均客單價
    const payingTeacherIds = new Set(paidOrders.map(o => o.user_id).filter(Boolean))
    const payingTeacherRate = teachersWithClassrooms.length > 0
      ? Math.round((payingTeacherIds.size / teachersWithClassrooms.length) * 100) : 0
    const avgOrderValue = paidOrders.length > 0 ? Math.round(totalRevenue / paidOrders.length) : 0

    // ── 組合回傳 ─────────────────────────────────────────────────────────────
    return res.status(200).json({
      teacherDashboard: {
        dailyTeacherGrowth,
        dailyActiveTeachers,
        teacherParticipationRate,
        topActiveTeachers,
        recentTeachers,
        totalTeachers: teachersWithClassrooms.length,
        avgClassroomsPerTeacher,
        avgStudentsPerTeacher,
      },
      studentDashboard: {
        totalStudents,
        activeStudents,
        neverSubmitted,
        submissionRate,
        gradingCompletionRate,
        avgSubmissionsPerStudent,
        dailyActiveStudents,
        submissionByHour,
        topActiveStudents,
      },
      inkDashboard: {
        totalInkDistributed,
        totalInkConsumed,
        totalInkBalance,
        totalRevenue,
        recentRevenue,
        dailyInkConsumption,
        dailyOrderTrend,
        ordersByStatus,
        topPackages,
        payingTeacherRate,
        avgOrderValue,
        totalOrders: paidOrders.length,
        recentInkLedger: recentInkLedgerResult.data || [],
      },
    })

  } catch (error) {
    console.error('Analytics error:', error)
    return res.status(500).json({ error: '取得統計資料失敗' })
  }
}

async function finalizeAssignmentTagState(
  supabaseAdmin,
  ownerId,
  assignmentId,
  nowIso,
  sampleCount,
  model,
  promptVersion
) {
  const { data: latest, error } = await supabaseAdmin
    .from('assignment_tag_state')
    .select('dirty, last_event_at')
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }

  const baseUpdate = {
    sample_count: sampleCount,
    last_generated_at: nowIso,
    model,
    prompt_version: promptVersion,
    updated_at: nowIso,
    dirty: false
  }

  if (latest?.dirty) {
    const lastEventAt = latest.last_event_at || nowIso
    const nextRunAt = addMinutesIso(lastEventAt, TAG_QUIET_MINUTES)
    const result = await supabaseAdmin
      .from('assignment_tag_state')
      .update({
        ...baseUpdate,
        status: 'pending',
        window_started_at: lastEventAt,
        next_run_at: nextRunAt ?? undefined
      })
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)

    if (result.error) {
      throw new Error(result.error.message)
    }
    return
  }

  const result = await supabaseAdmin
    .from('assignment_tag_state')
    .update({
      ...baseUpdate,
      status: 'ready'
    })
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)

  if (result.error) {
    throw new Error(result.error.message)
  }
}

async function getDictionaryUsageMap(supabaseAdmin, ownerId) {
  const { data: aggregates, error } = await supabaseAdmin
    .from('assignment_tag_aggregates')
    .select('tag_label, tag_count, assignment_id')
    .eq('owner_id', ownerId)

  if (error) {
    throw new Error(error.message)
  }

  const usageMap = new Map()
  ;(aggregates || []).forEach((row) => {
    const normalized = normalizeTagLabel(row.tag_label)
    if (!normalized) return
    if (!usageMap.has(normalized)) {
      usageMap.set(normalized, { assignments: new Set(), total: 0 })
    }
    const bucket = usageMap.get(normalized)
    if (bucket) {
      if (row.assignment_id) bucket.assignments.add(row.assignment_id)
      bucket.total += Number(row.tag_count) || 0
    }
  })

  return usageMap
}

async function touchDictionaryMergeState(supabaseAdmin, ownerId, nowIso) {
  if (!ownerId) return
  const nextRunAt = addMinutesIso(nowIso, DICT_MERGE_QUIET_MINUTES)
  const { error } = await supabaseAdmin
    .from('tag_dictionary_state')
    .upsert(
      {
        owner_id: ownerId,
        status: 'pending',
        next_run_at: nextRunAt,
        error_message: null,
        updated_at: nowIso
      },
      { onConflict: 'owner_id' }
    )

  if (error) {
    throw new Error(error.message)
  }
}

async function mergeDictionaryForOwner(supabaseAdmin, ownerId) {
  if (!ownerId) {
    throw new Error('Missing owner_id for dictionary merge')
  }
  const nowIso = new Date().toISOString()
  const { data: dictionaryRows, error } = await supabaseAdmin
    .from('tag_dictionary')
    .select('id, label, normalized_label, status, merged_to_tag_id')
    .eq('owner_id', ownerId)
    .eq('status', 'active')

  if (error) {
    throw new Error(error.message)
  }

  const activeRows = dictionaryRows || []
  if (activeRows.length < DICT_MERGE_MIN_LABELS) {
    return { skipped: 'insufficient_labels', labelCount: activeRows.length }
  }
  if (activeRows.length > DICT_MERGE_MAX_LABELS) {
    return { skipped: 'too_many_labels', labelCount: activeRows.length }
  }

  const usageMap = await getDictionaryUsageMap(supabaseAdmin, ownerId)
  const items = activeRows.map((row) => {
    const normalized = row.normalized_label || normalizeTagLabel(row.label)
    const usage = usageMap.get(normalized)
    return {
      label: row.label,
      total: usage ? usage.total : 0,
      assignments: usage ? usage.assignments.size : 0
    }
  })

  const prompt = buildDictionaryMergePrompt(items)
  logTagAggregation('dict_merge_request', { ownerId, count: items.length })
  const responseText = await callGeminiText(prompt)
  logTagAggregation('dict_merge_response', {
    ownerId,
    length: responseText.length
  })
  const parsed = extractJsonFromText(responseText)
  const rawGroups = Array.isArray(parsed?.groups) ? parsed.groups : []

  const idByNormalized = new Map()
  const rowById = new Map()
  activeRows.forEach((row) => {
    const normalized = row.normalized_label || normalizeTagLabel(row.label)
    if (!normalized) return
    idByNormalized.set(normalized, row)
    rowById.set(row.id, row)
  })

  const groups = rawGroups
    .map((group) => {
      const canonical =
        typeof group?.canonical === 'string' ? group.canonical.trim() : ''
      const members = Array.isArray(group?.members)
        ? group.members
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter((item) => item.length > 0)
        : []
      if (!canonical || members.length === 0) return null
      if (
        !members.some(
          (item) => normalizeTagLabel(item) === normalizeTagLabel(canonical)
        )
      ) {
        members.unshift(canonical)
      }
      const uniqueMembers = Array.from(new Set(members))
      if (uniqueMembers.length < 2) return null
      return { canonical, members: uniqueMembers }
    })
    .filter(Boolean)

  if (!groups.length) {
    await updateAbilityMappingForOwner(supabaseAdmin, ownerId)
    return { merged: false, groups: 0, labelCount: items.length }
  }

  const canonicalIds = new Set()
  const mergeUpdates = []
  const mergedMemberIds = new Set()

  for (const group of groups) {
    const canonicalNormalized = normalizeTagLabel(group.canonical)
    if (!canonicalNormalized) continue
    let canonicalRow = idByNormalized.get(canonicalNormalized)
    if (!canonicalRow) {
      const insertResult = await supabaseAdmin
        .from('tag_dictionary')
        .insert({
          owner_id: ownerId,
          label: group.canonical,
          normalized_label: canonicalNormalized,
          status: 'active',
          created_at: nowIso,
          updated_at: nowIso
        })
        .select('id, label, normalized_label')
        .single()

      if (insertResult.error) {
        throw new Error(insertResult.error.message)
      }
      canonicalRow = insertResult.data
      idByNormalized.set(canonicalNormalized, canonicalRow)
      rowById.set(canonicalRow.id, canonicalRow)
    }

    canonicalIds.add(canonicalRow.id)

    group.members.forEach((member) => {
      const memberNormalized = normalizeTagLabel(member)
      if (!memberNormalized || memberNormalized === canonicalNormalized) return
      const memberRow = idByNormalized.get(memberNormalized)
      if (!memberRow) return
      if (mergedMemberIds.has(memberRow.id)) return
      mergedMemberIds.add(memberRow.id)
      mergeUpdates.push({
        id: memberRow.id,
        merged_to_tag_id: canonicalRow.id
      })
    })
  }

  if (canonicalIds.size > 0) {
    const { error: canonicalError } = await supabaseAdmin
      .from('tag_dictionary')
      .update({
        status: 'active',
        merged_to_tag_id: null,
        updated_at: nowIso
      })
      .in('id', Array.from(canonicalIds))

    if (canonicalError) {
      throw new Error(canonicalError.message)
    }
  }

  if (mergeUpdates.length > 0) {
    const { error: mergeError } = await supabaseAdmin
      .from('tag_dictionary')
      .upsert(
        mergeUpdates.map((item) => ({
          id: item.id,
          status: 'merged',
          merged_to_tag_id: item.merged_to_tag_id,
          updated_at: nowIso
        }))
      )

    if (mergeError) {
      throw new Error(mergeError.message)
    }
  }

  await updateAbilityMappingForOwner(supabaseAdmin, ownerId)

  return {
    merged: true,
    groups: groups.length,
    mergedCount: mergeUpdates.length,
    canonicalCount: canonicalIds.size
  }
}

async function processDictionaryMergeQueue(
  supabaseAdmin,
  ownerIds = null,
  force = false
) {
  const nowIso = new Date().toISOString()
  const stateQuery = supabaseAdmin
    .from('tag_dictionary_state')
    .select('owner_id, status, next_run_at')
    .eq('status', 'pending')

  if (Array.isArray(ownerIds) && ownerIds.length > 0) {
    stateQuery.in('owner_id', ownerIds)
  }

  const { data: states, error } = await stateQuery
  if (error) {
    throw new Error(error.message)
  }

  const nowMs = Date.now()
  const dueStates = (states || []).filter((row) => {
    if (force) return true
    if (!row.next_run_at) return true
    const nextRunAtMs = Date.parse(row.next_run_at)
    return Number.isFinite(nextRunAtMs) && nowMs >= nextRunAtMs
  })

  const results = []
  for (const stateRow of dueStates) {
    const runningUpdate = await supabaseAdmin
      .from('tag_dictionary_state')
      .update({ status: 'running', error_message: null, updated_at: nowIso })
      .eq('owner_id', stateRow.owner_id)
      .eq('status', 'pending')

    if (runningUpdate.error) {
      results.push({
        ownerId: stateRow.owner_id,
        ok: false,
        error: runningUpdate.error.message
      })
      continue
    }

    try {
      const mergeResult = await mergeDictionaryForOwner(
        supabaseAdmin,
        stateRow.owner_id
      )
      await supabaseAdmin
        .from('tag_dictionary_state')
        .update({
          status: 'idle',
          last_merged_at: nowIso,
          model: DICT_MERGE_MODEL,
          prompt_version: DICT_MERGE_PROMPT_VERSION,
          error_message: null,
          updated_at: nowIso
        })
        .eq('owner_id', stateRow.owner_id)

      results.push({ ownerId: stateRow.owner_id, ok: true, ...mergeResult })
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'merge failed'
      await supabaseAdmin
        .from('tag_dictionary_state')
        .update({
          status: 'failed',
          error_message: errorMessage,
          updated_at: nowIso
        })
        .eq('owner_id', stateRow.owner_id)

      results.push({
        ownerId: stateRow.owner_id,
        ok: false,
        error: errorMessage
      })
    }
  }

  return results
}

async function refreshDomainTagAggregates(supabaseAdmin, ownerId, domain) {
  if (!ownerId || !domain) return
  const nowIso = new Date().toISOString()

  const assignmentQuery = supabaseAdmin
    .from('assignments')
    .select('id')
    .eq('owner_id', ownerId)

  if (domain === 'uncategorized') {
    assignmentQuery.or('domain.is.null,domain.eq.uncategorized')
  } else {
    assignmentQuery.eq('domain', domain)
  }

  const { data: assignmentRows, error: assignmentError } =
    await assignmentQuery

  if (assignmentError) {
    throw new Error(assignmentError.message)
  }

  const assignmentIds = (assignmentRows || [])
    .map((row) => row.id)
    .filter(Boolean)

  await supabaseAdmin
    .from('domain_tag_aggregates')
    .delete()
    .eq('owner_id', ownerId)
    .eq('domain', domain)

  if (assignmentIds.length === 0) {
    return
  }

  const { data: tagRows, error: tagError } = await supabaseAdmin
    .from('assignment_tag_aggregates')
    .select('assignment_id, tag_label, tag_count')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)

  if (tagError) {
    throw new Error(tagError.message)
  }

  const { data: stateRows, error: stateError } = await supabaseAdmin
    .from('assignment_tag_state')
    .select('assignment_id, sample_count')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)

  if (stateError) {
    throw new Error(stateError.message)
  }

  const sampleTotal = (stateRows || []).reduce(
    (sum, row) => sum + (Number(row.sample_count) || 0),
    0
  )

  const tagMap = new Map()
  ;(tagRows || []).forEach((row) => {
    const label = row.tag_label
    if (!label) return
    if (!tagMap.has(label)) {
      tagMap.set(label, { total: 0, assignments: new Set() })
    }
    const bucket = tagMap.get(label)
    if (bucket) {
      bucket.total += Number(row.tag_count) || 0
      if (row.assignment_id) bucket.assignments.add(row.assignment_id)
    }
  })

  if (tagMap.size === 0) {
    return
  }

  const rows = Array.from(tagMap.entries()).map(([label, stats]) => ({
    owner_id: ownerId,
    domain,
    tag_label: label,
    tag_count: Math.max(1, Math.round(stats.total)),
    assignment_count: stats.assignments.size,
    sample_count: sampleTotal,
    generated_at: nowIso,
    model: DOMAIN_AGG_MODEL,
    prompt_version: DOMAIN_AGG_PROMPT_VERSION,
    updated_at: nowIso
  }))

  const { error: insertError } = await supabaseAdmin
    .from('domain_tag_aggregates')
    .insert(rows)

  if (insertError) {
    throw new Error(insertError.message)
  }
}

async function refreshDomainAggregatesForOwner(supabaseAdmin, ownerId) {
  if (!ownerId) return { skipped: 'missing_owner', domains: 0, assignments: 0 }

  const { data: assignmentRows, error: assignmentError } = await supabaseAdmin
    .from('assignment_tag_aggregates')
    .select('assignment_id')
    .eq('owner_id', ownerId)

  if (assignmentError) {
    throw new Error(assignmentError.message)
  }

  const assignmentIds = Array.from(
    new Set((assignmentRows || []).map((row) => row.assignment_id).filter(Boolean))
  )

  if (assignmentIds.length === 0) {
    return { skipped: 'no_assignments', domains: 0, assignments: 0 }
  }

  const { data: domainsRows, error: domainsError } = await supabaseAdmin
    .from('assignments')
    .select('id, domain')
    .eq('owner_id', ownerId)
    .in('id', assignmentIds)

  if (domainsError) {
    throw new Error(domainsError.message)
  }

  const domains = new Set()
  ;(domainsRows || []).forEach((row) => {
    domains.add(row.domain || 'uncategorized')
  })

  for (const domain of domains) {
    await refreshDomainTagAggregates(supabaseAdmin, ownerId, domain)
  }

  return { domains: domains.size, assignments: assignmentIds.length }
}

async function updateAbilityMappingForOwner(supabaseAdmin, ownerId) {
  if (!ownerId) return { skipped: 'missing_owner' }
  const nowIso = new Date().toISOString()
  const { data: dictionaryRows, error: dictionaryError } = await supabaseAdmin
    .from('tag_dictionary')
    .select('id, label, normalized_label, status')
    .eq('owner_id', ownerId)
    .eq('status', 'active')

  if (dictionaryError) {
    throw new Error(dictionaryError.message)
  }

  const activeTags = dictionaryRows || []
  if (activeTags.length < ABILITY_MIN_TAGS) {
    return { skipped: 'insufficient_tags', tagCount: activeTags.length }
  }

  const usageMap = await getDictionaryUsageMap(supabaseAdmin, ownerId)
  const tagItems = activeTags
    .map((row) => {
      const normalized = row.normalized_label || normalizeTagLabel(row.label)
      const usage = usageMap.get(normalized)
      return {
        id: row.id,
        label: row.label,
        total: usage ? usage.total : 0,
        assignments: usage ? usage.assignments.size : 0
      }
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, ABILITY_TAG_LIMIT)

  const { data: abilityRows, error: abilityError } = await supabaseAdmin
    .from('ability_dictionary')
    .select('id, label, normalized_label, status')
    .eq('owner_id', ownerId)
    .eq('status', 'active')

  if (abilityError) {
    throw new Error(abilityError.message)
  }

  const abilityLabels = (abilityRows || [])
    .map((row) => row.label)
    .filter(Boolean)
  const prompt = buildAbilityPrompt(tagItems, abilityLabels)
  logTagAggregation('ability_request', { ownerId, count: tagItems.length })
  const responseText = await callGeminiText(prompt)
  logTagAggregation('ability_response', { ownerId, length: responseText.length })
  const parsed = extractJsonFromText(responseText)
  const rawMappings = Array.isArray(parsed?.mappings) ? parsed.mappings : []
  const rawAbilities = Array.isArray(parsed?.abilities) ? parsed.abilities : []

  const abilitySet = new Set(
    rawAbilities
      .map((item) => (typeof item?.label === 'string' ? item.label.trim() : ''))
      .filter(Boolean)
  )

  rawMappings.forEach((item) => {
    const abilityLabel =
      typeof item?.ability === 'string' ? item.ability.trim() : ''
    if (abilityLabel) abilitySet.add(abilityLabel)
  })

  const abilityMap = new Map(
    (abilityRows || []).map((row) => [
      row.normalized_label || normalizeAbilityLabel(row.label),
      row
    ])
  )

  const newAbilityRows = []
  abilitySet.forEach((label) => {
    const normalized = normalizeAbilityLabel(label)
    if (!normalized || abilityMap.has(normalized)) return
    newAbilityRows.push({
      owner_id: ownerId,
      label,
      normalized_label: normalized,
      status: 'active',
      created_at: nowIso,
      updated_at: nowIso
    })
  })

  if (newAbilityRows.length > 0) {
    const insertResult = await supabaseAdmin
      .from('ability_dictionary')
      .insert(newAbilityRows)
      .select('id, label, normalized_label')

    if (insertResult.error) {
      throw new Error(insertResult.error.message)
    }

    ;(insertResult.data || []).forEach((row) => {
      const normalized = row.normalized_label || normalizeAbilityLabel(row.label)
      if (normalized) abilityMap.set(normalized, row)
    })
  }

  const tagIdMap = new Map(
    tagItems.map((item) => [normalizeTagLabel(item.label), item.id])
  )

  const mappingRows = []
  rawMappings.forEach((item) => {
    const tagLabel = typeof item?.tag === 'string' ? item.tag.trim() : ''
    const abilityLabel =
      typeof item?.ability === 'string' ? item.ability.trim() : ''
    if (!tagLabel || !abilityLabel) return
    const tagNormalized = normalizeTagLabel(tagLabel)
    const abilityNormalized = normalizeAbilityLabel(abilityLabel)
    const tagId = tagIdMap.get(tagNormalized)
    const abilityRow = abilityMap.get(abilityNormalized)
    if (!tagId || !abilityRow) return
    const confidence = Number(item?.confidence)
    mappingRows.push({
      owner_id: ownerId,
      tag_id: tagId,
      ability_id: abilityRow.id,
      confidence: Number.isFinite(confidence) ? confidence : null,
      source: 'ai',
      updated_at: nowIso
    })
  })

  await supabaseAdmin.from('tag_ability_map').delete().eq('owner_id', ownerId)

  if (mappingRows.length > 0) {
    const { error: mapError } = await supabaseAdmin
      .from('tag_ability_map')
      .insert(mappingRows)

    if (mapError) {
      throw new Error(mapError.message)
    }
  }

  await refreshAbilityAggregates(supabaseAdmin, ownerId)
  return { mapped: mappingRows.length, abilities: abilitySet.size }
}

async function refreshAbilityAggregates(supabaseAdmin, ownerId) {
  if (!ownerId) return
  const nowIso = new Date().toISOString()

  const { data: mappingRows, error: mappingError } = await supabaseAdmin
    .from('tag_ability_map')
    .select('tag_id, ability_id, confidence')
    .eq('owner_id', ownerId)

  if (mappingError) {
    throw new Error(mappingError.message)
  }

  const { data: tagRows, error: tagError } = await supabaseAdmin
    .from('tag_dictionary')
    .select('id, label, normalized_label')
    .eq('owner_id', ownerId)

  if (tagError) {
    throw new Error(tagError.message)
  }

  const tagLabelById = new Map(
    (tagRows || []).map((row) => [
      row.id,
      row.normalized_label || normalizeTagLabel(row.label)
    ])
  )

  const abilityByTag = new Map()
  ;(mappingRows || []).forEach((row) => {
    const tagNormalized = tagLabelById.get(row.tag_id)
    if (!tagNormalized) return
    abilityByTag.set(tagNormalized, row)
  })

  const { data: aggRows, error: aggError } = await supabaseAdmin
    .from('assignment_tag_aggregates')
    .select('assignment_id, tag_label, tag_count')
    .eq('owner_id', ownerId)

  if (aggError) {
    throw new Error(aggError.message)
  }

  const assignmentIds = Array.from(
    new Set((aggRows || []).map((row) => row.assignment_id).filter(Boolean))
  )

  const { data: assignmentRows, error: assignmentError } = await supabaseAdmin
    .from('assignments')
    .select('id, domain')
    .eq('owner_id', ownerId)
    .in('id', assignmentIds)

  if (assignmentError) {
    throw new Error(assignmentError.message)
  }

  const domainByAssignment = new Map(
    (assignmentRows || []).map((row) => [row.id, row.domain || 'uncategorized'])
  )

  const abilityStats = new Map()
  ;(aggRows || []).forEach((row) => {
    const normalized = normalizeTagLabel(row.tag_label)
    if (!normalized) return
    const mapping = abilityByTag.get(normalized)
    if (!mapping) return
    const abilityId = mapping.ability_id
    if (!abilityStats.has(abilityId)) {
      abilityStats.set(abilityId, {
        total: 0,
        assignments: new Set(),
        domains: new Set()
      })
    }
    const bucket = abilityStats.get(abilityId)
    const confidence = Number(mapping.confidence)
    const weight = Number.isFinite(confidence) ? confidence : 1
    bucket.total += (Number(row.tag_count) || 0) * weight
    if (row.assignment_id) bucket.assignments.add(row.assignment_id)
    if (row.assignment_id) {
      bucket.domains.add(domainByAssignment.get(row.assignment_id) || 'uncategorized')
    }
  })

  await supabaseAdmin
    .from('ability_aggregates')
    .delete()
    .eq('owner_id', ownerId)

  if (abilityStats.size === 0) return

  const rows = Array.from(abilityStats.entries()).map(([abilityId, stats]) => ({
    owner_id: ownerId,
    ability_id: abilityId,
    total_count: Math.max(1, Math.round(stats.total)),
    assignment_count: stats.assignments.size,
    domain_count: stats.domains.size,
    generated_at: nowIso,
    model: ABILITY_MODEL,
    prompt_version: ABILITY_PROMPT_VERSION,
    updated_at: nowIso
  }))

  const { error: insertError } = await supabaseAdmin
    .from('ability_aggregates')
    .insert(rows)

  if (insertError) {
    throw new Error(insertError.message)
  }
}

async function aggregateAssignmentTags(supabaseAdmin, stateRow) {
  const ownerId = stateRow.owner_id
  const assignmentId = stateRow.assignment_id
  const nowIso = new Date().toISOString()
  const startedAt = Date.now()

  logTagAggregation('start', { assignmentId })

  if (!ownerId) {
    throw new Error('Missing owner_id for assignment tag aggregation')
  }

  const { data: assignmentRow, error: assignmentError } = await supabaseAdmin
    .from('assignments')
    .select('domain')
    .eq('id', assignmentId)
    .eq('owner_id', ownerId)
    .maybeSingle()

  if (assignmentError) {
    throw new Error(assignmentError.message)
  }

  const assignmentDomain = assignmentRow?.domain || 'uncategorized'

  if (stateRow.manual_locked) {
    const lockedUpdate = await supabaseAdmin
      .from('assignment_tag_state')
      .update({
        status: 'ready',
        dirty: false,
        updated_at: nowIso
      })
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)

    if (lockedUpdate.error) {
      throw new Error(lockedUpdate.error.message)
    }

    logTagAggregation('manual_locked_skip', {
      assignmentId,
      durationMs: Date.now() - startedAt
    })
    return {
      assignmentId,
      status: 'locked',
      sampleCount: stateRow.sample_count ?? 0
    }
  }

  const runningUpdate = await supabaseAdmin
    .from('assignment_tag_state')
    .update({ status: 'running', updated_at: nowIso })
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)

  if (runningUpdate.error) {
    throw new Error(runningUpdate.error.message)
  }

  const { data: submissions, error: submissionsError } = await supabaseAdmin
    .from('submissions')
    .select('id, student_id, grading_result, status')
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)

  if (submissionsError) {
    throw new Error(submissionsError.message)
  }

  const gradedSubmissions = (submissions || []).filter(
    (row) => row.grading_result !== null || row.status === 'graded'
  )

  const sampleCount = gradedSubmissions.length
  logTagAggregation('samples', {
    assignmentId,
    total: submissions?.length ?? 0,
    graded: sampleCount
  })
  if (sampleCount < TAG_MIN_SAMPLE_COUNT) {
    logTagAggregation('insufficient_samples', {
      assignmentId,
      sampleCount
    })
    const result = await supabaseAdmin
      .from('assignment_tag_state')
      .update({
        status: 'insufficient_samples',
        sample_count: sampleCount,
        updated_at: nowIso
      })
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)

    if (result.error) {
      throw new Error(result.error.message)
    }
    return { assignmentId, status: 'insufficient_samples', sampleCount }
  }

  const issueStats = buildIssueStats(gradedSubmissions).slice(0, TAG_TOP_ISSUES)
  logTagAggregation('issue_stats', {
    assignmentId,
    count: issueStats.length
  })

  if (issueStats.length === 0) {
    await supabaseAdmin
      .from('assignment_tag_aggregates')
      .delete()
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)

    await finalizeAssignmentTagState(
      supabaseAdmin,
      ownerId,
      assignmentId,
      nowIso,
      sampleCount,
      TAG_MODEL,
      TAG_PROMPT_VERSION
    )

    try {
      await refreshDomainTagAggregates(
        supabaseAdmin,
        ownerId,
        assignmentDomain
      )
    } catch (err) {
      logTagAggregation('domain_agg_error', {
        assignmentId,
        message: err instanceof Error ? err.message : 'domain aggregate failed'
      })
    }

    logTagAggregation('done_empty', {
      assignmentId,
      durationMs: Date.now() - startedAt
    })
    return { assignmentId, status: 'ready', sampleCount }
  }

  const { data: dictionaryRows, error: dictionaryError } = await supabaseAdmin
    .from('tag_dictionary')
    .select('id, label, normalized_label')
    .eq('owner_id', ownerId)
    .eq('status', 'active')

  if (dictionaryError) {
    throw new Error(dictionaryError.message)
  }

  const dictionaryMap = new Map()
  const dictionaryLabels = []
  for (const row of dictionaryRows || []) {
    const normalized = row.normalized_label || normalizeTagLabel(row.label)
    dictionaryMap.set(normalized, row)
    if (row.label) dictionaryLabels.push(row.label)
  }

  logTagAggregation('dictionary', {
    assignmentId,
    count: dictionaryLabels.length
  })

  const prompt = buildTagPrompt(issueStats, dictionaryLabels)
  logTagAggregation('llm_request', { assignmentId })
  const responseText = await callGeminiText(prompt)
  logTagAggregation('llm_response', { assignmentId, length: responseText.length })
  const parsed = extractJsonFromText(responseText)
  const rawTags = Array.isArray(parsed?.tags) ? parsed.tags : []

  const normalizedTags = rawTags
    .map((tag) => {
      const label =
        typeof tag?.label === 'string'
          ? tag.label.trim()
          : typeof tag?.tag === 'string'
            ? tag.tag.trim()
            : ''
      const count = parseInt(tag?.count, 10)
      if (!label || !Number.isFinite(count) || count <= 0) return null
      const examples = Array.isArray(tag?.examples)
        ? tag.examples
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter((item) => item.length > 0)
            .slice(0, 2)
        : undefined
      return {
        label,
        count: Math.min(count, sampleCount),
        examples
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)
    .slice(0, TAG_LIMIT)

  if (!normalizedTags.length) {
    throw new Error('Gemini tag output invalid')
  }

  logTagAggregation('tags_ready', {
    assignmentId,
    count: normalizedTags.length
  })

  const newDictionaryRows = []
  normalizedTags.forEach((tag) => {
    const normalizedLabel = normalizeTagLabel(tag.label)
    if (!dictionaryMap.has(normalizedLabel)) {
      newDictionaryRows.push({
        owner_id: ownerId,
        label: tag.label,
        normalized_label: normalizedLabel,
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso
      })
    }
  })

  if (newDictionaryRows.length > 0) {
    const insertResult = await supabaseAdmin
      .from('tag_dictionary')
      .insert(newDictionaryRows)
      .select('id, label, normalized_label')

    if (insertResult.error) {
      throw new Error(insertResult.error.message)
    }

    await touchDictionaryMergeState(supabaseAdmin, ownerId, nowIso)
  }

  await supabaseAdmin
    .from('assignment_tag_aggregates')
    .delete()
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)

  const aggregateRows = normalizedTags.map((tag) => ({
    owner_id: ownerId,
    assignment_id: assignmentId,
    tag_label: tag.label,
    tag_count: tag.count,
    examples: tag.examples ?? null,
    generated_at: nowIso,
    model: TAG_MODEL,
    prompt_version: TAG_PROMPT_VERSION,
    updated_at: nowIso
  }))

  const insertResult = await supabaseAdmin
    .from('assignment_tag_aggregates')
    .insert(aggregateRows)

  if (insertResult.error) {
    throw new Error(insertResult.error.message)
  }

  await finalizeAssignmentTagState(
    supabaseAdmin,
    ownerId,
    assignmentId,
    nowIso,
    sampleCount,
    TAG_MODEL,
    TAG_PROMPT_VERSION
  )

  try {
    await refreshDomainTagAggregates(supabaseAdmin, ownerId, assignmentDomain)
  } catch (err) {
    logTagAggregation('domain_agg_error', {
      assignmentId,
      message: err instanceof Error ? err.message : 'domain aggregate failed'
    })
  }

  logTagAggregation('done', {
    assignmentId,
    durationMs: Date.now() - startedAt
  })
  return { assignmentId, status: 'ready', sampleCount }
}

// ========== TOKEN USAGE DASHBOARD ==========
// 2026-05-21: 後台 Token 用量分析
// GET /api/admin/analytics?action=token-usage&from=YYYY-MM-DD&to=YYYY-MM-DD&userId=xxx
// 老師本位視角：學生用 AI 算在 billing_user_id（老師 owner_id）名下
async function handleTokenUsage(req, res, supabaseAdmin) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // 預設區間：最近 30 天（含今天）—— 用 Taipei timezone (UTC+8)
    const TAIPEI_OFFSET = '+08:00'
    const now = new Date()
    const defaultFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)
    // 用 Taipei 本地時間轉 YYYY-MM-DD（避免拿到 UTC date）
    const toTaipeiDateStr = (d) => {
      const taipei = new Date(d.getTime() + 8 * 3600 * 1000)
      return taipei.toISOString().split('T')[0]
    }
    const fromStr = String(req.query?.from || '').trim() || toTaipeiDateStr(defaultFrom)
    const toStr = String(req.query?.to || '').trim() || toTaipeiDateStr(now)
    const userId = String(req.query?.userId || '').trim() || null
    // 2026-05-21: 預設 includeAdmin=true（含 admin 測試）；前端可改 false 排除
    const includeAdmin = String(req.query?.includeAdmin || 'true').toLowerCase() !== 'false'

    // 2026-05-22: fromStr/toStr 視為 Taipei 本地日期、轉成 UTC 區間查詢
    // 例：from=2026-05-22 → Taipei 5/22 00:00 = UTC 5/21 16:00
    const fromIso = new Date(`${fromStr}T00:00:00${TAIPEI_OFFSET}`).toISOString()
    const toIso = new Date(`${toStr}T23:59:59.999${TAIPEI_OFFSET}`).toISOString()

    // ── 撈 token 用量（依 billing_user_id 聚合）──
    // 2026-05-23: SELECT 加 assignment_id / submission_id 給「按作業拆解」用
    const usageQuery = (from, to) => {
      let q = supabaseAdmin
        .from('ink_session_usage')
        .select('billing_user_id, route_key, model_name, input_tokens, output_tokens, total_tokens, is_admin_test, assignment_id, submission_id, created_at')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
      if (userId) q = q.eq('billing_user_id', userId)
      if (!includeAdmin) q = q.eq('is_admin_test', false)
      return q.range(from, to)
    }
    const usageRows = await fetchAllRows(usageQuery)

    // ── 撈老師清單（給 dropdown） ──
    // 2026-05-22: 只列「在這段時間區間內有用量」的老師、跟 fromIso/toIso 連動
    // 也尊重 includeAdmin 篩選（關掉就不列 admin）
    const billingIdsWithUsage = await fetchAllRows((from, to) => {
      let q = supabaseAdmin
        .from('ink_session_usage')
        .select('billing_user_id')
        .not('billing_user_id', 'is', null)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
      if (!includeAdmin) q = q.eq('is_admin_test', false)
      return q.range(from, to)
    })
    const uniqueBillingIds = Array.from(new Set(billingIdsWithUsage.map(r => r.billing_user_id).filter(Boolean)))
    let teachers = []
    if (uniqueBillingIds.length > 0) {
      // 分批 IN clause（避免 URL 過長）
      const CHUNK = 200
      for (let i = 0; i < uniqueBillingIds.length; i += CHUNK) {
        const chunk = uniqueBillingIds.slice(i, i + CHUNK)
        const { data: profileRows } = await supabaseAdmin
          .from('profiles')
          .select('id, name, email, role')
          .in('id', chunk)
        if (Array.isArray(profileRows)) {
          teachers.push(...profileRows.filter(p => p.role !== 'admin'))
        }
      }
      teachers.sort((a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || '')))
    }

    // ── 成本計算 helper（依實際 model 真實 Gemini rate） ──
    // gemini-3.5-flash: $1.50 input / $9.00 output per 1M
    // gemini-2.5-flash: $0.075 input / $0.30 output per 1M
    // 未知 model: 用 3.5-flash rate 保守估
    function modelRates(modelName) {
      const m = String(modelName || '').toLowerCase()
      if (m.includes('2.5-flash-lite')) return { inUsd: 0.10, outUsd: 0.40 }
      if (m.includes('2.5-flash')) return { inUsd: 0.075, outUsd: 0.30 }
      if (m.includes('3.5-flash')) return { inUsd: 1.50, outUsd: 9.00 }
      if (m.includes('3-flash-preview')) return { inUsd: 1.50, outUsd: 9.00 }
      if (m.includes('pro')) return { inUsd: 1.25, outUsd: 5.00 }
      return { inUsd: 1.50, outUsd: 9.00 }
    }
    const USD_TO_TWD = 33

    function rowCostTwd(row) {
      const rates = modelRates(row.model_name)
      const usd = (Number(row.input_tokens) || 0) * rates.inUsd / 1_000_000
        + (Number(row.output_tokens) || 0) * rates.outUsd / 1_000_000
      return usd * USD_TO_TWD
    }

    // 2026-05-23: route_key → 類別 mapping
    // 用途：byCategory 聚合 + byAssignment 拆批改/報告/訂正
    function routeToCategory(routeKey) {
      const k = String(routeKey || '')
      if (k.startsWith('grading.recheck')) return '訂正'
      if (k.startsWith('grading.')) return '批改'
      if (k.startsWith('report.')) return '報告'
      if (k.startsWith('answer_key.')) return '答案卷'
      if (k.startsWith('perspective.')) return '系統'
      return '其他'
    }

    // ── Summary ──
    let totalIn = 0, totalOut = 0, totalUsd = 0
    for (const r of usageRows) {
      totalIn += Number(r.input_tokens) || 0
      totalOut += Number(r.output_tokens) || 0
      const rates = modelRates(r.model_name)
      totalUsd += (Number(r.input_tokens) || 0) * rates.inUsd / 1_000_000
        + (Number(r.output_tokens) || 0) * rates.outUsd / 1_000_000
    }
    const summary = {
      totalCalls: usageRows.length,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalUsdCost: +totalUsd.toFixed(4),
      totalTwdCost: +(totalUsd * USD_TO_TWD).toFixed(2)
    }

    // ── byStage ──
    const stageMap = {}
    for (const r of usageRows) {
      const key = r.route_key || '(unknown)'
      if (!stageMap[key]) stageMap[key] = { route_key: key, calls: 0, input: 0, output: 0, twd: 0 }
      stageMap[key].calls += 1
      stageMap[key].input += Number(r.input_tokens) || 0
      stageMap[key].output += Number(r.output_tokens) || 0
      stageMap[key].twd += rowCostTwd(r)
    }
    const byStage = Object.values(stageMap)
      .map(s => ({ ...s, twd: +s.twd.toFixed(2) }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))

    // ── byModel ──
    const modelMap = {}
    for (const r of usageRows) {
      const key = r.model_name || '(unknown)'
      if (!modelMap[key]) modelMap[key] = { model_name: key, calls: 0, input: 0, output: 0, twd: 0 }
      modelMap[key].calls += 1
      modelMap[key].input += Number(r.input_tokens) || 0
      modelMap[key].output += Number(r.output_tokens) || 0
      modelMap[key].twd += rowCostTwd(r)
    }
    const byModel = Object.values(modelMap)
      .map(m => ({ ...m, twd: +m.twd.toFixed(2) }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))

    // ── timeSeries（per date × per stage tokens）──
    // 給 stacked area chart 用
    // 2026-05-22: 用 Taipei timezone 做 date grouping（避免半夜跑的測試被分到前一天）
    const timeMap = {}  // { 'YYYY-MM-DD': { route_key: total_tokens } }
    for (const r of usageRows) {
      const taipeiDate = toTaipeiDateStr(new Date(r.created_at))
      const stage = r.route_key || '(unknown)'
      const tokens = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0)
      if (!timeMap[taipeiDate]) timeMap[taipeiDate] = {}
      timeMap[taipeiDate][stage] = (timeMap[taipeiDate][stage] || 0) + tokens
    }
    const timeSeries = Object.entries(timeMap)
      .map(([date, stages]) => ({ date, stages }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // ── byCategory（每日 × 類別）2026-05-23 新增 ──
    const categoryMap = {}     // { category: { calls, in, out, twd } }
    const categoryDailyMap = {} // { date: { category: tokens } }
    for (const r of usageRows) {
      const cat = routeToCategory(r.route_key)
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, calls: 0, input: 0, output: 0, twd: 0 }
      categoryMap[cat].calls += 1
      categoryMap[cat].input += Number(r.input_tokens) || 0
      categoryMap[cat].output += Number(r.output_tokens) || 0
      categoryMap[cat].twd += rowCostTwd(r)
      const taipeiDate = toTaipeiDateStr(new Date(r.created_at))
      if (!categoryDailyMap[taipeiDate]) categoryDailyMap[taipeiDate] = {}
      categoryDailyMap[taipeiDate][cat] = (categoryDailyMap[taipeiDate][cat] || 0)
        + (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0)
    }
    const byCategory = Object.values(categoryMap)
      .map(c => ({ ...c, twd: +c.twd.toFixed(2) }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))
    const categoryDaily = Object.entries(categoryDailyMap)
      .map(([date, cats]) => ({ date, categories: cats }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // ── byAssignment（按作業拆解 top 20，並拆批改/報告/訂正）2026-05-23 強化 ──
    const assignmentMap = {}
    for (const r of usageRows) {
      const aid = r.assignment_id
      if (!aid) continue  // null 跳過（非批改類 AI call）
      if (!assignmentMap[aid]) {
        assignmentMap[aid] = {
          assignment_id: aid,
          calls: 0, input: 0, output: 0, twd: 0,
          grading_calls: 0, grading_twd: 0,
          report_calls: 0, report_twd: 0,
          correction_calls: 0, correction_twd: 0,
          submission_ids: new Set()
        }
      }
      const tw = rowCostTwd(r)
      const cat = routeToCategory(r.route_key)
      assignmentMap[aid].calls += 1
      assignmentMap[aid].input += Number(r.input_tokens) || 0
      assignmentMap[aid].output += Number(r.output_tokens) || 0
      assignmentMap[aid].twd += tw
      if (cat === '批改') { assignmentMap[aid].grading_calls += 1; assignmentMap[aid].grading_twd += tw }
      else if (cat === '報告') { assignmentMap[aid].report_calls += 1; assignmentMap[aid].report_twd += tw }
      else if (cat === '訂正') { assignmentMap[aid].correction_calls += 1; assignmentMap[aid].correction_twd += tw }
      if (r.submission_id) assignmentMap[aid].submission_ids.add(r.submission_id)
    }
    let byAssignment = Object.values(assignmentMap)
      .map(a => ({
        assignment_id: a.assignment_id,
        calls: a.calls,
        input: a.input,
        output: a.output,
        twd: +a.twd.toFixed(2),
        grading_calls: a.grading_calls,
        grading_twd: +a.grading_twd.toFixed(2),
        report_calls: a.report_calls,
        report_twd: +a.report_twd.toFixed(2),
        correction_calls: a.correction_calls,
        correction_twd: +a.correction_twd.toFixed(2),
        submission_count: a.submission_ids.size
      }))
      .sort((a, b) => b.input + b.output - (a.input + a.output))
      .slice(0, 20)  // top 20

    // JOIN assignments 拿 title / domain / owner_id
    if (byAssignment.length > 0) {
      const aids = byAssignment.map(a => a.assignment_id)
      const { data: assignRows } = await supabaseAdmin
        .from('assignments')
        .select('id, title, domain, owner_id')
        .in('id', aids)
      const ownerIds = Array.from(new Set((assignRows || []).map(a => a.owner_id).filter(Boolean)))
      const ownerNameMap = {}
      if (ownerIds.length > 0) {
        const { data: ownerRows } = await supabaseAdmin
          .from('profiles')
          .select('id, name, email')
          .in('id', ownerIds)
        for (const o of (ownerRows || [])) {
          ownerNameMap[o.id] = o.name || o.email || ''
        }
      }
      const aMetaMap = {}
      for (const a of (assignRows || [])) {
        aMetaMap[a.id] = { title: a.title || '(未命名)', domain: a.domain || '', owner_name: ownerNameMap[a.owner_id] || '' }
      }
      byAssignment = byAssignment.map(a => ({
        ...a,
        ...(aMetaMap[a.assignment_id] || { title: '(已刪除)', domain: '', owner_name: '' })
      }))
    }

    // ── 額外統計：admin 測試的用量比例 ──
    const adminCalls = usageRows.filter(r => r.is_admin_test).length
    const realCalls = usageRows.length - adminCalls

    res.status(200).json({
      params: { from: fromStr, to: toStr, userId, includeAdmin },
      summary,
      byStage,
      byModel,
      byCategory,
      categoryDaily,
      byAssignment,
      timeSeries,
      teachers: teachers.map(t => ({ id: t.id, name: t.name, email: t.email })),
      adminTestCount: adminCalls,
      realCallCount: realCalls
    })
  } catch (e) {
    console.error('[admin/token-usage] failed:', e)
    res.status(500).json({ error: e?.message || 'Internal error' })
  }
}

async function handleAggregateTags(req, res, supabaseAdmin) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  let body = parseJsonBody(req, res)
  if (body === null) {
    if (res.headersSent) return
    body = {}
  }
  const ownerId = body.ownerId || req.query?.ownerId || null
  const assignmentId = body.assignmentId || req.query?.assignmentId || null
  const force = parseBooleanParam(body.force ?? req.query?.force, false)
  const scope = typeof (body.scope ?? req.query?.scope) === 'string'
    ? String(body.scope ?? req.query?.scope).trim()
    : ''
  const layers = typeof (body.layers ?? req.query?.layers) === 'string'
    ? String(body.layers ?? req.query?.layers).trim()
    : ''
  const includeReady =
    scope === 'all' ||
    parseBooleanParam(body.forceAll ?? req.query?.forceAll, false)
  const includeLayers =
    layers === 'all' ||
    parseBooleanParam(body.aggregateLayers ?? req.query?.aggregateLayers, false)

  logTagAggregation('request', {
    method: req.method,
    ownerScope: ownerId ? 'filtered' : 'all',
    assignmentScope: assignmentId ? 'filtered' : 'all',
    force
  })

  const stateQuery = supabaseAdmin
    .from('assignment_tag_state')
    .select('*')

  if (ownerId) stateQuery.eq('owner_id', ownerId)
  if (assignmentId) stateQuery.eq('assignment_id', assignmentId)
  if (includeReady) {
    stateQuery.in('status', [
      'pending',
      'ready',
      'failed',
      'insufficient_samples'
    ])
  } else {
    stateQuery.eq('status', 'pending')
  }

  const { data: states, error } = await stateQuery
  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  logTagAggregation('pending_states', {
    count: states?.length ?? 0
  })

  const nowMs = Date.now()
  const dueStates = force
    ? states || []
    : (states || []).filter((row) => {
        const nextRunAtMs = row.next_run_at ? Date.parse(row.next_run_at) : NaN
        const windowStartMs = row.window_started_at
          ? Date.parse(row.window_started_at)
          : NaN
        const lastEventMs = row.last_event_at ? Date.parse(row.last_event_at) : NaN
    const quietDue =
      Number.isFinite(nextRunAtMs) && nowMs >= nextRunAtMs
        ? true
        : Number.isFinite(lastEventMs)
          ? nowMs - lastEventMs >= TAG_QUIET_MINUTES * 60 * 1000
          : false
        const maxWaitDue =
          Number.isFinite(windowStartMs) &&
          nowMs - windowStartMs >= TAG_MAX_WAIT_MINUTES * 60 * 1000
        return quietDue || maxWaitDue
      })

  logTagAggregation('due_states', { count: dueStates.length })

  const results = []
  const ownerSet = new Set()
  for (const stateRow of dueStates) {
    if (stateRow.owner_id) ownerSet.add(stateRow.owner_id)
    try {
      const result = await aggregateAssignmentTags(supabaseAdmin, stateRow)
      results.push({ assignmentId: stateRow.assignment_id, ok: true, ...result })
    } catch (err) {
      console.error('[tag-agg] error', {
        assignmentId: stateRow.assignment_id,
        message: err instanceof Error ? err.message : 'aggregate failed'
      })
      await supabaseAdmin
        .from('assignment_tag_state')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('owner_id', stateRow.owner_id)
        .eq('assignment_id', stateRow.assignment_id)

      results.push({
        assignmentId: stateRow.assignment_id,
        ok: false,
        error: err instanceof Error ? err.message : 'aggregate failed'
      })
    }
  }

  let domainResults = []
  let abilityResults = []
  if (includeLayers) {
    const ownerList = Array.from(ownerSet)
    for (const ownerIdEntry of ownerList) {
      try {
        const result = await refreshDomainAggregatesForOwner(
          supabaseAdmin,
          ownerIdEntry
        )
        domainResults.push({ ownerId: ownerIdEntry, ok: true, ...result })
      } catch (err) {
        domainResults.push({
          ownerId: ownerIdEntry,
          ok: false,
          error: err instanceof Error ? err.message : 'domain aggregate failed'
        })
      }
    }

    for (const ownerIdEntry of ownerList) {
      try {
        const result = await updateAbilityMappingForOwner(
          supabaseAdmin,
          ownerIdEntry
        )
        abilityResults.push({ ownerId: ownerIdEntry, ok: true, ...result })
      } catch (err) {
        abilityResults.push({
          ownerId: ownerIdEntry,
          ok: false,
          error: err instanceof Error ? err.message : 'ability aggregate failed'
        })
      }
    }
  }

  res.status(200).json({
    success: true,
    processed: results.length,
    results,
    domainResults,
    abilityResults
  })
}

// ========== MAIN HANDLER ==========
export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  const action = resolveAction(req)

  // 標籤系統已停用
  if (action === 'aggregate-tags') {
    return res.status(410).json({ error: '標籤系統已停用' })
  }

  const adminContext = await requireAdmin(req, res)
  if (!adminContext) return

  const { supabaseAdmin, user: adminUser } = adminContext

  // 路由到對應的處理函數
  if (action === 'users') {
    return await handleUsers(req, res, supabaseAdmin)
  }

  if (action === 'user-stats') {
    return await handleUserStats(req, res, supabaseAdmin)
  }

  if (action === 'user-detail') {
    return await handleUserDetail(req, res, supabaseAdmin)
  }

  if (action === 'packages') {
    return await handlePackages(req, res, supabaseAdmin)
  }

  if (action === 'ink-orders') {
    return await handleInkOrders(req, res, supabaseAdmin, adminUser)
  }

  // 標籤系統已停用
  if (action === 'tags') {
    return res.status(410).json({ error: '標籤系統已停用' })
  }

  if (action === 'analytics') {
    return await handleAnalytics(req, res, supabaseAdmin)
  }

  if (action === 'token-usage') {
    return await handleTokenUsage(req, res, supabaseAdmin)
  }

  if (action === 'announcements') {
    return await handleAnnouncements(req, res, supabaseAdmin, adminUser)
  }

  if (action === 'quality') {
    return await handleQuality(req, res, supabaseAdmin)
  }

  res.status(404).json({ error: 'Unknown action' })
}

// ========== QUALITY DASHBOARD ==========
// 開發者用、逐份檢視批改品質（原圖 + bbox + AI1/AI2 read），不顯示給老師/學生
// /api/admin/quality?mode=assignments[&days=N]
// /api/admin/quality?mode=submissions&assignmentId=xxx
// /api/admin/quality?mode=submission_detail&submissionId=xxx

async function handleQuality(req, res, supabaseAdmin) {
  const mode = String(req.query?.mode || 'assignments')
  const assignmentId = req.query?.assignmentId ? String(req.query.assignmentId) : null
  const submissionId = req.query?.submissionId ? String(req.query.submissionId) : null
  const pipelineRunId = req.query?.pipelineRunId ? String(req.query.pipelineRunId) : null
  // date: YYYY-MM-DD（哪一天有批改、未帶預設今天、UTC 解讀）
  const dateStr = req.query?.date ? String(req.query.date) : null

  try {
    if (mode === 'assignments') {
      const day = parseDateForDay(dateStr)
      return res.status(200).json(await qualityAssignmentList(supabaseAdmin, day))
    }
    if (mode === 'submissions') {
      if (!assignmentId) return res.status(400).json({ error: 'assignmentId required' })
      return res.status(200).json(await qualitySubmissionList(supabaseAdmin, assignmentId))
    }
    if (mode === 'submission_detail') {
      if (!submissionId) return res.status(400).json({ error: 'submissionId required' })
      return res.status(200).json(await qualitySubmissionDetail(supabaseAdmin, submissionId, pipelineRunId))
    }
    return res.status(400).json({ error: 'Unknown mode' })
  } catch (err) {
    console.error('[admin/quality] error:', err)
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Quality query failed' })
  }
}

// ── Single-day helper（YYYY-MM-DD、未帶預設今天台灣時間）──
// ⚠️ 切日界用台灣時區 +08:00、不用 UTC：老師早上 7 點批改、UTC 還在前一天
//   選 2026-05-22 → 找台灣 5/22 00:00 ~ 23:59 = UTC 5/21 16:00 ~ 5/22 16:00
function parseDateForDay(dateStr) {
  const dayRe = /^\d{4}-\d{2}-\d{2}$/
  // today: 用台灣時區算今天的 YYYY-MM-DD
  const now = new Date()
  const twNow = new Date(now.getTime() + 8 * 3600 * 1000)
  const today = `${twNow.getUTCFullYear()}-${String(twNow.getUTCMonth() + 1).padStart(2, '0')}-${String(twNow.getUTCDate()).padStart(2, '0')}`
  const date = (dateStr && dayRe.test(dateStr)) ? dateStr : today
  return {
    date,
    fromIso: `${date}T00:00:00.000+08:00`,
    toIso: `${date}T23:59:59.999+08:00`
  }
}

// ── Assignment list（給前端 dropdown 用、某一天有批改的作業）──
async function qualityAssignmentList(db, day) {
  const { fromIso, toIso, date } = day
  const { data, error } = await db
    .from('grading_stage_logs')
    .select('assignment_id, created_at')
    .gte('created_at', fromIso)
    .lte('created_at', toIso)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) throw new Error(error.message)
  const counts = new Map()
  for (const r of data || []) {
    counts.set(r.assignment_id, (counts.get(r.assignment_id) || 0) + 1)
  }
  const aids = [...counts.keys()]
  if (aids.length === 0) return { assignments: [], date }
  const { data: ass } = await db
    .from('assignments')
    .select('id, title, total_pages, doc_type, created_at')
    .in('id', aids)
  return {
    assignments: (ass || [])
      .map((a) => ({ ...a, log_count: counts.get(a.id) || 0 }))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    date
  }
}

// ── Submission list（某 assignment 下、按學生）──
async function qualitySubmissionList(db, assignmentId) {
  // ⚠️ DB-safety: 拆兩個 query、避免一次 SELECT 拉所有 log 的 read_answer_1 JSONB
  //   - countsQuery: 只拿 phase metadata 算 runCount/phaseACount/phaseBCount（無 JSONB、~30B/row）
  //   - phaseAQuery: filter Phase A only、SELECT read_answer_1、最新一筆給 sidebar 用
  // 之前一次 SELECT 5000 筆 read_answer_1 JSONB → 把 DB 打爆。教訓：拉大欄位前先 filter。
  const [countsRes, phaseARes] = await Promise.all([
    db.from('grading_stage_logs')
      .select('submission_id, phase, created_at')
      .eq('assignment_id', assignmentId)
      .limit(5000),
    db.from('grading_stage_logs')
      .select('submission_id, created_at, needs_review_count, read_answer_1')
      .eq('assignment_id', assignmentId)
      .not('read_answer_1', 'is', null)
      .order('created_at', { ascending: false })
      .limit(2000)
  ])
  if (countsRes.error) throw new Error(countsRes.error.message)
  if (phaseARes.error) throw new Error(phaseARes.error.message)

  // run counts + 最新一次批改活動時間 per submission
  const countsBySid = new Map()
  const lastActivityBySid = new Map()
  for (const r of countsRes.data || []) {
    const sid = r.submission_id
    if (!countsBySid.has(sid)) countsBySid.set(sid, { runCount: 0, phaseACount: 0, phaseBCount: 0 })
    const c = countsBySid.get(sid)
    c.runCount += 1
    if (r.phase === 'phase_a') c.phaseACount += 1
    else if (r.phase === 'phase_b') c.phaseBCount += 1
    const ts = r.created_at
    if (ts && (!lastActivityBySid.has(sid) || ts > lastActivityBySid.get(sid))) {
      lastActivityBySid.set(sid, ts)
    }
  }

  // 每份取最新 Phase A
  const latestPhaseABySid = new Map()
  for (const r of phaseARes.data || []) {
    if (!latestPhaseABySid.has(r.submission_id)) latestPhaseABySid.set(r.submission_id, r)
  }
  const sids = [...latestPhaseABySid.keys()]
  if (sids.length === 0) return { assignmentId, submissions: [] }

  const { data: subs } = await db
    .from('submissions')
    .select('id, student_id, image_url, graded_at, source, status')
    .in('id', sids)
  const studentIds = [...new Set((subs || []).map((s) => s.student_id).filter(Boolean))]
  const { data: students } = studentIds.length > 0
    ? await db.from('students').select('id, name, seat_number').in('id', studentIds)
    : { data: [] }
  const studentById = new Map((students || []).map((s) => [s.id, s]))

  const submissions = (subs || []).map((s) => {
    const log = latestPhaseABySid.get(s.id)
    const counts = countsBySid.get(s.id) || { runCount: 0, phaseACount: 0, phaseBCount: 0 }
    const student = s.student_id ? studentById.get(s.student_id) : null
    const totalQuestions = Array.isArray(log?.read_answer_1) ? log.read_answer_1.length : 0
    return {
      submissionId: s.id,
      studentId: s.student_id || null,
      studentName: student?.name || '(未綁定)',
      seatNumber: student?.seat_number ?? null,
      source: s.source || null,
      status: s.status || null,
      totalQuestions,
      needsReviewCount: log?.needs_review_count || 0,
      gradedAt: s.graded_at || null,
      lastActivityAt: lastActivityBySid.get(s.id) || null,
      runCount: counts.runCount,
      phaseACount: counts.phaseACount,
      phaseBCount: counts.phaseBCount
    }
  }).sort((a, b) => {
    const sa = a.seatNumber ?? 9999
    const sb = b.seatNumber ?? 9999
    if (sa !== sb) return sa - sb
    return String(a.studentName).localeCompare(String(b.studentName), 'zh-Hant')
  })

  return { assignmentId, submissions }
}

// ── Submission detail（單份卷子的 bbox + read + arbiter + final answer）──
async function qualitySubmissionDetail(db, submissionId, pipelineRunId = null) {
  const { data: sub, error: sErr } = await db
    .from('submissions')
    .select('id, assignment_id, student_id, image_url, graded_at, final_answers, grading_result, source, status')
    .eq('id', submissionId)
    .maybeSingle()
  if (sErr) throw new Error(sErr.message)
  if (!sub) {
    const err = new Error('Submission not found')
    err.status = 404
    throw err
  }

  // ⚠️ DB-safety: 拆兩個 query、不要一次 SELECT 全部 log + 大 JSONB（classify 可達 500KB/筆）
  //   - timeline query: 只拉 metadata（無 JSONB、~50B/row）→ 給 runs[] 用
  //   - 確定要顯示的 run 後、再單獨 SELECT 那一筆的大欄位（classify/read_answer_1/2/arbiter）
  // 之前 LIMIT 50 + 全 SELECT 大欄位 → 一次 detail call 拉 1-5MB、密集點學生就把 DB 打爆
  const [assRes, stuRes, runsRes] = await Promise.all([
    db.from('assignments').select('id, title, total_pages, doc_type').eq('id', sub.assignment_id).maybeSingle(),
    sub.student_id
      ? db.from('students').select('id, name, seat_number').eq('id', sub.student_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('grading_stage_logs')
      .select('pipeline_run_id, phase, model, created_at, needs_review_count, total_score')
      .eq('submission_id', submissionId)
      .order('created_at', { ascending: true })
      .limit(50)
  ])
  const assignment = assRes?.data || null
  const student = stuRes?.data || null
  const allRuns = runsRes?.data || []

  // 選定要顯示的 Phase A run
  const phaseARuns = allRuns.filter((r) => r.phase === 'phase_a')
  let targetRunId = null
  if (pipelineRunId) {
    const found = phaseARuns.find((r) => r.pipeline_run_id === pipelineRunId)
    if (found) targetRunId = found.pipeline_run_id
  }
  if (!targetRunId && phaseARuns.length > 0) {
    targetRunId = phaseARuns[phaseARuns.length - 1].pipeline_run_id  // 最新 Phase A
  }

  // 只拉選中那一筆 Phase A 的大欄位
  // ⚠️ 必須 filter phase='phase_a'、因為 Phase A 跟 Phase B 共用同一個 pipeline_run_id
  // 不加 phase filter 會撈到 2 筆 → maybeSingle 噴 "JSON object requested, multiple rows"
  // Phase B 同 pipeline_run_id 的 accessor 一併拉、給每題的批改分數 + 理由用
  let log = null
  let phaseBLog = null
  if (targetRunId) {
    const [phaseARes, phaseBRes] = await Promise.all([
      db.from('grading_stage_logs')
        .select('pipeline_run_id, classify, read_answer_1, read_answer_2, arbiter, needs_review_count')
        .eq('submission_id', submissionId)
        .eq('pipeline_run_id', targetRunId)
        .eq('phase', 'phase_a')
        .maybeSingle(),
      db.from('grading_stage_logs')
        .select('pipeline_run_id, accessor, total_score')
        .eq('submission_id', submissionId)
        .eq('pipeline_run_id', targetRunId)
        .eq('phase', 'phase_b')
        .maybeSingle()
    ])
    if (phaseARes.error) throw new Error(phaseARes.error.message)
    log = phaseARes.data || null
    phaseBLog = phaseBRes.data || null
  }

  // runs timeline：用 metadata-only 結果
  const runs = allRuns.map((r) => ({
    pipelineRunId: r.pipeline_run_id,
    phase: r.phase || null,
    model: r.model || null,
    createdAt: r.created_at,
    needsReviewCount: r.needs_review_count ?? null,
    totalScore: r.total_score ?? null,
    hasPhaseAData: r.phase === 'phase_a',
    isSelected: targetRunId != null && r.pipeline_run_id === targetRunId
  }))

  // 簽 storage URL（image_url 是 path 或完整 URL）
  let imageUrl = null
  const rawImage = sub.image_url || `submissions/${sub.id}.webp`
  if (/^(https?:|data:|blob:)/i.test(rawImage)) {
    imageUrl = rawImage
  } else {
    try {
      const { data: signed } = await db.storage
        .from('homework-images')
        .createSignedUrl(rawImage, 3600)
      imageUrl = signed?.signedUrl || null
    } catch (e) {
      console.warn('[admin/quality] signed url failed:', e?.message)
    }
  }

  // bbox：取「實際送進 crop + read 的最終 bbox」、不是 AI raw classify
  //   優先序：rowAnchorOverrides.after > overrides.after > classifyBboxes.bbox
  //   (row anchor 是 full replace、跑在 OCR width_floor/x_shift 之後)
  // ⚠️ submissions/<id>.webp 是垂直堆疊的 merged 多頁圖、但每頁 bbox 是 normalized 到該「單頁」(y ∈ [0,1])。
  //   page 1+ 的 bbox 要 offset 才能畫在 merged 圖上：mergedY = (pageIdx + bbox.y) / pageCount
  //   假設所有 page 等高（teacher_scan 走 PDF rasterize 一律相同 dpi 故等高）
  const bboxByQid = new Map()
  const bboxSourceByQid = new Map()  // qid → 'raw' | 'ocr_override' | 'row_anchor'
  const perPage = log?.classify?.ocrAssist?.perPage || []
  const pageCount = perPage.length || 1
  const toMerged = (b, pageIdx) => pageCount > 1
    ? { x: b.x, y: (pageIdx + b.y) / pageCount, w: b.w, h: b.h / pageCount }
    : b
  perPage.forEach((p, pageIdx) => {
    // 1) raw classifyBboxes
    for (const item of p?.classifyBboxes || []) {
      if (item?.qid && item?.bbox) {
        bboxByQid.set(item.qid, { page: pageIdx, bbox: toMerged(item.bbox, pageIdx) })
        bboxSourceByQid.set(item.qid, 'raw')
      }
    }
    // 2) OCR width_floor + x_shift overrides
    for (const ovr of p?.overrides || []) {
      if (ovr?.questionId && ovr?.after) {
        bboxByQid.set(ovr.questionId, { page: pageIdx, bbox: toMerged(ovr.after, pageIdx) })
        bboxSourceByQid.set(ovr.questionId, 'ocr_override')
      }
    }
    // 3) row anchor full-replace（最後跑、優先級最高）
    for (const ovr of p?.rowAnchorOverrides || []) {
      if (ovr?.qid && ovr?.after) {
        bboxByQid.set(ovr.qid, { page: pageIdx, bbox: toMerged(ovr.after, pageIdx) })
        bboxSourceByQid.set(ovr.qid, 'row_anchor')
      }
    }
  })

  // qid → type（從 alignedQuestions / 或 read_answer 也可帶）
  const typeByQid = new Map()
  const aligned = log?.classify?.alignedQuestions || []
  for (const q of aligned) {
    if (q?.questionId) typeByQid.set(q.questionId, q.questionType || q.type || null)
  }

  const r1Arr = Array.isArray(log?.read_answer_1) ? log.read_answer_1 : []
  const r2Arr = Array.isArray(log?.read_answer_2) ? log.read_answer_2 : []
  const arbArr = Array.isArray(log?.arbiter) ? log.arbiter : []
  const r1Map = new Map(r1Arr.map((q) => [q.questionId, q]))
  const r2Map = new Map(r2Arr.map((q) => [q.questionId, q]))
  const arbMap = new Map(arbArr.map((a) => [a.questionId, a]))

  const finalArr = Array.isArray(sub.final_answers) ? sub.final_answers : []
  const finalMap = new Map(finalArr.map((f) => [f.questionId, f]))

  const mistakes = Array.isArray(sub.grading_result?.mistakes) ? sub.grading_result.mistakes : []
  const mistakeSet = new Set(mistakes.map((m) => m.questionId).filter(Boolean))

  // Phase B accessor per qid（B1 批改結果：score / maxScore / isCorrect / reason）
  const accessorArr = Array.isArray(phaseBLog?.accessor) ? phaseBLog.accessor : []
  const accessorMap = new Map(accessorArr.map((a) => [a.questionId, a]))

  // union 所有 qid，題序按 1-2-3 自然排序
  const qids = new Set([
    ...bboxByQid.keys(),
    ...r1Map.keys(),
    ...r2Map.keys()
  ])

  const questions = [...qids].map((qid) => {
    const bb = bboxByQid.get(qid)
    const r1 = r1Map.get(qid)
    const r2 = r2Map.get(qid)
    const arb = arbMap.get(qid)
    const final = finalMap.get(qid)
    const acc = accessorMap.get(qid)
    return {
      qid,
      type: typeByQid.get(qid) || null,
      page: bb?.page ?? 0,
      bbox: bb?.bbox || null,
      bboxSource: bboxSourceByQid.get(qid) || null,  // 'raw' | 'ocr_override' | 'row_anchor'
      ai1: r1 ? { answer: r1.answer ?? '', status: r1.status || null } : null,
      ai2: r2 ? { answer: r2.answer ?? '', status: r2.status || null } : null,
      arbiterConsistent: arb?.consistent ?? null,
      finalAnswer: final?.finalStudentAnswer ?? null,
      finalAnswerSource: final?.finalAnswerSource ?? final?.source ?? null,
      isMistake: mistakeSet.has(qid),
      // Phase B 批改：分數 + 對錯 + 批改理由（只在錯題時前端顯示 reason）
      score: acc?.score ?? null,
      maxScore: acc?.maxScore ?? null,
      isCorrect: typeof acc?.isCorrect === 'boolean' ? acc.isCorrect : null,
      scoringReason: acc?.reason || null
    }
  }).sort((a, b) => sortQidNumeric(a.qid, b.qid))

  return {
    submissionId,
    assignmentId: sub.assignment_id,
    assignmentTitle: assignment?.title || '',
    totalPages: assignment?.total_pages || 1,
    studentName: student?.name || '(未綁定)',
    seatNumber: student?.seat_number ?? null,
    source: sub.source || null,
    status: sub.status || null,
    imageUrl,
    needsReviewCount: log?.needs_review_count || 0,
    selectedPipelineRunId: log?.pipeline_run_id || null,
    runs,
    questions
  }
}

function sortQidNumeric(a, b) {
  const pa = String(a).split('-').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('-').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}
// ========== ANNOUNCEMENTS ==========
async function handleAnnouncements(req, res, supabaseAdmin, adminUser) {
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('id, title, body, active, starts_at, ends_at, created_at, updated_at, created_by')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      return res.status(500).json({ error: error.message || '讀取公告失敗' })
    }
    return res.status(200).json({ announcements: data || [] })
  }

  if (req.method === 'POST') {
    const body = parseJsonBody(req, res)
    if (!body) return
    const title = String(body.title || '').trim()
    if (!title) {
      return res.status(400).json({ error: '標題不可為空' })
    }
    const startsAt = parseOptionalDateTime(body.startsAt)
    const endsAt = parseOptionalDateTime(body.endsAt)
    if (startsAt === undefined || endsAt === undefined) {
      return res.status(400).json({ error: '起訖時間格式錯誤' })
    }
    const insert = {
      title,
      body: String(body.body || ''),
      active: parseBoolean(body.active, false),
      starts_at: startsAt || new Date().toISOString(),
      ends_at: endsAt || null,
      created_by: adminUser?.id || null
    }
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .insert(insert)
      .select('id, title, body, active, starts_at, ends_at, created_at, updated_at, created_by')
      .single()
    if (error) {
      return res.status(500).json({ error: error.message || '新增公告失敗' })
    }
    return res.status(200).json({ announcement: data })
  }

  if (req.method === 'PATCH') {
    const body = parseJsonBody(req, res)
    if (!body) return
    const id = String(body.id || '').trim()
    if (!id) {
      return res.status(400).json({ error: 'id 必填' })
    }
    const updates = { updated_at: new Date().toISOString() }
    if (typeof body.title === 'string') {
      const t = body.title.trim()
      if (!t) return res.status(400).json({ error: '標題不可為空' })
      updates.title = t
    }
    if (typeof body.body === 'string') {
      updates.body = body.body
    }
    if (body.active !== undefined) {
      updates.active = parseBoolean(body.active, false)
    }
    if (body.startsAt !== undefined) {
      const sa = parseOptionalDateTime(body.startsAt)
      if (sa === undefined) {
        return res.status(400).json({ error: '起始時間格式錯誤' })
      }
      updates.starts_at = sa || new Date().toISOString()
    }
    if (body.endsAt !== undefined) {
      const ea = parseOptionalDateTime(body.endsAt)
      if (ea === undefined) {
        return res.status(400).json({ error: '結束時間格式錯誤' })
      }
      updates.ends_at = ea
    }
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .update(updates)
      .eq('id', id)
      .select('id, title, body, active, starts_at, ends_at, created_at, updated_at, created_by')
      .single()
    if (error) {
      return res.status(500).json({ error: error.message || '更新公告失敗' })
    }
    return res.status(200).json({ announcement: data })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query?.id || '').trim()
    if (!id) {
      return res.status(400).json({ error: 'id 必填' })
    }
    const { error } = await supabaseAdmin
      .from('announcements')
      .delete()
      .eq('id', id)
    if (error) {
      return res.status(500).json({ error: error.message || '刪除公告失敗' })
    }
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method Not Allowed' })
}
