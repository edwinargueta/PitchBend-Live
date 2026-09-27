"""The shared YouTube URL contract: this table is also run against the browser's
parser (apps/web/src/lib/youtube.contract.test.ts), so the two can't drift."""

import json
from pathlib import Path

import pytest

from pitchbend_live.youtube import extract_video_id

_TABLE = json.loads((Path(__file__).parent / "fixtures" / "youtube_urls.json").read_text())


@pytest.mark.parametrize("case", _TABLE["cases"], ids=lambda c: repr(c["input"])[:60])
def test_shared_url_contract(case: dict[str, str | None]) -> None:
    assert extract_video_id(case["input"]) == case["id"]
