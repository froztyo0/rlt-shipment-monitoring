"""Data-quality flag definitions over etl.shipment.

Each flag is a SQL boolean expression evaluated inline (single pass over the
table — no joins), so the same definitions power the list view, the KPI
aggregates and the ops drill-down. Blank checks cast to text first so they
work whatever the underlying column type is.
"""


def blank(col: str) -> str:
    return f"(NULLIF(btrim({col}::text), '') IS NULL)"


def not_blank(col: str) -> str:
    return f"(NULLIF(btrim({col}::text), '') IS NOT NULL)"


# Terminal-state heuristics (shipment table only stores display strings).
# COALESCE(..., FALSE) matters: ILIKE against NULL yields NULL, and
# NOT NULL is still NULL — without it every active-dependent flag
# silently drops rows whose status columns are blank.
DELIVERED_SQL = (
    "COALESCE(s.currentmilestone ILIKE '%deliver%' "
    "OR s.dosestatus ILIKE '%deliver%' "
    "OR s.routestatus ILIKE '%deliver%' "
    "OR s.routestatus ILIKE '%complet%' "
    f"OR {not_blank('s.actualdeliverytime')} "
    f"OR {not_blank('s.pod_receival_time')}, FALSE)"
)

CANCELLED_SQL = (
    "COALESCE(s.currentmilestone ILIKE '%cancel%' "
    "OR s.dosestatus ILIKE '%cancel%' "
    "OR s.routestatus ILIKE '%cancel%' "
    "OR s.rome_status ILIKE '%cancel%', FALSE)"
)

TERMINAL_SQL = f"({DELIVERED_SQL} OR {CANCELLED_SQL})"
ACTIVE_SQL = f"(NOT {TERMINAL_SQL})"

COL_3A2_STATUS = 's."3agest2_status"'

IS_AIR_SQL = (
    f"COALESCE({not_blank('s.transportmode_flight')} "
    "OR s.modeoftransportation ILIKE '%air%' "
    "OR s.modeoftransportation ILIKE '%flight%' "
    f"OR {not_blank('s.flightnumber')}, FALSE)"
)

# name -> (sql, severity, label, what it means / where we go digging)
FLAG_DEFS: dict[str, tuple[str, str, str, str]] = {
    "missing_batch": (
        blank("s.batchnumber"), "serious", "Missing batch number",
        "No batch on the shipment — check threeagesttwo_batches_inbound / _fullload for this sales order",
    ),
    "missing_carrier": (
        blank("s.carrier"), "serious", "Missing carrier",
        "No carrier assigned — check carrier_inbound and carrier_inbound_rejects",
    ),
    "missing_carrier_tracking": (
        f"({blank('s.carriertrackingnumber')} AND {ACTIVE_SQL})", "warning", "Missing carrier tracking #",
        "Carrier tracking id absent while shipment is active",
    ),
    "missing_planned_delivery": (
        blank("s.planneddeliverydate"), "serious", "Missing planned delivery",
        "No planned delivery date — check ROME order / 3A GEST2 sales order",
    ),
    "missing_injection_date": (
        blank("s.injectiondate"), "critical", "Missing injection date",
        "No injection date — dose scheduling unknown; check ROME inbound",
    ),
    "missing_dest_coords": (
        f"({blank('s.destinationlatitude')} OR {blank('s.destinationlongitude')})",
        "warning", "No destination coordinates",
        "Geofence/ETA math impossible — matches 'No Geographical Coordinates for Destination' notification",
    ),
    "missing_route": (
        f"({blank('s.route')} AND {ACTIVE_SQL})", "warning", "Missing routing info",
        "No route on an active shipment — matches 'Missing Routing Information Alert'",
    ),
    "missing_flight_air": (
        f"({IS_AIR_SQL} AND {blank('s.flightnumber')} AND {ACTIVE_SQL})",
        "warning", "Air shipment w/o flight number",
        "Mode is AIR but no flight number — check carrier_inbound.flight_details",
    ),
    "missing_eta": (
        f"({blank('s.etadeliverytime')} AND {ACTIVE_SQL})", "info", "Missing ETA",
        "No ETA while in transit",
    ),
    "gps_stale": (
        f"({ACTIVE_SQL} AND {not_blank('s.actualdeparted')} AND "
        "(s.lastgps IS NULL OR s.lastgps::timestamp < now() - make_interval(hours => $GPS_STALE$)))",
        "serious", "GPS signal stale",
        "Departed but no recent GPS ping — matches 'GPS Signal Lost Alert'; check sensitech_inbound_trip/_rejects",
    ),
    "no_sensitech_data": (
        f"({blank('s.lastgps')} AND {not_blank('s.actualdeparted')} AND {ACTIVE_SQL})",
        "serious", "No Sensitech data",
        "Departed but never received a GPS fix — matches 'No Sensitech Data Received'",
    ),
    "stale_injection": (
        f"({not_blank('s.injectiondate')} AND s.injectiondate::date < CURRENT_DATE AND {ACTIVE_SQL})",
        "critical", "Injection date passed, not closed",
        "Injection date is in the past but shipment is neither delivered nor cancelled — needs RCA",
    ),
    "delivered_no_pod": (
        f"({DELIVERED_SQL} AND {blank('s.podname')} AND {blank('s.pod_receival_time')})",
        "warning", "Delivered without POD",
        "Delivery recorded but no proof-of-delivery — matches 'POD Missed Alert'",
    ),
    "upstream_silent_rome": (
        f"({blank('s.rome_status')} AND {ACTIVE_SQL})", "info", "No ROME status",
        "matches 'No Events From Upstream' — check rome_inbound_orders / _rejects",
    ),
    "upstream_silent_3a2": (
        f"({blank(COL_3A2_STATUS)} AND {ACTIVE_SQL})", "info", "No 3A GEST2 status",
        "matches 'No Events From 3Agest2' — check threeagesttwo inbound tables",
    ),
    "upstream_silent_carrier": (
        f"({blank('s.carrier_status')} AND {ACTIVE_SQL})", "warning", "No carrier events",
        "matches 'No Events From Carrier' — check carrier_inbound / _rejects",
    ),
}


def flag_sql(name: str, gps_stale_hours: int) -> str:
    sql = FLAG_DEFS[name][0]
    return sql.replace("$GPS_STALE$", str(int(gps_stale_hours)))


def flag_select_columns(gps_stale_hours: int) -> str:
    """`, <expr> AS flag_x, ...` for the shipment list query."""
    return ",\n  ".join(
        f"{flag_sql(n, gps_stale_hours)} AS flag_{n}" for n in FLAG_DEFS
    )


def flag_count_columns(gps_stale_hours: int) -> str:
    """`COUNT(*) FILTER (WHERE <expr>) AS n_x, ...` for the KPI aggregate."""
    return ",\n  ".join(
        f"COUNT(*) FILTER (WHERE {flag_sql(n, gps_stale_hours)}) AS n_{n}" for n in FLAG_DEFS
    )


def any_flag_sql(gps_stale_hours: int) -> str:
    return "(" + " OR ".join(flag_sql(n, gps_stale_hours) for n in FLAG_DEFS) + ")"


def extract_flags(row: dict) -> list[dict]:
    """Pull flag_* booleans off a DB row into a compact issue list."""
    out = []
    for name, (_sql, severity, label, hint) in FLAG_DEFS.items():
        if row.get(f"flag_{name}"):
            out.append({"code": name, "severity": severity, "label": label, "hint": hint})
    return out


FLAG_META = {
    name: {"severity": sev, "label": label, "hint": hint}
    for name, (_s, sev, label, hint) in FLAG_DEFS.items()
}
