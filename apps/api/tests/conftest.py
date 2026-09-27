from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from keyshift.main import app
from keyshift.settings import get_settings


@pytest.fixture(autouse=True)
def _fresh_settings() -> Iterator[None]:
    """Re-read the environment in every test (get_settings() is cached)."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
