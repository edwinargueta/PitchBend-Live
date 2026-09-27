import pytest

from pitchbend_live.titles import FALLBACK_TITLE, MAX_TITLE_LENGTH, sanitize_title


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, "Untitled"),
        ("", "Untitled"),
        ("   ", "Untitled"),
        ("Hello   World", "Hello World"),
        ("  padded\ttabs\nnewlines  ", "padded tabs newlines"),
        ("bell\x07char", "bell char"),
        ("bidi\u202eoverride", "bidi override"),
        ("zero\u200bwidth", "zero width"),
        ("AC/DC - Back in Black", "AC/DC - Back in Black"),
        ("Café 🎸 Ünïcödé", "Café 🎸 Ünïcödé"),
        ("\x00\x01\x02", "Untitled"),
    ],
)
def test_sanitize_title(raw: str | None, expected: str) -> None:
    assert sanitize_title(raw) == expected


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("song.mp3", "song"),
        ("My Song (live).final.m4a", "My Song (live).final"),
        ("C:\\Users\\me\\Music\\track.flac", "track"),
        ("../../etc/passwd", "passwd"),
        ("/abs/path/to/tune.ogg", "tune"),
        ("noext", "noext"),
        (".hidden", ".hidden"),
        ("...", "..."),
        ("dir/", "Untitled"),
        ("  spaced   name .wav", "spaced name"),
        (None, "Untitled"),
    ],
)
def test_filename_titles_strip_path_and_extension(filename: str | None, expected: str) -> None:
    assert sanitize_title(filename, filename=True) == expected


def test_title_is_capped() -> None:
    title = sanitize_title("x" * 500)
    assert len(title) == MAX_TITLE_LENGTH == 120


def test_cap_does_not_leave_trailing_space() -> None:
    raw = "a" * (MAX_TITLE_LENGTH - 1) + " bcdef"
    assert sanitize_title(raw) == "a" * (MAX_TITLE_LENGTH - 1)


def test_fallback_constant() -> None:
    assert FALLBACK_TITLE == "Untitled"
