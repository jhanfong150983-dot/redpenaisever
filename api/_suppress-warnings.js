// Suppress Node.js deprecation warnings in Vercel serverless functions
process.removeAllListeners('warning')

const originalEmit = process.emit
process.emit = function (name, data, ...args) {
  if (
    name === 'warning' &&
    typeof data === 'object' &&
    data.name === 'DeprecationWarning' &&
    data.message?.includes('url.parse')
  ) {
    return false
  }
  return originalEmit.apply(process, [name, data, ...args])
}
