# CLAUDE.md — Portfolio Sync

## What this is
A stateless HTTP service: broker confirmation PDFs in, spreadsheet rows out. It
runs on behalf of other people, so the bar is higher than for a personal script.

It is the third piece of a set. `ai-companion` is a learning project.
`akd-portfolio-sync` is the author's own nightly job and is **not to be touched
from here**. This repo is the shareable version, and it duplicates some parsing
logic from that one on purpose — coupling a running system to an experiment
would be worse than the duplication.

## The one rule that matters
**This service never learns anything about anyone.** No credentials, no storage,
no access to Gmail or Sheets, nothing remembered between requests. Every feature
request should be checked against that first. If something needs a secret or a
database, it belongs in the caller's own Google account, not here.

## Design already settled
- **The brains stay in Python.** Apps Script is a dumb pipe: it gathers PDFs and
  writes cells. If logic starts moving into JavaScript there will be two
  implementations that drift apart.
- **Brokers differ in only four ways** — sender, subject, attachment test, parser.
  Everything else is shared. A new broker is one module plus one line in
  `REGISTRY`; do not grow the abstraction beyond that.

## Things already learned the hard way
- **Never OCR the confirmation.** It has a text layer. Drive OCR broke the line
  structure and parsed zero trades.
- **Column order is not stable between confirmations.** Read each number by its
  shape: quantity has no decimals, rate has exactly four, amount is closest to
  `qty × rate`. Never by position.
- **Validate arithmetic, not format.** It survives layout changes; a stricter
  regex does not.
- **Dedupe on the memo number and on the trade itself.** Statement-imported rows
  carry no memo and are dated by settlement, not trade.
- **Attachments arrive as `application/octet-stream`.** Match the filename.
- **One bad PDF must not fail the batch** — but it contributes none of its own
  trades. Half-understood rows are worse than a skipped day.

## Testing
`python test_endpoint.py` runs against real confirmations whose correct answers
are already known. Keep it that way — assertions against real files catch what
invented fixtures never will.
