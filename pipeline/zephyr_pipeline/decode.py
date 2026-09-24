from pathlib import Path

import cfgrib
import numpy as np
import xarray as xr

EXPECTED = {
    "u10": ("u", "m s**-1"),
    "v10": ("v", "m s**-1"),
    "t2m": ("temperature", "K"),
    "prate": ("precipitation", "kg m**-2 s**-1"),
    "tcc": ("clouds", "%"),
    "lsm": ("land", "(0 - 1)"),
}


def load_fields(path: Path) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
    fields: dict[str, np.ndarray] = {}
    lats = lons = None
    with xr.set_options(use_new_combine_kwarg_defaults=True):
        datasets = cfgrib.open_datasets(str(path), backend_kwargs={"indexpath": ""})
    for ds in datasets:
        try:
            for name, da in ds.data_vars.items():
                if name not in EXPECTED:
                    continue
                field, units = EXPECTED[name]
                if da.attrs.get("units") != units:
                    raise ValueError(f"{name}: expected units {units!r}, got {da.attrs.get('units')!r}")
                if field in fields:
                    raise ValueError(f"{name} appears more than once")
                values = da.values.astype(np.float32)
                if not np.isfinite(values).all():
                    raise ValueError(f"{name} contains non-finite values")
                fields[field] = values
                ds_lats, ds_lons = ds.latitude.values, ds.longitude.values
                if lats is None:
                    lats, lons = ds_lats, ds_lons
                elif not (np.array_equal(lats, ds_lats) and np.array_equal(lons, ds_lons)):
                    raise ValueError(f"{name} is on a different grid")
        finally:
            ds.close()
    missing = {f for f, _ in EXPECTED.values()} - fields.keys()
    if missing:
        raise ValueError(f"GRIB file is missing fields: {sorted(missing)}")
    return fields, lats, lons
