# Portfolio Sync

A small service that turns broker trade-confirmation PDFs into rows a spreadsheet
can write.

It exists for one reason: Google Apps Script cannot read a PDF. Everything else a
portfolio sync needs — finding the email, writing the sheet, setting a daily
trigger — Apps Script does well, inside the user's own Google account, with no
password shared and nothing to host. Only the parsing has to happen elsewhere, so
only the parsing lives here.

## What it deliberately cannot do

- hold credentials
- reach anyone's Gmail
- open anyone's spreadsheet
- remember a single request

A PDF comes in, rows go back out. Keeping the contract that narrow is what makes
it safe to run on behalf of other people.

## Endpoints

| | |
|---|---|
| `GET /health` | liveness, and which brokers are supported |
| `GET /brokers` | what a broker dropdown should offer |
| `GET /prices?symbols=DGKC,LUCK` | current PSX prices (all of them if omitted) |
| `POST /parse` | confirmations in, trades out |

`POST /parse` takes the PDFs base64 encoded, plus whatever the sheet already
holds so duplicates can be skipped:

```json
{
  "broker": "akd",
  "pdfs": [{"name": "COAF21602.pdf", "content_type": "application/octet-stream",
            "data": "<base64>"}],
  "known_rows": [["DGKC", "BUY", 200, 207.89, "Memo 260901/COAF21602"]],
  "sectors": {"DGKC": "Cement"}
}
```

and answers with the trades that are genuinely new:

```json
{
  "trades": [{"date": "2026-09-01", "scrip": "DGKC", "sector": "Cement",
              "type": "BUY", "qty": 200, "rate": 207.89,
              "debit": 41650.71, "credit": null, "notes": "Memo 260901/COAF21602"}],
  "duplicates_skipped": 7, "new_scrips": [], "problems": [], "pdfs_read": 5
}
```

## Adding a broker

Only four things differ between brokers: the sender, the subject, which
attachment is the confirmation, and how to read the PDF. Everything after that is
shared. So a new broker is one module in `brokers/` and one line in `REGISTRY`,
and the dropdown is `list(REGISTRY)`.

## Running it

```
pip install -r requirements.txt
uvicorn app:app --reload          # http://127.0.0.1:8000/docs
python test_endpoint.py           # smoke test against real confirmations
```

## How it protects the caller

- Each trade is checked against `qty × rate ± charges = amount`. More than 1% out
  and it is rejected with a reason, not written.
- Duplicates are caught on the memo number *and* on the trade itself, because
  rows imported from an account statement carry no memo and are often dated by
  settlement rather than trade.
- One unreadable PDF is reported and skipped; the rest of the batch still goes
  through. But a PDF that fails contributes none of its own trades.
