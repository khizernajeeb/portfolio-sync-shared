"""Split realised profit across Pakistan's tax years using FIFO.

Carried over from akd-portfolio-sync so the shared service can answer the same
question for anyone. Keeping this in Python rather than reimplementing it in
Apps Script is deliberate: two copies of a FIFO calculation would drift.

The portfolio sheet reports realised P&L as one all-time number per scrip.
At filing time the question is different: how much was realised *in this tax
year*. Answering that needs each sale matched against the specific lots it
consumed, which is FIFO - the same basis the sheet and the broker's app use.

Pakistan's tax year runs 1 July to 30 June and is named for the year it ends
in, so 1 Jul 2025 - 30 Jun 2026 is tax year 2026.

This is a record of what was realised and when. It is not tax advice - rates
and holding-period rules are a question for a tax advisor.
"""

from collections import defaultdict, deque

BUY_LIKE = {"BUY", "BONUS", "RIGHT"}
FISCAL_YEAR_ENDS_IN_MONTH = 6


def tax_year(day) -> int:
    """1 Jul 2025 - 30 Jun 2026 both fall in tax year 2026."""
    return day.year + 1 if day.month > FISCAL_YEAR_ENDS_IN_MONTH else day.year


def label(year: int) -> str:
    return f"{year - 1}-{str(year)[2:]} (TY{year})"


def realised_by_year(trades: list[dict]) -> tuple[dict, list[str]]:
    """Return ({tax year: totals}, warnings).

    Each trade needs: date, scrip, type, qty, debit, credit, and `order` to
    break ties between trades made on the same day.
    """
    lots: dict[str, deque] = defaultdict(deque)
    years: dict[int, dict] = defaultdict(
        lambda: {"proceeds": 0.0, "cost": 0.0, "realised": 0.0, "adjustments": 0.0, "sales": 0}
    )
    warnings: list[str] = []

    for trade in sorted(trades, key=lambda t: (t["date"], t["order"])):
        scrip, kind, qty = trade["scrip"], trade["type"], trade["qty"]
        year = years[tax_year(trade["date"])]

        if kind in BUY_LIKE:
            if qty:
                lots[scrip].append([qty, trade["debit"] / qty])

        elif kind == "SELL":
            remaining, cost = qty, 0.0
            while remaining > 0 and lots[scrip]:
                lot = lots[scrip][0]
                taken = min(remaining, lot[0])
                cost += taken * lot[1]
                lot[0] -= taken
                remaining -= taken
                if lot[0] <= 0:
                    lots[scrip].popleft()
            if remaining > 0:
                # Selling more than the recorded purchases can account for -
                # usually a buy that was never entered. Report it instead of
                # quietly treating those shares as free.
                warnings.append(
                    f"{trade['date']}: sold {remaining:g} {scrip} with no matching purchase on record"
                )
            year["proceeds"] += trade["credit"]
            year["cost"] += cost
            year["realised"] += trade["credit"] - cost
            year["sales"] += 1

        else:
            # DIFFERENCE: the broker's small rate adjustments, cash either way.
            adjustment = trade["credit"] - trade["debit"]
            year["adjustments"] += adjustment
            year["realised"] += adjustment

    return dict(years), warnings


def remaining_cost(trades: list[dict]) -> float:
    """FIFO cost of everything still held - used to check the total adds up."""
    lots: dict[str, deque] = defaultdict(deque)
    for trade in sorted(trades, key=lambda t: (t["date"], t["order"])):
        if trade["type"] in BUY_LIKE and trade["qty"]:
            lots[trade["scrip"]].append([trade["qty"], trade["debit"] / trade["qty"]])
        elif trade["type"] == "SELL":
            remaining = trade["qty"]
            while remaining > 0 and lots[trade["scrip"]]:
                lot = lots[trade["scrip"]][0]
                taken = min(remaining, lot[0])
                lot[0] -= taken
                remaining -= taken
                if lot[0] <= 0:
                    lots[trade["scrip"]].popleft()
    return sum(qty * unit for queue in lots.values() for qty, unit in queue)
