/**
 * GET /api/auth/1campus?code=XXX&dsns=YYY            → Phase 1: 1Campus SSO 入口
 * GET /api/auth/1campus?__step=oauth&dsns=YYY         → Phase 2a: OAuth 授權啟動
 * GET /api/auth/1campus?__step=oauth_callback&...     → Phase 2b: OAuth 授權回呼
 *
 * 外部 URL 相容（透過 Vercel rewrites 轉入此 handler）：
 *   /api/auth/1campus-oauth-callback → /api/auth/1campus?__step=oauth_callback
 *   /api/oauth/callback              → /api/auth/1campus?__step=oauth_callback
 */
import crypto from 'crypto'
import { handleCors } from '../../server/_cors.js'
import {
  setAuthCookies,
  isSecureRequest,
  parseCookies,
  getAuthUser
} from '../../server/_auth.js'
import {
  getSupabaseAdmin,
  getSupabaseUrl,
  getSupabaseServiceRoleKey
} from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import {
  isValidDsns,
  fetchCampus1Identity,
  buildCampus1VirtualEmail,
  buildCampus1DisplayName,
  exchangeCampus1OAuthCode,
  fetchCampus1UserInfo
} from '../../server/_1campus.js'

// ============================================================
// 常數
// ============================================================

const CAMPUS1_OAUTH_AUTHORIZE = 'https://auth.ischool.com.tw/oauth/authorize.php'
const STATE_COOKIE_NAME = 'rp-campus1-state'
const STATE_TTL_SECONDS = 600

// ============================================================
// 共用工具函數
// ============================================================

function getStringParam(req, name) {
  const val = req.query?.[name]
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val)) return String(val[0] || '').trim()
  return ''
}

function getFrontendUrl(req) {
  const frontendUrl = getEnvValue('FRONTEND_URL')
  if (frontendUrl) return frontendUrl.replace(/\/+$/, '')

  const host = String(req.headers?.host || '').toLowerCase()
  if (host.includes('localhost:3000') || host.includes('127.0.0.1:3000')) {
    return 'http://localhost:5173'
  }

  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}

function getOAuthCallbackUrl(req) {
  const fromEnv = getEnvValue('CAMPUS1_OAUTH_CALLBACK')
  if (fromEnv) return fromEnv

  const proto = req.headers?.['x-forwarded-proto'] || 'http'
  const host = req.headers?.host || 'localhost:3000'
  // 使用 Vercel rewrite 相容的 URL（外部 OAuth 註冊使用此路徑）
  return `${proto}://${host}/api/auth/1campus-oauth-callback`
}

function getCookieSettings(secure) {
  const sameSite = getEnvValue('AUTH_COOKIE_SAME_SITE') || 'Lax'
  const domain = (getEnvValue('AUTH_COOKIE_DOMAIN') || '').trim()
  const effectiveSecure = sameSite.toLowerCase() === 'none' ? true : secure
  return { sameSite, domain, effectiveSecure }
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie])
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie])
  } else {
    res.setHeader('Set-Cookie', [existing, cookie])
  }
}

function serializeStateCookie(value, secure) {
  const { sameSite, domain, effectiveSecure } = getCookieSettings(secure)
  const parts = [
    `${STATE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    `Max-Age=${STATE_TTL_SECONDS}`,
    'Path=/',
    `SameSite=${sameSite}`,
    'HttpOnly'
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (effectiveSecure) parts.push('Secure')
  return parts.join('; ')
}

function clearStateCookie(res, secure) {
  const { sameSite, domain, effectiveSecure } = getCookieSettings(secure)
  const parts = [
    `${STATE_COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    `SameSite=${sameSite}`,
    'HttpOnly'
  ]
  if (domain) parts.push(`Domain=${domain}`)
  if (effectiveSecure) parts.push('Secure')
  appendSetCookie(res, parts.join('; '))
}

function ssoErrorRedirect(res, frontendUrl, errorCode) {
  res.writeHead(302, { Location: `${frontendUrl}?sso_error=${errorCode}` })
  res.end()
}

// ============================================================
// 共用 DB 工具
// ============================================================

/**
 * 建立 Supabase 使用者 Session（generateLink → verify OTP）
 * 後端直接取得 session，不寄出 email
 */
async function createSessionForEmail(email) {
  const supabaseAdmin = getSupabaseAdmin()
  const supabaseUrl = getSupabaseUrl()
  const serviceRoleKey = getSupabaseServiceRoleKey()

  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email
    })

  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(`生成登入連結失敗: ${linkError?.message || 'no OTP'}`)
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'email',
      email,
      token: linkData.properties.email_otp
    })
  })

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    throw new Error(
      errData?.error_description || errData?.error || '建立會話失敗'
    )
  }

  return response.json()
}

// ============================================================
// Phase 1：1Campus SSO 入口
// ============================================================

async function handlePhase1(req, res) {
  const frontendUrl = getFrontendUrl(req)

  const code = getStringParam(req, 'code')
  const dsns = getStringParam(req, 'dsns')

  if (!code || code.length > 512) {
    ssoErrorRedirect(res, frontendUrl, 'invalid_params')
    return
  }

  if (!dsns || !isValidDsns(dsns)) {
    ssoErrorRedirect(res, frontendUrl, 'invalid_params')
    return
  }

  let identity
  try {
    identity = await fetchCampus1Identity(dsns, code)
  } catch (err) {
    console.error('[1campus SSO] Identity API failed:', err?.message)
    ssoErrorRedirect(res, frontendUrl, 'identity_failed')
    return
  }

  if (identity?.roleType !== 'teacher' && identity?.roleType !== 'student') {
    ssoErrorRedirect(res, frontendUrl, 'unsupported_role')
    return
  }

  const isStudent = identity.roleType === 'student'
  const account = String(identity.account || '').trim()
  if (!account) {
    ssoErrorRedirect(res, frontendUrl, 'identity_failed')
    return
  }

  // Log raw identity for diagnosing missing teacherID
  console.log('[1campus Phase1] raw identity keys:', Object.keys(identity || {}))
  console.log('[1campus Phase1] raw identity (truncated):', JSON.stringify(identity).slice(0, 600))

  // teacherID / studentID 可能在頂層或嵌套物件中（依 1campus API 版本而異）
  const rawTeacherID = identity.teacherID ?? identity.teacher?.teacherID ?? null
  const teacherID = rawTeacherID != null && rawTeacherID !== '' ? String(rawTeacherID).trim() : ''
  const rawStudentID = identity.studentID ?? identity.student?.studentID ?? null
  const studentID = rawStudentID != null && rawStudentID !== '' ? String(rawStudentID).trim() : ''
  const rawStudentNumber = identity.studentNumber ?? identity.student?.studentNumber ?? null
  const studentNumber = rawStudentNumber != null && rawStudentNumber !== '' ? String(rawStudentNumber).trim() : ''
  const rawStudentClassID = identity.classID ?? identity.student?.classID ?? null
  const studentClassID = rawStudentClassID != null && rawStudentClassID !== '' ? String(rawStudentClassID).trim() : ''
  const rawStudentSeatNo = identity.seatNo ?? identity.student?.seatNo ?? null
  const parsedStudentSeatNo = Number(rawStudentSeatNo)
  const studentSeatNo = Number.isFinite(parsedStudentSeatNo) && parsedStudentSeatNo > 0 ? parsedStudentSeatNo : 0
  const rawStudentClassName = identity.className ?? identity.student?.className ?? null
  const studentClassName = rawStudentClassName != null && rawStudentClassName !== '' ? String(rawStudentClassName).trim() : ''
  const rawStudentClassNo = identity.classNo ?? identity.student?.classNo ?? null
  const studentClassNo = rawStudentClassNo != null && rawStudentClassNo !== '' ? String(rawStudentClassNo).trim() : ''
  console.log('[1campus Phase1] identity fields:', {
    account,
    teacherID,
    studentID,
    studentNumber,
    studentClassID,
    studentSeatNo,
    roleType: identity.roleType
  })
  const studentMeta = isStudent
    ? {
        ...(studentID ? { studentID } : {}),
        ...(studentNumber ? { studentNumber } : {}),
        ...(studentClassID ? { classID: studentClassID } : {}),
        ...(studentClassName ? { className: studentClassName } : {}),
        ...(studentClassNo ? { classNo: studentClassNo } : {}),
        ...(studentSeatNo > 0 ? { seatNo: studentSeatNo } : {})
      }
    : null
  const displayName = buildCampus1DisplayName(identity)
  const virtualEmail = buildCampus1VirtualEmail(account, dsns)
  const supabaseAdmin = getSupabaseAdmin()
  const nowIso = new Date().toISOString()

  let userId
  try {
    const { data: existingIdentity, error: identityError } =
      await supabaseAdmin
        .from('external_identities')
        .select('user_id, provider_meta')
        .eq('provider', 'campus1')
        .eq('provider_account', account)
        .maybeSingle()

    if (identityError) throw new Error('查詢身份記錄失敗')

    if (existingIdentity) {
      userId = existingIdentity.user_id
      const updatedMeta = {
        ...(existingIdentity.provider_meta || {}),
        ...(isStudent ? studentMeta : { teacherID }),
        displayName,
        dsns,
        roleType: identity.roleType,
        lastLoginAt: nowIso
      }
      await supabaseAdmin
        .from('external_identities')
        .update({ provider_meta: updatedMeta, updated_at: nowIso })
        .eq('provider', 'campus1')
        .eq('provider_account', account)

      // 補建遺失的 profile（profile 可能被手動刪除或當初建立失敗）
      const { data: existingProfileCheck } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .maybeSingle()

      if (!existingProfileCheck) {
        console.log('[1campus Phase1] profile missing for existing identity, repairing:', userId)
        const { data: authUserData } = await supabaseAdmin.auth.admin.getUserById(userId)
        const repairEmail = authUserData?.user?.email || virtualEmail
        const { error: repairProfileError } = await supabaseAdmin
          .from('profiles')
          .upsert({
            id: userId,
            email: repairEmail,
            name: displayName,
            role: 'user',
            permission_tier: 'basic',
            ink_balance: isStudent ? 0 : 10,
            updated_at: nowIso
          }, { onConflict: 'id', ignoreDuplicates: true })
        if (repairProfileError) {
          console.warn('[1campus Phase1] profile repair failed:', repairProfileError.message)
        }
      }
    } else {
      const { data: existingProfile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('email', virtualEmail)
        .maybeSingle()

      // 備援：同一學生可能從不同 dsns 登入，virtualEmail 不同但 smail email 相同。
      // 透過 students 表找出已存在的 auth_user_id，避免替同一學生建立多個帳號。
      let existingStudentUserId = null
      if (!existingProfile && isStudent && account) {
        const smailCandidate = (() => {
          // 若 account 已是完整 email（含 @），直接使用
          if (account.includes('@')) return account.toLowerCase()
          // 否則嘗試從 smail 格式推導（account@smail.{dsns}）
          return `${account.toLowerCase()}@smail.${dsns}`
        })()
        const { data: matchedStudent } = await supabaseAdmin
          .from('students')
          .select('auth_user_id')
          .eq('email', smailCandidate)
          .not('auth_user_id', 'is', null)
          .maybeSingle()
        if (matchedStudent?.auth_user_id) {
          existingStudentUserId = matchedStudent.auth_user_id
          console.log('[1campus Phase1] found existing student user via smail email:', smailCandidate, '→', existingStudentUserId)
        }
      }

      if (existingProfile) {
        userId = existingProfile.id
      } else if (existingStudentUserId) {
        userId = existingStudentUserId
      } else {
        const { data: newUserData, error: createError } =
          await supabaseAdmin.auth.admin.createUser({
            email: virtualEmail,
            email_confirm: true,
            user_metadata: { full_name: displayName }
          })

        if (createError) throw new Error(`建立帳號失敗: ${createError.message}`)
        userId = newUserData.user.id

        const { error: profileError } = await supabaseAdmin
          .from('profiles')
          .upsert({
            id: userId,
            email: virtualEmail,
            name: displayName,
            role: 'user',
            permission_tier: 'basic',
            ink_balance: isStudent ? 0 : 10,
            updated_at: nowIso
          }, { onConflict: 'id', ignoreDuplicates: true })

        if (profileError) {
          console.warn('[1campus SSO] Profile upsert failed:', profileError.message)
        }
      }

      const meta = {
        ...(isStudent ? studentMeta : { teacherID }),
        displayName,
        dsns,
        roleType: identity.roleType,
        lastLoginAt: nowIso
      }
      const { error: insertError } = await supabaseAdmin
        .from('external_identities')
        .insert({
          user_id: userId,
          provider: 'campus1',
          provider_account: account,
          provider_dsns: dsns,
          provider_meta: meta
        })

      if (insertError) throw new Error(`建立身份記錄失敗: ${insertError.message}`)
    }
  } catch (err) {
    console.error('[1campus SSO] findOrCreateUser failed:', err?.message)
    const isRateLimit = /429|rate.?limit|too.?many/i.test(err?.message || '')
    ssoErrorRedirect(res, frontendUrl, isRateLimit ? 'system_busy' : 'create_user_failed')
    return
  }

  // 學生：綁定 auth_user_id（多層備援，避免單一鍵值不一致）
  if (isStudent) {
    try {
      const matchedMap = new Map()
      const normalizedAccountEmail = account.toLowerCase()
      let studentNumberLookupAvailable = true
      const pushMatches = (rows) => {
        for (const row of rows || []) {
          if (!row?.id || !row?.owner_id) continue
          matchedMap.set(`${row.owner_id}::${row.id}`, row)
        }
      }

      const fetchStudents = async (label, builder) => {
        try {
          const { data, error } = await builder()
          const errMsg = String(error?.message || '').toLowerCase()
          if (error) {
            if (
              label === 'student_number' &&
              errMsg.includes('student_number') &&
              (
                errMsg.includes('does not exist') ||
                errMsg.includes('schema cache') ||
                errMsg.includes("could not find")
              )
            ) {
              studentNumberLookupAvailable = false
              console.log('[1campus SSO] student_number lookup skipped: column not exists')
              return []
            }
            console.warn(`[1campus SSO] Student lookup failed(${label}):`, error.message)
            return []
          }
          return data || []
        } catch (err) {
          console.warn(`[1campus SSO] Student lookup exception(${label}):`, err?.message)
          return []
        }
      }

      if (studentID) {
        const byProviderStudentId = await fetchStudents('provider_student_id', () =>
          supabaseAdmin
            .from('students')
            .select('id, owner_id, auth_user_id, email, provider_student_id')
            .eq('provider_student_id', studentID)
        )
        pushMatches(byProviderStudentId)
      }

      // 備援 1：用 1Campus account(email) 直接匹配 students.email
      if (matchedMap.size === 0 && normalizedAccountEmail.includes('@')) {
        const byAccountEmail = await fetchStudents('email', () =>
          supabaseAdmin
            .from('students')
            .select('id, owner_id, auth_user_id, email, provider_student_id')
            .eq('email', normalizedAccountEmail)
        )
        pushMatches(byAccountEmail)
      }

      if (matchedMap.size === 0 && studentNumber && studentNumberLookupAvailable) {
        const byStudentNumber = await fetchStudents('student_number', () =>
          supabaseAdmin
            .from('students')
            .select('id, owner_id, auth_user_id, email, provider_student_id')
            .eq('student_number', studentNumber)
        )
        pushMatches(byStudentNumber)
      }

      if (matchedMap.size === 0 && studentClassID && studentSeatNo > 0) {
        const { data: syncRows, error: syncError } = await supabaseAdmin
          .from('campus_classroom_sync')
          .select('owner_id, classroom_id')
          .eq('provider', 'campus1')
          .eq('provider_dsns', dsns)
          .eq('provider_class_id', studentClassID)

        if (syncError) {
          console.warn('[1campus SSO] class sync lookup failed:', syncError.message)
        } else if (syncRows?.length) {
          const byClassSeatResults = await Promise.all(
            syncRows.map((sync) =>
              fetchStudents(`class_seat:${sync.owner_id}:${sync.classroom_id}`, () =>
                supabaseAdmin
                  .from('students')
                  .select('id, owner_id, auth_user_id, email, provider_student_id')
                  .eq('owner_id', sync.owner_id)
                  .eq('classroom_id', sync.classroom_id)
                  .eq('seat_number', studentSeatNo)
              )
            )
          )
          byClassSeatResults.forEach(pushMatches)
        }
      }

      // 備援 3：className + seatNo（當 classID 與同步資料不一致時）
      if (matchedMap.size === 0 && studentClassName && studentSeatNo > 0) {
        const { data: syncRowsByClassName, error: syncNameError } = await supabaseAdmin
          .from('campus_classroom_sync')
          .select('owner_id, classroom_id')
          .eq('provider', 'campus1')
          .eq('provider_dsns', dsns)
          .ilike('provider_class_name', `${studentClassName}%`)

        if (syncNameError) {
          console.warn('[1campus SSO] class name sync lookup failed:', syncNameError.message)
        } else if (syncRowsByClassName?.length) {
          const byClassNameSeatResults = await Promise.all(
            syncRowsByClassName.map((sync) =>
              fetchStudents(`class_name_seat:${sync.owner_id}:${sync.classroom_id}`, () =>
                supabaseAdmin
                  .from('students')
                  .select('id, owner_id, auth_user_id, email, provider_student_id')
                  .eq('owner_id', sync.owner_id)
                  .eq('classroom_id', sync.classroom_id)
                  .eq('seat_number', studentSeatNo)
              )
            )
          )
          byClassNameSeatResults.forEach(pushMatches)
        }
      }

      const matchedStudents = Array.from(matchedMap.values())

      if (matchedStudents.length > 0) {
        const needsUpdate = matchedStudents.filter((s) => {
          if (s.auth_user_id !== userId) return true
          if (normalizedAccountEmail.includes('@') && !s.email) return true
          if (studentID && !s.provider_student_id) return true
          return false
        })
        if (needsUpdate.length > 0) {
          const bindResults = await Promise.all(
            needsUpdate.map(async (s) => {
              const payload = { auth_user_id: userId, updated_at: nowIso }
              if (normalizedAccountEmail.includes('@') && !s.email) payload.email = normalizedAccountEmail
              if (studentID && !s.provider_student_id) payload.provider_student_id = studentID
              const result = await supabaseAdmin
                .from('students')
                .update(payload)
                .eq('id', s.id)
                .eq('owner_id', s.owner_id)
              return { studentId: s.id, ownerId: s.owner_id, result }
            })
          )
          const bindFailures = bindResults.filter(({ result }) => result.error)
          const bindSuccesses = bindResults.filter(({ result }) => !result.error)
          if (bindSuccesses.length > 0) {
            console.log(
              `[1campus SSO] Bound/updated student records: ${bindSuccesses.length}`,
              { studentID, studentNumber, classID: studentClassID, seatNo: studentSeatNo }
            )
          }
          if (bindFailures.length > 0) {
            console.warn(
              `[1campus SSO] Student binding update FAILED for ${bindFailures.length} record(s):`,
              bindFailures.map(({ studentId, result }) => ({
                studentId,
                error: result.error?.message,
                code: result.error?.code
              }))
            )
          }
        }
      } else {
        console.log(
          '[1campus SSO] No student records matched for binding',
          { studentID, studentNumber, classID: studentClassID, seatNo: studentSeatNo, dsns }
        )
      }
    } catch (err) {
      console.warn('[1campus SSO] Student binding failed (non-blocking):', err?.message)
    }
  }

  let session
  try {
    // 如果 userId（來自 external_identities）與 virtualEmail 的 Supabase 用戶不同
    // （merge 後 identity.user_id → Google user），需要用真實 email 建立 session
    // 以 auth user 的實際 email 為準（避免 profile.email 與 auth user email 不一致）
    let sessionEmail = virtualEmail
    try {
      const { data: authUserData } = await supabaseAdmin.auth.admin.getUserById(userId)
      const authUserEmail = authUserData?.user?.email
      if (authUserEmail && authUserEmail !== virtualEmail) {
        sessionEmail = authUserEmail
        console.log('[1campus SSO] Using auth user email for session:', sessionEmail)
      }
    } catch {
      // fall through to virtualEmail
    }

    session = await createSessionForEmail(sessionEmail)
    if (!session?.access_token) throw new Error('Session 缺少 access_token')
  } catch (err) {
    console.error('[1campus SSO] Session creation failed:', err?.message)
    const isRateLimit = /429|rate.?limit|too.?many/i.test(err?.message || '')
    ssoErrorRedirect(res, frontendUrl, isRateLimit ? 'system_busy' : 'session_failed')
    return
  }

  setAuthCookies(res, session, isSecureRequest(req), req)

  // 學生不需要 OAuth Phase 2（Jasmine API 權限），直接導向前端
  if (isStudent) {
    console.log('[1campus Phase1] Student → skip OAuth, redirect to frontend')
    res.writeHead(302, {
      Location: `${frontendUrl}?sso_provider=campus1&entry=student`
    })
    res.end()
    return
  }

  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  console.log('[1campus Phase1] clientId exists?', !!clientId, 'clientId length:', clientId?.length, 'dsns:', dsns)
  if (clientId) {
    // Redirect 到 Phase 2 OAuth 啟動（直接使用 __step 參數，不需獨立檔案）
    const oauthParams = new URLSearchParams({ __step: 'oauth', dsns })
    const phase2Url = `/api/auth/1campus?${oauthParams.toString()}`
    console.log('[1campus Phase1] → Phase 2 redirect:', phase2Url)
    res.writeHead(302, {
      Location: phase2Url
    })
  } else {
    console.log('[1campus Phase1] → No CLIENT_ID, skip OAuth, redirect to frontend')
    res.writeHead(302, {
      Location: `${frontendUrl}?sso_provider=campus1`
    })
  }
  res.end()
}

// ============================================================
// Phase 2a：OAuth 授權啟動
// ============================================================

async function handleOAuthInitiate(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const dsns = getStringParam(req, 'dsns')
  if (!dsns || !isValidDsns(dsns)) {
    res.status(400).json({ error: 'Invalid dsns' })
    return
  }

  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  if (!clientId) {
    res.status(503).json({ error: '1Campus OAuth 未設定' })
    return
  }

  const nonce = crypto.randomBytes(16).toString('hex')
  const stateData = JSON.stringify({ nonce, dsns, userId: user.id })
  const stateB64 = Buffer.from(stateData).toString('base64url')

  const stateCookie = serializeStateCookie(stateB64, isSecureRequest(req))
  appendSetCookie(res, stateCookie)

  const callbackUrl = getOAuthCallbackUrl(req)
  console.log(`[1campus OAuth initiate] client_id=${clientId} redirect_uri=${callbackUrl} dsns=${dsns}`)

  const authUrl =
    `${CAMPUS1_OAUTH_AUTHORIZE}?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: 'User.Mail,jasmine,jasmine.contact',
      state: stateB64
    }).toString()

  res.writeHead(302, { Location: authUrl })
  res.end()
}

// ============================================================
// Phase 2b：OAuth 授權回呼
// ============================================================

async function mergeCampus1IntoGoogleAccount(supabaseAdmin, oldUserId, googleUserId) {
  const nowIso = new Date().toISOString()

  // 搬移所有 owner_id 指向舊帳號的資料表
  const ownerTables = [
    'folders',
    'assignments',
    'submissions',
    'classrooms',
    'students',
    'campus_classroom_sync',
    'ability_aggregates',
    'ability_dictionary',
    'assignment_student_state',
    'assignment_tag_aggregates',
    'assignment_tag_state',
    'correction_attempt_logs',
    'correction_question_items',
    'deleted_records',
    'domain_tag_aggregates',
    'tag_ability_map',
    'tag_dictionary',
    'tag_dictionary_state',
    'teacher_notifications',
    'teacher_preferences'
  ]
  for (const table of ownerTables) {
    await supabaseAdmin.from(table).update({ owner_id: googleUserId }).eq('owner_id', oldUserId)
  }
  await supabaseAdmin
    .from('external_identities')
    .update({ user_id: googleUserId, updated_at: nowIso })
    .eq('user_id', oldUserId)

  // 所有資料搬移完畢後，刪除舊的 1Campus 虛擬帳號
  await supabaseAdmin.from('profiles').delete().eq('id', oldUserId)
  await supabaseAdmin.auth.admin.deleteUser(oldUserId)
}

async function handleOAuthCallback(req, res) {
  const frontendUrl = getFrontendUrl(req)
  const secure = isSecureRequest(req)

  if (req.query?.error) {
    clearStateCookie(res, secure)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const code = getStringParam(req, 'code')
  const state = getStringParam(req, 'state')

  if (!code || !state) {
    clearStateCookie(res, secure)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const cookies = parseCookies(req)
  const cookieStateRaw = cookies[STATE_COOKIE_NAME] || ''
  const cookieState = cookieStateRaw ? decodeURIComponent(cookieStateRaw) : ''
  clearStateCookie(res, secure)

  if (!cookieState || cookieState !== state) {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  let stateData
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString())
  } catch {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const { dsns, userId: campus1UserId } = stateData

  if (!dsns || !isValidDsns(dsns) || !campus1UserId) {
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const supabaseAdmin = getSupabaseAdmin()
  const callbackUrl = getOAuthCallbackUrl(req)

  let tokenData
  try {
    tokenData = await exchangeCampus1OAuthCode(code, callbackUrl)
  } catch (err) {
    console.error('[1campus OAuth callback] Token exchange failed:', err?.message)
    res.writeHead(302, { Location: `${frontendUrl}?sso_error=oauth_error` })
    res.end()
    return
  }

  const accessToken = tokenData.access_token
  const refreshToken = tokenData.refresh_token
  const expiresIn = tokenData.expires_in || 3600
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

  let realEmail = ''
  try {
    const userInfo = await fetchCampus1UserInfo(accessToken)
    realEmail = typeof userInfo.mail === 'string' ? userInfo.mail.trim() : ''
  } catch (err) {
    console.warn('[1campus OAuth callback] UserInfo failed (non-blocking):', err?.message)
  }

  // 查找 identity：先用 user_id，fallback 用 dsns + provider（merge 後 user_id 可能已變）
  let identityData = null
  {
    const { data, error } = await supabaseAdmin
      .from('external_identities')
      .select('provider_meta, provider_account, user_id')
      .eq('user_id', campus1UserId)
      .eq('provider', 'campus1')
      .maybeSingle()

    if (!error && data) {
      identityData = data
    } else {
      // fallback：merge 後 user_id 已改，用 dsns 找
      console.log('[1campus OAuth callback] identity not found by user_id, trying dsns fallback')
      const { data: fallback } = await supabaseAdmin
        .from('external_identities')
        .select('provider_meta, provider_account, user_id')
        .eq('provider', 'campus1')
        .eq('provider_dsns', dsns)
        .maybeSingle()

      if (fallback) {
        identityData = fallback
        console.log('[1campus OAuth callback] found identity via dsns, actual user_id:', fallback.user_id)
      }
    }
  }

  if (identityData) {
    const updatedMeta = {
      ...(identityData.provider_meta || {}),
      oauth_access_token: accessToken,
      oauth_refresh_token: refreshToken,
      oauth_token_expires_at: tokenExpiresAt,
      ...(realEmail ? { real_email: realEmail } : {})
    }
    // 用 identity 實際的 user_id 更新（可能與 campus1UserId 不同）
    await supabaseAdmin
      .from('external_identities')
      .update({ provider_meta: updatedMeta, updated_at: new Date().toISOString() })
      .eq('user_id', identityData.user_id)
      .eq('provider', 'campus1')

    console.log('[1campus OAuth callback] saved OAuth tokens for user_id:', identityData.user_id)
  } else {
    console.error('[1campus OAuth callback] identity not found at all, tokens NOT saved!')
  }

  // 使用 identity 的實際 user_id（merge 後可能與 campus1UserId 不同）
  let finalUserId = identityData?.user_id || campus1UserId

  if (realEmail) {
    try {
      const { data: googleProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, email')
        .eq('email', realEmail)
        .neq('id', finalUserId)
        .maybeSingle()

      if (googleProfile) {
        await mergeCampus1IntoGoogleAccount(
          supabaseAdmin,
          campus1UserId,
          googleProfile.id
        )
        finalUserId = googleProfile.id

        const newSession = await createSessionForEmail(realEmail)
        if (newSession?.access_token) {
          setAuthCookies(
            res,
            {
              access_token: newSession.access_token,
              refresh_token: newSession.refresh_token,
              expires_in: newSession.expires_in || 3600
            },
            secure,
            req
          )
        }
      }
    } catch (err) {
      console.error(
        '[1campus OAuth callback] Email auto-match failed (non-blocking):',
        err?.message
      )
    }

    try {
      await supabaseAdmin
        .from('profiles')
        .update({ email: realEmail, updated_at: new Date().toISOString() })
        .eq('id', finalUserId)
        .like('email', 'campus1.%')
    } catch (err) {
      console.warn('[1campus OAuth callback] Update real email failed:', err?.message)
    }
  }

  const teacherID = String(identityData?.provider_meta?.teacherID || '')
  const providerAccount = String(identityData?.provider_account || '')

  const redirectParams = new URLSearchParams({
    sso_provider: 'campus1',
    sso_sync: '1',
    sso_dsns: dsns
  })
  // 帶 sso_teacher_id（teacherID 優先，否則用 provider_account）
  const syncId = teacherID || providerAccount
  if (syncId) redirectParams.set('sso_teacher_id', syncId)

  res.writeHead(302, { Location: `${frontendUrl}?${redirectParams.toString()}` })
  res.end()
}

// ============================================================
// 主 Handler（分派）
// ============================================================

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const step = getStringParam(req, '__step')

  if (step === 'oauth') {
    await handleOAuthInitiate(req, res)
    return
  }

  if (step === 'oauth_callback') {
    await handleOAuthCallback(req, res)
    return
  }

  // 預設：Phase 1 SSO 入口
  await handlePhase1(req, res)
}
