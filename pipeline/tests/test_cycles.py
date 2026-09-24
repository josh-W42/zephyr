from datetime import datetime, timedelta, timezone

import pytest

from zephyr_pipeline.cycles import NoRunAvailable, Run, candidate_runs, pick_run

UTC = timezone.utc


def at(day, hour, minute=0):
    return datetime(2026, 9, day, hour, minute, tzinfo=UTC)


def test_candidates_start_at_latest_cycle_with_nearest_forecast_hour():
    runs = candidate_runs(at(23, 14, 20))
    assert runs[0] == Run(at(23, 12), 2)
    assert runs[1] == Run(at(23, 6), 8)


def test_forecast_hour_rounds_half_up_to_nearest_hour():
    assert candidate_runs(at(23, 14, 30))[0].fhour == 3
    assert candidate_runs(at(23, 14, 29))[0].fhour == 2


def test_candidates_cross_midnight():
    runs = candidate_runs(at(24, 1, 10), lookback=4)
    assert runs == [
        Run(at(24, 0), 1),
        Run(at(23, 18), 7),
        Run(at(23, 12), 13),
        Run(at(23, 6), 19),
    ]


def test_non_utc_input_is_normalised():
    eastern = timezone(timedelta(hours=-4))
    now = datetime(2026, 9, 23, 10, 20, tzinfo=eastern)  # 14:20Z
    assert candidate_runs(now)[0] == Run(at(23, 12), 2)


def test_naive_datetime_rejected():
    with pytest.raises(ValueError):
        candidate_runs(datetime(2026, 9, 23, 14, 0))


def test_pick_run_skips_runs_that_do_not_exist_yet():
    run = pick_run(at(23, 14, 20), exists=lambda r: r.cycle_time.hour != 12)
    assert run == Run(at(23, 6), 8)


def test_pick_run_raises_when_nothing_available():
    with pytest.raises(NoRunAvailable):
        pick_run(at(23, 14), exists=lambda r: False)


def test_valid_time():
    assert Run(at(23, 12), 5).valid_time == at(23, 17)
