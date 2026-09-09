"""AKD Securities: how to find its emails, and how to read its confirmations.

The PDF has a text layer, so no OCR is used - a previous attempt ran it through
Drive OCR, which broke the line structure and parsed nothing at all.

Column order in the extracted text is NOT stable between confirmations. Of eight
real samples, two put Amount immediately after Quantity and the rest put it last.
So nothing is read by position. Each number is identified by its own shape:

    quantity  -> the only token with no decimal point   (200, 1,850)
    rate      -> the only token with exactly 4 decimals (207.8900)
    amount    -> the number closest to quantity x rate

Every row is then checked against that arithmetic, which is what actually catches
a misread - a stricter regex only catches a changed format.
"""

import re
from datetime import datetime

from pypdf import PdfReader

NAME = "AKD Securities"
SENDER = "confirmation@akdsl.com"
SUBJECT = "Trade Confirmation"

MARKETS = ("Ready", "Future", "Odd Lot")

RATE_RE = re.compile(r"^\d+\.\d{4}$")
QTY_RE = re.compile(r"^\d{1,3}(,\d{3})*$")
NUMBER_RE = re.compile(r"\d[\d,]*\.?\d*")
SCRIP_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
MEMO_RE = re.compile(r"\d{6}/COAF\d+")


def is_attachment(filename: str, content_type: str) -> bool:
    """AKD sends the PDF as application/octet-stream, so match the name."""
    return filename.lower().endswith(".pdf") or content_type == "application/pdf"


def _to_number(token: str) -> float:
    return float(token.replace(",", ""))


def _find_date(text: str) -> str:
    match = re.search(r"Date\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})", text)
    if not match:
        raise ValueError("no confirmation date found")
    month, day, year = match.groups()
    return datetime.strptime(f"{month} {day} {year}", "%B %d %Y").strftime("%Y-%m-%d")


def _find_memo(text: str) -> str:
    match = MEMO_RE.search(text)
    if not match:
        raise ValueError("no memo number found")
    return match.group(0)


def _is_trade_line(line: str) -> bool:
    """A trade row names a market. 'Total :' and 'Client Total :' rows do not."""
    squashed = line.replace(" ", "")
    if not any(market.replace(" ", "") in squashed for market in MARKETS):
        return False
    first = line.split()[0] if line.split() else ""
    return bool(SCRIP_RE.match(first))


def _parse_trade_line(line: str) -> dict:
    scrip = line.split()[0]
    rest = line[len(scrip):]
    for market in MARKETS:
        rest = rest.replace(market, " ")
    numbers = NUMBER_RE.findall(rest)

    rates = [n for n in numbers if RATE_RE.match(n)]
    quantities = [n for n in numbers if QTY_RE.match(n)]
    if len(rates) != 1:
        raise ValueError(f"{scrip}: expected one 4-decimal rate, got {rates}")
    if len(quantities) != 1:
        raise ValueError(f"{scrip}: expected one whole-number qty, got {quantities}")

    rate = _to_number(rates[0])
    quantity = int(_to_number(quantities[0]))
    gross = quantity * rate

    candidates = [_to_number(n) for n in numbers if n not in (rates[0], quantities[0])]
    if not candidates:
        raise ValueError(f"{scrip}: no amount on this row")
    amount = min(candidates, key=lambda value: abs(value - gross))

    if gross and abs(amount - gross) / gross > 0.01:
        raise ValueError(
            f"{scrip}: amount {amount:,.2f} is not within 1% of "
            f"{quantity} x {rate} = {gross:,.2f}"
        )
    return {"scrip": scrip, "qty": quantity, "rate": rate, "amount": amount}


def parse(pdf_bytes: bytes) -> list[dict]:
    """Return one dict per trade in a confirmation PDF."""
    import io

    reader = PdfReader(io.BytesIO(pdf_bytes))
    text = "\n".join(p.extract_text(extraction_mode="layout") for p in reader.pages)

    date = _find_date(text)
    memo = _find_memo(text)

    trades = []
    section = None  # which half of the page we are reading

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue

        squashed = line.replace(" ", "")
        if squashed.startswith("PURCHASE"):
            section = "BUY"
            continue
        if squashed.startswith("SALE"):
            section = "SELL"
            continue
        if not _is_trade_line(line):
            continue
        if section is None:
            raise ValueError(f"trade row before any PURCHASE/SALE header: {line}")

        trade = _parse_trade_line(line)
        trade.update(
            date=date,
            memo=memo,
            type=section,
            debit=trade["amount"] if section == "BUY" else None,
            credit=None if section == "BUY" else trade["amount"],
        )
        trades.append(trade)

    if not trades:
        raise ValueError("no trades found in this PDF")
    return trades


def memo_in(text: str) -> str | None:
    """Pull a memo number out of an existing sheet note, whatever its format."""
    match = MEMO_RE.search(text or "")
    return match.group(0) if match else None
