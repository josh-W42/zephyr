from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

CYCLE_SPACING = timedelta(hours=6)


@dataclass(frozen=True)
class Run:
    cycle_time: datetime
    fhour: int

    @property
    def valid_time(self) -> datetime:
        return self.cycle_time + timedelta(hours=self.fhour)


class NoRunAvailable(RuntimeError):
    pass


def candidate_runs(now: datetime, lookback: int = 4) -> list[Run]:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    cycle = now.replace(hour=now.hour - now.hour % 6, minute=0, second=0, microsecond=0)
    runs = []
    for _ in range(lookback):
        fhour = int((now - cycle) / timedelta(hours=1) + 0.5)
        runs.append(Run(cycle, fhour))
        cycle -= CYCLE_SPACING
    return runs


def pick_run(now: datetime, exists: Callable[[Run], bool], lookback: int = 4) -> Run:
    for run in candidate_runs(now, lookback):
        if exists(run):
            return run
    raise NoRunAvailable(f"no GFS run in the {lookback} cycles before {now.isoformat()}")
