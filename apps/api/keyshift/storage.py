"""Filesystem layout on the shared ``/data`` volume (ARCHITECTURE.md §6.3, ADR 0005 §10).

- ``MEDIA_DIR/<uuid4>.m4a``: served by nginx; files appear here only by atomic rename.
- ``TMP_DIR/<job_id>/``: per-job staging (upload bodies, yt-dlp downloads); never served.
- ``TMP_DIR/.cache/``: yt-dlp and Deno caches, kept across jobs and skipped by cleanup.
"""

import asyncio
import contextlib
import errno
import os
import shutil
import uuid
from pathlib import Path

from keyshift.db.migrate import apply_migrations
from keyshift.settings import Settings

MEDIA_FILE_MODE = 0o644  # nginx (another uid, read-only mount) must be able to read it
CACHE_DIR_NAME = ".cache"


def ensure_dirs(settings: Settings) -> None:
    """Create MEDIA_DIR, TMP_DIR and the DB directory if missing (api and worker startup).

    Modes match the K8s init container: media 0755, tmp and db 0750. Existing
    directories are left alone.
    """
    for path, mode in (
        (settings.MEDIA_DIR, 0o755),
        (settings.TMP_DIR, 0o750),
        (os.path.dirname(settings.DB_PATH) or ".", 0o750),
    ):
        os.makedirs(path, mode=mode, exist_ok=True)


def job_dir(settings: Settings, job_id: str) -> Path:
    return Path(settings.TMP_DIR) / job_id


def staged_upload_path(settings: Settings, job_id: str) -> Path:
    return job_dir(settings, job_id) / "upload"


def cache_dir(settings: Settings, name: str) -> Path:
    return Path(settings.TMP_DIR) / CACHE_DIR_NAME / name


def new_media_name() -> str:
    return f"{uuid.uuid4()}.m4a"


def media_path(settings: Settings, media_file: str) -> Path:
    return Path(settings.MEDIA_DIR) / media_file


def media_url(settings: Settings, media_file: str) -> str:
    return f"{settings.MEDIA_BASE_URL.rstrip('/')}/{media_file}"


def atomic_move(src: Path, dst: Path) -> None:
    """Move ``src`` to ``dst`` so ``dst`` never exists half-written.

    TMP_DIR and MEDIA_DIR share the PVC, so this is a plain rename. If they ever end up on
    different filesystems, copy to a hidden temp name next to ``dst`` and rename that.
    """
    try:
        os.replace(src, dst)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        tmp = dst.with_name(f".{dst.name}.{uuid.uuid4().hex}.tmp")
        try:
            shutil.copyfile(src, tmp)
            os.replace(tmp, dst)
        finally:
            tmp.unlink(missing_ok=True)
        src.unlink(missing_ok=True)


def publish_media(src: Path, dst: Path) -> None:
    """Make ``src`` world-readable and fresh, then move it into MEDIA_DIR atomically.

    The mtime is reset so cleanup's orphan grace period starts now (yt-dlp may have
    set it from the server's Last-Modified).
    """
    os.chmod(src, MEDIA_FILE_MODE)
    os.utime(src)
    atomic_move(src, dst)


def remove_path(path: Path) -> None:
    """Delete a file or directory tree, ignoring anything already gone."""
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


async def prepare_storage(settings: Settings) -> None:
    """Directories, then migrations: run at startup by both the api and the worker."""
    await asyncio.to_thread(ensure_dirs, settings)
    await asyncio.to_thread(apply_migrations, settings.DB_PATH)
