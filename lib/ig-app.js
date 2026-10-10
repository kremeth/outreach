// Talks to the Outreach app (app-main.js), which runs Instagram actions in its Instagram panel.
const http = require('http')

const PORT = (Number(process.env.PORT) || 8787) + 3
const NOT_OPEN = 'The Outreach app is not open. Start it with Start Review.command to comment, send DMs or voicenotes.'

function call(urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body))
    const request = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        let result = {}
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        if (response.statusCode === 200) resolve(result)
        else reject(Object.assign(new Error(result.error || 'Instagram action failed.'), { kind: result.kind || 'error', waitMs: result.waitMs || 0, thread: result.thread || null }))
      })
    })
    request.on('timeout', () => {
      request.destroy()
      reject(Object.assign(new Error('Instagram took too long. Check the Instagram panel before trying again.'), { kind: 'timeout' }))
    })
    request.on('error', (error) => {
      reject(error.code === 'ECONNREFUSED' ? Object.assign(new Error(NOT_OPEN), { kind: 'app' }) : error)
    })
    if (payload) request.write(payload)
    request.end()
  })
}

module.exports = {
  engage: ({ permalink, message, username, pk, allowLiked }) => call('/comment', { permalink, message, username, pk, allowLiked }, 90000),
  sendDm: ({ username, message, detail, expect }) => call('/dm', { username, message, detail, expect }, 90000),
  unfollow: ({ username, sheetRow, checkChat }) => call('/unfollow', { username, sheetRow, checkChat }, 120000),
  guard: () => call('/guard', null, 8000),
  voiceStatus: () => call('/voice/status', null, 5000),
  voiceNext: () => call('/voice/next', {}, 6 * 60 * 1000),
  health: () => call('/health', null, 2000),
}
