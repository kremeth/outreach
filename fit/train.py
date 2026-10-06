"""Learns which sheet profiles are Yes-type from name, handle, bio and followers.

Reads data/fit/text.jsonl (from fit/embed-text.js), reports how well it separates Yes from No,
and scores the pending rows into data/fit/pending-scores.csv.

  detect/.venv/bin/python fit/train.py [--recall 0.98]
"""

import argparse
import csv
import json
import math
import re
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data' / 'fit'
RECENT_FROM_ROW = 6000


def followers_of(text):
    value = str(text or '').strip().upper().replace(',', '')
    match = re.match(r'^([\d.]+)\s*([KM]?)', value)
    if not match:
        return 0.0
    number = float(match.group(1) or 0)
    return number * {'K': 1e3, 'M': 1e6}.get(match.group(2), 1)


def read(name):
    latest = {}
    for line in (DATA / name).read_text().split('\n'):
        if line:
            row = json.loads(line)
            if row.get('vector'):
                latest[row['sheetRow']] = row
    return latest


def load(source, only_rows=None):
    rows = list(read('grid.jsonl' if source == 'grid' else 'text.jsonl').values())
    if only_rows is not None:
        rows = [row for row in rows if row['sheetRow'] in only_rows]
    rows.sort(key=lambda row: row['sheetRow'])
    vectors = np.array([row['vector'] for row in rows], dtype=np.float32)
    followers = np.array([math.log10(1 + followers_of(row['followers'])) for row in rows], dtype=np.float32)
    features = np.hstack([vectors, ((followers - 4) / 1.5)[:, None], ((followers - 4) / 1.5)[:, None] ** 2])
    keep = np.array([row['keep'].strip().lower() for row in rows])
    return rows, features, keep


def model():
    return LogisticRegression(C=1.0, class_weight='balanced', max_iter=3000)


def threshold_for(scores, labels, recall):
    yes = np.sort(scores[labels == 1])
    index = int(math.floor((1 - recall) * len(yes)))
    return yes[max(0, min(index, len(yes) - 1))]


def describe(name, scores, labels, cut):
    yes, no = labels == 1, labels == 0
    kept_yes = (scores[yes] >= cut).mean()
    removed_no = (scores[no] < cut).mean()
    print(f'  {name}: {yes.sum()} Yes / {no.sum()} No -> keeps {kept_yes:.1%} of Yes, removes {removed_no:.1%} of No')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--recall', type=float, default=0.98, help='Share of Yes rows that must survive the filter')
    parser.add_argument('--source', choices=['text', 'grid'], default='grid', help='text = sheet name/handle/bio only, grid = bio plus grid description')
    parser.add_argument('--same-rows', action='store_true', help='Only use rows that have a grid, so text and grid runs are comparable')
    args = parser.parse_args()

    only = set(read('grid.jsonl')) if args.same_rows else None
    rows, features, keep = load(args.source, only)
    print(f'Source: {args.source}' + (' (rows with a grid only)' if args.same_rows else ''))
    labeled = np.isin(keep, ['yes', 'no'])
    X, y = features[labeled], (keep[labeled] == 'yes').astype(int)
    sheet_rows = np.array([row['sheetRow'] for row in rows])[labeled]
    print(f'{labeled.sum()} decided rows ({y.sum()} Yes, {(1 - y).sum()} No), {(~labeled).sum()} pending\n')

    out_of_fold = np.zeros(len(y))
    for train, test in StratifiedKFold(n_splits=5, shuffle=True, random_state=0).split(X, y):
        out_of_fold[test] = model().fit(X[train], y[train]).predict_proba(X[test])[:, 1]
    cut = threshold_for(out_of_fold, y, args.recall)
    print(f'Shuffled 5-fold test (cut-off set to keep {args.recall:.0%} of Yes):')
    describe('all decided rows', out_of_fold, y, cut)
    recent = sheet_rows >= RECENT_FROM_ROW
    describe(f'rows {RECENT_FROM_ROW}+ only', out_of_fold[recent], y[recent], cut)

    older = ~recent
    time_model = model().fit(X[older], y[older])
    time_scores = time_model.predict_proba(X[recent])[:, 1]
    time_cut = threshold_for(time_model.predict_proba(X[older])[:, 1], y[older], args.recall)
    print(f'\nTime-split test (train on rows < {RECENT_FROM_ROW}, test on rows {RECENT_FROM_ROW}+):')
    describe('same cut-off rule', time_scores, y[recent], time_cut)
    recent_cut = threshold_for(time_scores, y[recent], args.recall)
    describe('best cut-off on recent rows (optimistic)', time_scores, y[recent], recent_cut)

    labeled_rows = [row for row, flag in zip(rows, labeled) if flag]
    order = np.argsort(out_of_fold)

    def line(row, prefix):
        found = [part for part in row['text'].split('\n') if part.startswith(prefix)]
        return found[0][len(prefix):].strip() if found else ''

    def show(index):
        row = labeled_rows[index]
        detail = line(row, 'Grid:') or line(row, 'Bio:')
        print(f"  {out_of_fold[index]:.3f} row {row['sheetRow']} {line(row, 'Name:')[:30]} | {detail[:110]}")

    print('\nLowest-scored Yes rows (the ones a strict filter would lose):')
    for index in [i for i in order if y[i] == 1][:8]:
        show(index)
    print('\nLowest-scored No rows (clearest non-fits):')
    for index in [i for i in order if y[i] == 0][:8]:
        show(index)

    pending_rows = [row for row, flag in zip(rows, labeled) if not flag]
    if not len(pending_rows):
        return
    final = model().fit(X, y)
    pending_scores = final.predict_proba(features[~labeled])[:, 1]
    with open(DATA / f'pending-scores-{args.source}.csv', 'w', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['sheetRow', 'name', 'username', 'followers', 'score', 'decision', 'text'])
        for row, score in sorted(zip(pending_rows, pending_scores), key=lambda item: item[1]):
            writer.writerow([row['sheetRow'], row['name'], row['username'], row['followers'], f'{score:.4f}', 'keep' if score >= cut else 'auto-no', row['text'].replace('\n', ' | ')])
    removed = (pending_scores < cut).mean()
    print(f'\nPending rows: {len(pending_scores)} scored, {removed:.1%} would be auto-No at this cut-off ({(pending_scores < cut).sum()} rows)')
    print(f"Saved {DATA / f'pending-scores-{args.source}.csv'}")


if __name__ == '__main__':
    main()
