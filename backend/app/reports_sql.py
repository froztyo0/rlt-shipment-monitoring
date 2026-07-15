"""Carrier-issue report query — a parameterized port of the ops team's
hand-run SQL (latest ROME orders in an injection window -> carrier events vs
expected milestone maps -> per-order issue flags).

Placeholders from the original ({{carrier_cancelled_conditions}} etc.) are
generated from carrier_config.CARRIER_EVENTS. Binds: $1 = start date,
$2 = end date (both dates, inclusive).
"""
from .carrier_config import event_condition_sql

MAX_REPORT_ROWS = 5000


def build_carrier_issue_sql() -> str:
    cancelled_bare = event_condition_sql("cancelled", "")     # inside actual_events CTEs
    cancelled_a = event_condition_sql("cancelled", "a.")      # alias a
    cancelled_e = event_condition_sql("cancelled", "e.")      # expected_events alias
    delivery_bare = event_condition_sql("delivery", "")

    return f"""
WITH latest_orders AS (
    SELECT *
    FROM (
        SELECT
            *,
            ROW_NUMBER() OVER (
                PARTITION BY salesordernumber
                ORDER BY audit_timestamp DESC
            ) AS rn,
            MAX(CASE WHEN UPPER(TRIM(orderstatus::text)) = 'CANCELLED'
                     THEN 1 ELSE 0 END)
                OVER (PARTITION BY salesordernumber) AS has_cancelled
        FROM etl.rome_inbound_orders
    ) t
    WHERE rn = 1
      AND has_cancelled = 0
      AND injectiondate::date BETWEEN $1 AND $2
),

latest_carrier AS (
    SELECT salesordernumber, carriername, carrier_trackingid
    FROM (
        SELECT
            salesordernumber,
            TRIM(carriername::text) AS carriername,
            TRIM(carrier_trackingid::text) AS carrier_trackingid,
            ROW_NUMBER() OVER (
                PARTITION BY salesordernumber
                ORDER BY audit_timestamp DESC
            ) AS rn
        FROM etl.carrier_inbound
        WHERE NULLIF(TRIM(carriername::text), '') IS NOT NULL
    ) t
    WHERE rn = 1
),

-- carrier tracking id: best non-blank from the order's carrier events, and
-- if the carrier feed never carried one, fall back to the shipment table's
-- carriertrackingnumber (same source the dashboard/sales orders come from)
carrier_tracking AS (
    SELECT lo.salesordernumber,
           COALESCE(
               (SELECT MAX(NULLIF(TRIM(c.carrier_trackingid::text), ''))
                  FROM etl.carrier_inbound c
                 WHERE c.salesordernumber::text = lo.salesordernumber::text),
               (SELECT MAX(NULLIF(TRIM(sh.carriertrackingnumber::text), ''))
                  FROM etl.shipment sh
                 WHERE sh.salesordernumber::text = lo.salesordernumber::text)
           ) AS carrier_trackingid
    FROM latest_orders lo
),

-- latest shipment-table mode per order (bounded to the window's orders)
shipment_mode AS (
    SELECT DISTINCT ON (sh.salesordernumber)
        sh.salesordernumber, sh.modeoftransportation, sh.modeoftransportation_3a2
    FROM etl.shipment sh
    JOIN latest_orders lo ON lo.salesordernumber::text = sh.salesordernumber::text
    ORDER BY sh.salesordernumber, sh.lastupdateddt DESC NULLS LAST
),

-- transport mode from etl.shipment.modeoftransportation directly. Deriving it
-- from flightnumber presence was circular: an Air order MISSING its flight
-- number was classified Road, which then suppressed the missing_flightnumber
-- flag. Flight number is only a last-resort fallback when the mode is blank.
transport_type AS (
    SELECT
        lo.salesordernumber,
        CASE
            WHEN sm.modeoftransportation ILIKE '%air%' OR sm.modeoftransportation ILIKE '%flight%'
                 OR sm.modeoftransportation_3a2 ILIKE '%air%' THEN 'Air'
            WHEN sm.modeoftransportation ILIKE '%road%' OR sm.modeoftransportation ILIKE '%ground%'
                 OR sm.modeoftransportation ILIKE '%truck%' OR sm.modeoftransportation ILIKE '%drive%'
                 OR sm.modeoftransportation ILIKE '%courier%' THEN 'Road'
            WHEN EXISTS (
                SELECT 1 FROM etl.carrier_inbound c
                WHERE c.salesordernumber::text = lo.salesordernumber::text
                  AND NULLIF(BTRIM(c.flightnumber::text), '') IS NOT NULL) THEN 'Air'
            ELSE 'Road'
        END AS derived_mode
    FROM latest_orders lo
    LEFT JOIN shipment_mode sm ON sm.salesordernumber::text = lo.salesordernumber::text
),

expected_events AS (
    SELECT
        lo.salesordernumber,
        TRIM(m.carriername::text) AS carriername,
        TRIM(m."event"::text) AS event,
        NULLIF(TRIM(m.carrier_milestone_step::text), '')::int AS carrier_milestone_step,
        NULLIF(TRIM(m.milestone_flag::text), '')::int AS milestone_flag
    FROM latest_orders lo
    JOIN latest_carrier lc ON lc.salesordernumber::text = lo.salesordernumber::text
    JOIN transport_type tt ON tt.salesordernumber::text = lo.salesordernumber::text
    JOIN etl.carrier_milestone_air m
      ON tt.derived_mode = 'Air'
     AND TRIM(m.carriername::text) = TRIM(lc.carriername::text)
     AND NULLIF(TRIM(m."event"::text), '') IS NOT NULL

    UNION ALL

    SELECT
        lo.salesordernumber,
        TRIM(m.carriername::text) AS carriername,
        TRIM(m."event"::text) AS event,
        NULLIF(TRIM(m.carrier_milestone_step::text), '')::int AS carrier_milestone_step,
        NULLIF(TRIM(m.milestone_flag::text), '')::int AS milestone_flag
    FROM latest_orders lo
    JOIN latest_carrier lc ON lc.salesordernumber::text = lo.salesordernumber::text
    JOIN transport_type tt ON tt.salesordernumber::text = lo.salesordernumber::text
    JOIN etl.carrier_milestone_road m
      ON tt.derived_mode = 'Road'
     AND TRIM(m.carriername::text) = TRIM(lc.carriername::text)
     AND NULLIF(TRIM(m."event"::text), '') IS NOT NULL
),

actual_events AS (
    SELECT
        c.salesordernumber,
        TRIM(c.carriername::text) AS carriername,
        TRIM(c."event"::text) AS event,
        TRIM(c.event_description::text) AS event_description,
        c.eventtimestamp,
        c.audit_timestamp
    FROM etl.carrier_inbound c
    JOIN latest_orders lo ON lo.salesordernumber::text = c.salesordernumber::text
),

carrier_cancelled_flag AS (
    SELECT
        salesordernumber,
        MAX(CASE WHEN {cancelled_bare} THEN 1 ELSE 0 END) AS is_cancelled
    FROM actual_events
    GROUP BY salesordernumber
),

missing_flag AS (
    SELECT
        e.salesordernumber,
        CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS missing_events
    FROM expected_events e
    LEFT JOIN actual_events a
      ON e.salesordernumber::text = a.salesordernumber::text
     AND e.carriername = a.carriername
     AND e.event = a.event
    LEFT JOIN carrier_cancelled_flag ccf
      ON ccf.salesordernumber::text = e.salesordernumber::text
    WHERE a.event IS NULL
      AND (COALESCE(ccf.is_cancelled, 0) = 1 OR NOT ({cancelled_e}))
    GROUP BY e.salesordernumber
),

unordered_step AS (
    SELECT
        a.salesordernumber,
        a.event,
        a.audit_timestamp,
        e.carrier_milestone_step,
        LAG(e.carrier_milestone_step) OVER (
            PARTITION BY a.salesordernumber
            ORDER BY a.audit_timestamp, a.event
        ) AS prev_step
    FROM actual_events a
    LEFT JOIN expected_events e
      ON a.salesordernumber::text = e.salesordernumber::text
     AND a.carriername = e.carriername
     AND a.event = e.event
),

unordered_flag AS (
    SELECT
        salesordernumber,
        MAX(CASE WHEN carrier_milestone_step IS NOT NULL
                  AND prev_step IS NOT NULL
                  AND carrier_milestone_step < prev_step
                 THEN 1 ELSE 0 END) AS unordered_events
    FROM unordered_step
    GROUP BY salesordernumber
),

milestone_flag_check AS (
    WITH expected_groups AS (
        SELECT DISTINCT e.salesordernumber, e.milestone_flag
        FROM expected_events e
        LEFT JOIN carrier_cancelled_flag ccf
          ON ccf.salesordernumber::text = e.salesordernumber::text
        WHERE COALESCE(e.milestone_flag, -1) <> 0
           OR COALESCE(ccf.is_cancelled, 0) = 1
    ),
    actual_groups AS (
        SELECT DISTINCT a.salesordernumber, e.milestone_flag
        FROM actual_events a
        JOIN expected_events e
          ON a.salesordernumber::text = e.salesordernumber::text
         AND a.carriername = e.carriername
         AND a.event = e.event
    )
    SELECT
        eg.salesordernumber,
        CASE WHEN COUNT(*) FILTER (WHERE ag.milestone_flag IS NULL) > 0
             THEN 1 ELSE 0 END AS milestone_flag_missing
    FROM expected_groups eg
    LEFT JOIN actual_groups ag
      ON eg.salesordernumber::text = ag.salesordernumber::text
     AND eg.milestone_flag = ag.milestone_flag
    GROUP BY eg.salesordernumber
),

only_initial_milestone_categories AS (
    SELECT
        x.salesordernumber,
        CASE WHEN COUNT(*) > 0
              AND COUNT(x.milestone_flag) = COUNT(*)
              AND MIN(x.milestone_flag) = 1
              AND MAX(x.milestone_flag) = 1
             THEN 1 ELSE 0 END AS milestone_flag_only_1,
        CASE WHEN COUNT(*) > 0
              AND COUNT(x.carrier_milestone_step) = COUNT(*)
              AND MIN(x.carrier_milestone_step) = 1
              AND MAX(x.carrier_milestone_step) = 1
             THEN 1 ELSE 0 END AS carrier_milestone_step_only_1
    FROM (
        SELECT a.salesordernumber, a.carriername, a.event, a.audit_timestamp,
               e.milestone_flag, e.carrier_milestone_step
        FROM actual_events a
        LEFT JOIN expected_events e
          ON a.salesordernumber::text = e.salesordernumber::text
         AND a.carriername = e.carriername
         AND a.event = e.event
    ) x
    GROUP BY x.salesordernumber
),

delivery_events AS (
    SELECT
        salesordernumber,
        MAX(audit_timestamp) FILTER (WHERE {delivery_bare}) AS last_delivery_ts,
        COUNT(*) FILTER (WHERE {delivery_bare}) AS delivery_event_count
    FROM actual_events
    GROUP BY salesordernumber
),

event_after_delivery AS (
    SELECT
        d.salesordernumber,
        CASE
            WHEN d.delivery_event_count > 1 THEN 1
            WHEN EXISTS (
                SELECT 1 FROM actual_events a
                WHERE a.salesordernumber::text = d.salesordernumber::text
                  AND a.audit_timestamp > d.last_delivery_ts
                  AND NOT ({cancelled_a})
            ) THEN 1
            ELSE 0
        END AS event_after_delivery
    FROM delivery_events d
    WHERE d.last_delivery_ts IS NOT NULL
),

carrier_detail_flags AS (
    SELECT
        ci.salesordernumber,
        COUNT(*) AS carrier_event_count,
        MAX(CASE WHEN NULLIF(TRIM(ci.carriername::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_carriername,
        MAX(CASE WHEN NULLIF(TRIM(ci."event"::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_event,
        MAX(CASE WHEN NULLIF(TRIM(ci.event_description::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_event_description,
        MAX(CASE WHEN ci.eventtimestamp IS NOT NULL THEN 1 ELSE 0 END) AS has_eventtimestamp,
        MAX(CASE WHEN NULLIF(TRIM(ci.planned_pickuptime::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_planned_pickuptime,
        MAX(CASE WHEN NULLIF(TRIM(ci.actual_pickuptime::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_actual_pickuptime,
        MAX(CASE WHEN NULLIF(TRIM(ci.planned_deliverytime::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_planned_deliverytime,
        MAX(CASE WHEN NULLIF(TRIM(ci.actual_deliverytime::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_actual_deliverytime,
        MAX(CASE WHEN NULLIF(BTRIM(ci.flightnumber::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_flightnumber,
        MAX(CASE WHEN NULLIF(TRIM(ci.airway_bill_no::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_airway_bill_no,
        MAX(CASE WHEN NULLIF(TRIM(ci.flight_details::text), '') IS NOT NULL
                  AND LOWER(TRIM(ci.flight_details::text)) <> 'null' THEN 1 ELSE 0 END) AS has_flight_details,
        MAX(CASE WHEN NULLIF(TRIM(ci.departure_airport_iata::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_departure_airport_iata,
        MAX(CASE WHEN NULLIF(TRIM(ci.arrival_airport_iata::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_arrival_airport_iata,
        MAX(CASE WHEN NULLIF(TRIM(ci.departure_time::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_departure_time,
        MAX(CASE WHEN NULLIF(TRIM(ci.arrival_time::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_arrival_time,
        MAX(CASE WHEN NULLIF(TRIM(ci.pickupcompany::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pickupcompany,
        MAX(CASE WHEN NULLIF(TRIM(ci.pickupcity::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pickupcity,
        MAX(CASE WHEN NULLIF(TRIM(ci.pickupstate::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pickupstate,
        MAX(CASE WHEN NULLIF(TRIM(ci.pickupzip::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pickupzip,
        MAX(CASE WHEN NULLIF(TRIM(ci.deliverycompany::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_deliverycompany,
        MAX(CASE WHEN NULLIF(TRIM(ci.deliverycity::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_deliverycity,
        MAX(CASE WHEN NULLIF(TRIM(ci.deliverystate::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_deliverystate,
        MAX(CASE WHEN NULLIF(TRIM(ci.deliveryzip::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_deliveryzip,
        MAX(CASE WHEN NULLIF(TRIM(ci.carrier_trackingid::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_carrier_trackingid,
        MAX(CASE WHEN NULLIF(TRIM(ci.tracking_url::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_tracking_url,
        MAX(CASE WHEN NULLIF(TRIM(ci.pod_name::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pod_name,
        MAX(CASE WHEN NULLIF(TRIM(ci.pod_department::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pod_department,
        MAX(CASE WHEN NULLIF(TRIM(ci.pod_signature::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pod_signature,
        MAX(CASE WHEN NULLIF(TRIM(ci.pod_image::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pod_image,
        MAX(CASE WHEN NULLIF(TRIM(ci.pod_documents::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_pod_documents,
        MAX(CASE WHEN NULLIF(TRIM(ci.delay_reason::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_delay_reason,
        MAX(CASE WHEN NULLIF(TRIM(ci.shipment_type::text), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_shipment_type,
        MAX(CASE WHEN LOWER(COALESCE(ci."event"::text, '')) LIKE '%delay%'
                  OR LOWER(COALESCE(ci.event_description::text, '')) LIKE '%delay%'
                 THEN 1 ELSE 0 END) AS has_delay_event
    FROM etl.carrier_inbound ci
    JOIN latest_orders lo ON lo.salesordernumber::text = ci.salesordernumber::text
    GROUP BY ci.salesordernumber
),

issue_flags AS (
    SELECT
        lo.injectiondate::date AS injection_date,
        lo.salesordernumber,
        lo.ordertype,
        lc.carriername,
        COALESCE(ct.carrier_trackingid, lc.carrier_trackingid) AS carrier_trackingid,
        tt.derived_mode,
        COALESCE(cdf.carrier_event_count, 0) AS carrier_event_count,

        COALESCE(u.unordered_events, 0)::boolean AS unordered_events,
        COALESCE(m.missing_events, 0)::boolean AS missing_events,
        COALESCE(f.milestone_flag_missing, 0)::boolean AS milestone_flag_missing,
        COALESCE(ead.event_after_delivery, 0)::boolean AS event_after_delivery,
        COALESCE(ccf.is_cancelled, 0)::boolean AS is_cancelled,
        COALESCE(o.milestone_flag_only_1, 0)::boolean AS milestone_flag_only_1,
        COALESCE(o.carrier_milestone_step_only_1, 0)::boolean AS carrier_milestone_step_only_1,
        (COALESCE(cdf.carrier_event_count, 0) = 0)::boolean AS missing_all_carrier_events,
        (COALESCE(cdf.has_carriername, 0) = 0)::boolean AS missing_carriername,
        (COALESCE(cdf.has_event, 0) = 0)::boolean AS missing_event,
        (COALESCE(cdf.has_event_description, 0) = 0)::boolean AS missing_event_description,
        (COALESCE(cdf.has_eventtimestamp, 0) = 0)::boolean AS missing_eventtimestamp,
        (COALESCE(cdf.has_planned_pickuptime, 0) = 0)::boolean AS missing_planned_pickuptime,
        (COALESCE(cdf.has_actual_pickuptime, 0) = 0)::boolean AS missing_actual_pickuptime,
        (COALESCE(cdf.has_planned_deliverytime, 0) = 0)::boolean AS missing_planned_deliverytime,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_actual_deliverytime, 0) = 0)::boolean AS missing_actual_deliverytime,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_flightnumber, 0) = 0)::boolean AS missing_flightnumber,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_airway_bill_no, 0) = 0)::boolean AS missing_airway_bill_no,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_departure_airport_iata, 0) = 0)::boolean AS missing_departure_airport_iata,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_arrival_airport_iata, 0) = 0)::boolean AS missing_arrival_airport_iata,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_departure_time, 0) = 0)::boolean AS missing_departure_time,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_arrival_time, 0) = 0)::boolean AS missing_arrival_time,
        (tt.derived_mode = 'Air' AND COALESCE(cdf.has_flight_details, 0) = 0)::boolean AS missing_flight_details,
        (COALESCE(cdf.has_pickupcompany, 0) = 0)::boolean AS missing_pickupcompany,
        (COALESCE(cdf.has_pickupcity, 0) = 0)::boolean AS missing_pickupcity,
        (COALESCE(cdf.has_pickupstate, 0) = 0)::boolean AS missing_pickupstate,
        (COALESCE(cdf.has_pickupzip, 0) = 0)::boolean AS missing_pickupzip,
        (COALESCE(cdf.has_deliverycompany, 0) = 0)::boolean AS missing_deliverycompany,
        (COALESCE(cdf.has_deliverycity, 0) = 0)::boolean AS missing_deliverycity,
        (COALESCE(cdf.has_deliverystate, 0) = 0)::boolean AS missing_deliverystate,
        (COALESCE(cdf.has_deliveryzip, 0) = 0)::boolean AS missing_deliveryzip,
        (COALESCE(cdf.has_carrier_trackingid, 0) = 0)::boolean AS missing_carrier_trackingid,
        (COALESCE(cdf.has_tracking_url, 0) = 0)::boolean AS missing_tracking_url,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_pod_name, 0) = 0)::boolean AS missing_pod_name,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_pod_department, 0) = 0)::boolean AS missing_pod_department,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_pod_signature, 0) = 0)::boolean AS missing_pod_signature,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_pod_image, 0) = 0)::boolean AS missing_pod_image,
        (COALESCE(de.delivery_event_count, 0) > 0
         AND COALESCE(cdf.has_pod_documents, 0) = 0)::boolean AS missing_pod_documents,
        (COALESCE(cdf.has_delay_event, 0) = 1
         AND COALESCE(cdf.has_delay_reason, 0) = 0)::boolean AS missing_delay_reason,
        (COALESCE(cdf.has_shipment_type, 0) = 0)::boolean AS missing_shipment_type,

        -- mode mismatch: marked Road, no flight number, yet the carrier feed
        -- carries air indicators (airport IATA / flight details) → likely flew
        (tt.derived_mode = 'Road'
         AND COALESCE(cdf.has_flightnumber, 0) = 0
         AND EXISTS (
             SELECT 1 FROM etl.carrier_inbound c
             WHERE c.salesordernumber::text = lo.salesordernumber::text
               AND (NULLIF(TRIM(c.departure_airport_iata::text), '') IS NOT NULL
                    OR NULLIF(TRIM(c.arrival_airport_iata::text), '') IS NOT NULL
                    OR (NULLIF(TRIM(c.flight_details::text), '') IS NOT NULL
                        AND LOWER(TRIM(c.flight_details::text)) <> 'null'))
         ))::boolean AS mode_mismatch_air

    FROM latest_orders lo
    LEFT JOIN latest_carrier lc ON lc.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN carrier_tracking ct ON ct.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN transport_type tt ON tt.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN unordered_flag u ON u.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN missing_flag m ON m.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN milestone_flag_check f ON f.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN event_after_delivery ead ON ead.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN carrier_cancelled_flag ccf ON ccf.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN only_initial_milestone_categories o ON o.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN delivery_events de ON de.salesordernumber::text = lo.salesordernumber::text
    LEFT JOIN carrier_detail_flags cdf ON cdf.salesordernumber::text = lo.salesordernumber::text
)

SELECT *,
    (unordered_events OR missing_events OR milestone_flag_missing
     OR event_after_delivery OR is_cancelled OR milestone_flag_only_1
     OR carrier_milestone_step_only_1 OR missing_all_carrier_events
     OR missing_carriername OR missing_event OR missing_event_description
     OR missing_eventtimestamp OR missing_planned_pickuptime
     OR missing_actual_pickuptime OR missing_planned_deliverytime
     OR missing_actual_deliverytime OR missing_flightnumber
     OR missing_airway_bill_no OR missing_departure_airport_iata
     OR missing_arrival_airport_iata OR missing_departure_time
     OR missing_arrival_time OR missing_flight_details
     OR missing_pickupcompany OR missing_pickupcity OR missing_pickupstate
     OR missing_pickupzip OR missing_deliverycompany OR missing_deliverycity
     OR missing_deliverystate OR missing_deliveryzip
     OR missing_carrier_trackingid OR missing_tracking_url
     OR missing_pod_name OR missing_pod_department OR missing_pod_signature
     OR missing_pod_image OR missing_pod_documents OR missing_delay_reason
     OR missing_shipment_type OR mode_mismatch_air) AS has_any_carrier_issue
FROM issue_flags
WHERE (unordered_events OR missing_events OR milestone_flag_missing
     OR event_after_delivery OR is_cancelled OR milestone_flag_only_1
     OR carrier_milestone_step_only_1 OR missing_all_carrier_events
     OR missing_carriername OR missing_event OR missing_event_description
     OR missing_eventtimestamp OR missing_planned_pickuptime
     OR missing_actual_pickuptime OR missing_planned_deliverytime
     OR missing_actual_deliverytime OR missing_flightnumber
     OR missing_airway_bill_no OR missing_departure_airport_iata
     OR missing_arrival_airport_iata OR missing_departure_time
     OR missing_arrival_time OR missing_flight_details
     OR missing_pickupcompany OR missing_pickupcity OR missing_pickupstate
     OR missing_pickupzip OR missing_deliverycompany OR missing_deliverycity
     OR missing_deliverystate OR missing_deliveryzip
     OR missing_carrier_trackingid OR missing_tracking_url
     OR missing_pod_name OR missing_pod_department OR missing_pod_signature
     OR missing_pod_image OR missing_pod_documents OR missing_delay_reason
     OR missing_shipment_type OR mode_mismatch_air)
  -- carrier filter pushed into SQL so the LIMIT can't strip a requested
  -- carrier's rows before the API filters ($3 = uppercased carrier list or NULL)
  AND ($3::text[] IS NULL OR UPPER(TRIM(carriername::text)) = ANY($3))
ORDER BY carriername, salesordernumber
LIMIT {MAX_REPORT_ROWS}
"""


def build_event_detail_sql() -> str:
    """Per-order carrier-event anomalies across the whole injection window —
    a set-based generalization of the ops team's Individual Order Check.
    Returns only non-OK rows (missing / after-delivery / out-of-order /
    invalid-for-mode) so the email can name the specific events. Binds:
    $1 = start date, $2 = end date."""
    cancelled_bare = event_condition_sql("cancelled", "")
    delivery_bare = event_condition_sql("delivery", "")
    return f"""
WITH latest_orders AS (
    SELECT salesordernumber FROM (
        SELECT salesordernumber, injectiondate,
            ROW_NUMBER() OVER (PARTITION BY salesordernumber ORDER BY audit_timestamp DESC) AS rn,
            MAX(CASE WHEN UPPER(TRIM(orderstatus::text)) = 'CANCELLED' THEN 1 ELSE 0 END)
                OVER (PARTITION BY salesordernumber) AS has_cancelled
        FROM etl.rome_inbound_orders
    ) t
    WHERE rn = 1 AND has_cancelled = 0 AND injectiondate::date BETWEEN $1 AND $2
),

batch_latest AS (
    SELECT DISTINCT ON (sales_order_id)
        sales_order_id AS salesordernumber, mode_of_transport
    FROM etl.threeagesttwo_batches_inbound
    WHERE NULLIF(TRIM(mode_of_transport::text), '') IS NOT NULL
    ORDER BY sales_order_id, audit_timestamp DESC
),

actual_carriers AS (
    SELECT DISTINCT c.salesordernumber, TRIM(c.carriername::text) AS carriername
    FROM etl.carrier_inbound c
    JOIN latest_orders lo ON lo.salesordernumber::text = c.salesordernumber::text
    WHERE NULLIF(TRIM(c.carriername::text), '') IS NOT NULL
),

final_transport AS (
    SELECT lo.salesordernumber,
        CASE WHEN EXISTS (SELECT 1 FROM etl.carrier_inbound c
                          WHERE c.salesordernumber::text = lo.salesordernumber::text
                            AND NULLIF(BTRIM(c.flightnumber::text), '') IS NOT NULL) THEN 'Air'
             WHEN UPPER(TRIM(b.mode_of_transport::text)) = 'AIR' THEN 'Air'
             ELSE 'Road' END AS derived_mode
    FROM latest_orders lo
    LEFT JOIN batch_latest b ON b.salesordernumber::text = lo.salesordernumber::text
),

expected_events AS (
    SELECT ac.salesordernumber, TRIM(m.carriername::text) AS carriername,
           TRIM(m."event"::text) AS event, m.ui_milestone,
           NULLIF(TRIM(m.carrier_milestone_step::text), '')::int AS carrier_milestone_step,
           NULLIF(TRIM(m.milestone_flag::text), '')::int AS milestone_flag
    FROM etl.carrier_milestone_air m
    JOIN actual_carriers ac ON TRIM(m.carriername::text) = ac.carriername
    JOIN final_transport ft ON ft.salesordernumber::text = ac.salesordernumber::text AND ft.derived_mode = 'Air'
    WHERE NULLIF(TRIM(m."event"::text), '') IS NOT NULL

    UNION ALL

    SELECT ac.salesordernumber, TRIM(m.carriername::text),
           TRIM(m."event"::text), m.ui_milestone,
           NULLIF(TRIM(m.carrier_milestone_step::text), '')::int,
           NULLIF(TRIM(m.milestone_flag::text), '')::int
    FROM etl.carrier_milestone_road m
    JOIN actual_carriers ac ON TRIM(m.carriername::text) = ac.carriername
    JOIN final_transport ft ON ft.salesordernumber::text = ac.salesordernumber::text AND ft.derived_mode = 'Road'
    WHERE NULLIF(TRIM(m."event"::text), '') IS NOT NULL
),

actual_events AS (
    SELECT c.salesordernumber, TRIM(c.carriername::text) AS carriername,
           TRIM(c."event"::text) AS event, c.audit_timestamp,
           e.ui_milestone, e.carrier_milestone_step
    FROM etl.carrier_inbound c
    JOIN latest_orders lo ON lo.salesordernumber::text = c.salesordernumber::text
    LEFT JOIN expected_events e
      ON e.salesordernumber::text = c.salesordernumber::text
     AND e.carriername = TRIM(c.carriername::text)
     AND e.event = TRIM(c."event"::text)
),

delivery_ts AS (
    SELECT salesordernumber, MIN(audit_timestamp) FILTER (WHERE {delivery_bare}) AS first_delivery_ts
    FROM actual_events GROUP BY salesordernumber
),

ordered AS (
    SELECT ae.*, dt.first_delivery_ts,
           LAG(ae.carrier_milestone_step) OVER (
               PARTITION BY ae.salesordernumber ORDER BY ae.audit_timestamp) AS prev_step
    FROM actual_events ae
    LEFT JOIN delivery_ts dt ON dt.salesordernumber::text = ae.salesordernumber::text
),

missing AS (
    SELECT e.salesordernumber, e.carriername, e.event, e.ui_milestone
    FROM expected_events e
    LEFT JOIN actual_events a
      ON a.salesordernumber::text = e.salesordernumber::text
     AND a.carriername = e.carriername
     AND a.event = e.event
    -- flag 0 = cancellation pseudo-events; never "missing" from the happy path
    WHERE a.event IS NULL AND COALESCE(e.milestone_flag, -1) <> 0
)

SELECT salesordernumber, carriername, event, ui_milestone,
       audit_timestamp,
       CASE
           WHEN carrier_milestone_step IS NULL THEN 'INVALID_EVENT_FOR_MODE'
           WHEN first_delivery_ts IS NOT NULL AND audit_timestamp > first_delivery_ts
                AND NOT ({cancelled_bare}) THEN 'AFTER_DELIVERY'
           WHEN prev_step IS NOT NULL AND carrier_milestone_step < prev_step THEN 'OUT_OF_ORDER'
           ELSE 'OK'
       END AS event_status
FROM ordered
WHERE carrier_milestone_step IS NULL
   OR (first_delivery_ts IS NOT NULL AND audit_timestamp > first_delivery_ts AND NOT ({cancelled_bare}))
   OR (prev_step IS NOT NULL AND carrier_milestone_step < prev_step)

UNION ALL

SELECT salesordernumber, carriername, event, ui_milestone,
       NULL::timestamptz AS audit_timestamp, 'MISSING_EVENT' AS event_status
FROM missing
LIMIT 20000
"""
