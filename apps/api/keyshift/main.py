"""FastAPI application entrypoint (``uvicorn keyshift.main:app``)."""

from fastapi import FastAPI

from keyshift.routes import health


def create_app() -> FastAPI:
    # Everything the Ingress routes to this service lives under /api (§4), so the
    # interactive docs are served there too.
    app = FastAPI(
        title="KeyShift API",
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.include_router(health.router, prefix="/api")
    return app


app = create_app()
