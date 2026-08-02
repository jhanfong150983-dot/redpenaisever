import { getEnvValue } from './_env.js'

// ============================================================
// 常數
// ============================================================
const CAMPUS1_OAUTH_BASE = 'https://auth.ischool.com.tw'
const TOKEN_URL = `${CAMPUS1_OAUTH_BASE}/oauth/token.php`
const USERINFO_URL = `${CAMPUS1_OAUTH_BASE}/services/me.php`
const FETCH_TIMEOUT_MS = 10000

function getIdentityApiBase() {
  return getEnvValue('CAMPUS1_IDENTITY_API_BASE') || 'https://devapi.1campus.net'
}

function getJasmineApiBase() {
  return getEnvValue('CAMPUS1_JASMINE_API_BASE') || 'https://devapi.1campus.net/api/jasmine'
}

// ============================================================
// 安全驗證
// ============================================================

/**
 * 驗證 dsns 格式，防止 SSRF 路徑穿越攻擊
 * 規則：只允許英數字、點、連字號，禁止 ..，長度 ≤ 100
 */
export function isValidDsns(dsns) {
  if (typeof dsns !== 'string') return false
  if (dsns.length === 0 || dsns.length > 100) return false
  if (dsns.includes('..')) return false
  return /^[a-zA-Z0-9.\-]+$/.test(dsns)
}

// ============================================================
// Phase 1：Identity Code API
// ============================================================

/**
 * 向 1Campus Identity API 驗證 code，取得使用者身份
 * @param {string} dsns - 學校網域（已通過 isValidDsns 驗證）
 * @param {string} code - 一次性 identity code（300 秒有效）
 * @returns {Promise<object>} identity 物件（含 roleType, account, teacherID, teacherName 等）
 */
export async function fetchCampus1Identity(dsns, code) {
  const base = getIdentityApiBase()
  const url = `${base}/${dsns}/identity/${encodeURIComponent(code)}`

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `1Campus Identity API ${response.status}: ${text.slice(0, 200)}`
    )
  }

  return response.json()
}

/**
 * 組合虛擬 email（不是真實信箱，用於建立 Supabase 帳號）
 * 格式：campus1.{account}@{dsns}
 */
export function buildCampus1VirtualEmail(account, dsns) {
  const localPart = account.includes('@') ? account.split('@')[0] : account
  return `campus1.${localPart}@${dsns}`
}

/**
 * 從 identity 物件取得顯示名稱
 * 優先順序：teacherName → studentName → account → '使用者'
 */
export function buildCampus1DisplayName(identity) {
  return (
    String(identity?.teacherName || identity?.teacher?.teacherName || '').trim() ||
    String(identity?.studentName || identity?.student?.studentName || '').trim() ||
    String(identity?.account || '').trim() ||
    '使用者'
  )
}

// ============================================================
// Phase 2：OAuth 2.0 Token 操作
// ============================================================

/**
 * 用授權碼換取 OAuth Access/Refresh Token
 * @param {string} code - OAuth 授權碼
 * @param {string} redirectUri - 必須與授權時一致
 * @returns {Promise<{ access_token, refresh_token, expires_in }>}
 */
export async function exchangeCampus1OAuthCode(code, redirectUri) {
  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  const clientSecret = getEnvValue('CAMPUS1_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('1Campus OAuth credentials not configured')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: 'authorization_code'
  })

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token exchange failed ${response.status}: ${text.slice(0, 200)}`)
  }

  return response.json()
}

/**
 * 用 Access Token 取得使用者真實資訊（含 mail）
 * @param {string} accessToken
 * @returns {Promise<{ uuid, mail, firstName, lastName }>}
 */
export async function fetchCampus1UserInfo(accessToken) {
  const url = `${USERINFO_URL}?access_token=${encodeURIComponent(accessToken)}`

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!response.ok) {
    throw new Error(`UserInfo fetch failed ${response.status}`)
  }

  return response.json()
}

/**
 * 用 Refresh Token 重新取得 Access Token
 * @param {string} refreshToken
 * @returns {Promise<{ access_token, refresh_token?, expires_in }>}
 */
export async function refreshCampus1Token(refreshToken) {
  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  const clientSecret = getEnvValue('CAMPUS1_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('1Campus OAuth credentials not configured')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token refresh failed ${response.status}: ${text.slice(0, 200)}`)
  }

  return response.json()
}

/**
 * 取得可用的 OAuth Access Token（自動處理過期刷新）
 * 呼叫 Jasmine API 前必須先呼叫此函數
 * @param {object} supabaseAdmin - Supabase Admin client
 * @param {string} userId - Supabase user UUID
 * @returns {Promise<string>} 有效的 access_token
 */
export async function getCampus1AccessToken(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('external_identities')
    .select('provider_meta')
    .eq('user_id', userId)
    .eq('provider', 'campus1')
    .maybeSingle()

  if (error || !data) {
    throw new Error('找不到 1Campus 身份資料')
  }

  const meta = data.provider_meta || {}

  if (!meta.oauth_access_token) {
    throw new Error('1Campus OAuth token 未授權，請重新登入以取得班級同步權限')
  }

  // 檢查是否即將過期（60 秒緩衝）
  const expiresAt = meta.oauth_token_expires_at ? new Date(meta.oauth_token_expires_at) : null
  const isExpired = !expiresAt || Date.now() > expiresAt.getTime() - 60_000

  if (!isExpired) {
    return meta.oauth_access_token
  }

  // Token 過期，嘗試刷新
  if (!meta.oauth_refresh_token) {
    throw new Error('1Campus OAuth token 已過期且無法刷新，請重新登入')
  }

  const tokenData = await refreshCampus1Token(meta.oauth_refresh_token)

  const newExpiry = new Date(
    Date.now() + (tokenData.expires_in || 3600) * 1000
  ).toISOString()

  const newMeta = {
    ...meta,
    oauth_access_token: tokenData.access_token,
    oauth_token_expires_at: newExpiry,
    ...(tokenData.refresh_token
      ? { oauth_refresh_token: tokenData.refresh_token }
      : {})
  }

  await supabaseAdmin
    .from('external_identities')
    .update({ provider_meta: newMeta, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', 'campus1')

  return tokenData.access_token
}

// ============================================================
// Jasmine API Token（client_credentials 模式）
// ============================================================

// 記憶體快取（serverless 函數生命週期內有效）
let _jasmineTokenCache = { token: '', expiresAt: 0 }

/**
 * 用 client_credentials 取得 Jasmine API 專用 access token
 * 這是伺服器對伺服器的 token，不需要使用者授權
 * @returns {Promise<string>} 有效的 access_token
 */
export async function getJasmineAccessToken() {
  // 快取仍有效（60 秒緩衝）→ 直接回傳
  if (_jasmineTokenCache.token && Date.now() < _jasmineTokenCache.expiresAt - 60_000) {
    return _jasmineTokenCache.token
  }

  const clientId = getEnvValue('CAMPUS1_CLIENT_ID')
  const clientSecret = getEnvValue('CAMPUS1_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('1Campus OAuth credentials not configured (CAMPUS1_CLIENT_ID / CAMPUS1_CLIENT_SECRET)')
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'jasmine jasmine.contact'
  })

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jasmine client_credentials token failed ${response.status}: ${text.slice(0, 200)}`)
  }

  const tokenData = await response.json()
  const expiresIn = tokenData.expires_in || 3600

  _jasmineTokenCache = {
    token: tokenData.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  }

  console.log('[1campus] Got Jasmine client_credentials token, expires_in:', expiresIn)
  return tokenData.access_token
}

// ============================================================
// Phase 2：Jasmine API（班級 / 學生資料）
// ============================================================

/**
 * 取得老師的課程列表（含班級資訊）
 * 使用 getCourse API，回傳結構：{ course: [{ courseID, courseName, class: { classID, className, gradeYear, teacher }, teacher: [...] }] }
 * @param {string} dsns - 學校網域
 * @param {string|number} teacherID - 老師 ID
 * @param {string} accessToken - Jasmine access token
 * @returns {Promise<Array>} course 陣列
 */
export async function fetchCampus1Courses(dsns, teacherID, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getCourse?teacherID=${encodeURIComponent(String(teacherID))}`

  console.log('[1campus] fetchCampus1Courses URL:', url)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  console.log('[1campus] fetchCampus1Courses status:', response.status)

  if (response.status === 404) return []

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[1campus] fetchCampus1Courses error body:', text.slice(0, 400))
    throw new Error(`Jasmine getCourse failed ${response.status}: ${text.slice(0, 200)}`)
  }

  const json = await response.json()
  console.log('[1campus] fetchCampus1Courses raw json keys:', Object.keys(json || {}))
  const courses = json?.course ?? json?.data?.course ?? []
  return Array.isArray(courses) ? courses : []
}

/**
 * 2026-08-02 全校課程（Step 11 任課老師判定用、1Campus 官方回覆確認）：
 *   getCourse 不帶參數＝全校所有課程。回傳每筆含
 *   { courseName, subject, subjectLevel, schoolYear, semester,
 *     class: { classID, classNo, className, gradeYear },
 *     teacher: [{ teacherID, teacherAcc, teacherNo, teacherName }] }
 *   → 這是「班級 × 課程 × 授課教師」的權威來源，取代靠課程名稱字串比對的脆弱作法。
 *   ⚠ 官方說明：API 只回「當前學年學期」、不支援查歷史 → 落地時要帶 schoolYear/semester
 *     並保留舊資料，否則學期一換、上學期考卷的檢視權會斷。
 * @param {string} dsns
 * @param {string} accessToken
 * @returns {Promise<Array>} course 陣列
 */
export async function fetchCampus1AllCourses(dsns, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getCourse`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // 全校課程量大（官方估 100~500 門），比照 getClassStudent 放寬
    signal: AbortSignal.timeout(60000)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[1campus] fetchCampus1AllCourses error body:', text.slice(0, 400))
    throw new Error(`Jasmine getCourse(all) failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const courses = json?.course ?? json?.data?.course ?? []
  return Array.isArray(courses) ? courses : []
}

/**
 * 2026-08-02 全校班級（含導師 / 副導師、Step 11 導師判定用）：
 *   getClass 不帶參數＝全校所有班級。回傳每筆含
 *   { classID, classNo, className, gradeYear,
 *     teacher: { teacherID, teacherAcc, teacherNo, teacherName },            ← 班導師
 *     secondaryTeacher: { teacherID, teacherAcc, teacherNo, teacherName } }  ← 副班導師
 *   官方說明：角色不是用 roleType 欄位，而是「出現在哪個欄位」決定
 *   （class.teacher=班導、class.secondaryTeacher=副導、course.teacher[]=科任）。
 * @param {string} dsns
 * @param {string} accessToken
 * @returns {Promise<Array>} class 陣列
 */
export async function fetchCampus1ClassTeachers(dsns, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getClass`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[1campus] fetchCampus1ClassTeachers error body:', text.slice(0, 400))
    throw new Error(`Jasmine getClass failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const classes = json?.class ?? json?.data?.class ?? []
  return Array.isArray(classes) ? classes : []
}

/**
 * 取得老師課程的學生列表（含 email）
 * 使用 getCourseStudent API，回傳結構：
 * { course: [{ courseID, class: { classID, className }, student: [{ seatNo, studentName, studentNumber, studentAcc, email }] }] }
 * @param {string} dsns - 學校網域
 * @param {string|number} teacherID - 老師 ID
 * @param {string} accessToken - Jasmine access token（需 jasmine.contact scope 才有 email）
 * @returns {Promise<Array>} course 陣列（每個 course 含 student[]）
 */
export async function fetchCampus1CourseStudents(dsns, teacherID, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getCourseStudent?teacherID=${encodeURIComponent(String(teacherID))}`

  console.log('[1campus] fetchCampus1CourseStudents URL:', url)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })

  console.log('[1campus] fetchCampus1CourseStudents status:', response.status)

  if (response.status === 404) return []

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('[1campus] fetchCampus1CourseStudents error body:', text.slice(0, 400))
    throw new Error(`Jasmine getCourseStudent failed ${response.status}: ${text.slice(0, 200)}`)
  }

  const json = await response.json()
  console.log('[1campus] fetchCampus1CourseStudents raw json keys:', Object.keys(json || {}))
  const courses = json?.course ?? json?.data?.course ?? []
  return Array.isArray(courses) ? courses : []
}

/**
 * 2026-07-30 Step 3.5 全校名冊:getClassStudent 不帶參數=全校所有班級+學生(官方規格確認)。
 * 回傳 class 陣列:每班 { classID, className, gradeYear, classNo, schoolYear, semester,
 *   teacher:{teacherID,teacherName,teacherAcc}, student:[{studentID, studentName, studentNumber,
 *   seatNo, studentAcc, email(需 jasmine.contact), parent:[...](綁定家長,可能需額外 scope)}] }
 * @param {string} dsns
 * @param {string} accessToken - Jasmine client_credentials token
 * @returns {Promise<Array>} class 陣列
 */
export async function fetchCampus1ClassStudents(dsns, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getClassStudent`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // 全校資料量大,放寬 timeout
    signal: AbortSignal.timeout(30000)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jasmine getClassStudent failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const classes = json?.class ?? json?.data?.class ?? []
  return Array.isArray(classes) ? classes : []
}

/**
 * 2026-07-30 全校教師名冊:getTeacher 不帶參數=全校所有教師(官方規格確認)。
 * 回傳 teacher 陣列:{ teacherID(校內唯一), teacherName, teacherAcc, teacherNo, ... }
 * @param {string} dsns
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function fetchCampus1Teachers(dsns, accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getTeacher`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jasmine getTeacher failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const teachers = json?.teacher ?? json?.data?.teacher ?? []
  return Array.isArray(teachers) ? teachers : []
}

/**
 * 2026-07-30 轉出清查:傳入已知 studentID 清單,回傳「非在校」者(含 status:休學/畢業及離校/刪除/其他)。
 * 休學也算非在校、復學沿用同 studentID(官方規格)。status 欄位可能需 jasmine.profile scope。
 * @param {string} dsns
 * @param {Array<number>} studentIDs
 * @param {string} accessToken
 * @returns {Promise<Array<{studentID:number,status?:string}>>}
 */
export async function fetchCampus1StudentDeparted(dsns, studentIDs, accessToken) {
  if (!Array.isArray(studentIDs) || studentIDs.length === 0) return []
  const base = getJasmineApiBase()
  const url = `${base}/${dsns}/getStudentDeparted`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentID: studentIDs }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (response.status === 404) return []
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jasmine getStudentDeparted failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const rows = Array.isArray(json) ? json : (json?.student ?? json?.data ?? [])
  if (!Array.isArray(rows)) return []
  // 規格為物件陣列;防禦性容忍純 ID 陣列
  return rows.map((r) => (typeof r === 'object' && r !== null ? r : { studentID: r }))
}

/**
 * 取得本 app 被授權的所有學校資料（含 schoolType 學制 / 正式校名）。
 * 端點為 /api/jasmine/getSchool（dsns 不在路徑、回全部授權學校）。
 * @param {string} accessToken - Jasmine access token
 * @returns {Promise<Array>} school 陣列，每筆含 { schoolDsns, schoolType, schoolName, schoolOfficialName, ... }
 */
export async function fetchCampus1Schools(accessToken) {
  const base = getJasmineApiBase()
  const url = `${base}/getSchool`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jasmine getSchool failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const json = await response.json()
  const schools = json?.school ?? json?.data?.school ?? []
  return Array.isArray(schools) ? schools : []
}
