import urllib.error
import urllib.request
from collections.abc import Callable

from .cycles import Run
from .idx import byte_ranges, parse_idx

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
WANTED = [
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
]

HttpGet = Callable[[str, dict[str, str]], bytes]


def grib_url(run: Run, resolution: str = "0p25") -> str:
    c = run.cycle_time
    return f"{BUCKET}/gfs.{c:%Y%m%d}/{c:%H}/atmos/gfs.t{c:%H}z.pgrb2.{resolution}.f{run.fhour:03d}"


def http_get(url: str, headers: dict[str, str]) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as resp:
        return resp.read()


def url_exists(url: str) -> bool:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def download_subset(run: Run, get: HttpGet = http_get, resolution: str = "0p25") -> bytes:
    url = grib_url(run, resolution)
    ranges = byte_ranges(parse_idx(get(url + ".idx", {}).decode("ascii")), WANTED)
    chunks = []
    for key in WANTED:
        start, end = ranges[key]
        data = get(url, {"Range": f"bytes={start}-{'' if end is None else end}"})
        if not (data.startswith(b"GRIB") and data.endswith(b"7777")):
            raise ValueError(f"response for {key} is not a single GRIB message")
        if end is not None and len(data) != end - start + 1:
            raise ValueError(f"response for {key} has {len(data)} bytes, expected {end - start + 1}")
        chunks.append(data)
    return b"".join(chunks)
