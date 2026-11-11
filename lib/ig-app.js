// Talks to the Outreach app (app-main.js), which runs Instagram actions in its Instagram panel.
const http = require('http')

const PORT = (Number(process.env.PORT) || 8787) + 3
const NOT_OPEN = 'The Outreach app is not open. Start it with Start Review.command to comment, send DMs or voicenotes.'

// Every chat that comes back from the panel (read for any reason, or attached to an action that stopped
// because they had replied) is handed to these listeners: server.js adds missed replies to DMs to reply.
const threadListeners = []
function onThread(listener) {
  threadListeners.push(listener)
}
function shareThread(body, result) {
  const messages = Array.isArray(result?.messages) ? result.messages : Array.isArray(result?.thread) ? result.thread : null
  const username = result?.username || body?.username
  if (!messages || !username) return
  for (const listener of threadListeners) {
    try { listener(String(username), messages, body?.name || '', result?.avatar || '') } catch (error) { console.error('thread listener', error.message) }
  }
}

// How long an Instagram action may take: up to 40 seconds of safety check (ig-guard preflight), then the action.
const ACTION_MS = 150 * 1000

function call(urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body))
    const request = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method: payload ? 'POST' : 'GET',
      // A new connection every time (10 Nov, 4:09 to 4:15 pm: three replies came back "read ECONNRESET").
      // Node keeps a connection open for about 4 seconds and reuses it; the app closes it at 5. When this
      // server was busy for a second, a reply went down a connection the app had just closed and never
      // reached it: nothing was sent, but it showed as Not sent. A fresh connection is never closed under us.
      agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        let result = {}
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        shareThread(body, result)
        if (response.statusCode === 200) return resolve(result)
        // "It will be retried": Google Sheets refused or did not answer the safety check that comes before
        // every action, so Instagram was not touched. Not a failure: it waits and goes again (10 Nov: three
        // replies were marked Not sent for this, with that very sentence as the reason).
        const sheets = /It will be retried\.$/.test(result.error || '')
        reject(Object.assign(new Error(result.error || 'Instagram action failed.'), { kind: sheets ? 'wait' : result.kind || 'error', waitMs: sheets ? 60 * 1000 : result.waitMs || 0, thread: result.thread || null, sentParts: result.sentParts || 0 }))
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
  onThread,
  engage: ({ permalink, message, username, pk, allowLiked }) => call('/comment', { permalink, message, username, pk, allowLiked }, ACTION_MS),
  sendDm: ({ username, threadId, message, detail, expect }) => call('/dm', { username, threadId, message, detail, expect }, ACTION_MS),
  unfollow: ({ username, sheetRow, checkChat }) => call('/unfollow', { username, sheetRow, checkChat }, 120000),
  chatState: ({ username, threadId, transcribe }) => call('/chat-state', { username, threadId, transcribe }, 60000),
  inboxState: ({ folder, limit } = {}) => call('/inbox-state', { folder, limit }, 150000),
  openInboxRow: ({ name, folder, transcribe }) => call('/inbox-open', { name, folder, transcribe }, 60000),
  ourStories: ({ account }) => call('/our-stories', { account }, 150000),
  replyRelaunch: ({ username, sheetRow, step, text, expectLast }) => call('/reply-relaunch', { username, sheetRow, step, text, expectLast }, ACTION_MS),
  likeLast: ({ username, threadId, dryRun }) => call('/like-last', { username, threadId, dryRun }, ACTION_MS),
  react: ({ username, threadId, text, emoji }) => call('/react', { username, threadId, text, emoji }, ACTION_MS),
  guard: () => call('/guard', null, 8000),
  relaunchApp: () => call('/relaunch', {}, 5000),
  scraperOpen: (account = 1) => call('/scraper/open', { account }, 8000),
  scraperStatus: (account = 1, withName = false) => call('/scraper/status', { account, withName }, 12000),
  scraperHide: (account = 1) => call('/scraper/hide', { account }, 8000),
  scraperProgress: (account = 1) => call('/scraper/progress', { account }, 3000),
  voiceAudio: ({ username, threadId, max, probe }) => call('/voice-audio', { username, threadId, max, probe }, 180000),
  scraperProfile: (username, account = 1) => call('/scraper/profile', { username, account }, 90000),
  scraperFollowing: (username, max, account = 1, limits = {}) => call('/scraper/following', { username, max, account, ...limits }, 60 * 60 * 1000),
  voiceStatus: () => call('/voice/status', null, 5000),
  voiceNext: () => call('/voice/next', {}, 6 * 60 * 1000),
  voiceReply: ({ username, threadId, clipName, clipNames }) => call('/voice/reply', { username, threadId, clipName, clipNames }, 9 * 60 * 1000),
  health: () => call('/health', null, 2000),
}
