// Day 7 and day 14 messages for partnerships, written from their own data (drafts: the person reads,
// edits and sends them; nothing here is ever sent on its own).
//   Day 7:  "have you started your supplements? I had a quick look at your data and ..." the clear early
//           improvements, tied to the supplements in their stack and what the research found.
//   Day 14: "hope everything's still good, I had another look and ... is trending the right way", plus
//           when their monthly report is ready and when their reel is pencilled in.
// The data: scripts/partner-insights.js, run with the Nutricode backend's own code and credentials
// (read only), comparing their 14 days before the start (their story) with the days since. Only
// changes clearly beyond their normal day-to-day swing count; when there are none, the message says
// nothing about results (never invents any).
// Drafts kept in data/partner-drafts.json by username: { day7: {...}, day14: {...} }.
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const openai = require('./openai')
const dmReply = require('./dm-reply')

const BACKEND = process.env.NUTRICODE_BACKEND || '/Users/mathieukremeth/Desktop/NutricodeBackend'
const RESEARCH = process.env.NUTRICODE_RESEARCH || '/Users/mathieukremeth/Desktop/NutricodeApp/figma/metrics_supplement_research copy 5.json'
const STORE = path.join(__dirname, '..', 'data', 'partner-drafts.json')
const SCRIPT = path.join(__dirname, '..', 'scripts', 'partner-insights.js')

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return {} }
}
function save(store) {
  const tmp = `${STORE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1))
  fs.renameSync(tmp, STORE)
}

const available = () => fs.existsSync(path.join(BACKEND, 'function-device-connection', 'service_account.json')) && fs.existsSync(RESEARCH)

// Their data since `start` (iso), over `days` days.
function analyse({ email, start, days }) {
  return new Promise((resolve) => {
    if (!email) return resolve({ ok: false, reason: 'No app email for them on the Ongoing Partnerships tab.' })
    execFile(process.execPath, [SCRIPT, BACKEND, RESEARCH, JSON.stringify({ email, start, days })], { cwd: path.join(BACKEND, 'function-device-connection'), timeout: 4 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(JSON.parse(String(stdout || '{}')))
      } catch {
        resolve({ ok: false, reason: error ? error.message : 'The analysis gave nothing back.' })
      }
    })
  })
}

const longDate = (isoText) => new Date(`${isoText}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })

const INSTRUCTIONS = `You write a short Instagram DM from Mathieu, co-founder of nutricode.io (personalised supplements based on wearable data), to a creator he is partnering with. Write like a friendly founder texting: warm, casual, Australian-friendly, first person ("I"), ONE paragraph, no line breaks, no hashtags, at most one or two emojis, under 90 words.
Rules:
- Use ONLY the findings given. Never invent numbers, metrics or effects. Round numbers simply ("about 4 bpm lower").
- Talk about results as early signs ("already", "trending the right way", "early days but"), never as medical claims or guarantees.
- When a finding has research for a supplement in their stack, say it plainly: e.g. "which is exactly what the research on Magnesium shows" (you may name the supplement, not the paper).
- When there are no clear findings: do not mention any results; just say you're keeping an eye on their data and the monthly report will show the full picture.
- Do not mention data that got worse.`

async function writeDraft({ which, firstName, analysis, reportDate, reelDue, note = '' }) {
  const findings = (analysis.ok && analysis.improved || []).map((item) => ({
    metric: item.label, before: item.before, after: item.after, change_percent: item.pct,
    research: (item.research || []).map((r) => ({ supplement: r.supplement, finding: r.finding.slice(0, 300), effect: r.effect })),
  }))
  const brief = which === 'day7'
    ? `Day 7 since they started. The message: hey ${firstName || ''}, have you started on your supplements yet / hope you're getting on well with them; I had a quick look at your data and (the findings, if any, tied to their stack and the research). Close warmly.`
    : `Day 14 since they started. The message: hey ${firstName || ''}, hope everything's still good with the supplements; I had another look at your data and (the findings, if any: what is working, trending the right way); hope you're feeling the effect too. Then: your monthly report will be ready on ${longDate(reportDate)}, and we've pencilled your reel in for ${longDate(reelDue)} (a week after, so you'll have the report experience for it). Ask if that works.`
  const input = `${brief}\nTheir stack: ${(analysis.stack || []).join(', ') || 'unknown'}.\nFindings (clear improvements since they started, before -> after): ${findings.length ? JSON.stringify(findings) : 'none clear yet'}.${note ? `\nMathieu's note for this message (follow it): ${note}` : ''}\nWrite the message.`
  const answer = await openai.ask({
    model: dmReply.MODEL, effort: 'medium', instructions: INSTRUCTIONS, input, name: 'partner_message', purpose: 'partner check-in draft',
    schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  })
  return dmReply.oneParagraph(answer.message)
}

// Makes (or makes again) a partner's day 7 or day 14 draft.
async function draft(partner, which, { note = '' } = {}) {
  const days = which === 'day7' ? 7 : 14
  const analysis = available() ? await analyse({ email: partner.appEmail, start: partner.storyDate, days }) : { ok: false, reason: 'The Nutricode backend is not on this Mac.' }
  const text = await writeDraft({ which, firstName: partner.firstName, analysis, reportDate: partner.reportDate, reelDue: partner.reelDue, note })
  const store = load()
  store[partner.username] = { ...(store[partner.username] || {}), [which]: {
    text, at: Date.now(), status: 'draft',
    device: analysis.device || '', reason: analysis.ok ? '' : analysis.reason || '',
    findings: (analysis.improved || []).map((item) => ({ label: item.label, before: item.before, after: item.after, research: (item.research || []).map((r) => r.supplement) })),
    daysAfter: analysis.daysAfter || 0,
  } }
  save(store)
  return store[partner.username][which]
}

function get(username) {
  return load()[username] || {}
}

function setStatus(username, which, status, extra = {}) {
  const store = load()
  if (!store[username]?.[which]) return
  Object.assign(store[username][which], { status, ...extra })
  save(store)
}

module.exports = { draft, get, setStatus, analyse, available }
