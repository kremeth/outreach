#!/usr/bin/env node
// A partner's first days on their supplements, from the Nutricode backend (read only): their device data
// before vs since they started (the day of their story), the metrics that clearly improved, and what the
// research says about the supplements in their stack for those metrics.
//
// Runs with the backend's own code and credentials (its time-series extraction, as the monthly report
// uses), started by lib/partner-insights.js:
//   node scripts/partner-insights.js <backendDir> <researchJson> '{"email":"...","start":"2026-10-08","days":7}'
// Prints one JSON object.
const path = require('path')

const [backendDir, researchPath, inputJson] = process.argv.slice(2)
const functions = path.join(backendDir, 'function-device-connection')
const admin = require(path.join(functions, 'node_modules', 'firebase-admin'))
const { extractTimeSeries } = require(path.join(functions, 'analysis_monthly', 'lib', 'extractTimeSeries'))

// The metrics looked at: the device series name, better when it goes up or down, the research key, and
// how to say it.
const METRICS = [
  { name: 'HRV', better: 1, research: 'hrv', label: 'HRV', unit: 'ms', format: (v) => `${Math.round(v)} ms` },
  { name: 'RHR', better: -1, research: 'rhr', label: 'resting heart rate', unit: 'bpm', format: (v) => `${Math.round(v)} bpm` },
  { name: 'deep_sleep', better: 1, research: 'deep_sleep', label: 'deep sleep', unit: 'min', format: (v) => `${Math.round(v / 60)} min` },
  { name: 'rem_sleep', better: 1, research: 'rem_sleep', label: 'REM sleep', unit: 'min', format: (v) => `${Math.round(v / 60)} min` },
  { name: 'sleep_score', better: 1, research: 'sleep_quality', label: 'sleep score', unit: '', format: (v) => `${Math.round(v)}` },
  { name: 'sleep_efficiency', better: 1, research: 'sleep_quality', label: 'sleep efficiency', unit: '%', format: (v) => `${Math.round((v <= 1 ? v * 100 : v))}%` },
  { name: 'recovery', better: 1, research: 'recovery', label: 'recovery', unit: '%', format: (v) => `${Math.round(v)}%` },
  { name: 'awake_time', better: -1, research: 'sleep_disruptions', label: 'time awake at night', unit: 'min', format: (v) => `${Math.round(v / 60)} min` },
  { name: 'disturbances', better: -1, research: 'sleep_disruptions', label: 'sleep disturbances', unit: '', format: (v) => `${v.toFixed(1)} a night` },
  { name: 'sleep_time', better: 1, research: 'sleep_quality', label: 'total sleep', unit: 'h', format: (v) => `${(v / 3600).toFixed(1)} h` },
  { name: 'vo2_max', better: 1, research: 'vo2_max', label: 'VO2 max', unit: '', format: (v) => `${v.toFixed(1)}` },
]
const DEVICES = ['whoop', 'oura', 'garmin', 'polar', 'apple']
const BASELINE_DAYS = 14

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length
const sd = (values) => { const m = mean(values); return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1)) }
const addDays = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }

async function findUser(db, email) {
  const wanted = String(email || '').trim().toLowerCase()
  if (!wanted) return null
  for (const variant of [wanted, email]) {
    const exact = await db.collection('users').where('email', '==', variant).limit(1).get()
    if (!exact.empty) return exact.docs[0]
  }
  const all = await db.collection('users').select('email').get()
  return all.docs.find((doc) => String(doc.data().email || '').trim().toLowerCase() === wanted) || null
}

// The research for a metric and the supplements in their stack: the best-scored study for each.
function researchFor(research, key, stack) {
  const table = research[key] || {}
  const found = []
  for (const supplement of stack) {
    const entry = table[supplement]
    if (!entry || !(entry.supplement_score > 0) || !(entry.papers || []).length) continue
    const rank = { large: 4, strong: 3, moderate: 2, small: 1, weak: 1 }
    const paper = [...entry.papers].sort((a, b) => (rank[b.effect_strength] || 0) - (rank[a.effect_strength] || 0) || (b.study_type_score || 0) - (a.study_type_score || 0))[0]
    found.push({ supplement, score: entry.supplement_score, effect: paper.effect_strength || '', finding: paper.reasoning || paper.summary_text || '', study: paper.study_tag || '', duration: paper.trial_duration || '' })
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 2)
}

async function main() {
  const input = JSON.parse(inputJson || '{}')
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(require(path.join(functions, 'service_account.json'))) })
  const db = admin.firestore()
  // A cell can hold more than one email (a couple sharing a partnership): the first with an app account.
  let user = null
  for (const email of String(input.email || '').split(/[\s,;]+/).filter(Boolean)) {
    user = await findUser(db, email)
    if (user) break
  }
  if (!user) return { ok: false, reason: `No app account with the email ${input.email}.` }
  const ref = db.collection('users').doc(user.id)
  const supplements = await ref.collection('current_supplements').get()
  const latest = supplements.docs.map((doc) => doc.data()).sort((a, b) => (a.timestamp?._seconds || 0) - (b.timestamp?._seconds || 0)).pop() || {}
  const stack = latest.supplementList || []
  const subcollections = (await ref.listCollections()).map((c) => c.id)
  const start = input.start
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // Days on the supplements so far: from the start, at most `days`, never today (not complete).
  const endAfter = [addDays(start, (input.days || 7) - 1), addDays(today, -1)].sort()[0]
  // The device with data after the start (a wearable first; Apple only when nothing else has it).
  let chosen = null
  for (const device of DEVICES.filter((d) => subcollections.includes(d))) {
    try {
      const series = await extractTimeSeries({ userId: user.id, device, lastDays: 60, endDate: today })
      const keys = series.visualization?.meta?.date_keys || []
      const after = keys.filter((k) => k >= start && k <= endAfter).length
      if (after >= 3 && (!chosen || after > chosen.after)) chosen = { device, series, after }
      if (chosen && device !== 'apple') break
    } catch {}
  }
  const base = { ok: true, userId: user.id, stack, start, endAfter, firstName: '' }
  if (!chosen) return { ...base, ok: false, reason: 'No device data since they started (their device may not be syncing).', stack }
  const viz = chosen.series.visualization
  const keys = viz.meta.date_keys
  const index = (k) => String(keys.indexOf(k) + 1)
  const before = keys.filter((k) => k >= addDays(start, -BASELINE_DAYS) && k < start)
  const after = keys.filter((k) => k >= start && k <= endAfter)
  const metrics = []
  for (const metric of METRICS) {
    const series = viz.metrics?.[metric.name]
    if (!series) continue
    const values = (list) => list.map((k) => series[index(k)]).filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    const b = values(before)
    const a = values(after)
    if (b.length < 5 || a.length < 3) continue
    const spread = sd(b) || 1e-9
    const change = mean(a) - mean(b)
    // How clear the change is, against their normal day-to-day spread (positive = better).
    const z = (change / spread) * metric.better
    metrics.push({
      metric: metric.name, label: metric.label, better: z > 0, z: Number(z.toFixed(2)),
      before: metric.format(mean(b)), after: metric.format(mean(a)),
      pct: Number(((change / Math.abs(mean(b))) * 100).toFixed(1)),
      daysBefore: b.length, daysAfter: a.length,
      research: z > 0 ? researchFor(input.researchData || require(researchPath), metric.research, stack) : [],
    })
  }
  metrics.sort((x, y) => y.z - x.z)
  // Clear improvements (half a typical day-to-day swing or more), the strongest first.
  const improved = metrics.filter((m) => m.z >= 0.5).slice(0, 4)
  return { ...base, device: chosen.device, daysBefore: before.length, daysAfter: after.length, improved, all: metrics }
}

main().then((result) => {
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}).catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, reason: error.message }))
  process.exit(0)
})
