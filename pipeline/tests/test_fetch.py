from datetime import datetime, timezone

import pytest

from zephyr_pipeline.cycles import Run
from zephyr_pipeline.fetch import WANTED, download_subset, grib_url

RUN = Run(datetime(2026, 9, 23, 6, tzinfo=timezone.utc), 5)


def message(tag: bytes) -> bytes:
    return b"GRIB" + tag * 20 + b"7777"


def fake_file(order):
    """Builds a fake GRIB file + idx from (var, level, step) triples."""
    body, lines = b"", []
    for n, (var, level, step) in enumerate(order, 1):
        lines.append(f"{n}:{len(body)}:d=2026092306:{var}:{level}:{step}:")
        body += message(var.encode()[:1])
    return body, "\n".join(lines) + "\n"


def fake_get(files):
    calls = []

    def get(url, headers):
        calls.append((url, headers.get("Range")))
        body = files[url]
        rng = headers.get("Range")
        if rng is None:
            return body
        start, _, end = rng.removeprefix("bytes=").partition("-")
        return body[int(start) : int(end) + 1 if end else None]

    return get, calls


ORDER = [
    ("TMP", "2 m above ground", "5 hour fcst"),
    ("UGRD", "10 m above ground", "5 hour fcst"),
    ("VGRD", "10 m above ground", "5 hour fcst"),
    ("PRATE", "surface", "5 hour fcst"),
    ("PRATE", "surface", "0-5 hour ave fcst"),
    ("TCDC", "entire atmosphere", "5 hour fcst"),
]


def test_grib_url_layout():
    assert grib_url(RUN) == (
        "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260923/06/atmos/gfs.t06z.pgrb2.0p25.f005"
    )
    assert grib_url(RUN, "1p00").endswith("gfs.t06z.pgrb2.1p00.f005")


def test_download_subset_returns_wanted_messages_in_wanted_order():
    body, idx = fake_file(ORDER)
    url = grib_url(RUN)
    get, calls = fake_get({url: body, url + ".idx": idx.encode()})

    data = download_subset(RUN, get=get)

    assert data == message(b"U") + message(b"V") + message(b"T") + message(b"P") + message(b"T")
    assert calls[0] == (url + ".idx", None)
    assert calls[-1][1].endswith("-")  # TCDC is last in the file: open-ended range


def test_wanted_covers_the_five_fields():
    assert {v for v, _ in WANTED} == {"UGRD", "VGRD", "TMP", "PRATE", "TCDC"}


def test_unframed_response_raises():
    body, idx = fake_file(ORDER)
    url = grib_url(RUN)
    get, _ = fake_get({url: b"<Error>AccessDenied</Error>" + body[27:], url + ".idx": idx.encode()})
    with pytest.raises(ValueError, match="GRIB"):
        download_subset(RUN, get=get)
