"""``ingest_upload``: normalize a staged upload, then the shared ready -> key -> done flow.

``POST /api/uploads`` already sniffed and ffprobed the file and moved it to
``TMP_DIR/<job_id>/upload``; the worker re-probes it and copies/remuxes/transcodes it
to AAC m4a (ARCHITECTURE.md §10 A4, D8).
"""

import asyncio
from typing import Any

from keyshift.errors import ErrorCode
from keyshift.storage import staged_upload_path
from keyshift.titles import FALLBACK_TITLE
from keyshift.worker.pipeline import IngestError, JobRun, SourceAudio, run_ingest


async def upload_source(run: JobRun) -> SourceAudio:
    staged = staged_upload_path(run.deps.settings, run.job_id)
    if not await asyncio.to_thread(staged.is_file):
        # Cleanup removes staging older than 1 h, e.g. after a very long queue wait.
        raise IngestError(ErrorCode.INTERNAL)
    return SourceAudio(staged, run.track.title or FALLBACK_TITLE)


async def ingest_upload(ctx: dict[str, Any], job_id: str) -> None:
    """ARQ task: ingest an upload accepted by ``POST /api/uploads``."""
    await run_ingest(ctx, job_id, upload_source, bad_media=ErrorCode.UNSUPPORTED_FILE)
