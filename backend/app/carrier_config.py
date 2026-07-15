"""Per-carrier delivery / cancellation event vocabulary and the carrier-issue
catalog. Mirrors the ops team's report config (prod_ops_report_night) — edit
here when a carrier changes its event names."""

CARRIER_EVENTS: dict[str, dict[str, list[str]]] = {
    "MNX":       {"delivery": ["DELIVERED"], "cancelled": ["CANCELLED"]},
    "ASC":       {"delivery": ["COMPLETED_DELIVERY"], "cancelled": ["CANCELED"]},
    "AIRSPACE":  {"delivery": ["delivered,delivery_drive"],
                  "cancelled": ["admin_canceled,pre_transit",
                                "admin_canceled,pickup_drive",
                                "admin_canceled,delivery_drive"]},
    "SINOTRANS": {"delivery": ["Actual Delivery Time"], "cancelled": ["Canceled"]},
    "PHSE":      {"delivery": ["99-206"], "cancelled": ["99-914"]},
    "NURA":      {"delivery": ["4"], "cancelled": ["7"]},
    "CRISAGO":   {"delivery": ["Shipment Delivered"], "cancelled": ["CANCELLED"]},
    "MDS":       {"delivery": ["DELIVERED"], "cancelled": ["CANCELLED"]},
    "ONBC":      {"delivery": ["Shipment Delivered"], "cancelled": ["CANCELLED"]},
    "BONDEX":    {"delivery": ["ORDER_Completed"], "cancelled": ["CANCELLED"]},
    "DHL":       {"delivery": ["POD"], "cancelled": ["CANCELLED"]},
}


def event_condition_sql(kind: str, prefix: str) -> str:
    """OR-fragment matching (carrier, event) pairs for `kind` in
    ('delivery'|'cancelled'). `prefix` qualifies the column source, e.g. 'a.'.
    Values are inlined literals from this static config — never user input."""
    parts = []
    for carrier, events in CARRIER_EVENTS.items():
        for ev in events.get(kind, []):
            ev_sql = ev.replace("'", "''")
            parts.append(
                f"(UPPER(TRIM({prefix}carriername::text)) = '{carrier}' "
                f"AND TRIM({prefix}\"event\"::text) = '{ev_sql}')"
            )
    return "(" + " OR ".join(parts) + ")" if parts else "FALSE"


# code -> (friendly name, observation text used in reports & carrier emails)
ISSUE_CATALOG: dict[str, tuple[str, str]] = {
    "unordered_events": ("Unordered Events",
        "One or more carrier events are not in the expected milestone sequence."),
    "missing_events": ("Missing Events",
        "One or more expected carrier events are missing for this order. Please note that "
        "the missing events vary by order; not every order is missing all the events shown."),
    "milestone_flag_missing": ("Milestone Flag Missing",
        "The Milestone Flag field is missing from one or more carrier events."),
    "event_after_delivery": ("Event After Delivery",
        "One or more carrier events have a timestamp after the Delivery event."),
    "is_cancelled": ("Cancelled Order", "This order is marked as cancelled."),
    "milestone_flag_only_1": ("Milestone Flag Only 1",
        "Only one Milestone Flag value is being sent for this order."),
    "carrier_milestone_step_only_1": ("Carrier Milestone Step Only 1",
        "Only one Carrier Milestone Step value is being sent for this order."),
    "missing_all_carrier_events": ("Missing All Carrier Events",
        "No carrier events are available for this order."),
    "missing_carriername": ("Missing Carrier Name", "The Carrier Name field is missing."),
    "missing_event": ("Missing Event", "The Carrier Event field is missing."),
    "missing_event_description": ("Missing Event Description",
        "The Carrier Event Description field is missing."),
    "missing_eventtimestamp": ("Missing Event Timestamp",
        "The Carrier Event Timestamp field is missing."),
    "missing_planned_pickuptime": ("Missing Planned Pickup Time",
        "The Planned Pickup Time field is missing from the Pickup event."),
    "missing_actual_pickuptime": ("Missing Actual Pickup Time",
        "The Actual Pickup Time field is missing from the Pickup event."),
    "missing_planned_deliverytime": ("Missing Planned Delivery Time",
        "The Planned Delivery Time field is missing from the Delivery event."),
    "missing_actual_deliverytime": ("Missing Actual Delivery Time",
        "The Actual Delivery Time field is missing from the Delivery event."),
    "missing_flightnumber": ("Missing Flight Number",
        "The Flight Number field is missing from the flight details."),
    "missing_airway_bill_no": ("Missing Airway Bill Number",
        "The Airway Bill Number field is missing from the flight details."),
    "missing_departure_airport_iata": ("Missing Departure Airport IATA",
        "The Departure Airport IATA Code field is missing from the flight details."),
    "missing_arrival_airport_iata": ("Missing Arrival Airport IATA",
        "The Arrival Airport IATA Code field is missing from the flight details."),
    "missing_departure_time": ("Missing Departure Time",
        "The Departure Time field is missing from the flight details."),
    "missing_arrival_time": ("Missing Arrival Time",
        "The Arrival Time field is missing from the flight details."),
    "missing_flight_details": ("Missing Flight Details",
        "The flight details are missing for this order."),
    "missing_pickupcompany": ("Missing Pickup Company",
        "The Pickup Company field is missing from the pickup location details."),
    "missing_pickupcity": ("Missing Pickup City",
        "The Pickup City field is missing from the pickup location details."),
    "missing_pickupstate": ("Missing Pickup State",
        "The Pickup State field is missing from the pickup location details."),
    "missing_pickupzip": ("Missing Pickup ZIP",
        "The Pickup ZIP Code field is missing from the pickup location details."),
    "missing_deliverycompany": ("Missing Delivery Company",
        "The Delivery Company field is missing from the delivery location details."),
    "missing_deliverycity": ("Missing Delivery City",
        "The Delivery City field is missing from the delivery location details."),
    "missing_deliverystate": ("Missing Delivery State",
        "The Delivery State field is missing from the delivery location details."),
    "missing_deliveryzip": ("Missing Delivery ZIP",
        "The Delivery ZIP Code field is missing from the delivery location details."),
    "missing_carrier_trackingid": ("Missing Carrier Tracking ID",
        "The Carrier Tracking ID field is missing."),
    "missing_tracking_url": ("Missing Tracking URL", "The Tracking URL field is missing."),
    "missing_pod_name": ("Missing POD Name",
        "The Proof of Delivery Name field is missing from the Delivery event."),
    "missing_pod_department": ("Missing POD Department",
        "The Proof of Delivery Department field is missing from the Delivery event."),
    "missing_pod_signature": ("Missing POD Signature",
        "The Proof of Delivery Signature field is missing from the Delivery event."),
    "missing_pod_image": ("Missing POD Image",
        "The Proof of Delivery Image field is missing from the Delivery event."),
    "missing_pod_documents": ("Missing POD Documents",
        "The Proof of Delivery Documents field is missing from the Delivery event."),
    "missing_delay_reason": ("Missing Delay Reason",
        "The Delay Reason field is missing for the delayed event."),
    "missing_shipment_type": ("Missing Shipment Type",
        "The Shipment Type field is missing for this order."),
    "mode_mismatch_air": ("Transport mode mismatch (looks like Air, marked Road)",
        "This order is recorded as Road and has no flight number, yet the carrier "
        "events include air indicators (airport IATA codes / flight details) — it "
        "likely travelled by air and was mislabelled. Please confirm the mode of "
        "transport and provide the flight number and flight details."),
}
