import numpy as np
import pytest

from zephyr_pipeline.transform import Grid, convert_units, grid_from_coords, roll_longitude


def test_roll_moves_minus_180_to_column_zero():
    lons = np.arange(0, 360, 45.0)  # 0, 45, ..., 315
    arr = np.tile(lons, (2, 1))  # each cell holds its own longitude
    rolled, new_lons = roll_longitude(arr, lons)
    assert new_lons.tolist() == [-180, -135, -90, -45, 0, 45, 90, 135]
    assert rolled[0].tolist() == [180, 225, 270, 315, 0, 45, 90, 135]


def test_roll_rejects_unexpected_longitudes():
    with pytest.raises(ValueError):
        roll_longitude(np.zeros((1, 4)), np.array([-180.0, -90.0, 0.0, 90.0]))


def test_convert_units():
    raw = {
        "u": np.array([1.0]),
        "v": np.array([-2.0]),
        "temperature": np.array([273.15]),
        "precipitation": np.array([1 / 3600]),
        "clouds": np.array([50.0]),
    }
    out = convert_units(raw)
    assert out["temperature"][0] == pytest.approx(0.0)
    assert out["precipitation"][0] == pytest.approx(1.0)  # mm/h
    assert out["u"][0] == 1.0 and out["clouds"][0] == 50.0


def test_grid_from_coords():
    lats = np.array([90.0, 89.0, 88.0])
    lons = np.array([-180.0, -179.0, -178.0, -177.0])
    assert grid_from_coords(lats, lons) == Grid(4, 3, -180.0, 90.0, 1.0, -1.0)


def test_grid_rejects_uneven_spacing():
    with pytest.raises(ValueError):
        grid_from_coords(np.array([90.0, 89.0]), np.array([0.0, 1.0, 3.0]))
