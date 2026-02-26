import crypto from 'crypto'

const STAGE_CHECKOUT_URL = 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5'
const PROD_CHECKOUT_URL = 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'

const ENCODED_REPLACEMENTS = [
  ['%20', '+'],
  ['%21', '!'],
  ['%28', '('],
  ['%29', ')'],
  ['%2a', '*'],
  ['%2d', '-'],
  ['%2e', '.'],
  ['%5f', '_']
]

export function getEcpayConfig() {
  const merchantId = process.env.ECPAY_MERCHANT_ID || ''
  const hashKey = process.env.ECPAY_HASH_KEY || ''
  const hashIv = process.env.ECPAY_HASH_IV || ''
  const env = (process.env.ECPAY_ENV || 'stage').toLowerCase()
  const baseUrl =
    process.env.ECPAY_BASE_URL ||
    (env === 'prod' || env === 'production' ? PROD_CHECKOUT_URL : STAGE_CHECKOUT_URL)
  const choosePayment = process.env.ECPAY_CHOOSE_PAYMENT || 'Credit'
  const tradeDesc = process.env.ECPAY_TRADE_DESC || 'RedPen AI 墨水補充'
  const siteUrl = process.env.SITE_URL || ''

  return {
    merchantId,
    hashKey,
    hashIv,
    env,
    baseUrl,
    choosePayment,
    tradeDesc,
    siteUrl
  }
}

export function assertEcpayConfig(config) {
  if (!config.merchantId || !config.hashKey || !config.hashIv) {
    throw new Error('ECPay credentials missing')
  }
  if (!config.siteUrl) {
    throw new Error('SITE_URL is required for ECPay callbacks')
  }
}

function encodeEcpayValue(value) {
  let encoded = encodeURIComponent(value).toLowerCase()
  for (const [from, to] of ENCODED_REPLACEMENTS) {
    encoded = encoded.replace(new RegExp(from, 'g'), to)
  }
  return encoded
}

export function buildCheckMacValue(params, hashKey, hashIv) {
  const sortedKeys = Object.keys(params).sort((a, b) => a.localeCompare(b))
  const raw = sortedKeys.map((key) => `${key}=${params[key]}`).join('&')
  const encoded = encodeEcpayValue(`HashKey=${hashKey}&${raw}&HashIV=${hashIv}`)
  return crypto.createHash('sha256').update(encoded).digest('hex').toUpperCase()
}

export function formatMerchantTradeDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function createMerchantTradeNo() {
  const suffix = Math.floor(Math.random() * 900) + 100
  return `INK${Date.now()}${suffix}`
}

export function parseEcpayPayload(body) {
  if (!body) return {}
  if (typeof body === 'string') {
    return Object.fromEntries(new URLSearchParams(body))
  }
  if (Buffer.isBuffer(body)) {
    return Object.fromEntries(new URLSearchParams(body.toString('utf8')))
  }
  if (typeof body === 'object') return body
  return {}
}
