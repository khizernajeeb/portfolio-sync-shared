"""Turns broker confirmation PDFs into rows a spreadsheet can write.

This exists because Google Apps Script cannot read a PDF. Everything else in the
sync - finding the email, writing the sheet - Apps Script does perfectly well in
the user's own Google account. Only the parsing has to happen somewhere else, so
only the parsing lives here.

The service is deliberately ignorant. It holds no credentials, stores nothing,
cannot reach anyone's Gmail or spreadsheet, and forgets each request as soon as
it answers. A PDF comes in and rows go back out. That is the whole contract, and
keeping it that narrow is what makes it safe to run for other people.
"""

import base64
import binascii
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import brokers
import prices as psx

MAX_PDFS_PER_REQUEST = 60

app = FastAPI(
    title="Portfolio Sync",
    description="Broker confirmation PDFs in, spreadsheet rows out.",
    version="1.0.0",
)


class Attachment(BaseModel):
    name: str = ""
    content_type: str = ""
    data: str = Field(description="the PDF, base64 encoded")


class ParseRequest(BaseModel):
    broker: str = "akd"
    pdfs: list[Attachment]
    known_rows: list[list[Any]] = Field(
        default_factory=list,
        description="existing sheet rows as [scrip, type, qty, rate, notes], "
                    "used to skip trades that are already recorded",
    )
    sectors: dict[str, str] = Field(
        default_factory=dict,
        description="symbol -> sector, from the sheet's own list",
    )


class Trade(BaseModel):
    date: str
    scrip: str
    sector: str
    type: str
    qty: int
    rate: float
    debit: float | None
    credit: float | None
    notes: str


class ParseResponse(BaseModel):
    trades: list[Trade]
    duplicates_skipped: int
    new_scrips: list[str]
    problems: list[str]
    pdfs_read: int


def _number(value) -> float | None:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _known_keys(rows: list[list[Any]], broker: brokers.Broker) -> tuple[set, set]:
    """Build both duplicate keys from whatever the sheet already holds.

    Two keys, because rows can arrive from more than one source. Confirmations
    carry a memo number; rows imported from an account statement do not, and are
    often dated by settlement rather than by trade. The trade-shaped key covers
    those. An earlier version of this sync matched only one note format and saw
    36 of 325 rows - had its parser worked it would have re-added the other 289.
    """
    memo_keys, trade_keys = set(), set()
    for row in rows:
        row = list(row) + [""] * (5 - len(row))
        scrip = str(row[0]).strip().upper()
        kind = str(row[1]).strip().upper()
        qty, rate = _number(row[2]), _number(row[3])
        if not scrip or qty is None or rate is None:
            continue
        shape = (scrip, kind, int(qty), round(rate, 4))
        trade_keys.add(shape)
        memo = broker.memo_in(str(row[4]))
        if memo:
            memo_keys.add((memo,) + shape)
    return memo_keys, trade_keys


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "brokers": list(brokers.REGISTRY)}


@app.get("/brokers")
def list_brokers() -> list[dict]:
    """What a broker dropdown should offer, and how to search each one's mail."""
    return [
        {
            "key": b.key,
            "name": b.name,
            "sender": b.sender,
            "subject": b.subject,
            "gmail_query": b.gmail_query(7),
        }
        for b in brokers.REGISTRY.values()
    ]


@app.get("/prices")
def current_prices(symbols: str = "") -> dict:
    """All PSX prices, or just the comma-separated symbols asked for."""
    try:
        everything = psx.all_prices()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PSX unavailable: {exc}")

    wanted = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not wanted:
        return {"prices": everything, "missing": []}
    return {
        "prices": {s: everything[s] for s in wanted if s in everything},
        "missing": [s for s in wanted if s not in everything],
    }


@app.post("/parse", response_model=ParseResponse)
def parse(request: ParseRequest) -> ParseResponse:
    try:
        broker = brokers.get(request.broker)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if len(request.pdfs) > MAX_PDFS_PER_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=f"{len(request.pdfs)} PDFs in one request; send at most "
                   f"{MAX_PDFS_PER_REQUEST} per call and repeat.",
        )

    memo_keys, trade_keys = _known_keys(request.known_rows, broker)
    sectors = {k.strip().upper(): v for k, v in request.sectors.items()}

    trades: list[Trade] = []
    problems: list[str] = []
    new_scrips: list[str] = []
    duplicates = 0
    read = 0

    for attachment in request.pdfs:
        label = attachment.name or "attachment"
        if not broker.is_attachment(attachment.name, attachment.content_type):
            continue
        try:
            pdf_bytes = base64.b64decode(attachment.data, validate=True)
        except (binascii.Error, ValueError):
            problems.append(f"{label}: not valid base64")
            continue

        # Each confirmation stands alone. One unreadable PDF must not stop the
        # others, but a PDF that fails contributes none of its own trades -
        # half-understood rows are worse than a skipped day.
        try:
            parsed = broker.parse(pdf_bytes)
        except Exception as exc:
            problems.append(f"{label}: {exc}")
            continue

        read += 1
        for trade in parsed:
            shape = (trade["scrip"], trade["type"], trade["qty"], round(trade["rate"], 4))
            if ((trade["memo"],) + shape) in memo_keys or shape in trade_keys:
                duplicates += 1
                continue
            trade_keys.add(shape)   # guard against repeats inside this batch

            if trade["scrip"] not in sectors and trade["scrip"] not in new_scrips:
                new_scrips.append(trade["scrip"])

            trades.append(Trade(
                date=trade["date"],
                scrip=trade["scrip"],
                sector=sectors.get(trade["scrip"], ""),
                type=trade["type"],
                qty=trade["qty"],
                rate=round(trade["rate"], 4),
                debit=round(trade["debit"], 2) if trade["debit"] else None,
                credit=round(trade["credit"], 2) if trade["credit"] else None,
                notes=f"Memo {trade['memo']}",
            ))

    trades.sort(key=lambda t: (t.date, t.type, t.scrip))
    return ParseResponse(
        trades=trades,
        duplicates_skipped=duplicates,
        new_scrips=new_scrips,
        problems=problems,
        pdfs_read=read,
    )


class AnalyzeRequest(BaseModel):
    """Every trade in the sheet, so realised profit can be split by tax year."""
    transactions: list[list[Any]] = Field(
        description="rows as [date YYYY-MM-DD, scrip, type, qty, debit, credit], in sheet order"
    )


class TaxYearRow(BaseModel):
    label: str
    sales: int
    proceeds: float
    cost: float
    adjustments: float
    realised: float


class AnalyzeResponse(BaseModel):
    tax_years: list[TaxYearRow]
    total_realised: float
    notes: list[str]


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    """Realised profit per tax year, by replaying every trade through FIFO.

    This stays in Python rather than moving into the caller's Apps Script for
    the same reason the parsing does: one implementation of a calculation that
    money decisions rest on, not two that quietly drift apart.
    """
    from datetime import date as _date

    import tax

    trades = []
    for order, row in enumerate(request.transactions):
        row = list(row) + [""] * (6 - len(row))
        try:
            year, month, day = (int(part) for part in str(row[0])[:10].split("-"))
            when = _date(year, month, day)
        except (ValueError, TypeError):
            continue
        trades.append({
            "order": order,
            "date": when,
            "scrip": str(row[1]).strip().upper(),
            "type": str(row[2]).strip().upper(),
            "qty": _number(row[3]) or 0.0,
            "debit": _number(row[4]) or 0.0,
            "credit": _number(row[5]) or 0.0,
        })

    if not trades:
        return AnalyzeResponse(tax_years=[], total_realised=0.0, notes=[])

    years, notes = tax.realised_by_year(trades)
    rows = [
        TaxYearRow(
            label=tax.label(year),
            sales=data["sales"],
            proceeds=round(data["proceeds"], 2),
            cost=round(data["cost"], 2),
            adjustments=round(data["adjustments"], 2),
            realised=round(data["realised"], 2),
        )
        for year, data in sorted(years.items())
    ]
    return AnalyzeResponse(
        tax_years=rows,
        total_realised=round(sum(r.realised for r in rows), 2),
        notes=notes,
    )


class PricesRequest(BaseModel):
    symbols: list[str] = Field(default_factory=list)


@app.post("/prices-for")
def prices_for(request: PricesRequest) -> dict:
    """Prices for a named list of symbols, posted rather than in the URL.

    Apps Script cannot reach the exchange itself - UrlFetchApp reports the
    address as unavailable from Google's network - so callers ask for prices
    here. This only proxies the same public page anyone can open, holds it for
    a few minutes, and keeps nothing.
    """
    try:
        everything = psx.all_prices()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PSX unavailable: {exc}")

    wanted = [s.strip().upper() for s in request.symbols if s and s.strip()]
    if not wanted:
        return {"prices": {}, "missing": []}
    return {
        "prices": {s: everything[s] for s in wanted if s in everything},
        "missing": [s for s in wanted if s not in everything],
    }
