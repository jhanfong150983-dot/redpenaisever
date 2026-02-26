import { handleCors } from '../server/_cors.js'
// api/proxy.js
// 這段程式碼在 Vercel 的伺服器上執行，前端看不到

// 強制使用 Node.js runtime，避免 Edge runtime 的限制
export const config = {
  runtime: 'nodejs',
  maxDuration: 60  // 允許最多 60 秒（Vercel Pro 限制）
}

import { getAuthUser } from '../server/_auth.js'
import { getSupabaseAdmin } from '../server/_supabase.js'
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

const INK_EXCHANGE_RATE = 33
const INPUT_USD_PER_MILLION = 0.5
const OUTPUT_USD_PER_MILLION = 3
const PLATFORM_FEE_TWD = 1

function computeInkPoints(usageMetadata) {
  const inputTokens = Number(usageMetadata?.promptTokenCount) || 0
  const outputTokens = Number(usageMetadata?.candidatesTokenCount) || 0
  const totalTokens = Number(usageMetadata?.totalTokenCount) || inputTokens + outputTokens

  const baseUsd =
    (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION
  const baseTwd = baseUsd * INK_EXCHANGE_RATE
  const baseTwdRounded = Math.ceil(baseTwd)
  const platformFee = baseTwd >= 1 ? PLATFORM_FEE_TWD : 0
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

  let user = null
  try {
    const result = await getAuthUser(req, res)
    user = result.user
  } catch (error) {
    res.status(500).json({ error: 'Auth check failed' })
    return
  }

  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const apiKey = process.env.SECRET_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'Server API Key missing' })
    return
  }

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }
  }

  const { model, contents, inkSessionId, answerKey, answerKeyRef, ...payload } = body || {}
  if (!model || !Array.isArray(contents)) {
    res.status(400).json({ error: 'Missing model or contents' })
    return
  }

  // 🆕 處理 AnswerKey 緩存邏輯
  let resolvedAnswerKey = null
  let answerKeyHash = null
  
  if (answerKey) {
    // 前端傳來完整 AnswerKey：緩存並返回 hash
    answerKeyHash = computeAnswerKeyHash(answerKey)
    cacheAnswerKey(user.id, answerKeyHash, answerKey)
    resolvedAnswerKey = answerKey
    console.log(`📥 [AnswerKey] 收到完整 AnswerKey，hash=${answerKeyHash}`)
  } else if (answerKeyRef) {
    // 前端傳來 hash 引用：從緩存獲取
    resolvedAnswerKey = getCachedAnswerKey(user.id, answerKeyRef)
    if (!resolvedAnswerKey) {
      console.warn(`⚠️ [AnswerKey] 緩存未命中 ref=${answerKeyRef}，請求前端重傳`)
      res.status(422).json({ 
        error: 'AnswerKey cache miss', 
        code: 'ANSWER_KEY_CACHE_MISS',
        answerKeyRef 
      })
      return
    }
    answerKeyHash = answerKeyRef
    console.log(`📤 [AnswerKey] 使用緩存 AnswerKey，ref=${answerKeyRef}`)
  }

  // 🆕 如果有 AnswerKey，注入到 prompt 中
  let processedContents = contents
  if (resolvedAnswerKey) {
    processedContents = injectAnswerKeyToContents(contents, resolvedAnswerKey)
  }

  const modelPath = String(model).startsWith('models/')
    ? String(model)
    : `models/${model}`
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`

  let supabaseAdmin = null
  let currentBalance = 0
  let hasValidInkSession = false
  try {
    supabaseAdmin = getSupabaseAdmin()
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('ink_balance')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) {
      res.status(500).json({ error: '讀取使用者點數失敗' })
      return
    }

    currentBalance =
      typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0

    if (inkSessionId) {
      try {
        const sessionCheck = await resolveInkSession(
          supabaseAdmin,
          user.id,
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

    if (!hasValidInkSession && currentBalance <= 0) {
      const message = inkSessionId
        ? '批改會話已結束或點數不足，請重新進入或補充墨水'
        : '墨水不足，請先補充墨水'
      res.status(402).json({ error: message })
      return
    }
  } catch (error) {
    res.status(500).json({ error: '點數檢查失敗' })
    return
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: processedContents, ...payload })
    })

    const text = await response.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }

    // 🆕 返回 answerKeyHash 給前端（用於後續請求）
    if (response.ok && answerKeyHash && data && typeof data === 'object') {
      data.answerKeyHash = answerKeyHash
    }

    if (response.ok && data?.usageMetadata) {
      try {
        const cost = computeInkPoints(data.usageMetadata)
        let inkSummary = null
        if (hasValidInkSession && inkSessionId) {
          const { error: usageError } = await supabaseAdmin
            .from('ink_session_usage')
            .insert({
              user_id: user.id,
              session_id: inkSessionId,
              input_tokens: cost.inputTokens,
              output_tokens: cost.outputTokens,
              total_tokens: cost.totalTokens,
              usage_metadata: data.usageMetadata
            })

          if (usageError) {
            console.warn('Ink session usage insert failed:', usageError)
          } else {
            inkSummary = {
              pending: true,
              sessionId: inkSessionId
            }
          }
        }

        if (!inkSummary) {
          if (cost.points > 0) {
            const nextBalance = currentBalance - cost.points
            const { error: updateError } = await supabaseAdmin
              .from('profiles')
              .update({
                ink_balance: nextBalance,
                updated_at: new Date().toISOString()
              })
              .eq('id', user.id)

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
              user_id: user.id,
              delta: -cost.points,
              reason: 'gemini_generate_content',
              metadata: {
                model: model,
                usage: data.usageMetadata,
                cost,
                inkSessionId: inkSessionId || null
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

    res.status(response.ok ? 200 : response.status).json(data)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Gemini API' })
  }
}
