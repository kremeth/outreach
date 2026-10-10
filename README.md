# Outreach

Our influencer outreach app: prospecting (Yes / No), Hustling (pick comments), and Launch, which sends voicenotes, posts the picked comments with a like, sends relaunches, and unfollows creators who never replied or said no, in the background, spread over the day within Instagram-safe limits.

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
5. **Double-click `Install Dock App.command`.** It installs everything (a minute or two), builds **Outreach** in your Applications folder and adds it to the Dock.
   If macOS says it can't be opened, right-click it, choose Open, then Open again.
6. **Double-click `Setup Ranker.command`** (needs Python 3.10+). It sets up the local pick predictor once: a Python environment (`.venv`) with PyTorch and SentenceTransformers, and the Sentence-BERT model saved to `models/sentence_encoder/`. Everything after that runs offline (see *Pick predictor* below).
7. **Open Outreach from the Dock** and log into Instagram in the panel on the right. Approve the login in the Instagram app on your phone if it asks.

From then on, just click Outreach in the Dock. (`Start Review.command` still works too.)

Optional: put a short name for your computer in `data/machine-name.txt` (e.g. `Romain`). That name shows in the sheet's App Log tab.

## Daily use

1. **Prospecting:** answer Yes / No (Y / N keys) until you have about 30 Yes. The counter shows "yes today".
2. **Hustling:** pick a comment for each new post (1–5 keys, R for 5 new ones). Picks are saved for Launch. Next to each of the 5 options, the pick predictor shows how likely you are to pick it (adding up to 100). It runs entirely on this computer (see *Pick predictor*).
   Every round of 5 suggestions and what you did with it (picked, own comment, rewrote and how, skipped, later, undo) is saved to the **HUSTLING Training Data** tab, to train a model later.
3. **Launch** on the To do page. It runs from 8:00 to 21:00 and carries anything left over to the next morning. Outreach just has to be open; it can sit on another desktop or behind other windows, and it keeps the Mac awake while it runs. Launch stays on until you press Stop: if Outreach, its server or the Mac restarts, it picks up again by itself.

   Before each relaunch the chat is read. If they wrote back, Gemini judges the reply: a clear no is marked **No** and they are unfollowed; anything still going is marked **Replied**. Three days after the 2nd relaunch, the chat is checked again: no reply means unfollow and **unfollowed** in the sheet (at most 20 unfollows a day).

The **API costs** card at the top of To do shows what the Gemini API cost today (large), this week and this month, in USD, for both computers. It is computed from the token counts Gemini reports for every call, at Google's published rates; each computer writes its own daily totals to the sheet's **API Usage** tab.

## Pick predictor (local ranker)

Gemini only writes the 5 comment options. Ranking them is done by `ranker/`, a Python package that runs 100% on this computer: Sentence-BERT (`all-MiniLM-L6-v2`) embeds the comments locally, and an attention network (PyTorch: self-attention over the 5 comments and the post, cross-attention to your recent picks) scores them; a softmax gives the chances.

**Install and provision once** (online): `Setup Ranker.command`, or by hand:
```bash
python3 -m venv .venv
```
```bash
.venv/bin/pip install -r ranker/requirements.txt
```
```bash
.venv/bin/python -m ranker.setup_models
```
After this you can switch Wi-Fi off: training, evaluation, checkpoints and predictions never need the network. The ranker forces Hugging Face offline mode (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `local_files_only=True`), turns telemetry off and only loads the encoder from `models/sentence_encoder/`. Paths live in `ranker/config.py` (override with `RANKER_ENCODER_DIR`, `RANKER_DATA_DIR`, `RANKER_DATASET`).

**Data:** Outreach writes the training tab to `data/ranker/dataset.jsonl` whenever it reads the sheet. Embeddings are cached in `data/ranker/embeddings.sqlite`, checkpoints in `data/ranker/checkpoints/`, metrics in `data/ranker/metrics.json`, the log in `data/ranker/ranker.log`.

**Train locally** (Outreach also does this by itself every 5 new picks): uses CUDA or Apple Silicon (MPS) when available, otherwise CPU.
```bash
.venv/bin/python -m ranker.train
```
**Evaluate locally** (on the time-ordered train / validation / test split; the test rounds are the newest and never trained on):
```bash
.venv/bin/python -m ranker.evaluate
```
**Predict locally** (CPU is enough):
```bash
.venv/bin/python -c "from ranker import predict_comments; print(predict_comments(['one', 'two', 'three', 'four', 'five']))"
```
`predict_comments(comments)` returns `probabilities` (sum to 1), `percentages` (sum to 100), `best_index` and `best_comment`. Outreach talks to a long-running local worker (`python -m ranker.serve`, JSON over stdin/stdout, no sockets).

**Offline tests** (all network connections are blocked for the run): the encoder loads from disk, a training step and an evaluation run, a checkpoint saves and loads, five comments get probabilities summing to 1 and a winner.
```bash
.venv/bin/python -m unittest ranker.test_offline -v
```

## Working together

- Each computer reserves what it is working on (profiles, creators, posts) in the **App Log** tab of the sheet, so we never get the same profile or send the same message twice.
- Before writing to the sheet, the app re-reads the live cell and never overwrites the other person's answer.
- Instagram limits (comments, DMs, voicenotes per hour and per day) count both computers together. If Instagram ever shows a warning, both computers stop all Instagram actions for 48 hours.
- Don't edit or delete rows in the App Log tab, and don't sort the main sheet while the app is open.

## Updating

```bash
git pull
```
Quit and reopen Outreach. The Dock app runs the code from this folder, so there is nothing to rebuild. Only run `Install Dock App.command` again if you move this folder, or if an update says Electron changed (then run `npm install` first).

## What is not in the repo

Secrets (`data/google-service-account.json`, `data/gemini-key.txt`), browser logins, logs, each computer's local state, the Python environment (`.venv`) and the Sentence-BERT weights (`models/`) stay on each Mac. The voicenote clips are in `data/voice/clips`.
