"""Which brokers are supported, and what differs between them.

Only four things are broker-specific: who the email comes from, what its subject
looks like, which attachment is the confirmation, and how to read that PDF.
Everything after that - validating the arithmetic, skipping duplicates, deciding
what to write into the sheet - is the same for every broker.

Adding a broker is therefore one new module and one line in REGISTRY. The
dropdown a user picks from is just `list(REGISTRY)`.
"""

from dataclasses import dataclass
from typing import Callable

from . import akd


@dataclass(frozen=True)
class Broker:
    key: str
    name: str
    sender: str
    subject: str
    parse: Callable[[bytes], list[dict]]
    is_attachment: Callable[[str, str], bool]
    memo_in: Callable[[str], str | None]

    def gmail_query(self, since_days: int) -> str:
        """The Gmail search the client should run for this broker."""
        return (
            f'from:{self.sender} subject:"{self.subject}" '
            f"has:attachment newer_than:{since_days}d"
        )


REGISTRY: dict[str, Broker] = {
    "akd": Broker(
        key="akd",
        name=akd.NAME,
        sender=akd.SENDER,
        subject=akd.SUBJECT,
        parse=akd.parse,
        is_attachment=akd.is_attachment,
        memo_in=akd.memo_in,
    ),
}


def get(key: str) -> Broker:
    try:
        return REGISTRY[key.lower().strip()]
    except KeyError:
        raise ValueError(f"unknown broker '{key}'. Supported: {', '.join(REGISTRY)}")
