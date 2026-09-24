import pytest

from zephyr_pipeline.idx import IdxEntry, byte_ranges, parse_idx

SAMPLE = """\
1:0:d=2026092300:PRMSL:mean sea level:6 hour fcst:
2:1000:d=2026092300:TMP:2 m above ground:6 hour fcst:
3:1500:d=2026092300:UGRD:10 m above ground:6 hour fcst:
4:2100:d=2026092300:VGRD:10 m above ground:6 hour fcst:
5:2700:d=2026092300:PRATE:surface:6 hour fcst:
6:3000:d=2026092300:PRATE:surface:0-6 hour ave fcst:
7:3400:d=2026092300:TCDC:entire atmosphere:6 hour fcst:
8:3900:d=2026092300:TCDC:entire atmosphere:0-6 hour ave fcst:
"""

WANTED = [
    ("UGRD", "10 m above ground"),
    ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"),
    ("PRATE", "surface"),
    ("TCDC", "entire atmosphere"),
]


def test_parse_idx_reads_offset_var_level_step():
    entries = parse_idx(SAMPLE)
    assert len(entries) == 8
    assert entries[1] == IdxEntry(1000, "TMP", "2 m above ground", "6 hour fcst")


def test_byte_ranges_are_inclusive_and_end_before_next_message():
    ranges = byte_ranges(parse_idx(SAMPLE), WANTED)
    assert ranges[("TMP", "2 m above ground")] == (1000, 1499)
    assert ranges[("UGRD", "10 m above ground")] == (1500, 2099)


def test_averaged_messages_are_ignored():
    ranges = byte_ranges(parse_idx(SAMPLE), WANTED)
    assert ranges[("PRATE", "surface")] == (2700, 2999)
    assert ranges[("TCDC", "entire atmosphere")] == (3400, 3899)


def test_analysis_step_counts_as_instantaneous():
    text = "1:0:d=2026092300:PRATE:surface:anl:\n2:500:d=2026092300:TMP:surface:anl:\n"
    assert byte_ranges(parse_idx(text), [("PRATE", "surface")]) == {("PRATE", "surface"): (0, 499)}


def test_last_message_range_is_open_ended():
    text = "1:0:d=2026092300:TMP:surface:anl:\n2:800:d=2026092300:TCDC:entire atmosphere:anl:\n"
    ranges = byte_ranges(parse_idx(text), [("TCDC", "entire atmosphere")])
    assert ranges[("TCDC", "entire atmosphere")] == (800, None)


def test_missing_field_raises():
    with pytest.raises(ValueError, match="missing"):
        byte_ranges(parse_idx(SAMPLE), [("HGT", "500 mb")])


def test_duplicate_instantaneous_field_raises():
    text = "1:0:d=x:TMP:2 m above ground:anl:\n2:10:d=x:TMP:2 m above ground:6 hour fcst:\n"
    with pytest.raises(ValueError, match="multiple"):
        byte_ranges(parse_idx(text), [("TMP", "2 m above ground")])


@pytest.mark.parametrize("text", ["garbage\n", "1:abc:d=x:TMP:2 m above ground:anl:\n"])
def test_malformed_lines_raise(text):
    with pytest.raises(ValueError):
        parse_idx(text)


def test_non_increasing_offsets_raise():
    with pytest.raises(ValueError, match="increasing"):
        parse_idx("1:500:d=x:A:l:anl:\n2:100:d=x:B:l:anl:\n")
