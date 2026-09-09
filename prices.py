"""Current PSX prices, read from the exchange's public market-watch page.

One request returns every listed symbol, so a whole portfolio is priced in a
single call. Columns are located by the header's `data-name` attribute rather
than by position, so a reordered table cannot silently shift which number is
read as the price.
"""

import time
from html.parser import HTMLParser

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

MARKET_WATCH_URL = "https://dps.psx.com.pk/market-watch"
PRICE_COLUMN = "close"   # the column the site labels CURRENT
SYMBOL_COLUMN = "symbol"

CACHE_SECONDS = 300      # several clients a few minutes apart get one fetch
_cache: tuple[float, dict] | None = None


class _MarketWatchParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.headers: list[str] = []
        self.rows: list[list[str]] = []
        self._in_head = False
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._order: str | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "thead":
            self._in_head = True
        elif tag == "th" and self._in_head:
            self.headers.append(attrs.get("data-name", ""))
        elif tag == "tr" and not self._in_head:
            self._row = []
        elif tag == "td" and self._row is not None:
            self._cell = []
            self._order = attrs.get("data-order")

    def handle_endtag(self, tag):
        if tag == "thead":
            self._in_head = False
        elif tag == "td" and self._cell is not None:
            text = "".join(self._cell).strip()
            self._row.append(self._order if self._order is not None else text)
            self._cell = self._order = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _session() -> requests.Session:
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=Retry(
        total=4, backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504), allowed_methods=("GET",))))
    return session


def all_prices(timeout: int = 30) -> dict[str, float]:
    """{symbol: current price} for everything listed, cached briefly."""
    global _cache
    if _cache and time.time() - _cache[0] < CACHE_SECONDS:
        return _cache[1]

    response = _session().get(
        MARKET_WATCH_URL, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()

    parser = _MarketWatchParser()
    parser.feed(response.text)
    if SYMBOL_COLUMN not in parser.headers or PRICE_COLUMN not in parser.headers:
        raise ValueError(f"market-watch table changed shape: {parser.headers}")

    symbol_at = parser.headers.index(SYMBOL_COLUMN)
    price_at = parser.headers.index(PRICE_COLUMN)

    prices = {}
    for row in parser.rows:
        if len(row) <= max(symbol_at, price_at):
            continue
        try:
            prices[row[symbol_at].strip().upper()] = float(row[price_at])
        except ValueError:
            continue   # suspended or newly listed, no price yet

    if not prices:
        raise ValueError("market-watch returned no prices")
    _cache = (time.time(), prices)
    return prices
