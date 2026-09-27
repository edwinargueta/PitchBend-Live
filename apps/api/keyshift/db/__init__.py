"""SQLite persistence: connections, migrations, and the track/job repository.

``Database.run(fn, ...)`` opens a connection in a worker thread, calls
``fn(conn, ...)`` and closes it, so the event loop never blocks on SQLite (a write can
wait up to ``busy_timeout`` for the other process's lock).
"""

import asyncio
import sqlite3
from collections.abc import Callable
from typing import Concatenate, ParamSpec, TypeVar

from keyshift.db.connection import connect

P = ParamSpec("P")
T = TypeVar("T")


class Database:
    def __init__(self, path: str) -> None:
        self.path = path

    def call(
        self,
        fn: Callable[Concatenate[sqlite3.Connection, P], T],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        conn = connect(self.path)
        try:
            return fn(conn, *args, **kwargs)
        finally:
            conn.close()

    async def run(
        self,
        fn: Callable[Concatenate[sqlite3.Connection, P], T],
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> T:
        return await asyncio.to_thread(lambda: self.call(fn, *args, **kwargs))
