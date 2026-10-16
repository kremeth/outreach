// A one-off clean-up of who nutricode.io follows (16 Oct): accounts followed that are not on Hustling
// (Keep hustling Yes), from the following list Mathieu pasted. Launch unfollows them with its normal
// unfollows (same pace, limits and 48 hour stop), after the creators due to be closed out. Each one is
// checked again just before: still not on Hustling, not a partner, not someone we are talking to.
// data/unfollow-cleanup.json: { queue: [username], done: { username: result } }
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'unfollow-cleanup.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    return { queue: [], done: {} }
  }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 1))
}

function pending() {
  const state = load()
  return state.queue.filter((username) => !state.done[username])
}

function mark(username, result) {
  const state = load()
  state.done[username] = { result, at: Date.now() }
  save(state)
}

function summary() {
  const state = load()
  const done = Object.values(state.done)
  return { total: state.queue.length, unfollowed: done.filter((item) => item.result === 'unfollowed').length, skipped: done.filter((item) => item.result !== 'unfollowed').length, left: pending().length }
}

module.exports = { load, save, pending, mark, summary }
