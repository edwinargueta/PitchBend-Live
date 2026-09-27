"""UTC timestamps in the one format stored in SQLite (ADR 0005 §14).

``YYYY-MM-DDTHH:MM:SSZ`` sorts lexicographically in time order, so SQL can compare the
strings directly (``expires_at <= :now``).
"""

from datetime import UTC, datetime, timedelta

TS_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def utcnow() -> datetime:
    """The current time, truncated to whole seconds (the stored precision)."""
    return datetime.now(UTC).replace(microsecond=0)


def format_ts(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime(TS_FORMAT)


def parse_ts(value: str) -> datetime:
    return datetime.strptime(value, TS_FORMAT).replace(tzinfo=UTC)


def now_ts() -> str:
    return format_ts(utcnow())


def ts_after(start: str, *, hours: float = 0, seconds: float = 0) -> str:
    return format_ts(parse_ts(start) + timedelta(hours=hours, seconds=seconds))
