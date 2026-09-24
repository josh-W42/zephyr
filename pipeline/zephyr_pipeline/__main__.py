import argparse
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .build import build
from .cycles import NoRunAvailable, pick_run
from .fetch import download_subset, grib_url, url_exists


def _aware(value: str) -> datetime:
    t = datetime.fromisoformat(value)
    if t.tzinfo is None:
        raise argparse.ArgumentTypeError("--now needs a timezone, e.g. 2026-09-23T14:00Z")
    return t


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="zephyr_pipeline", description="Build zephyr textures from the latest GFS run")
    p.add_argument("--out", type=Path, required=True, help="output directory, e.g. web/public/data")
    p.add_argument("--resolution", choices=["0p25", "0p50", "1p00"], default="0p25")
    p.add_argument("--now", type=_aware, help="pretend current time (ISO 8601 with timezone)")
    args = p.parse_args(argv)

    now = args.now or datetime.now(timezone.utc)
    try:
        run = pick_run(now, lambda r: url_exists(grib_url(r, args.resolution) + ".idx"))
    except NoRunAvailable as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"GFS {run.cycle_time:%Y-%m-%d %H}z f{run.fhour:03d}, valid {run.valid_time:%Y-%m-%d %H:%M}Z")

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        grib = Path(tmp) / "subset.grib2"
        grib.write_bytes(download_subset(run, resolution=args.resolution))
        manifest = build(args.out, grib, run, datetime.now(timezone.utc))

    for name, layer in manifest["layers"].items():
        size = (args.out / layer["file"]).stat().st_size / 1024
        print(f"  {name:13} {layer['file']:32} {size:7.1f} KiB  {layer['min']} .. {layer['max']} {layer['units']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
