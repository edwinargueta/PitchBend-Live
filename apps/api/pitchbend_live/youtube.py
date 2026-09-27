"""Authoritative YouTube URL validation and rebuild (ARCHITECTURE.md §6.4, CLAUDE.md §3).

Only the rebuilt ``https://www.youtube.com/watch?v=<id>`` ever reaches yt-dlp; the raw
user input is discarded after parsing. The browser's ``src/lib/youtube.ts``
(``extractVideoId``) implements the same rules; this module stays authoritative. Both
parse by hand: URL-spec leniency (backslashes, ``https:/host``, stripped tabs) would
accept inputs these rules reject.

Rules:

- Trim (JavaScript ``String.prototype.trim`` whitespace, for parity with the browser).
- Scheme optional; ``http://`` / ``https://`` only, case-insensitive. Any other scheme,
  a scheme without ``//``, and a scheme-relative ``//host`` start are rejected.
- Authority: a bare host matching ``^[A-Za-z0-9.-]+$``, compared case-insensitively.
  No userinfo, no port (not even ``:443``), no empty host, no trailing dot.
- The ``#fragment`` is stripped and ignored. Paths are case-sensitive.
- ``youtube.com`` / ``www.youtube.com`` / ``m.youtube.com``: exactly ``/watch`` with a
  ``v`` query parameter, or ``/shorts/<ID>`` with one optional trailing ``/`` (its query
  is ignored).
- ``music.youtube.com``: exactly ``/watch`` with ``v``.
- ``youtu.be``: exactly ``/<ID>``, no trailing slash; the query (e.g. ``?si=``) is ignored.
- Watch URLs: the **first** ``v`` parameter wins, percent-decoded with URLSearchParams
  semantics (``+`` is a space). Other parameters (``list``, ``t``, ``si``...) are ignored.
- The ID must match ``^[A-Za-z0-9_-]{11}$`` after extraction.
"""

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
_HOST = re.compile(r"[A-Za-z0-9.-]+")
_SHORTS_PATH = re.compile(r"/shorts/([^/]*)/?")

# The characters JavaScript's trim() removes (WhiteSpace + LineTerminator).
_JS_WHITESPACE = "".join(
    map(
        chr,
        (
            0x09,
            0x0A,
            0x0B,
            0x0C,
            0x0D,
            0x20,
            0xA0,
            0x1680,
            *range(0x2000, 0x200B),
            0x2028,
            0x2029,
            0x202F,
            0x205F,
            0x3000,
            0xFEFF,
        ),
    )
)

_WATCH_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com"})
_MUSIC_HOST = "music.youtube.com"
_SHORT_LINK_HOST = "youtu.be"


@dataclass(frozen=True)
class YouTubeVideo:
    video_id: str

    @property
    def url(self) -> str:
        """The only URL ever handed to yt-dlp."""
        return watch_url(self.video_id)

    @property
    def source_key(self) -> str:
        return f"yt:{self.video_id}"


def watch_url(video_id: str) -> str:
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("not a YouTube video id")
    return f"https://www.youtube.com/watch?v={video_id}"


def video_id_from_source_key(source_key: str) -> str:
    """``yt:<id>`` -> ``<id>``, re-validated so a corrupt row can't reach yt-dlp."""
    prefix, _, video_id = source_key.partition(":")
    if prefix != "yt" or not VIDEO_ID.fullmatch(video_id):
        raise ValueError("not a YouTube source key")
    return video_id


def _first_v(query: str) -> str | None:
    for name, value in parse_qsl(query, keep_blank_values=True, errors="replace"):
        if name == "v":
            return value
    return None


def extract_video_id(raw: object) -> str | None:
    """The 11-character video ID of an accepted YouTube URL, else ``None``."""
    if not isinstance(raw, str):
        return None
    text = raw.strip(_JS_WHITESPACE)
    if text.startswith("//"):
        return None
    if scheme := _SCHEME.match(text):
        rest = text[scheme.end() :]
        if scheme.group(0)[:-1].lower() not in ("http", "https") or not rest.startswith("//"):
            return None
        text = rest[2:]

    text = text.split("#", 1)[0]
    authority_end = min((i for i in (text.find("/"), text.find("?")) if i >= 0), default=len(text))
    host, remainder = text[:authority_end], text[authority_end:]
    if not _HOST.fullmatch(host):
        return None
    host = host.lower()
    path, _, query = remainder.partition("?")

    candidate: str | None = None
    if host in _WATCH_HOSTS:
        if path == "/watch":
            candidate = _first_v(query)
        elif shorts := _SHORTS_PATH.fullmatch(path):
            candidate = shorts.group(1)
    elif host == _MUSIC_HOST:
        if path == "/watch":
            candidate = _first_v(query)
    elif host == _SHORT_LINK_HOST and path.startswith("/"):
        candidate = path[1:]

    if candidate is not None and VIDEO_ID.fullmatch(candidate):
        return candidate
    return None


def parse_youtube_url(raw: object) -> YouTubeVideo | None:
    """Return the video for an accepted YouTube URL, else ``None``."""
    video_id = extract_video_id(raw)
    return YouTubeVideo(video_id) if video_id else None
