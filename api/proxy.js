import { handleCors } from '../server/_cors.js'
// api/proxy.js
// 這段程式碼在 Vercel 的伺服器上執行，前端看不到

// 強制使用 Node.js runtime，避免 Edge runtime 的限制
export const config = {
  runtime: 'nodejs'
}

import { getAuthUser } from '../server/_auth.js'
import { getSupabaseAdmin } from '../server/_supabase.js'
import { getEnvValue } from '../server/_env.js'
import { runAiPipeline } from '../server/ai/orchestrator.js'
import { MODEL_FLASH } from '../server/ai/model-config.js'
import { resolveBillingUserId } from '../server/billing-user.js'
import crypto from 'crypto'

// 🆕 AnswerKey 緩存（按 user + hash 存儲）
// 使用 Map 作為簡單的內存緩存，每個 Vercel 實例獨立
// 實際生產環境可考慮使用 Redis/Upstash
const answerKeyCache = new Map()
const ANSWER_KEY_CACHE_TTL = 30 * 60 * 1000 // 30 分鐘過期

/**
 * 計算 AnswerKey 的 hash（用作緩存 key）
 */
function computeAnswerKeyHash(answerKey) {
  const json = JSON.stringify(answerKey)
  return crypto.createHash('md5').update(json).digest('hex').slice(0, 16)
}

function normalizeAnswerKeyPayload(rawAnswerKey, logPrefix = '[proxy]') {
  if (!rawAnswerKey) return null
  if (typeof rawAnswerKey === 'object') return rawAnswerKey
  if (typeof rawAnswerKey === 'string') {
    const trimmed = rawAnswerKey.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') return parsed
      console.warn(`${logPrefix} answerKey-parse-failed reason=not_object`)
      return null
    } catch (error) {
      console.warn(`${logPrefix} answerKey-parse-failed reason=invalid_json`)
      return null
    }
  }
  console.warn(`${logPrefix} answerKey-parse-failed reason=unsupported_type type=${typeof rawAnswerKey}`)
  return null
}

function readSingleHeaderValue(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

function normalizeGradingPipelineMode(rawMode) {
  const mode = String(rawMode || '')
    .trim()
    .toLowerCase()
  if (!mode) return null
  if (['single', 'single-shot', 'legacy'].includes(mode)) return 'single'
  if (['staged', '4stage', 'four-stage'].includes(mode)) return 'staged'
  if (['auto', 'default'].includes(mode)) return 'auto'
  return null
}

function normalizeReadAnswerSplitMode(rawValue) {
  if (typeof rawValue === 'boolean') return rawValue
  const value = String(rawValue || '')
    .trim()
    .toLowerCase()
  if (!value) return null
  if (['1', 'true', 'on', 'split', 'staged'].includes(value)) return true
  if (['0', 'false', 'off', 'legacy', 'single', 'single-shot'].includes(value)) return false
  return null
}

/**
 * 緩存 AnswerKey
 */
function cacheAnswerKey(userId, hash, answerKey) {
  const cacheKey = `${userId}:${hash}`
  answerKeyCache.set(cacheKey, {
    answerKey,
    expiresAt: Date.now() + ANSWER_KEY_CACHE_TTL
  })
  console.log(`📦 [AnswerKey Cache] 已緩存 ${cacheKey}`)
}

/**
 * 從緩存獲取 AnswerKey
 */
function getCachedAnswerKey(userId, hash) {
  const cacheKey = `${userId}:${hash}`
  const cached = answerKeyCache.get(cacheKey)
  
  if (!cached) {
    console.log(`❌ [AnswerKey Cache] 未找到 ${cacheKey}`)
    return null
  }
  
  if (Date.now() > cached.expiresAt) {
    console.log(`⏰ [AnswerKey Cache] 已過期 ${cacheKey}`)
    answerKeyCache.delete(cacheKey)
    return null
  }
  
  console.log(`✅ [AnswerKey Cache] 命中 ${cacheKey}`)
  return cached.answerKey
}

/**
 * 清理過期的緩存項目（定期執行）
 */
function cleanupExpiredCache() {
  const now = Date.now()
  let cleaned = 0
  for (const [key, value] of answerKeyCache.entries()) {
    if (now > value.expiresAt) {
      answerKeyCache.delete(key)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 [AnswerKey Cache] 清理了 ${cleaned} 個過期項目`)
  }
}

// 每 5 分鐘清理一次過期緩存
setInterval(cleanupExpiredCache, 5 * 60 * 1000)

/**
 * 🆕 將 AnswerKey 注入到 contents 的第一個 text part 中
 * 這樣對 Gemini 模型來說，效果和前端直接傳是一樣的
 */
function injectAnswerKeyToContents(contents, answerKey) {
  // 深拷貝避免修改原始物件
  const newContents = JSON.parse(JSON.stringify(contents))
  
  // 找到第一個 user role 的 message
  for (const content of newContents) {
    if (content.role === 'user' && Array.isArray(content.parts)) {
      // 找到第一個 text part
      for (let i = 0; i < content.parts.length; i++) {
        const part = content.parts[i]
        if (part.text && typeof part.text === 'string') {
          // 在 prompt 開頭注入 AnswerKey JSON
          // 找到適當的注入點（在「標準答案與配分」說明之前）
          const answerKeyJson = JSON.stringify(answerKey)
          const answerKeySection = `
下面是本次作業的標準答案與配分（JSON 格式）：
${answerKeyJson}
`
          // 檢查是否已經有 AnswerKey（避免重複注入）
          if (!part.text.includes('標準答案與配分（JSON 格式）')) {
            // 找到適當的位置插入（在批改流程說明之前）
            const insertMarker = '【批改流程】'
            const insertIndex = part.text.indexOf(insertMarker)
            if (insertIndex > 0) {
              part.text = part.text.slice(0, insertIndex) + answerKeySection + '\n' + part.text.slice(insertIndex)
            } else {
              // 如果找不到標記，在開頭插入
              part.text = answerKeySection + '\n' + part.text
            }
          }
          return newContents
        }
      }
    }
  }
  
  return newContents
}

// 2026-05-22: pricing 常數搬到 server/pricing-config.js 中央化
import {
  INK_EXCHANGE_RATE,
  INPUT_USD_PER_MILLION,
  OUTPUT_USD_PER_MILLION,
  PLATFORM_FEE_TWD
} from '../server/pricing-config.js'
import { trackingContext } from '../server/ink-usage-tracker.js'

function computeInkPoints(usageMetadata) {
  const inputTokens = Number(usageMetadata?.promptTokenCount) || 0
  const outputTokens = Number(usageMetadata?.candidatesTokenCount) || 0
  const totalTokens = Number(usageMetadata?.totalTokenCount) || inputTokens + outputTokens

  const baseUsd =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION
  const baseTwd = baseUsd * INK_EXCHANGE_RATE
  const baseTwdRounded = Math.ceil(baseTwd)
  // 2026-05-22: 拔掉 baseTwd>=1 條件 (跟 ink-session.js 對齊)
  const platformFee = PLATFORM_FEE_TWD
  const points = baseTwdRounded + platformFee

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    baseUsd,
    baseTwd,
    baseTwdRounded,
    platformFee,
    points
  }
}

// Session 有效期限：2 小時
const SESSION_TTL_MINUTES = 120

function createProxyRequestId(req) {
  const headerRequestId = req?.headers?.['x-request-id']
  if (typeof headerRequestId === 'string' && headerRequestId.trim()) {
    return headerRequestId.trim().slice(0, 48)
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function maskUserId(userId) {
  const raw = String(userId || '')
  if (!raw) return 'anonymous'
  return raw.length <= 8 ? raw : `${raw.slice(0, 4)}...${raw.slice(-4)}`
}

async function fetchAnswerSheetImagesForClassify(supabaseAdmin, userId, assignmentId) {
  try {
    const { data: assignment } = await supabaseAdmin
      .from('assignments')
      .select('id, owner_id')
      .eq('id', assignmentId)
      .maybeSingle()
    if (!assignment || assignment.owner_id !== userId) return []

    const startMs = Date.now()
    const bucket = supabaseAdmin.storage.from('homework-images')

    // 先試 page-0，不存在就直接返回（避免白打 9 個 404）
    const { data: first, error: firstErr } = await bucket.download(`answer-sheets/${assignmentId}/page-0.webp`)
    if (firstErr || !first) {
      console.log(`[AnswerSheet] page-0 不存在，跳過，耗時 ${Date.now() - startMs}ms`)
      return []
    }
    const firstBuffer = Buffer.from(await first.arrayBuffer())
    const firstImage = { mimeType: 'image/webp', data: firstBuffer.toString('base64') }

    // page-0 存在，並行下載 page-1 ~ page-9
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, i) => i + 1).map(async (i) => {
        const { data, error } = await bucket.download(`answer-sheets/${assignmentId}/page-${i}.webp`)
        if (error || !data) return null
        const buffer = Buffer.from(await data.arrayBuffer())
        return { mimeType: 'image/webp', data: buffer.toString('base64') }
      })
    )

    const images = [firstImage]
    for (const r of results) {
      const val = r.status === 'fulfilled' ? r.value : null
      if (!val) break
      images.push(val)
    }
    console.log(`[AnswerSheet] 並行下載 ${images.length} 張圖片，耗時 ${Date.now() - startMs}ms`)
    return images
  } catch (err) {
    console.warn('[AnswerSheet] fetchAnswerSheetImagesForClassify failed:', err?.message || err)
    return []
  }
}

async function fetchQuestionBookletImages(supabaseAdmin, userId, assignmentId) {
  try {
    const { data: assignment } = await supabaseAdmin
      .from('assignments')
      .select('id, owner_id, answer_key_template_id')
      .eq('id', assignmentId)
      .maybeSingle()
    if (!assignment || assignment.owner_id !== userId) return []

    const startMs = Date.now()
    const bucket = supabaseAdmin.storage.from('homework-images')

    // 嘗試指定 prefix 下載 page-0 → 19，回傳找到的圖片陣列
    async function downloadFromPrefix(prefix) {
      const { data: first, error: firstErr } = await bucket.download(`${prefix}/page-0.webp`)
      if (firstErr || !first) return null
      const firstBuffer = Buffer.from(await first.arrayBuffer())
      const firstImage = { mimeType: 'image/webp', data: firstBuffer.toString('base64') }

      const results = await Promise.allSettled(
        Array.from({ length: 19 }, (_, i) => i + 1).map(async (i) => {
          const { data, error } = await bucket.download(`${prefix}/page-${i}.webp`)
          if (error || !data) return null
          const buffer = Buffer.from(await data.arrayBuffer())
          return { mimeType: 'image/webp', data: buffer.toString('base64') }
        })
      )

      const images = [firstImage]
      for (const r of results) {
        const val = r.status === 'fulfilled' ? r.value : null
        if (!val) break
        images.push(val)
      }
      return images
    }

    // 1) assignment-level（建作業時當下上傳）
    const assignmentLevel = await downloadFromPrefix(`question-booklets/${assignmentId}`)
    if (assignmentLevel) {
      console.log(`[QuestionBooklet] assignment-level ${assignmentLevel.length} 頁，耗時 ${Date.now() - startMs}ms`)
      return assignmentLevel
    }

    // 2) template-level fallback（透過模板共用、後補上傳）
    const templateId = assignment.answer_key_template_id
    if (templateId) {
      const templateLevel = await downloadFromPrefix(`question-booklets/${templateId}`)
      if (templateLevel) {
        console.log(`[QuestionBooklet] template-level fallback ${templateLevel.length} 頁，耗時 ${Date.now() - startMs}ms`)
        return templateLevel
      }
    }

    console.log(`[QuestionBooklet] 找不到題本（assignment 或 template），耗時 ${Date.now() - startMs}ms`)
    return []
  } catch (err) {
    console.warn('[QuestionBooklet] fetchQuestionBookletImages failed:', err?.message || err)
    return []
  }
}

async function resolveInkSession(supabaseAdmin, userId, inkSessionId) {
  if (!inkSessionId) return { ok: false, reason: 'no_session_id' }

  const { data, error } = await supabaseAdmin
    .from('ink_sessions')
    .select('id, status, expires_at')
    .eq('id', inkSessionId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    console.warn('Ink session query error:', error)
    return { ok: false, reason: 'query_error' }
  }
  
  if (!data) {
    console.warn('Ink session not found:', { inkSessionId, userId })
    return { ok: false, reason: 'not_found' }
  }
  
  if (data.status !== 'active') {
    console.warn('Ink session not active:', { inkSessionId, status: data.status })
    return { ok: false, reason: 'not_active', status: data.status }
  }

  const now = Date.now()
  const expiresAtMs = data.expires_at ? Date.parse(data.expires_at) : NaN
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    return { ok: false, expired: true, reason: 'expired' }
  }

  try {
    // 每次活動時延長 session 過期時間（滾動式延長）
    const newExpiresAt = new Date(now + SESSION_TTL_MINUTES * 60 * 1000).toISOString()
    await supabaseAdmin
      .from('ink_sessions')
      .update({ 
        last_activity_at: new Date().toISOString(),
        expires_at: newExpiresAt  // 延長過期時間
      })
      .eq('id', inkSessionId)
      .eq('user_id', userId)
  } catch (error) {
    console.warn('Ink session activity update failed:', error)
  }

  return { ok: true }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const requestId = createProxyRequestId(req)
  const logPrefix = `[proxy][${requestId}]`
  console.log(`${logPrefix} 收到請求 method=${req.method}`)

  let user = null
  try {
    const result = await getAuthUser(req, res)
    user = result.user
  } catch (error) {
    console.error(`${logPrefix} auth-check-failed`, error?.message || error)
    res.status(500).json({ error: 'Auth check failed' })
    return
  }

  if (!user) {
    console.warn(`${logPrefix} unauthorized`)
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  console.log(`${logPrefix} 認證通過 user=${maskUserId(user.id)}`)

  // AI_ACTIVE_GEMINI_KEY=primary（預設）→ 用 SECRET_API_KEY，備援 SYSTEM_GEMINI_API_KEY
  // AI_ACTIVE_GEMINI_KEY=secondary         → 用 SYSTEM_GEMINI_API_KEY，備援 SECRET_API_KEY
  const activeGeminiKey = (getEnvValue('AI_ACTIVE_GEMINI_KEY') || 'primary').toLowerCase()
  const apiKey =
    activeGeminiKey === 'secondary'
      ? (getEnvValue('SYSTEM_GEMINI_API_KEY') || getEnvValue('SECRET_API_KEY'))
      : (getEnvValue('SECRET_API_KEY') || getEnvValue('SYSTEM_GEMINI_API_KEY'))
  if (!apiKey) {
    const diagnostics = {
      cwd: process.cwd(),
      activeGeminiKey,
      hasSecretApiKeyEnv: typeof process.env.SECRET_API_KEY === 'string',
      secretApiKeyLength: String(process.env.SECRET_API_KEY || '').length,
      hasSystemApiKeyEnv: typeof process.env.SYSTEM_GEMINI_API_KEY === 'string',
      systemApiKeyLength: String(process.env.SYSTEM_GEMINI_API_KEY || '').length,
      hasSecretApiKeyLocal: Boolean(getEnvValue('SECRET_API_KEY')),
      hasSystemApiKeyLocal: Boolean(getEnvValue('SYSTEM_GEMINI_API_KEY'))
    }
    console.error(`${logPrefix} api-key-missing diagnostics:`, diagnostics)
    res.status(500).json({
      error: 'Server API Key missing (SECRET_API_KEY / SYSTEM_GEMINI_API_KEY)',
      diagnostics
    })
    return
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      console.warn(`${logPrefix} bad-request invalid-json-body`)
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }
  }

  const {
    model: requestedModel,
    contents,
    inkSessionId,
    answerKey,
    answerKeyRef,
    routeKey,
    gradingMode: requestedGradingMode,
    readAnswerSplitMode: requestedReadAnswerSplitMode,
    // 內部 routing flag — 拿出來當作 internalContext 的一部分，不可再 forward 到 Gemini
    answerSheetMode: requestedAnswerSheetMode,
    ...payload
  } = body || {}
  // 2026-05-21: model 由 server/ai/model-config.js 統一管理（MODEL_PRO / MODEL_FLASH 2 個 env）
  // orchestrator.executeSinglePipelineCall + staged-grading.executeStage 內部會以 routeKey 查 STAGE_MODEL
  // proxy 層 model 變數只是個 placeholder（傳下去會被 orchestrator 覆寫），給 client 傳什麼都行
  const model = requestedModel || MODEL_FLASH
  const normalizedAnswerKeyPayload = normalizeAnswerKeyPayload(answerKey, logPrefix)
  const headerGradingMode = readSingleHeaderValue(req?.headers?.['x-grading-pipeline-mode'])
  const envGradingMode = getEnvValue('AI_GRADING_PIPELINE_MODE') || process.env.AI_GRADING_PIPELINE_MODE
  const gradingMode =
    normalizeGradingPipelineMode(requestedGradingMode) ||
    normalizeGradingPipelineMode(headerGradingMode) ||
    normalizeGradingPipelineMode(envGradingMode) ||
    'staged' // 預設使用分階段批改流程
  const enableStagedGrading = gradingMode !== 'single'

  const headerSplitMode = readSingleHeaderValue(req?.headers?.['x-read-answer-split-mode'])
  const envSplitMode = getEnvValue('READ_ANSWER_SPLIT_MODE')
  const readAnswerSplitMode =
    normalizeReadAnswerSplitMode(requestedReadAnswerSplitMode) ??
    normalizeReadAnswerSplitMode(headerSplitMode) ??
    normalizeReadAnswerSplitMode(envSplitMode)

  if (!Array.isArray(contents)) {
    console.warn(`${logPrefix} bad-request missing contents`)
    res.status(400).json({ error: 'Missing contents' })
    return
  }
  console.log(
    `${logPrefix} 解析 路由=${routeKey || 'none'} 有答案卷=${Boolean(answerKey)} 有 ref=${Boolean(answerKeyRef)} 批改模式=${gradingMode}${enableStagedGrading ? ' 階段化' : ''}（實際 model 由 routeKey 查 STAGE_MODEL）`
  )

  // 🆕 處理 AnswerKey 緩存邏輯
  let resolvedAnswerKey = null
  let answerKeyHash = null
  
  if (normalizedAnswerKeyPayload) {
    // 前端傳來完整 AnswerKey：緩存並返回 hash
    answerKeyHash = computeAnswerKeyHash(normalizedAnswerKeyPayload)
    cacheAnswerKey(user.id, answerKeyHash, normalizedAnswerKeyPayload)
    resolvedAnswerKey = normalizedAnswerKeyPayload
    console.log(`📥 [AnswerKey] 收到完整 AnswerKey，hash=${answerKeyHash}`)
  } else if (answerKeyRef) {
    // 前端傳來 hash 引用：從緩存獲取
    const cachedAnswerKey = getCachedAnswerKey(user.id, answerKeyRef)
    resolvedAnswerKey = normalizeAnswerKeyPayload(cachedAnswerKey, logPrefix)
    if (!resolvedAnswerKey) {
      console.warn(`⚠️ [AnswerKey] 緩存未命中 ref=${answerKeyRef}，請求前端重傳`)
      res.status(422).json({ 
        error: 'AnswerKey cache miss or invalid format',
        code: 'ANSWER_KEY_CACHE_MISS_OR_INVALID',
        answerKeyRef 
      })
      return
    }
    // 將舊格式（字串）緩存回寫為物件，避免後續再解析失敗
    cacheAnswerKey(user.id, answerKeyRef, resolvedAnswerKey)
    answerKeyHash = answerKeyRef
    console.log(`📤 [AnswerKey] 使用緩存 AnswerKey，ref=${answerKeyRef}`)
  } else if (answerKey) {
    // 有傳 answerKey 但格式不合法（例如非法字串）
    console.warn(`${logPrefix} bad-request invalid-answerKey-format type=${typeof answerKey}`)
    res.status(400).json({
      error: 'Invalid answerKey format. Must be object or JSON-object string.'
    })
    return
  }

  // 🆕 AnswerKey 注入延後到「billing 解析之後」再做。
  // 原因（2026-06-02 學生自助批改）：injectAnswerKeyToContents 會就地改寫 contents，
  // 且學生 actor 一律不可信任 client 傳的 answerKey（會被用來灌假正解作弊）。
  // 必須先知道 isStudentActor / billingUserId，才能決定「用 client key（老師）還是 server live key（學生）」。
  let processedContents = contents

  let supabaseAdmin = null
  let currentBalance = 0
  let isAdmin = false
  let hasValidInkSession = false
  // 計費對象：學生 → 老師 owner_id；老師/admin → 自己
  // 「老師付費、學生免費」的核心：所有 balance check / deduction 都對 billingUserId 做
  let billingUserId = user.id
  let actorUserId = user.id
  let isStudentActor = false
  try {
    supabaseAdmin = getSupabaseAdmin()

    const billing = await resolveBillingUserId(supabaseAdmin, user.id)
    billingUserId = billing.billingUserId
    actorUserId = billing.actorUserId
    isStudentActor = billing.isStudent

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance, role')
      .eq('id', billingUserId)
      .maybeSingle()

    if (profileError) {
      console.error(`${logPrefix} profile-read-failed`, profileError?.message || profileError)
      res.status(500).json({ error: '讀取使用者點數失敗' })
      return
    }

    isAdmin = profile?.role === 'admin'
    currentBalance =
      typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0

    if (isStudentActor) {
      console.log(`${logPrefix} billing-routed student actor=${actorUserId.slice(0, 8)}... → teacher=${billingUserId.slice(0, 8)}... balance=${currentBalance}`)
    }

    if (inkSessionId) {
      try {
        // session 仍以 actor（學生本人）為 key — 一個老師可能同時有多個學生在批改、
        // 各自的 usage 透過自己的 session 分開記
        const sessionCheck = await resolveInkSession(
          supabaseAdmin,
          actorUserId,
          inkSessionId
        )
        if (!sessionCheck.ok) {
          let message = '批改會話無效，請重新進入批改頁'
          if (sessionCheck.expired) {
            message = '批改會話已過期，請重新進入批改頁'
          } else if (sessionCheck.reason === 'not_active') {
            message = `批改會話已結束（狀態：${sessionCheck.status}），請重新進入批改頁`
          } else if (sessionCheck.reason === 'not_found') {
            message = '批改會話不存在，請重新進入批改頁'
          }
          console.warn(`${logPrefix} ink-session-invalid reason=${sessionCheck.reason} sessionId=${inkSessionId}`)
          res.status(409).json({ error: message })
          return
        }
        hasValidInkSession = true
      } catch (error) {
        console.warn('Ink session check failed:', error)
        res.status(500).json({ error: '批改會話驗證失敗，請稍後再試' })
        return
      }
    }

    if (!isAdmin && !hasValidInkSession && currentBalance <= 0) {
      const message = inkSessionId
        ? '批改會話已結束或點數不足，請重新進入或補充墨水'
        : '墨水不足，請先補充墨水'
      console.warn(`${logPrefix} insufficient-ink balance=${currentBalance} hasSession=${Boolean(inkSessionId)}`)
      res.status(402).json({ error: message })
      return
    }
  } catch (error) {
    console.error(`${logPrefix} ink-check-failed`, error?.message || error)
    res.status(500).json({ error: '點數檢查失敗' })
    return
  }

  // ── §0 答案外洩防護 + AnswerKey 注入（延後到 billing 解析後）─────────────────
  // 學生 actor：一律忽略 client 傳的 answerKey（可能灌假正解作弊），改由 server 依
  // assignmentId + billingUserId(老師 owner_id) 撈 live answerKey 注入。撈不到就不注入
  // （寧可批改缺答案卷失敗、也不外洩/不採信 client）。老師/admin：維持用 client resolvedAnswerKey。
  const isGradingRoute = typeof routeKey === 'string' && routeKey.startsWith('grading.')
  if (isStudentActor && isGradingRoute && payload?.assignmentId) {
    resolvedAnswerKey = null
    answerKeyHash = null
    try {
      const { data: a } = await supabaseAdmin
        .from('assignments')
        .select('owner_id, answer_key')
        .eq('id', payload.assignmentId)
        .maybeSingle()
      if (a && a.owner_id === billingUserId && a.answer_key) {
        resolvedAnswerKey = normalizeAnswerKeyPayload(a.answer_key, logPrefix)
        if (resolvedAnswerKey) {
          console.log(`📥 [AnswerKey] 學生路徑 server 注入 live answerKey assignmentId=${payload.assignmentId}`)
        }
      } else {
        console.warn(`${logPrefix} student-answerkey-inject-skip reason=${!a ? 'no_assignment' : a.owner_id !== billingUserId ? 'owner_mismatch' : 'no_answer_key'}`)
      }
    } catch (e) {
      console.warn(`${logPrefix} student-answerkey-inject-failed`, e?.message || e)
    }
  }
  if (resolvedAnswerKey) {
    processedContents = injectAnswerKeyToContents(contents, resolvedAnswerKey)
  }

  // ── 答案卷參考圖（Phase A classify 使用）────────────────────────────────────
  let answerKeyImages = []
  let assignmentTotalPages = null  // 🆕 用於 staged-grading.js 判定是否該按 ID 切頁
  // 2026-05-25: Phase A 拆 3 個 route 後、原本只認 'grading.phase_a' 條件失效
  //   → classify call (grading.phase_a_classify) 拿不到 assignmentTotalPages
  //   → staged-grading.js fallback 按題號 prefix 切頁、單頁多 section 卷被切成薄條紋
  //   → AI 看不到完整題目、CLASSIFY_LOW_COVERAGE。
  // 修：classify 與 legacy phase_a 兩條都要拿。
  // 重踩 feedback_dont_infer_total_pages_from_question_ids.md 的雷。
  const needsAnswerKeyImagesAndTotalPages =
    routeKey === 'grading.phase_a' || routeKey === 'grading.phase_a_classify'
  if (needsAnswerKeyImagesAndTotalPages && payload?.assignmentId) {
    answerKeyImages = await fetchAnswerSheetImagesForClassify(
      // 2026-06-02: 用 billingUserId（學生→老師 owner_id）比對 owner_id，否則學生發起的
      // answer_only 批改抓不到答案卷圖（owner_id !== 學生 user.id → 回 []）。老師自批 billingUserId===user.id 不變。
      supabaseAdmin, billingUserId, payload.assignmentId
    )
    if (answerKeyImages.length > 0) {
      console.log(`📷 [AnswerSheet] 載入 ${answerKeyImages.length} 頁答案卷圖 assignmentId=${payload.assignmentId} routeKey=${routeKey}`)
    }
    // 🆕 拿 total_pages：staged-grading 用此判定「單頁多 section 卷」、跳過 ID 自動切頁
    try {
      const { data: a } = await supabaseAdmin
        .from('assignments')
        .select('total_pages')
        .eq('id', payload.assignmentId)
        .maybeSingle()
      if (a?.total_pages != null) assignmentTotalPages = Number(a.total_pages)
    } catch (e) {
      console.warn('[AnswerSheet] fetch total_pages failed:', e?.message)
    }
  }

  // ── 題本圖（Phase B explain 使用，answer_only 模式下需要題本圖來讀題目）────
  const answerSheetMode = requestedAnswerSheetMode || 'with_questions'
  let questionBookletImages = []
  if (routeKey === 'grading.phase_b' && answerSheetMode === 'answer_only' && payload?.assignmentId) {
    questionBookletImages = await fetchQuestionBookletImages(
      // 2026-06-02: 同上，用 billingUserId 比對 owner_id（學生自助批改 answer_only 需題本圖）。
      supabaseAdmin, billingUserId, payload.assignmentId
    )
    if (questionBookletImages.length > 0) {
      console.log(`📖 [QuestionBooklet] 載入 ${questionBookletImages.length} 頁題本圖 assignmentId=${payload.assignmentId}`)
    }
  }

  try {
    // 2026-05-22: trackingContext 把 user / billing / admin / session 等 ALS 鋪好
    // 各層 callGeminiGenerateContent 完成後可直接呼叫 recordTokenUsage()、不必每層手動傳
    const pipelineResult = await trackingContext.run(
      {
        supabaseAdmin,
        actorUserId,
        billingUserId,
        isAdmin,
        inkSessionId,
        // 2026-05-23: 帶 assignment/submission 給 recordTokenUsage 寫入 ink_session_usage
        assignmentId: payload?.assignmentId || undefined,
        submissionId: payload?.submissionId || undefined
      },
      () =>
        runAiPipeline({
          apiKey,
          model,
          contents: processedContents,
          payload,
          requestedRouteKey: routeKey,
          routeHint: {
            hasResolvedAnswerKey: Boolean(resolvedAnswerKey),
            hasAnswerKeyRef: Boolean(answerKeyRef),
            hasAnswerKeyPayload: Boolean(normalizedAnswerKeyPayload)
          },
          internalContext: {
            resolvedAnswerKey,
            requestId,
            enableStagedGrading,
            gradingMode,
            readAnswerSplitMode,
            answerKeyImages,
            answerSheetMode,
            questionBookletImages,
            domainHint: payload?.domain || undefined,
            ownerId: user.id,
            assignmentId: payload?.assignmentId || undefined,
            submissionId: payload?.submissionId || undefined,
            assignmentTotalPages  // 🆕 給 staged-grading 判定 ID 自動切頁
          }
        })
    )

    const responseStatus = Number(pipelineResult.status) || 500
    const responseOk = responseStatus >= 200 && responseStatus < 300
    const data = pipelineResult.data

    // 🆕 返回 answerKeyHash 給前端（用於後續請求）
    if (responseOk && answerKeyHash && data && typeof data === 'object') {
      data.answerKeyHash = answerKeyHash
    }

    if (responseOk && data?.usageMetadata) {
      try {
        const cost = computeInkPoints(data.usageMetadata)
        let inkSummary = null

        // 2026-05-22: ink_session_usage 寫入下沉到各 AI call 層（executeStage /
        // executeSinglePipelineCall / applyMathEqBlankOverride）透過 trackingContext.run
        // 取得 actor/billing/admin/session、避免本層 aggregated 寫 + 雙寫
        if (isAdmin) {
          inkSummary = { chargedPoints: 0, balanceBefore: currentBalance, balanceAfter: currentBalance, applied: true, adminBypass: true }
        } else if (hasValidInkSession && inkSessionId) {
          // 真實扣款在 session 結算時、由 settleInkSession 累加 ink_session_usage 所有 row
          inkSummary = {
            pending: true,
            sessionId: inkSessionId
          }
        }

        if (!inkSummary) {
          if (cost.points > 0) {
            // floor at 0：避免 cost > balance 時把餘額扣成負數
            // 真正的 "balance ≤ 0 不准呼叫" 守在前面的 proxy.js:578 那層
            const nextBalance = Math.max(0, currentBalance - cost.points)
            const { error: updateError } = await supabaseAdmin
              .from('profiles')
              .update({
                ink_balance: nextBalance,
                updated_at: new Date().toISOString()
              })
              .eq('id', billingUserId)

            if (updateError) {
              console.warn('Ink balance update failed:', updateError)
              inkSummary = {
                chargedPoints: cost.points,
                balanceBefore: currentBalance,
                balanceAfter: currentBalance,
                applied: false
              }
            } else {
              inkSummary = {
                chargedPoints: cost.points,
                balanceBefore: currentBalance,
                balanceAfter: nextBalance,
                applied: true
              }
            }

            const { error: ledgerError } = await supabaseAdmin.from('ink_ledger').insert({
              user_id: billingUserId,
              delta: -cost.points,
              reason: 'gemini_generate_content',
              metadata: {
                model: model,
                usage: data.usageMetadata,
                cost,
                inkSessionId: inkSessionId || null,
                actorUserId,                    // 實際發出 request 的人（學生時與 user_id 不同）
                billedTo: isStudentActor ? 'teacher_owner' : 'self'
              }
            })

            if (ledgerError) {
              console.warn('Ink ledger insert failed:', ledgerError)
            }
          } else {
            inkSummary = {
              chargedPoints: 0,
              balanceBefore: currentBalance,
              balanceAfter: currentBalance,
              applied: true
            }
          }
        }

        if (inkSummary && data && typeof data === 'object') {
          data.ink = inkSummary
        }
      } catch (error) {
        console.warn('Ink billing failed:', error)
      }
    }

    console.log(
      `${logPrefix} 回應 status=${responseStatus} 路由=${pipelineResult.resolvedRouteKey} pipeline=${pipelineResult.pipelineMeta?.pipeline || 'unknown'}`
    )

    // 批改結果摘要 log（grading.evaluate 時才輸出）
    if (responseOk && pipelineResult.resolvedRouteKey === 'grading.evaluate' && data) {
      const details = Array.isArray(data.details) ? data.details : []
      const correctCount = details.filter((d) => d.isCorrect === true).length
      const wrongCount = details.length - correctCount
      const perQ = details
        .map((d) => `${d.questionId}:${d.isCorrect ? '✓' : '✗'}${d.score}/${d.maxScore}`)
        .join(' ')
      console.log(
        `${logPrefix} grading-summary totalScore=${data.totalScore} questions=${details.length} correct=${correctCount} wrong=${wrongCount} needsReview=${Boolean(data.needsReview)}`
      )
      if (perQ) {
        console.log(`${logPrefix} grading-per-question ${perQ}`)
      }
      if (Array.isArray(data.reviewReasons) && data.reviewReasons.length > 0) {
        console.log(`${logPrefix} grading-review-reasons ${data.reviewReasons.join(' | ')}`)
      }
    }

    res.status(responseStatus).json(data)
  } catch (error) {
    console.error(`${logPrefix} request-failed`, error)
    if (Number(error?.status) === 504) {
      res.status(504).json({ error: 'Gemini request timeout' })
      return
    }
    // technical: 給前端藏在「技術資訊」摺疊區＋遠端除錯用（vertex 認證失敗等 exception 才看得到根因）
    res.status(500).json({
      error: 'Failed to fetch Gemini API',
      technical: String(error?.message || error).slice(0, 300)
    })
  }
}
