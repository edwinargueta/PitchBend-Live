"""The authoritative URL table (§6.4 + the browser-parity rules for extractVideoId)."""

import pytest

from pitchbend_live.youtube import (
    extract_video_id,
    parse_youtube_url,
    video_id_from_source_key,
    watch_url,
)

ID = "dQw4w9WgXcQ"

ACCEPTED: list[tuple[str, str]] = [
    # watch on the three watch hosts, with and without scheme/www
    (f"https://www.youtube.com/watch?v={ID}", ID),
    (f"http://www.youtube.com/watch?v={ID}", ID),
    (f"www.youtube.com/watch?v={ID}", ID),
    (f"youtube.com/watch?v={ID}", ID),
    (f"https://youtube.com/watch?v={ID}", ID),
    (f"https://m.youtube.com/watch?v={ID}", ID),
    # case-insensitive scheme and host
    (f"HTTPS://WWW.YouTube.com/watch?v={ID}", ID),
    (f"HtTp://youtube.COM/watch?v={ID}", ID),
    # extra params ignored, v anywhere; the first v wins
    (f"https://www.youtube.com/watch?v={ID}&list=PL123&index=2", ID),
    (f"https://www.youtube.com/watch?feature=share&v={ID}&t=42s", ID),
    (f"https://www.youtube.com/watch?v={ID}&v=AAAAAAAAAAA", ID),
    (f"https://www.youtube.com/watch?si=abc&v={ID}#t=30", ID),
    # percent-decoded v (URLSearchParams semantics)
    ("https://www.youtube.com/watch?v=dQw4w9WgXc%51", ID),
    ("https://www.youtube.com/watch?%76=" + ID, ID),
    # shorts, optional single trailing slash, query ignored
    (f"https://www.youtube.com/shorts/{ID}", ID),
    (f"https://youtube.com/shorts/{ID}/", ID),
    (f"https://m.youtube.com/shorts/{ID}?feature=share", ID),
    (f"youtube.com/shorts/{ID}/?si=x#frag", ID),
    # music
    (f"https://music.youtube.com/watch?v={ID}", ID),
    (f"music.youtube.com/watch?v={ID}&list=RDAMVM{ID}", ID),
    # youtu.be, query and fragment ignored
    (f"https://youtu.be/{ID}", ID),
    (f"youtu.be/{ID}?si=AbCdEf", ID),
    (f"http://YOUTU.BE/{ID}?t=10#x", ID),
    # trimmed (JavaScript trim whitespace, including NBSP and BOM)
    (f"  https://youtu.be/{ID}\n", ID),
    ("\t" + f"https://youtu.be/{ID}" + chr(0xA0) + chr(0xFEFF), ID),
    # IDs with - and _
    ("https://youtu.be/a-b_c-d_e-f", "a-b_c-d_e-f"),
]

REJECTED: list[str] = [
    "",
    "   ",
    ID,
    "not a url",
    # playlists, embeds, live, channels, handles
    "https://www.youtube.com/playlist?list=PL1234567890",
    f"https://www.youtube.com/embed/{ID}",
    f"https://www.youtube.com/live/{ID}",
    "https://www.youtube.com/@SomeHandle",
    "https://www.youtube.com/channel/UC1234567890",
    f"https://www.youtube.com/v/{ID}",
    # other hosts
    f"https://www.youtube-nocookie.com/embed/{ID}",
    f"https://youtube-nocookie.com/watch?v={ID}",
    f"https://evil.com/watch?v={ID}",
    f"https://youtube.com.evil.com/watch?v={ID}",
    f"https://evilyoutube.com/watch?v={ID}",
    f"https://music.youtube.com/shorts/{ID}",
    f"https://gaming.youtube.com/watch?v={ID}",
    f"https://www.youtu.be/{ID}",
    # schemes
    f"ftp://youtube.com/watch?v={ID}",
    f"javascript:alert(1)//youtube.com/watch?v={ID}",
    f"mailto:x@youtube.com/watch?v={ID}",
    f"//youtube.com/watch?v={ID}",
    f"https:/youtube.com/watch?v={ID}",
    f"https:youtube.com/watch?v={ID}",
    f"file:///youtube.com/watch?v={ID}",
    # authority: userinfo, ports, empty host, trailing dot, backslash
    f"https://user@youtube.com/watch?v={ID}",
    f"https://user:pw@youtube.com/watch?v={ID}",
    f"https://youtube.com:443/watch?v={ID}",
    f"youtube.com:443/watch?v={ID}",
    f"https:///watch?v={ID}",
    f"https://youtube.com./watch?v={ID}",
    f"https://youtube.com\\watch?v={ID}",
    f"https://youtube.com\\@evil.com/watch?v={ID}",
    # paths are case-sensitive and exact
    f"https://www.youtube.com/Watch?v={ID}",
    f"https://www.youtube.com/watch/?v={ID}",
    f"https://www.youtube.com/watch/{ID}",
    f"https://www.youtube.com?v={ID}",
    f"https://www.youtube.com/?v={ID}",
    f"https://www.youtube.com/shorts/{ID}//",
    f"https://www.youtube.com/shorts/{ID}/extra",
    f"https://www.youtube.com/SHORTS/{ID}",
    f"https://youtu.be/{ID}/",
    f"https://youtu.be/{ID}/extra",
    "https://youtu.be/",
    f"https://music.youtube.com/watch/?v={ID}",
    # wrong-length or invalid IDs
    "https://youtu.be/dQw4w9WgXc",
    "https://youtu.be/dQw4w9WgXcQQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXc",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
    "https://www.youtube.com/watch?v=dQw4w9WgX!Q",
    "https://www.youtube.com/watch?v=dQw4w9WgX+Q",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch?vv=" + ID,
    "https://www.youtube.com/watch",
    f"https://www.youtube.com/watch?list=PL1&v=bad&v={ID}",
    "https://www.youtube.com/shorts/dQw4w9WgXc",
    # whitespace/control characters inside are not stripped
    "https://youtu.be/dQw4w\t9WgXcQ",
    f"https://you tube.com/watch?v={ID}",
    # the fragment can't carry the id
    f"https://www.youtube.com/watch#v={ID}",
]


@pytest.mark.parametrize(("raw", "expected"), ACCEPTED)
def test_accepted(raw: str, expected: str) -> None:
    assert extract_video_id(raw) == expected
    video = parse_youtube_url(raw)
    assert video is not None
    assert video.video_id == expected
    assert video.url == f"https://www.youtube.com/watch?v={expected}"
    assert video.source_key == f"yt:{expected}"


@pytest.mark.parametrize("raw", REJECTED)
def test_rejected(raw: str) -> None:
    assert extract_video_id(raw) is None
    assert parse_youtube_url(raw) is None


@pytest.mark.parametrize("raw", [None, 123, ["https://youtu.be/" + ID], {"url": ID}])
def test_non_strings_are_rejected(raw: object) -> None:
    assert parse_youtube_url(raw) is None


def test_rebuilt_url_drops_everything_but_the_id() -> None:
    video = parse_youtube_url(f"https://www.youtube.com/watch?v={ID}&list=PL1&t=9#frag")
    assert video is not None
    assert video.url == f"https://www.youtube.com/watch?v={ID}"


def test_watch_url_validates() -> None:
    assert watch_url(ID) == f"https://www.youtube.com/watch?v={ID}"
    with pytest.raises(ValueError):
        watch_url("bad&list=x")


@pytest.mark.parametrize("key", [f"up:{ID}", "yt:short", f"yt:{ID}&x", f"yt{ID}", ""])
def test_video_id_from_source_key_rejects_corrupt_keys(key: str) -> None:
    with pytest.raises(ValueError):
        video_id_from_source_key(key)


def test_video_id_from_source_key() -> None:
    assert video_id_from_source_key(f"yt:{ID}") == ID
