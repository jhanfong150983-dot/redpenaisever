import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

const PENDING_TTL_MINUTES = 30
const TAG_QUIET_MINUTES = 5
const TAG_MAX_WAIT_MINUTES = 30
const TAG_MIN_SAMPLE_COUNT = 5
const TAG_TOP_ISSUES = 50
const TAG_LIMIT = 8
const TAG_MODEL = 'gemini-3-flash-preview'
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
  return process.env.SYSTEM_GEMINI_API_KEY || process.env.SECRET_API_KEY || ''
}

async function callGeminiText(prompt) {
  const apiKey = getSystemApiKey()
  if (!apiKey) {
    throw new Error('Server API Key missing')
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TAG_MODEL}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })
  })

  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
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
    // 1. 获取所有用户基本信息
    const { data: users, error: usersError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, name, avatar_url, role, permission_tier, ink_balance, created_at, updated_at')
      .order('created_at', { ascending: false })

    if (usersError) throw usersError

    // 2. 批量查询统计数据 - 班级数
    const { data: classroomStats } = await supabaseAdmin
      .from('classrooms')
      .select('owner_id')

    const classroomCountMap = {}
    classroomStats?.forEach(row => {
      classroomCountMap[row.owner_id] = (classroomCountMap[row.owner_id] || 0) + 1
    })

    // 3. 批量查询统计数据 - 学生数
    const { data: studentStats } = await supabaseAdmin
      .from('students')
      .select('owner_id')

    const studentCountMap = {}
    studentStats?.forEach(row => {
      studentCountMap[row.owner_id] = (studentCountMap[row.owner_id] || 0) + 1
    })

    // 4. 批量查询统计数据 - 作业数
    const { data: assignmentStats } = await supabaseAdmin
      .from('assignments')
      .select('owner_id')

    const assignmentCountMap = {}
    assignmentStats?.forEach(row => {
      assignmentCountMap[row.owner_id] = (assignmentCountMap[row.owner_id] || 0) + 1
    })

    // 5. 批量查询统计数据 - 提交总数和已批改数
    const { data: submissionStats } = await supabaseAdmin
      .from('submissions')
      .select('owner_id, graded_at')

    const submissionCountMap = {}
    const gradedCountMap = {}
    submissionStats?.forEach(row => {
      submissionCountMap[row.owner_id] = (submissionCountMap[row.owner_id] || 0) + 1
      if (row.graded_at) {
        gradedCountMap[row.owner_id] = (gradedCountMap[row.owner_id] || 0) + 1
      }
    })

    // 6. 批量查询统计数据 - 墨水消耗（最近30天）
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: inkStats } = await supabaseAdmin
      .from('ink_ledger')
      .select('user_id, delta')
      .lt('delta', 0)  // 只统计消耗（负数）
      .gte('created_at', thirtyDaysAgo)

    const inkUsedMap = {}
    inkStats?.forEach(row => {
      inkUsedMap[row.user_id] = (inkUsedMap[row.user_id] || 0) + Math.abs(row.delta)
    })

    // 7. 组合数据
    const userStats = (users || []).map(user => {
      const classroomCount = classroomCountMap[user.id] || 0
      const studentCount = studentCountMap[user.id] || 0
      const assignmentCount = assignmentCountMap[user.id] || 0
      const submissionCount = submissionCountMap[user.id] || 0
      const gradedCount = gradedCountMap[user.id] || 0
      const totalInkUsed = inkUsedMap[user.id] || 0

      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatar_url,
        inkBalance: user.ink_balance || 0,
        role: user.role || 'user',
        permissionTier: user.permission_tier || 'basic',
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        classroomCount,
        studentCount,
        assignmentCount,
        submissionCount,
        gradedCount,
        gradingProgress: submissionCount > 0
          ? Math.round((gradedCount / submissionCount) * 100)
          : 0,
        totalInkUsed,
        lastActiveAt: user.updated_at
      }
    })

    res.status(200).json({ users: userStats })
  } catch (err) {
    console.error('Error fetching user stats:', err)
    res.status(500).json({ error: '获取用户统计数据失败' })
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
    // 1. 系統概覽統計
    const [
      totalUsersResult,
      totalOrdersResult,
      totalRevenueResult,
      totalInkDistributedResult,
      activeUsersResult
    ] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true }),

      supabaseAdmin
        .from('ink_orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'paid'),

      supabaseAdmin
        .from('ink_orders')
        .select('amount_twd')
        .eq('status', 'paid'),

      supabaseAdmin
        .from('ink_ledger')
        .select('delta')
        .gt('delta', 0),

      supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .gte('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    ])

    const totalRevenue = totalRevenueResult.data?.reduce((sum, order) => sum + (order.amount_twd || 0), 0) || 0
    const totalInkDistributed = totalInkDistributedResult.data?.reduce((sum, ledger) => sum + (ledger.delta || 0), 0) || 0

    // 2. 最近註冊的用戶
    const { data: recentUsers } = await supabaseAdmin
      .from('profiles')
      .select('id, email, name, avatar_url, created_at')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(10)

    // 3. 最活躍用戶
    const { data: inkUsageData } = await supabaseAdmin
      .from('ink_ledger')
      .select('user_id, delta')
      .lt('delta', 0)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

    const userUsageMap = {}
    inkUsageData?.forEach(record => {
      if (!userUsageMap[record.user_id]) {
        userUsageMap[record.user_id] = 0
      }
      userUsageMap[record.user_id] += Math.abs(record.delta)
    })

    const topUserIds = Object.entries(userUsageMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId]) => userId)

    const { data: topUsers } = topUserIds.length > 0
      ? await supabaseAdmin
          .from('profiles')
          .select('id, email, name, avatar_url, ink_balance')
          .in('id', topUserIds)
      : { data: [] }

    const topUsersWithUsage = topUsers?.map(user => ({
      ...user,
      ink_used: userUsageMap[user.id] || 0
    })).sort((a, b) => b.ink_used - a.ink_used) || []

    // 4. 訂單統計
    const { data: recentOrders } = await supabaseAdmin
      .from('ink_orders')
      .select('id, status, amount_twd, created_at')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })

    const ordersByStatus = {
      paid: recentOrders?.filter(o => o.status === 'paid').length || 0,
      pending: recentOrders?.filter(o => o.status === 'pending').length || 0,
      cancelled: recentOrders?.filter(o => o.status === 'cancelled').length || 0
    }

    const recentRevenue = recentOrders?.filter(o => o.status === 'paid').reduce((sum, o) => sum + (o.amount_twd || 0), 0) || 0

    // 5. 每日訂單趨勢
    const dailyOrders = {}
    recentOrders?.forEach(order => {
      if (order.status === 'paid') {
        const date = order.created_at.split('T')[0]
        if (!dailyOrders[date]) {
          dailyOrders[date] = { count: 0, revenue: 0 }
        }
        dailyOrders[date].count++
        dailyOrders[date].revenue += order.amount_twd || 0
      }
    })

    const dailyOrdersArray = Object.entries(dailyOrders)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // 6. 熱門購買方案
    const { data: packageStats } = await supabaseAdmin
      .from('ink_orders')
      .select('package_id, package_label, drops, bonus_drops')
      .eq('status', 'paid')
      .not('package_id', 'is', null)

    const packageSalesMap = {}
    packageStats?.forEach(order => {
      const key = order.package_id
      if (!packageSalesMap[key]) {
        packageSalesMap[key] = {
          package_id: order.package_id,
          package_label: order.package_label,
          drops: order.drops,
          bonus_drops: order.bonus_drops,
          sales_count: 0
        }
      }
      packageSalesMap[key].sales_count++
    })

    const topPackages = Object.values(packageSalesMap)
      .sort((a, b) => b.sales_count - a.sales_count)
      .slice(0, 5)

    // 7. 墨水點數統計
    const { data: allProfiles } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance')

    const totalInkBalance = allProfiles?.reduce((sum, p) => sum + (p.ink_balance || 0), 0) || 0
    const avgInkBalance = allProfiles?.length > 0 ? Math.round(totalInkBalance / allProfiles.length) : 0

    // 8. 最近墨水點數變動記錄
    const { data: recentInkLedger } = await supabaseAdmin
      .from('ink_ledger')
      .select(`
        id,
        user_id,
        delta,
        reason,
        metadata,
        created_at,
        profiles:user_id (
          email,
          name
        )
      `)
      .order('created_at', { ascending: false })
      .limit(50)

    // 9. 用戶成長趨勢
    const { data: userGrowthData } = await supabaseAdmin
      .from('profiles')
      .select('created_at')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

    const dailyNewUsers = {}
    userGrowthData?.forEach(user => {
      const date = user.created_at.split('T')[0]
      dailyNewUsers[date] = (dailyNewUsers[date] || 0) + 1
    })

    const userGrowthArray = Object.entries(dailyNewUsers)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const analytics = {
      overview: {
        totalUsers: totalUsersResult.count || 0,
        activeUsers: activeUsersResult.count || 0,
        totalOrders: totalOrdersResult.count || 0,
        totalRevenue,
        totalInkDistributed,
        totalInkBalance,
        avgInkBalance
      },
      recentUsers: recentUsers || [],
      topUsers: topUsersWithUsage,
      orders: {
        byStatus: ordersByStatus,
        recentRevenue,
        dailyTrend: dailyOrdersArray
      },
      topPackages,
      recentInkLedger: recentInkLedger || [],
      userGrowth: userGrowthArray
    }

    return res.status(200).json(analytics)

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

  if (action === 'aggregate-tags') {
    const context = await requireAdminOrCron(req, res)
    if (!context) return
    return await handleAggregateTags(req, res, context.supabaseAdmin)
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

  if (action === 'tags') {
    return await handleTags(req, res, supabaseAdmin)
  }

  if (action === 'analytics') {
    return await handleAnalytics(req, res, supabaseAdmin)
  }

  res.status(404).json({ error: 'Unknown action' })
}
