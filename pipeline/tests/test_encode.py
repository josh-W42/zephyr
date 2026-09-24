import io

import numpy as np
import pytest
from PIL import Image

from zephyr_pipeline.encode import dequantize, encode_png, quantize


@pytest.mark.parametrize("encoding", ["linear", "sqrt"])
def test_round_trip_within_half_a_step(encoding):
    rng = np.random.default_rng(0)
    a = rng.uniform(0, 40, size=(50, 80)).astype(np.float32)
    lo, hi = 0.0, 40.0
    back = dequantize(quantize(a, lo, hi, encoding), lo, hi, encoding)
    if encoding == "linear":
        assert np.abs(back - a).max() <= (hi - lo) / 255 / 2 + 1e-4
    else:
        step = (np.sqrt(hi) - np.sqrt(lo)) / 255
        assert np.abs(np.sqrt(back) - np.sqrt(a)).max() <= step / 2 + 1e-4


def test_sqrt_keeps_light_values_that_linear_rounds_to_zero():
    a = np.array([0.05, 50.0], dtype=np.float32)  # linear: 0.255 -> 0; sqrt: 8.06 -> 8
    assert quantize(a, 0, 50, "linear")[0] == 0
    assert quantize(a, 0, 50, "sqrt")[0] > 0


def test_values_outside_range_are_clipped():
    q = quantize(np.array([-5.0, 15.0]), 0.0, 10.0)
    assert q.tolist() == [0, 255]


def test_constant_field_encodes_to_zero():
    assert quantize(np.full((2, 2), 7.0), 7.0, 7.0).tolist() == [[0, 0], [0, 0]]


def test_non_finite_values_rejected():
    with pytest.raises(ValueError):
        quantize(np.array([1.0, np.nan]), 0.0, 1.0)


def test_sqrt_rejects_negative_minimum():
    with pytest.raises(ValueError):
        quantize(np.array([1.0]), -1.0, 1.0, "sqrt")


def test_single_channel_png_is_greyscale():
    img = Image.open(io.BytesIO(encode_png([np.full((3, 4), 9, np.uint8)])))
    assert img.mode == "L" and img.size == (4, 3)


def test_two_channel_png_is_rgb_with_empty_blue():
    u = np.full((3, 4), 10, np.uint8)
    v = np.full((3, 4), 200, np.uint8)
    px = np.asarray(Image.open(io.BytesIO(encode_png([u, v]))))
    assert px.shape == (3, 4, 3)
    assert (px[..., 0] == 10).all() and (px[..., 1] == 200).all() and (px[..., 2] == 0).all()
