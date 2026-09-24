import sys
import urllib.error
import urllib.request
from pathlib import Path

import cfgrib

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
WANTED = {
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
}


def get(url, rng=None):
    req = urllib.request.Request(url, headers={"Range": rng} if rng else {})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.status, resp.read()


def head_status(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def subset(date, cycle, fhour, res, out):
    base = f"{BUCKET}/gfs.{date}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.{res}.f{fhour:03d}"
    _, idx = get(base + ".idx")
    parts = [line.split(":") for line in idx.decode("ascii").splitlines() if line]
    chunks = []
    for i, p in enumerate(parts):
        if (p[3], p[4]) in WANTED and "ave" not in p[5] and "acc" not in p[5]:
            start = int(p[1])
            end = str(int(parts[i + 1][1]) - 1) if i + 1 < len(parts) else ""
            status, data = get(base, f"bytes={start}-{end}")
            ok = data[:4] == b"GRIB" and data[-4:] == b"7777"
            print(f"  {p[3]:6} {p[4]:20} {p[5]:12} HTTP {status} {len(data):>8} B  framed={ok}")
            chunks.append(data)
    out.write_bytes(b"".join(chunks))
    print(f"  wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")


def inspect(path):
    for ds in cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""}):
        try:
            for name, da in ds.data_vars.items():
                v = da.values
                print(
                    f"  {name:6} level={da.attrs.get('GRIB_typeOfLevel')} "
                    f"step={da.attrs.get('GRIB_stepType')} units={da.attrs.get('units')!r} "
                    f"shape={v.shape} min={v.min():.4g} max={v.max():.4g}"
                )
            lat, lon = ds.latitude.values, ds.longitude.values
            print(f"  lat {lat[0]}..{lat[-1]} (n={lat.size})  lon {lon[0]}..{lon[-1]} (n={lon.size})")
        finally:
            ds.close()


if __name__ == "__main__":
    date, cycle, fhour = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(exist_ok=True)
    for res in ("0p25", "0p50", "1p00"):
        print(f"== {res}")
        path = out_dir / f"subset_{res}.grib2"
        subset(date, cycle, fhour, res, path)
        inspect(path)
    missing = f"{BUCKET}/gfs.{date}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.0p25.f999.idx"
    print(f"== HEAD on missing key -> {head_status(missing)}")
