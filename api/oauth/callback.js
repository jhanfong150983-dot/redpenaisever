/**
 * GET /oauth/callback
 *
 * 1Campus demo client 白名單相容路由
 * demo client 僅接受 http://localhost:3000/oauth/callback，
 * 此檔案直接轉發給正式 handler 處理。
 */
export { default } from '../auth/1campus-oauth-callback.js'
