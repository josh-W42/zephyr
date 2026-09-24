from pathlib import Path

import numpy as np

from zephyr_pipeline.decode import load_fields

FIXTURE = Path(__file__).parent / "fixtures" / "gfs_1p00_subset.grib2"


def test_fixture_decodes_to_five_physically_plausible_fields():
    fields, lats, lons = load_fields(FIXTURE)

    assert set(fields) == {"u", "v", "temperature", "precipitation", "clouds", "land"}
    assert all(a.shape == (181, 360) for a in fields.values())
    assert lats[0] == 90 and lats[-1] == -90
    assert lons[0] == 0 and lons[-1] == 359

    assert 180 < fields["temperature"].min() and fields["temperature"].max() < 340  # K
    assert np.abs(fields["u"]).max() < 120 and np.abs(fields["v"]).max() < 120  # m/s
    assert fields["precipitation"].min() >= 0
    assert 0 <= fields["clouds"].min() and fields["clouds"].max() <= 100
    assert set(np.unique(fields["land"]).tolist()) <= {0.0, 1.0}
    assert 0.2 < fields["land"].mean() < 0.45  # ~29% of Earth is land; GFS counts Antarctica
