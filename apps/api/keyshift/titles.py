"""The one title sanitizer for upload filenames and yt-dlp titles (ADR 0005 §12).

Titles are untrusted, display-only strings: they never become paths, URLs or log fields.
"""

import re
import unicodedata

MAX_TITLE_LENGTH = 120
FALLBACK_TITLE = "Untitled"

_WHITESPACE = re.compile(r"\s+")
_PATH_SEPARATORS = re.compile(r"[\\/]")


def _strip_control(text: str) -> str:
    # Control/format/private/unassigned code points (Unicode category C*) become spaces,
    # so "a\tb" stays two words and bidi overrides can't reorder the displayed text.
    return "".join(" " if unicodedata.category(ch).startswith("C") else ch for ch in text)


def sanitize_title(raw: str | None, *, filename: bool = False) -> str:
    """Return a safe display title.

    Control characters are removed, whitespace collapsed, the result capped at
    ``MAX_TITLE_LENGTH`` characters, and an empty result becomes ``"Untitled"``.

    With ``filename=True`` (uploads) the path components and the extension are stripped
    first, so ``C:\\music\\My Song.mp3`` becomes ``My Song``. yt-dlp titles keep their
    slashes ("AC/DC - Back in Black"): stripping path components there would mangle them.
    """
    if not raw:
        return FALLBACK_TITLE
    text = raw
    if filename:
        text = _PATH_SEPARATORS.split(text)[-1]
        stem, dot, _ext = text.rpartition(".")
        if dot and stem.strip(" ."):
            text = stem
    text = _WHITESPACE.sub(" ", _strip_control(text)).strip()
    if len(text) > MAX_TITLE_LENGTH:
        text = text[:MAX_TITLE_LENGTH].rstrip()
    return text or FALLBACK_TITLE
