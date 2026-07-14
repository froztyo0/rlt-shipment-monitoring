from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
DATA_DIR = BASE_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "postgres"
    db_user: str = "postgres"
    db_password: str = ""
    db_sslmode: str = "prefer"

    db_pool_min: int = 1
    db_pool_max: int = 5
    db_statement_timeout_ms: int = 30000

    active_window_days: int = 7
    gps_stale_hours: int = 4
    ghost_max_speed_kmh: float = 1100.0
    default_geofence_km: float = 1.0

    airports_csv_url: str = (
        "https://raw.githubusercontent.com/datasets/airport-codes/main/data/airport-codes.csv"
    )
    airports_csv_url_fallback: str = (
        "https://raw.githubusercontent.com/datasets/airport-codes/master/data/airport-codes.csv"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
