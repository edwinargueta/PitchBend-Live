"""§6.6 error codes, statuses and the one JSON error shape."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pitchbend_live.errors import (
    HTTP_STATUS,
    NON_FATAL,
    ApiError,
    ErrorCode,
    default_message,
    error_body,
    install_error_handlers,
    limit_message,
)

CONTRACT = {
    "INVALID_URL": 400,
    "UNSUPPORTED_FILE": 400,
    "FILE_TOO_LARGE": 413,
    "VIDEO_TOO_LONG": 422,
    "LIVESTREAM": 422,
    "SOURCE_UNAVAILABLE": 422,
    "SOURCE_BLOCKED": 502,
    "RATE_LIMITED": 429,
    "NOT_FOUND": 404,
    "INTERNAL": 500,
}


def test_codes_and_statuses_match_contract() -> None:
    assert {c.value for c in ErrorCode} == set(CONTRACT) | {"KEY_DETECTION_FAILED"}
    assert {c.value: s for c, s in HTTP_STATUS.items()} == CONTRACT
    assert {"KEY_DETECTION_FAILED"} == NON_FATAL


def test_every_code_has_a_message() -> None:
    for code in ErrorCode:
        assert default_message(code)
    assert "upload" in default_message(ErrorCode.SOURCE_BLOCKED).lower()
    assert default_message("BOGUS") == default_message(ErrorCode.INTERNAL)


def test_limit_messages_quote_config() -> None:
    assert "50 MB" in limit_message(ErrorCode.FILE_TOO_LARGE, max_upload_mb=50, max_duration_s=720)
    assert "12 minutes" in limit_message(
        ErrorCode.VIDEO_TOO_LONG, max_upload_mb=50, max_duration_s=720
    )
    assert limit_message(ErrorCode.LIVESTREAM, max_upload_mb=1, max_duration_s=1) == (
        default_message(ErrorCode.LIVESTREAM)
    )


def test_error_body_shape() -> None:
    assert error_body(ErrorCode.NOT_FOUND, "gone") == {
        "error": {"code": "NOT_FOUND", "message": "gone"}
    }
    assert error_body(ErrorCode.RATE_LIMITED, retry_after_s=7)["error"]["retry_after_s"] == 7


def build_app() -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/api/raise/{code}")
    async def raise_code(code: str) -> None:
        raise ApiError(ErrorCode(code), retry_after_s=5 if code == "RATE_LIMITED" else None)

    @app.get("/api/boom")
    async def boom() -> None:
        raise RuntimeError("secret internals /data/db/pitchbend-live.db")

    @app.post("/api/uploads")
    async def uploads(x: int) -> None:
        pass

    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("code", sorted(CONTRACT))
def test_api_error_renders_contract_shape(code: str) -> None:
    response = build_app().get(f"/api/raise/{code}")
    assert response.status_code == CONTRACT[code]
    error = response.json()["error"]
    assert error["code"] == code and error["message"]
    if code == "RATE_LIMITED":
        assert error["retry_after_s"] == 5
        assert response.headers["retry-after"] == "5"
    else:
        assert "retry_after_s" not in error
        assert "retry-after" not in response.headers


def test_unexpected_exception_is_internal_without_details() -> None:
    response = build_app().get("/api/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "INTERNAL", "message": default_message(ErrorCode.INTERNAL)}
    }
    assert "secret" not in response.text and "Traceback" not in response.text


def test_unknown_route_is_not_found_shape() -> None:
    response = build_app().get("/api/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_method_not_allowed_keeps_status_and_shape() -> None:
    response = build_app().delete("/api/boom")
    assert response.status_code == 405
    assert set(response.json()["error"]) == {"code", "message"}


def test_validation_on_uploads_maps_to_unsupported_file() -> None:
    response = build_app().post("/api/uploads")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNSUPPORTED_FILE"


def test_api_error_defaults() -> None:
    error = ApiError(ErrorCode.LIVESTREAM)
    assert error.status_code == 422
    assert error.message == default_message(ErrorCode.LIVESTREAM)
    assert str(error) == "LIVESTREAM"
    assert ApiError(ErrorCode.KEY_DETECTION_FAILED).status_code == 500
