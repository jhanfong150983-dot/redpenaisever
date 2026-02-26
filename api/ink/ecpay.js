import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'
import {
  getEcpayConfig,
  assertEcpayConfig,
  buildCheckMacValue,
  formatMerchantTradeDate,
  createMerchantTradeNo,
  parseEcpayPayload
} from '../../server/_ecpay.js'

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

function parseBoolean(value) {
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

function parseDateValue(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function isPackageActive(pkg, now) {
  if (!pkg?.is_active) return false
  const startsAt = parseDateValue(pkg.starts_at)
  if (startsAt && startsAt > now) return false
  const endsAt = parseDateValue(pkg.ends_at)
  if (endsAt && endsAt <= now) return false
  return true
}

async function createOrderWithTradeNo(
  supabaseAdmin,
  userId,
  drops,
  amountTwd,
  packageSnapshot
) {
  let attempts = 0
  let lastError = null

  while (attempts < 3) {
    attempts += 1
    const tradeNo = createMerchantTradeNo()
    const { data, error } = await supabaseAdmin
      .from('ink_orders')
      .insert({
        user_id: userId,
        drops,
        amount_twd: amountTwd,
        status: 'pending',
        provider: 'ecpay',
        provider_txn_id: tradeNo,
        ...packageSnapshot
      })
      .select(
        'id, drops, bonus_drops, amount_twd, status, provider, provider_txn_id, created_at, updated_at'
      )
      .single()

    if (!error) {
      return { order: data, tradeNo }
    }

    lastError = error
    if (error.code !== '23505') {
      break
    }
  }

  throw new Error(lastError?.message || '建立訂單失敗')
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

async function handleCheckout(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const payload = parseJsonBody(req, res)
  if (!payload) return

  const packageId = parsePositiveInt(payload.packageId)
  if (!packageId) {
    res.status(400).json({ error: '請選擇有效的補充方案' })
    return
  }
  const consent = parseBoolean(payload.consent)
  if (!consent) {
    res.status(400).json({ error: '請先同意條款後再付款' })
    return
  }
  const termsVersion =
    typeof payload.termsVersion === 'string' ? payload.termsVersion.trim() : ''
  const privacyVersion =
    typeof payload.privacyVersion === 'string' ? payload.privacyVersion.trim() : ''
  if (!termsVersion || !privacyVersion) {
    res.status(400).json({ error: '條款版本缺失' })
    return
  }

  const config = getEcpayConfig()
  try {
    assertEcpayConfig(config)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'ECPay 設定缺失' })
    return
  }

  const supabaseAdmin = getSupabaseAdmin()

  try {
    const { data: pkg, error: packageError } = await supabaseAdmin
      .from('ink_packages')
      .select(
        'id, label, description, drops, bonus_drops, starts_at, ends_at, is_active'
      )
      .eq('id', packageId)
      .maybeSingle()

    if (packageError) {
      res.status(500).json({ error: '讀取方案失敗' })
      return
    }

    if (!pkg) {
      res.status(404).json({ error: '方案不存在' })
      return
    }

    const now = new Date()
    if (!isPackageActive(pkg, now)) {
      res.status(400).json({ error: '方案已下架或尚未開始' })
      return
    }

    const drops = Number.parseInt(String(pkg.drops), 10)
    if (!Number.isFinite(drops) || drops <= 0) {
      res.status(400).json({ error: '方案滴數設定錯誤' })
      return
    }

    const bonusDrops =
      typeof pkg.bonus_drops === 'number' && pkg.bonus_drops > 0
        ? pkg.bonus_drops
        : 0
    const amountTwd = drops
    const packageSnapshot = {
      package_id: pkg.id,
      package_label: pkg.label,
      package_description: pkg.description ?? null,
      bonus_drops: bonusDrops,
      consent_at: new Date().toISOString(),
      terms_version: termsVersion,
      privacy_version: privacyVersion
    }

    const { order, tradeNo } = await createOrderWithTradeNo(
      supabaseAdmin,
      user.id,
      drops,
      amountTwd,
      packageSnapshot
    )

    const clientBackUrl = `${config.siteUrl}/?page=ink-topup&payment=ecpay&orderId=${order.id}`
    const itemName =
      bonusDrops > 0 ? `墨水 ${drops} 滴 + 贈送 ${bonusDrops} 滴` : `墨水 ${drops} 滴`
    const fields = {
      MerchantID: config.merchantId,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: formatMerchantTradeDate(),
      PaymentType: 'aio',
      TotalAmount: String(amountTwd),
      TradeDesc: config.tradeDesc,
      ItemName: itemName,
      ReturnURL: `${config.siteUrl}/api/ink/ecpay?action=notify`,
      ClientBackURL: clientBackUrl,
      ChoosePayment: config.choosePayment,
      EncryptType: '1',
      CustomField1: String(order.id)
    }

    const checkMacValue = buildCheckMacValue(fields, config.hashKey, config.hashIv)

    res.status(200).json({
      action: config.baseUrl,
      fields: {
        ...fields,
        CheckMacValue: checkMacValue
      },
      orderId: order.id
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '建立訂單失敗' })
  }
}

async function handleNotify(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('0|Method Not Allowed')
    return
  }

  const config = getEcpayConfig()
  try {
    assertEcpayConfig(config)
  } catch (error) {
    res.status(500).send('0|Missing config')
    return
  }

  const payload = parseEcpayPayload(req.body)
  const receivedCheckMac = String(payload.CheckMacValue || '')

  if (!receivedCheckMac) {
    res.status(400).send('0|Missing CheckMacValue')
    return
  }

  const { CheckMacValue: _omit, ...payloadForCheck } = payload
  const expectedCheckMac = buildCheckMacValue(
    payloadForCheck,
    config.hashKey,
    config.hashIv
  )

  if (expectedCheckMac !== receivedCheckMac.toUpperCase()) {
    res.status(400).send('0|CheckMacValue Error')
    return
  }

  const merchantTradeNo = String(payload.MerchantTradeNo || '')
  const tradeAmount = Number.parseInt(String(payload.TradeAmt || ''), 10)

  if (!merchantTradeNo) {
    res.status(400).send('0|Missing MerchantTradeNo')
    return
  }

  const supabaseAdmin = getSupabaseAdmin()

  const { data: order, error: orderError } = await supabaseAdmin
    .from('ink_orders')
    .select(
      'id, user_id, drops, bonus_drops, amount_twd, status, provider_txn_id, provider, package_id, package_label, package_description'
    )
    .eq('provider', 'ecpay')
    .eq('provider_txn_id', merchantTradeNo)
    .maybeSingle()

  if (orderError) {
    res.status(500).send('0|Order lookup failed')
    return
  }

  if (!order) {
    res.status(404).send('0|Order not found')
    return
  }

  const rtnCode = String(payload.RtnCode || '')
  if (rtnCode !== '1') {
    if (order.status !== 'paid') {
      const { error: cancelError } = await supabaseAdmin
        .from('ink_orders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', order.id)
      if (cancelError) {
        res.status(500).send('0|Order update failed')
        return
      }
    }
    res.status(200).send('1|OK')
    return
  }

  if (Number.isFinite(tradeAmount) && tradeAmount !== order.amount_twd) {
    res.status(400).send('0|Amount mismatch')
    return
  }

  if (order.status === 'paid') {
    const { error: upgradeError } = await supabaseAdmin
      .from('profiles')
      .update({
        permission_tier: 'advanced',
        updated_at: new Date().toISOString()
      })
      .eq('id', order.user_id)

    if (upgradeError) {
      res.status(500).send('0|Permission update failed')
      return
    }

    res.status(200).send('1|OK')
    return
  }

  try {
    const hasLedger = await hasOrderLedger(supabaseAdmin, order.user_id, order.id)

    if (!hasLedger) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('ink_balance')
        .eq('id', order.user_id)
        .maybeSingle()

      if (profileError) {
        res.status(500).send('0|Profile lookup failed')
        return
      }

      const currentBalance =
        typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0
      const bonusDrops =
        typeof order.bonus_drops === 'number' && order.bonus_drops > 0
          ? order.bonus_drops
          : 0
      const totalDrops = order.drops + bonusDrops
      const balanceAfter = currentBalance + totalDrops

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({
          ink_balance: balanceAfter,
          permission_tier: 'advanced',
          updated_at: new Date().toISOString()
        })
        .eq('id', order.user_id)

      if (updateError) {
        res.status(500).send('0|Balance update failed')
        return
      }

      const { error: ledgerError } = await supabaseAdmin.from('ink_ledger').insert({
        user_id: order.user_id,
        delta: totalDrops,
        reason: 'order_paid',
        metadata: {
          orderId: order.id,
          provider: order.provider,
          tradeNo: payload.TradeNo,
          merchantTradeNo,
          amountTwd: order.amount_twd,
          baseDrops: order.drops,
          bonusDrops,
          totalDrops,
          packageId: order.package_id,
          packageLabel: order.package_label,
          packageDescription: order.package_description,
          balanceBefore: currentBalance,
          balanceAfter
        }
      })

      if (ledgerError) {
        res.status(500).send('0|Ledger insert failed')
        return
      }
    }

    const { error: updateOrderError } = await supabaseAdmin
      .from('ink_orders')
      .update({ status: 'paid', updated_at: new Date().toISOString() })
      .eq('id', order.id)

    if (updateOrderError) {
      res.status(500).send('0|Order update failed')
      return
    }

    res.status(200).send('1|OK')
  } catch (error) {
    res.status(500).send('0|Server Error')
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  const action = resolveAction(req)
  if (action === 'checkout') {
    await handleCheckout(req, res)
    return
  }
  if (action === 'notify') {
    await handleNotify(req, res)
    return
  }
  res.status(404).json({ error: 'Not Found' })
}
