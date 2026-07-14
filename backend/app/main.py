import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import airports
from .db import close_pool, fetch_val
from .routers import feeds, kpis, ops, shipment_detail, shipments

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Airport reference data loads in a thread; DB pool is lazy so the API
    # boots (and /api/health reports clearly) even if RDS is unreachable.
    await asyncio.to_thread(airports.load)
    yield
    await close_pool()


app = FastAPI(title="RLT Shipment Monitoring", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# order matters: literal routes (e.g. /api/shipments/filters) before /{tracking}
app.include_router(feeds.router)
app.include_router(kpis.router)
app.include_router(shipments.router)
app.include_router(shipment_detail.router)
app.include_router(ops.router)


@app.get("/api/health")
async def health():
    try:
        await fetch_val("SELECT 1")
        db = "ok"
    except Exception as e:  # noqa: BLE001
        db = f"error: {type(e).__name__}: {e}"
    return {"status": "ok", "database": db, "airports_loaded": airports.load()}
