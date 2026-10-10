(() => {
  if (window.__voiceHooked) return
  window.__voiceHooked = true

  const NativeRecorder = window.MediaRecorder
  if (NativeRecorder) {
    class HQRecorder extends NativeRecorder {
      constructor(stream, options = {}) {
        const settings = { ...options }
        delete settings.bitsPerSecond
        settings.audioBitsPerSecond = 192000
        super(stream, settings)
      }
    }
    window.MediaRecorder = HQRecorder
  }

  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)

  function labelOf(el) {
    const bits = [el.getAttribute('aria-label'), el.getAttribute('title')]
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      bits.push(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '))
    }
    if (el.innerText && el.innerText.length < 80) bits.push(el.innerText)
    for (const node of el.querySelectorAll?.('[aria-label], svg title') || []) {
      bits.push(node.getAttribute?.('aria-label') || node.textContent || '')
    }
    return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  function visible(el) {
    const rect = el.getClientRects()[0]
    if (!rect || rect.width < 8 || rect.height < 8) return false
    const style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }

  function collect(node, out) {
    if (!node || node.nodeType !== 1) return
    if (node.matches && node.matches('button, [role="button"], [aria-label]') && visible(node)) out.push(node)
    if (node.shadowRoot) collect(node.shadowRoot, out)
    for (const child of node.children || []) collect(child, out)
  }

  function buttons() {
    const nodes = []
    collect(document.body, nodes)
    const seen = new Set()
    return nodes.map((el) => {
      const clickable = el.closest?.('button, [role="button"]') || el
      return { el: clickable, label: labelOf(el) || labelOf(clickable) }
    }).filter((item) => {
      if (!item.label || seen.has(item.el)) return false
      seen.add(item.el)
      return true
    })
  }

  function inComposer(item) {
    const rect = item.el.getBoundingClientRect()
    return rect.top > window.innerHeight * 0.45
  }

  function find(pattern, { composer = false } = {}) {
    const pool = composer ? buttons().filter(inComposer) : buttons()
    return pool.find((item) => pattern.test(item.label))
  }

  function pointOf(el) {
    const rect = el.getBoundingClientRect()
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    }
  }

  function headerButtons() {
    const root = document.querySelector('main header') || document.querySelector('header')
    if (!root) return []
    return [...root.querySelectorAll('button, [role="button"]')].filter(visible).map((el) => ({
      el,
      label: (el.innerText || '').replace(/\s+/g, ' ').trim(),
    })).filter((item) => item.label && item.label.length < 40)
  }

  function composerMic() {
    const nodes = []
    collect(document.body, nodes)
    const seen = new Set()
    const hits = []
    for (const node of nodes) {
      const el = node.closest?.('button, [role="button"]') || node
      if (!el || seen.has(el) || !visible(el)) continue
      seen.add(el)
      const label = labelOf(el)
      if (!label || label.length > 40) continue
      if (!/\b(voice clip|microphone)\b/i.test(label)) continue
      if (/call|voice message|sent a voice/i.test(label)) continue
      const rect = el.getBoundingClientRect()
      if (rect.top < window.innerHeight - 160) continue
      if (rect.width > 72 || rect.height > 72) continue
      hits.push({ el, label })
    }
    return hits[0] || null
  }

  function press(el) {
    const rect = el.getBoundingClientRect()
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.click()
  }

  navigator.mediaDevices.getUserMedia = async function getUserMedia(constraints) {
    const audioOnly = Boolean(constraints && constraints.audio && !constraints.video)
    if (audioOnly && window.__armVoiceNote && window.__audioBuffer && window.__audioCtx) {
      window.__armVoiceNote = false
      const ctx = window.__audioCtx
      if (ctx.state === 'suspended') await ctx.resume()
      const dest = ctx.createMediaStreamDestination()
      const source = ctx.createBufferSource()
      source.buffer = window.__audioBuffer
      source.connect(dest)
      window.__voiceSource = source
      window.__voiceStream = dest.stream
      source.onended = () => {
        if (window.__voiceCancel) return
        document.documentElement.dataset.voiceState = 'ended'
      }
      document.documentElement.dataset.voiceState = 'recording'
      window.__speechTimer = setTimeout(() => {
        if (window.__voiceCancel) return
        source.start()
        document.documentElement.dataset.voiceState = 'speech'
      }, 450)
      return dest.stream
    }
    return original(constraints)
  }

  window.__loadVoice = async (b64) => {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const ctx = window.__audioCtx || new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    window.__audioCtx = ctx
    const copy = bytes.buffer.slice(0)
    window.__audioBuffer = await ctx.decodeAudioData(copy)
    document.documentElement.dataset.voiceState = 'ready'
    return { ok: true, duration: window.__audioBuffer.duration }
  }

  window.__startIgRecord = () => {
    window.__voiceCancel = false
    window.__armVoiceNote = true
    const mic = composerMic()
    if (!mic) {
      window.__armVoiceNote = false
      return {
        ok: false,
        error: 'No voice button in this chat yet.',
        labels: buttons().filter(inComposer).slice(0, 16).map((item) => item.label),
      }
    }
    press(mic.el)
    return { ok: true, label: mic.label, pressed: true, ...pointOf(mic.el) }
  }

  window.__composerReady = () => {
    const mic = composerMic()
    if (!mic) return { ok: false }
    return { ok: true, label: mic.label, ...pointOf(mic.el) }
  }

  function stopStream() {
    if (!window.__voiceStream) return
    window.__voiceStream.getTracks().forEach((track) => track.stop())
  }

  function sendButton() {
    const pool = buttons().filter(inComposer)
    const match = pool.find((item) => /^send$/i.test(item.label))
      || pool.find((item) => /\bsend\b/i.test(item.label) && !/unsend/i.test(item.label))
    if (!match) return null
    return match
  }

  window.__finishIgRecord = async () => {
    stopStream()
    const end = find(/end recording/i, { composer: true }) || find(/stop recording/i, { composer: true })
    if (end) press(end.el)

    let target = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      target = sendButton()
      if (target) break
    }
    if (!target) {
      return {
        ok: false,
        ended: Boolean(end),
        labels: buttons().filter(inComposer).slice(0, 24).map((item) => item.label),
      }
    }
    press(target.el)
    return { ok: true, ended: Boolean(end), sent: target.label }
  }

  window.__cancelIgRecord = () => {
    window.__voiceCancel = true
    window.__armVoiceNote = false
    clearTimeout(window.__speechTimer)
    if (window.__voiceSource) {
      try { window.__voiceSource.onended = null } catch (error) {}
      try { window.__voiceSource.stop() } catch (error) {}
    }
    const cancel = find(/^cancel$/i, { composer: true })
    if (cancel) press(cancel.el)
    document.documentElement.dataset.voiceState = 'cancelled'
    return { ok: true, cancelled: Boolean(cancel) }
  }

  function pageText() {
    return (document.body?.innerText || '').slice(0, 2500)
  }

  window.__igPageState = () => {
    const text = pageText()
    const path = location.pathname.toLowerCase()
    if (/action blocked|try again later|we limit how often|confirm you're human|suspicious activity/i.test(text)) {
      return { kind: 'blocked', text: text.slice(0, 200) }
    }
    if (path.startsWith('/accounts/login') || /log in to continue|log into instagram/i.test(text)) {
      return { kind: 'login' }
    }
    // A deleted (or renamed) account: its profile and its chat link both show this page.
    if (/sorry, this page isn't available/i.test(text)) return { kind: 'missing' }
    return { kind: 'ok', path, text: text.slice(0, 200) }
  }

  window.__followProfile = () => {
    const blocked = window.__igPageState()
    if (blocked.kind !== 'ok') return { ok: false, ...blocked }
    const items = headerButtons()
    const already = items.find((item) => /^(following|requested)\b/i.test(item.label))
    if (already) return { ok: true, already: already.label }
    const follow = items.find((item) => /^follow( back)?$/i.test(item.label))
    if (!follow) {
      return {
        ok: false,
        error: 'No Follow button on this profile.',
        labels: items.map((item) => item.label).slice(0, 12),
      }
    }
    return { ok: true, click: true, label: follow.label, ...pointOf(follow.el) }
  }

  // Unfollow, step 1: the profile's Following (or Requested) button. notFollowing when it already says Follow.
  window.__unfollowStart = () => {
    const blocked = window.__igPageState()
    if (blocked.kind !== 'ok') return { ok: false, ...blocked }
    const items = headerButtons()
    if (items.some((item) => /^follow( back)?$/i.test(item.label))) return { ok: true, notFollowing: true }
    const following = items.find((item) => /^(following|requested)\b/i.test(item.label))
    if (!following) return { ok: false, error: 'No Following button on this profile.', labels: items.map((item) => item.label).slice(0, 12) }
    return { ok: true, click: true, label: following.label, ...pointOf(following.el) }
  }

  // Unfollow, step 2: the "Unfollow" choice in the menu or confirmation dialog that opened, newest dialog first.
  window.__unfollowChoice = () => {
    for (const dialog of [...document.querySelectorAll('[role="dialog"]')].reverse()) {
      const target = [...dialog.querySelectorAll('button, [role="button"], div, span')]
        .filter((el) => visible(el) && el.children.length < 4 && /^unfollow$/i.test((el.innerText || '').trim()))
        .pop()
      if (target) return { ok: true, ...pointOf(target.closest('button, [role="button"]') || target) }
    }
    return { ok: false }
  }

  window.__canMessage = () => {
    const blocked = window.__igPageState()
    if (blocked.kind !== 'ok') return { ok: false, ...blocked }
    const text = pageText()
    if (/doesn't allow new message requests|you can't message this account|messaging unavailable/i.test(text)) {
      return { ok: false, kind: 'unreachable', error: 'This account cannot receive your messages.' }
    }
    const mic = composerMic()
    return { ok: Boolean(mic), mic: mic?.label || '' }
  }
})()
