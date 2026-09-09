from __future__ import annotations

import os
import re
import hashlib
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
DATABASE_URL = os.environ["DATABASE_URL"]
IP_HASH_SALT = os.environ["IP_HASH_SALT"]
SHANGHAI = ZoneInfo("Asia/Shanghai")

# Platform axis for download counters. The legacy `downloads` column keeps
# meaning "mobile (Android) downloads" so historical numbers stay intact;
# desktop downloads live in `desktop_downloads`.
PLATFORMS = ("android", "desktop")


class EventPayload(BaseModel):
    eventId: str = Field(min_length=8, max_length=128, pattern=EVENT_ID_PATTERN.pattern)
    platform: str = Field(default="android", pattern="^(android|desktop)$")


class StatsStore:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection[Any]]:
        with psycopg.connect(self.database_url, connect_timeout=5) as connection:
            yield connection

    def initialize(self) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS counters (
                    id SMALLINT PRIMARY KEY CHECK (id = 1),
                    total_views BIGINT NOT NULL DEFAULT 0 CHECK (total_views >= 0),
                    downloads BIGINT NOT NULL DEFAULT 0 CHECK (downloads >= 0)
                )
                """
            )
            # Mobile-vs-desktop download split; idempotent for pre-existing rows.
            cursor.execute(
                "ALTER TABLE counters ADD COLUMN IF NOT EXISTS desktop_downloads "
                "BIGINT NOT NULL DEFAULT 0 CHECK (desktop_downloads >= 0)"
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS app_daily_active (
                    active_date DATE NOT NULL,
                    ip_hash CHAR(64) NOT NULL,
                    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    app_version VARCHAR(32) NOT NULL DEFAULT '',
                    PRIMARY KEY (active_date, ip_hash)
                )
                """
            )
            cursor.execute(
                """
                INSERT INTO counters (id, total_views, downloads)
                VALUES (1, 0, 0)
                ON CONFLICT (id) DO NOTHING
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS stat_events (
                    event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('view', 'download')),
                    event_id VARCHAR(128) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (event_type, event_id)
                )
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_stat_events_type_created_at
                ON stat_events (event_type, created_at)
                """
            )

    @staticmethod
    def prune(cursor: psycopg.Cursor[Any]) -> None:
        cursor.execute(
            """
            DELETE FROM stat_events
            WHERE (event_type = 'view' AND created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours')
               OR (event_type = 'download' AND created_at < CURRENT_TIMESTAMP - INTERVAL '7 days')
            """
        )

    @staticmethod
    def summary(cursor: psycopg.Cursor[Any]) -> dict[str, int]:
        cursor.execute(
            "SELECT total_views, downloads, desktop_downloads FROM counters WHERE id = 1"
        )
        total_views, downloads, desktop_downloads = cursor.fetchone()
        cursor.execute(
            """
            SELECT COUNT(*)
            FROM stat_events
            WHERE event_type = 'view'
              AND created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
            """
        )
        views_24h = cursor.fetchone()[0]
        return {
            "totalViews": int(total_views),
            "views24h": int(views_24h),
            "downloads": int(downloads),
            "desktopDownloads": int(desktop_downloads),
        }

    def get_stats(self, range_from: str | None = None, range_to: str | None = None) -> dict[str, Any]:
        today = datetime.now(SHANGHAI).date()
        with self.connect() as connection, connection.cursor() as cursor:
            self.prune(cursor)
            result: dict[str, Any] = self.summary(cursor)
            cursor.execute("SELECT COUNT(*) FROM app_daily_active WHERE active_date = %s", (today,))
            result["appDauToday"] = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT COUNT(*) FROM app_daily_active WHERE active_date = %s",
                (today - timedelta(days=1),),
            )
            result["appDauYesterday"] = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT COUNT(DISTINCT ip_hash) FROM app_daily_active WHERE active_date >= %s",
                (today - timedelta(days=6),),
            )
            result["appUnique7d"] = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT COUNT(DISTINCT ip_hash) FROM app_daily_active WHERE active_date >= %s",
                (today - timedelta(days=29),),
            )
            result["appUnique30d"] = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT COALESCE(SUM(c), 0) FROM ("
                "SELECT COUNT(*) AS c FROM app_daily_active "
                "WHERE active_date >= %s GROUP BY active_date) AS d",
                (today - timedelta(days=6),),
            )
            result["appDau7dAverage"] = round(int(cursor.fetchone()[0]) / 7, 1)
            cursor.execute("SELECT COUNT(*) FROM app_daily_active")
            result["appDailyStartsTotal"] = int(cursor.fetchone()[0])
            cursor.execute(
                "SELECT active_date::text, COUNT(*) FROM app_daily_active "
                "WHERE active_date >= %s GROUP BY active_date ORDER BY active_date",
                (today - timedelta(days=29),),
            )
            counts = {row[0]: int(row[1]) for row in cursor.fetchall()}
            result["appDau30d"] = [
                {"date": day.isoformat(), "count": counts.get(day.isoformat(), 0)}
                for day in (today - timedelta(days=offset) for offset in range(29, -1, -1))
            ]
            result["appDau30dPeak"] = max((item["count"] for item in result["appDau30d"]), default=0)
            result["appDau30dAverage"] = round(
                sum(item["count"] for item in result["appDau30d"]) / 30,
                1,
            )
            cursor.execute(
                "SELECT app_version, COUNT(DISTINCT ip_hash) AS users "
                "FROM app_daily_active WHERE active_date >= %s "
                "GROUP BY app_version ORDER BY users DESC",
                (today - timedelta(days=29),),
            )
            result["versions"] = [
                {"version": (row[0] or "unknown"), "users": int(row[1])}
                for row in cursor.fetchall()
            ]
            if range_from and range_to:
                result["range"] = self.get_range_stats(cursor, range_from, range_to)
            return result

    def get_range_stats(self, cursor: psycopg.Cursor[Any], range_from: str, range_to: str) -> dict[str, Any]:
        """自定义时间范围：每日日活趋势、平均日活、独立设备、版本分布。"""
        try:
            start = date.fromisoformat(range_from)
            end = date.fromisoformat(range_to)
        except ValueError as error:
            raise ValueError(f"invalid date range: {error}") from error
        if start > end:
            start, end = end, start
        if (end - start).days > 366:
            end = start + timedelta(days=366)
        cursor.execute(
            "SELECT active_date::text, COUNT(*) FROM app_daily_active "
            "WHERE active_date >= %s AND active_date <= %s "
            "GROUP BY active_date ORDER BY active_date",
            (start, end),
        )
        counts = {row[0]: int(row[1]) for row in cursor.fetchall()}
        span = (end - start).days + 1
        trend = [
            {"date": (start + timedelta(days=offset)).isoformat(),
             "count": counts.get((start + timedelta(days=offset)).isoformat(), 0)}
            for offset in range(span)
        ]
        cursor.execute(
            "SELECT COUNT(DISTINCT ip_hash) FROM app_daily_active "
            "WHERE active_date >= %s AND active_date <= %s",
            (start, end),
        )
        unique = int(cursor.fetchone()[0])
        cursor.execute(
            "SELECT app_version, COUNT(DISTINCT ip_hash) AS users FROM app_daily_active "
            "WHERE active_date >= %s AND active_date <= %s "
            "GROUP BY app_version ORDER BY users DESC",
            (start, end),
        )
        versions = [
            {"version": (row[0] or "unknown"), "users": int(row[1])}
            for row in cursor.fetchall()
        ]
        return {
            "from": start.isoformat(),
            "to": end.isoformat(),
            "trend": trend,
            "average": round(sum(item["count"] for item in trend) / span, 1),
            "peak": max((item["count"] for item in trend), default=0),
            "unique": unique,
            "versions": versions,
        }

    def record(self, event_type: str, event_id: str, platform: str = "android") -> dict[str, int]:
        counter_column = "total_views" if event_type == "view" else (
            "desktop_downloads" if platform == "desktop" else "downloads"
        )
        with self.connect() as connection, connection.cursor() as cursor:
            self.prune(cursor)
            cursor.execute(
                """
                INSERT INTO stat_events (event_type, event_id)
                VALUES (%s, %s)
                ON CONFLICT (event_type, event_id) DO NOTHING
                RETURNING 1
                """,
                (event_type, event_id),
            )
            if cursor.fetchone() is not None:
                cursor.execute(f"UPDATE counters SET {counter_column} = {counter_column} + 1 WHERE id = 1")
            return self.summary(cursor)

    def health(self) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT 1")

    def record_daily_active(self, ip_hash: str, app_version: str) -> dict[str, Any]:
        active_date = datetime.now(SHANGHAI).date()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO app_daily_active (active_date, ip_hash, app_version) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (active_date, ip_hash, app_version[:32]),
            )
        return self.get_stats()


store = StatsStore(DATABASE_URL)
app = FastAPI(title="Coomi Website Statistics", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def disable_api_caching(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(psycopg.Error)
async def handle_database_error(_request: Any, _error: psycopg.Error) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "stats_unavailable"},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/health")
def health() -> dict[str, str]:
    store.health()
    return {"status": "ok"}


@app.get("/api/stats")
def get_stats(
    from_date: str | None = Query(None, alias="from"),
    to_date: str | None = Query(None, alias="to"),
) -> dict[str, Any]:
    if bool(from_date) != bool(to_date):
        raise HTTPException(status_code=400, detail={"error": "from and to must be provided together"})
    if from_date and to_date:
        for value in (from_date, to_date):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise HTTPException(status_code=400, detail={"error": "invalid date format, expect YYYY-MM-DD"})
        try:
            return store.get_stats(range_from=from_date, range_to=to_date)
        except ValueError as error:
            raise HTTPException(status_code=400, detail={"error": str(error)}) from error
    return store.get_stats()


@app.post("/coomi/feedback/api/stats/dau")
def record_app_dau(request: Request) -> dict[str, Any]:
    real_ip = request.headers.get("x-real-ip", "").strip()
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    ip = real_ip or forwarded or (request.client.host if request.client else "unknown")
    ip_hash = hashlib.sha256(f"{IP_HASH_SALT}:{ip}".encode()).hexdigest()
    return store.record_daily_active(ip_hash, request.headers.get("x-coomi-version", ""))


@app.post("/api/stats/view")
def record_view(payload: EventPayload) -> dict[str, int]:
    return store.record("view", payload.eventId)


@app.post("/api/stats/download")
def record_download(payload: EventPayload) -> dict[str, int]:
    return store.record("download", payload.eventId, payload.platform)
