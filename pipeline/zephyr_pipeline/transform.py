from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Grid:
    width: int
    height: int
    lon0: float
    lat0: float
    dlon: float
    dlat: float


def roll_longitude(arr: np.ndarray, lons: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if lons[0] != 0 or lons[-1] >= 360 or np.any(np.diff(lons) <= 0):
        raise ValueError("expected ascending longitudes in [0, 360) starting at 0")
    k = int(np.searchsorted(lons, 180.0))
    new_lons = np.concatenate([lons[k:] - 360.0, lons[:k]])
    return np.concatenate([arr[..., k:], arr[..., :k]], axis=-1), new_lons


def convert_units(raw: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    out = dict(raw)
    out["temperature"] = raw["temperature"] - 273.15
    out["precipitation"] = raw["precipitation"] * 3600.0
    return out


def grid_from_coords(lats: np.ndarray, lons: np.ndarray) -> Grid:
    dlat, dlon = float(lats[1] - lats[0]), float(lons[1] - lons[0])
    if not (np.allclose(np.diff(lats), dlat) and np.allclose(np.diff(lons), dlon)):
        raise ValueError("grid spacing is not uniform")
    return Grid(int(lons.size), int(lats.size), float(lons[0]), float(lats[0]), dlon, dlat)
