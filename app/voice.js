// Sends one voicenote in the app's Instagram panel, for the scheduler (lib/autopilot.js on the server).
// Same steps as the old sender: follow the creator, open the DM, feed the clip in as the microphone,
// wait for it to end, press Send, mark Pending in the sheet.
const fs = require('fs')
const queue = require('../lib/send-queue')
const guard = require('../lib/ig-guard')
const log = require('../lib/shared-log')
const ig = require('./instagram')

const SETTLE_BEFORE_SEND_MS = 2500
const QUEUE_CACHE_MS = 2 * 60 * 1000

let wc = null
let hookSource = ''
let ensureLive = async () => {}
let running = null
let waiting = null
let profiles = []
let profilesAt = 0
let clipSeconds = 0
let status = { phase: 'idle', text: '' }

function init(options) {
  wc = options.webContents
  hookSource = options.hookSource
  ensureLive = options.ensureLive || ensureLive
}

function active() {
  return Boolean(running)
}

function getStatus() {
  return { ...status, sentToday: queue.sentToday(), dailyLimit: queue.DAILY_LIMIT }
}

function fail(message, kind = 'error') {
  return Object.assign(new Error(message), { kind })
}

async function ensureHook() {
  const ready = await ig.run(wc, 'Boolean(window.__loadVoice)').catch(() => false)
  if (!ready) await ig.run(wc, hookSource)
}

async function openUrl(url) {
  await ig.openUrl(wc, url)
  await ensureHook()
}

// Next creator waiting for a voicenote: claimed for this computer and re-checked in the live sheet.
async function nextProfile() {
  if (!profiles.length || Date.now() - profilesAt > QUEUE_CACHE_MS) {
    profiles = await queue.loadQueue()
    profilesAt = Date.now()
  }
  await log.refresh(0)
  // Anyone already sent to (or tried, and it may have gone through), or skipped because the chat was
  // not empty, is never voicenoted again.
  const attempted = new Set([
    ...log.list((entry) => entry.action === 'voice' && !/ notsent$/.test(entry.detail)).map((entry) => entry.detail.split(' ')[0]),
    ...log.list((entry) => entry.action === 'skip' && entry.target.startsWith('voice:')).map((entry) => entry.target),
  ])
  while (profiles.length) {
    const item = profiles.shift()
    if (attempted.has(`voice:${item.sheetRow}`)) continue
    if (log.claimedByOther(`voice:${item.sheetRow}`)) continue
    const claimed = await log.claim(`voice:${item.sheetRow}`, 30 * 60 * 1000)
    if (!claimed.ok) continue
    if (!(await queue.stillQueued(item))) continue
    return item
  }
  return null
}

// Resolves when the hook reports the clip ended, or after the clip length plus a margin.
function waitForEnd() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting = null
      resolve('timeout')
    }, Math.round((clipSeconds + 25) * 1000))
    waiting = (state) => {
      if (state !== 'ended') return
      clearTimeout(timer)
      waiting = null
      setTimeout(() => resolve('ended'), 300)
    }
  })
}

function onVoiceState(state) {
  if (waiting) waiting(state)
}

async function startRecording() {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureHook()
    const result = await ig.run(wc, 'window.__startIgRecord()')
    if (!result?.ok) throw fail(result?.error || 'Could not find the microphone button.', 'notsent')
    await ig.sleep(1200)
    let state = await ig.run(wc, `document.documentElement.dataset.voiceState || ''`)
    if (state !== 'recording' && state !== 'speech') {
      await ig.click(wc, result)
      await ig.sleep(1500)
      state = await ig.run(wc, `document.documentElement.dataset.voiceState || ''`)
    }
    if (state === 'recording' || state === 'speech') return
    await ig.run(wc, 'window.__cancelIgRecord()').catch(() => {})
    await ig.sleep(1500)
  }
  throw fail('Instagram did not start recording.', 'notsent')
}

// The hook's own page check is broad, so only a warning confirmed by the stricter check counts.
async function confirmWarning(fallback) {
  const found = await ig.pageProblem(wc)
  return found.problem === 'blocked' ? (found.warning || fallback) : ''
}

async function waitForComposer() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const composer = await ig.run(wc, 'window.__composerReady()').catch(() => null)
    if (composer?.ok) return composer
    await ig.sleep(500)
  }
  return null
}

async function sendOne(account) {
  if (queue.remainingToday() <= 0) return { done: true, reason: `Already sent ${queue.DAILY_LIMIT} voicenotes today.` }
  const item = await nextProfile()
  if (!item) return { done: true, reason: 'No voicenotes left to send.' }
  try {
    return await sendTo(item, account)
  } catch (error) {
    error.item = { name: item.name, username: item.username, sheetRow: item.sheetRow }
    throw error
  }
}

async function sendTo(item, account) {
  const pick = queue.pickVoice(item.device)
  if (!pick) throw fail(`No voice clip for ${item.device}.`, 'notsent')
  item.voice = pick.voice
  item.clip = pick.clip
  await guard.lock(account, 5 * 60 * 1000)

  // The first voicenote only goes into an empty chat. Anything already there (an old conversation,
  // a reply, anything) means skip them, before following or sending anything.
  status = { phase: 'preparing', text: `Checking the chat with @${item.username}` }
  await openUrl(`https://ig.me/m/${encodeURIComponent(item.username)}`)
  let state = await ig.run(wc, 'window.__igPageState()')
  if (state.kind === 'login') throw fail('Log into Instagram in the panel.', 'login')
  const ready = await waitForComposer()
  const reachable = await ig.run(wc, 'window.__canMessage()')
  if (reachable.kind === 'unreachable') {
    await queue.markUnreachable(item, reachable.error)
    return { sent: false, unreachable: true, item: { name: item.name, username: item.username } }
  }
  if (!ready) throw fail('The DM opened, but the chat never finished loading.', 'notsent')
  await ig.sleep(1500)
  const existing = await ig.readThread(wc)
  if (existing.length) {
    await log.append({ action: 'skip', target: `voice:${item.sheetRow}`, detail: `chat not empty (${existing.length} messages)` })
    return { sent: false, skipped: true, item: { name: item.name, username: item.username, sheetRow: item.sheetRow }, reason: 'The chat already has messages, so no voicenote.' }
  }

  status = { phase: 'preparing', text: `Following @${item.username}` }
  await openUrl(`https://www.instagram.com/${item.username}/`)
  state = await ig.run(wc, 'window.__igPageState()')
  if (state.kind === 'login') throw fail('Log into Instagram in the panel.', 'login')
  if (state.kind === 'blocked') {
    const warning = await confirmWarning(state.text)
    throw fail(warning ? `Instagram showed a warning: ${warning}` : 'Instagram may be limiting actions.', warning ? 'blocked' : 'notsent')
  }
  const followed = await ig.run(wc, 'window.__followProfile()')
  if (followed.click) {
    await ig.click(wc, followed)
    await ig.sleep(1500)
  }

  status = { phase: 'preparing', text: `Opening the DM with @${item.username}` }
  await openUrl(`https://ig.me/m/${encodeURIComponent(item.username)}`)
  state = await ig.run(wc, 'window.__igPageState()')
  if (state.kind === 'login') throw fail('Log into Instagram in the panel.', 'login')
  const composer = await waitForComposer()
  const canMessage = await ig.run(wc, 'window.__canMessage()')
  if (canMessage.kind === 'unreachable') {
    await queue.markUnreachable(item, canMessage.error)
    return { sent: false, unreachable: true, item: { name: item.name, username: item.username } }
  }
  const warning = await confirmWarning('Warning while opening the DM')
  if (warning) throw fail(`Instagram showed a warning: ${warning}`, 'blocked')
  if (!composer?.ok) throw fail('The DM opened, but the voice button never appeared.', 'notsent')

  const audio = fs.readFileSync(item.clip).toString('base64')
  await ensureHook()
  const loaded = await ig.run(wc, `window.__loadVoice(${JSON.stringify(audio)})`)
  clipSeconds = loaded?.duration || 30
  await ig.sleep(SETTLE_BEFORE_SEND_MS)

  // Instagram draws the waveform from the live audio only while the page is visible; a hidden page
  // gives a flat row of dots, so never record unless it is visible.
  if ((await ig.run(wc, 'document.visibilityState')) !== 'visible') await ensureLive()
  if ((await ig.run(wc, 'document.visibilityState')) !== 'visible') throw fail('macOS paused the Instagram panel, so the voicenote was not recorded. It will try again shortly.', 'hidden')
  status = { phase: 'recording', text: `Voicenote to @${item.username} (${item.voice})` }
  await startRecording()
  await waitForEnd()
  const result = await ig.run(wc, 'window.__finishIgRecord()')
  if (!result?.ok) {
    await ig.run(wc, 'window.__cancelIgRecord()').catch(() => {})
    throw fail('The voicenote ended, but Instagram did not show Send.', 'failed')
  }
  await ig.sleep(1500)
  await queue.markSent(item, item.voice)
  const after = await confirmWarning('Warning after a voicenote')
  if (after) throw fail(`Instagram showed a warning after sending: ${after}`, 'blocked')
  await ig.sleep(2000)
  const wave = await ig.lastVoiceWaveform(wc)
  return { sent: true, flatWaveform: Boolean(wave.found && wave.flat), item: { name: item.name, username: item.username, device: item.device, voice: item.voice, sheetRow: item.sheetRow } }
}

// One voicenote at a time. The app wraps this in its safety gate (limits, record, 48 hour stop).
async function sendNext(account) {
  if (running) throw fail('A voicenote is already being sent.', 'busy')
  running = sendOne(account)
  try {
    return await running
  } finally {
    running = null
    status = { phase: 'idle', text: '' }
  }
}

module.exports = { init, active, getStatus, onVoiceState, sendNext }
