import re
from dataclasses import dataclass

_INSTANT_STEP = re.compile(r"^(anl|\d+ hour fcst)$")

Field = tuple[str, str]


@dataclass(frozen=True)
class IdxEntry:
    offset: int
    var: str
    level: str
    step: str


def parse_idx(text: str) -> list[IdxEntry]:
    entries = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split(":")
        if len(parts) < 6:
            raise ValueError(f"malformed idx line {lineno}: {line!r}")
        try:
            offset = int(parts[1])
        except ValueError:
            raise ValueError(f"bad offset on idx line {lineno}: {line!r}") from None
        entries.append(IdxEntry(offset, parts[3], parts[4], parts[5]))
    if any(b.offset <= a.offset for a, b in zip(entries, entries[1:])):
        raise ValueError("idx offsets are not strictly increasing")
    return entries


def byte_ranges(entries: list[IdxEntry], wanted: list[Field]) -> dict[Field, tuple[int, int | None]]:
    """Inclusive (start, end) per wanted field; end is None for the file's last message."""
    ranges: dict[Field, tuple[int, int | None]] = {}
    for i, entry in enumerate(entries):
        key = (entry.var, entry.level)
        if key not in wanted or not _INSTANT_STEP.match(entry.step):
            continue
        if key in ranges:
            raise ValueError(f"multiple instantaneous messages for {key}")
        end = entries[i + 1].offset - 1 if i + 1 < len(entries) else None
        ranges[key] = (entry.offset, end)
    missing = [k for k in wanted if k not in ranges]
    if missing:
        raise ValueError(f"idx is missing fields: {missing}")
    return ranges
