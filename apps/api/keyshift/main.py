"""FastAPI application entrypoint (``uvicorn keyshift.main:app``).

The api never imports ``keyshift.worker``, yt-dlp, or librosa: it validates, dedups,
enqueues, and streams events; the worker does the heavy lifting.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from keyshift.errors import install_error_handlers
from keyshift.logs import configure_logging
from keyshift.routes import health, jobs, tracks, uploads
from keyshift.services import Services, build_services
from keyshift.settings import get_settings
from keyshift.storage import prepare_storage

logger = logging.getLogger(__name__)


def create_app(services: Services | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging()
        svc = services if services is not None else build_services(get_settings())
        await prepare_storage(svc.settings)
        app.state.services = svc
        logger.info("api started", extra={"event": "startup"})
        try:
            yield
        finally:
            if services is None:
                await svc.aclose()

    # Everything the Ingress routes to this service lives under /api (§4), so the
    # interactive docs are served there too.
    app = FastAPI(
        title="KeyShift API",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    install_error_handlers(app)
    app.include_router(health.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(uploads.router, prefix="/api")
    app.include_router(tracks.router, prefix="/api")
    return app


app = create_app()
