# Outreach

Our influencer outreach app: prospecting (Yes / No), Hustling (pick comments), and Launch, which sends voicenotes, posts the picked comments with a like, and sends relaunches in the background, spread over the day within Instagram-safe limits.

It runs on the shared Google Sheet, so both of us can use it at the same time on our own computers without overwriting each other.

## Setup on a new Mac (once)

1. **Install Node.js 22 or newer** from https://nodejs.org (the LTS installer is fine).
2. **Install Google Chrome** in /Applications if it isn't there (the app uses it in the background for profile previews).
3. **Clone this repo**, for example:
   ```bash
   git clone https://github.com/kremeth/outreach.git ~/Desktop/Outreach
   ```
4. **Add the two secret files** to the repo's `data/` folder. They are deliberately not in GitHub; get them from Mathieu (AirDrop, 1Password, never by email or Slack):
   - `data/google-service-account.json` (lets the app read and write the Google Sheet)
   - `data/gemini-key.txt` (writes the comment options)
5. **Double-click `Start Review.command`.** The first time it installs everything (a minute or two), then opens the Outreach window.
   If macOS says it can't be opened, right-click it, choose Open, then Open again.
6. **Log into Instagram** in the panel on the right of the Outreach window. Approve the login in the Instagram app on your phone if it asks.

Optional: put a short name for your computer in `data/machine-name.txt` (e.g. `Romain`). That name shows in the sheet's App Log tab.

## Daily use

1. **Prospecting:** answer Yes / No (Y / N keys) until you have about 30 Yes. The counter shows "yes today".
2. **Hustling:** pick a comment for each new post (1–5 keys, R for 5 new ones). Picks are saved for Launch.
3. **Launch** on the To do page. It runs from 8:00 to 21:00 and carries anything left over to the next morning. Keep the Outreach window open; it keeps the Mac awake while it runs.

## Working together

- Each computer reserves what it is working on (profiles, creators, posts) in the **App Log** tab of the sheet, so we never get the same profile or send the same message twice.
- Before writing to the sheet, the app re-reads the live cell and never overwrites the other person's answer.
- Instagram limits (comments, DMs, voicenotes per hour and per day) count both computers together. If Instagram ever shows a warning, both computers stop all Instagram actions for 48 hours.
- Don't edit or delete rows in the App Log tab, and don't sort the main sheet while the app is open.

## Updating

```bash
git pull
```
Then open `Start Review.command` again; it installs anything new automatically.

## What is not in the repo

Secrets (`data/google-service-account.json`, `data/gemini-key.txt`), browser logins, logs, and each computer's local state stay on each Mac. The voicenote clips are in `data/voice/clips`.
