-- Mock etl schema for local development / testing WITHOUT touching real RDS.
-- Types are deliberately loose (text) to mirror the defensive casts in the app.
CREATE SCHEMA IF NOT EXISTS etl;

CREATE TABLE etl.shipment (
  trackingnumber text, salesordernumber text, product text, destinationname text,
  destinationaddress text, destinationcountry text, injectiondate text, injectiontime text,
  ordertype text, dosestatus text, origin text, originaddress text, batchnumber text,
  planneddeliverydate text, planneddeliverytime text, carrier text, modeoftransportation text,
  region text, vialid text, scheduledeparted text, actualdeparted text, vialexpirationtime text,
  etadeliverytime text, destinationlatitude text, destinationlongitude text,
  currentmilestonestep text, currentmilestone text, route text, routestatus text, lastgps text,
  currentlatitude text, currentlongitude text, risk text, delta text, distance text,
  countofalerts text, alertstitle text, alerttype text, countofnotes text, rain text, pin text,
  lastupdateddt timestamptz, transportmode_flight text, milestone_carrier text,
  deliveryaddressid text, multileg_zipcode text, podname text, rome_zipcode text,
  carrier_zipcode text, currentleg text, totallegs text, originlatitude text, originlongitude text,
  eta_updated text, destinationcity text, planneddeliverytime_local text, etadeliverytime_local text,
  rome_status text, "3agest2_status" text, carrier_status text, distance_intransit text,
  injectiondate_local text, actualdeparted_local text, destination_timezone text, flightnumber text,
  geofence_delivery_status text, pod_receival_time text, ax_customer_number text,
  geofence_status text, failed_logistics text, riskbucket text, risk_reason text, rsstarttime text,
  dist_threshold text, delayreason text, zip_flag text, production_site text, region_code text,
  modeoftransportation_3a2 text, destinationcountry_fullname text, currentlocation text,
  carriertrackingnumber text, actualdeliverytime text, account text, destination_open_time text,
  cutoff_time text, shipmenttype text, flight_inputtype text, origin_timezone text,
  dest_timezone text, rsarrived text, salesordernumber_3a2 text, d2a_status text, ds_eta_updated text
);

CREATE TABLE etl.rome_inbound_orders (
  salesordernumber text, orderid text, orderstatus text, orderstatuscategory text,
  ordertype text, cancellationdate text, deliverydate text, injectiondate text,
  latesterpstatus text, audit_timestamp timestamptz, id bigint,
  deliveryaddressstreet text, deliveryaddresscity text, deliveryaddresszipcode text,
  deliveryaddressstate text, deliveryaddresscountry text
);
CREATE TABLE etl.rome_inbound_rejects (
  salesordernumber text, orderid text, orderstatus text, orderstatuscategory text,
  ordertype text, cancellationdate text, deliverydate text, injectiondate text,
  latesterpstatus text, audit_timestamp timestamptz, id bigint, error_message text,
  deliveryaddressstreet text, deliveryaddresscity text, deliveryaddresszipcode text,
  deliveryaddressstate text, deliveryaddresscountry text
);

CREATE TABLE etl.carrier_inbound (
  salesordernumber text, carriername text, "event" text, event_description text,
  eventtimestamp timestamptz, planned_pickuptime text, actual_pickuptime text,
  planned_deliverytime text, actual_deliverytime text, flightnumber text, airway_bill_no text,
  carrier_trackingid text, pod_signature text, pod_name text, id bigint,
  audit_timestamp timestamptz, tracking_url text, departure_airport_iata text,
  arrival_airport_iata text, departure_time text, arrival_time text, flight_details text,
  delay_reason text, charter_flag text, shipment_type text,
  pickupcompany text, pickupcity text, pickupstate text, pickupzip text,
  deliverycompany text, deliverycity text, deliverystate text, deliveryzip text,
  pod_department text, pod_image text, pod_documents text
);
CREATE TABLE etl.carrier_inbound_rejects (
  salesordernumber text, carriername text, "event" text, event_description text,
  eventtimestamp timestamptz, id bigint, error_message text, audit_timestamp timestamptz
);

CREATE TABLE etl.sensitech_inbound_trip (
  salesordernumber text, destinationid text, tripid text, ordernumber text,
  internaltripid text, deviceserialnumber text, trailerid text,
  latitude numeric, longitude numeric, current_address text,
  device_date_time timestamptz, device_ping_date_time timestamptz,
  audit_timestamp timestamptz, id bigint, trip_guid text, org_unit text
);
CREATE TABLE etl.sensitech_inbound_rejects (
  salesordernumber text, destinationid text, tripid text, ordernumber text,
  internaltripid text, deviceserialnumber text, trailerid text,
  latitude text, longitude text, current_address text,
  device_date_time text, device_ping_date_time text,
  audit_timestamp timestamptz, error_message text, id bigint, trip_guid text, org_unit text
);

CREATE TABLE etl.threeagesttwo_sales_inbound (
  so_id text, sales_order_id text, production_sites text, products_code text,
  customers_account text, order_status text, audit_timestamp timestamptz
);
CREATE TABLE etl.threeagesttwo_sales_inbound_fullload (
  so_id text, sales_order_id text, production_sites text, products_code text,
  customers_account text, order_status text, s3_key text,
  load_timestamp timestamptz, audit_timestamp timestamptz
);
CREATE TABLE etl.threeagesttwo_batches_inbound (
  id bigint, batch_no text, sales_order_id text, batch_status text,
  mode_of_transport text, updatedt timestamptz, audit_timestamp timestamptz
);
CREATE TABLE etl.threeagesttwo_batches_inbound_fullload (
  id bigint, batch_no text, sales_order_id text, batch_status text,
  load_timestamp timestamptz, audit_timestamp timestamptz
);

CREATE TABLE etl.order_milestone_history (
  salesordernumber text, trackingnumber text, carriername text, carriertrackingnumber text,
  flightnumber text, origin text, destination text, "event" text, event_description text,
  currentstep text, milestone text, milestone_flag text,
  departureairport_iata text, arrivalairport_iata text,
  event_timestamp timestamptz, audittimestamp timestamptz, event_timestamp_local text,
  currentleg text, totallegs text, multileg text, milestonetype text
);

CREATE TABLE etl.carrier_milestone_air (
  carriername text, "event" text, ui_milestone text, milestone_flag int, carrier_milestone_step int
);
CREATE TABLE etl.carrier_milestone_road (
  carriername text, "event" text, ui_milestone text, milestone_flag int, carrier_milestone_step int
);

-- ---- milestone maps (subset: MNX + MDS) -----------------------------------
INSERT INTO etl.carrier_milestone_air VALUES
 ('MNX','CONFIRMED','Carrier Confirmed',1,1), ('MNX','QDTORIG','Carrier Confirmed',1,2),
 ('MNX','QDTCHANGE','Carrier Confirmed',1,3), ('MNX','DISPATCHED','Driver Dispatched',1,4),
 ('MNX','PICKUP','Pickup',1,5), ('MNX','DEPTOAP','Departed',2,6),
 ('MNX','DROP','Arrival at Airport',2,7), ('MNX','ONBOARD','Arrival at Airport',2,8),
 ('MNX','DEPARTED','Flight Departure',3,9), ('MNX','ARRIVED','Flight Arrival',4,10),
 ('MNX','RECOVERED','Flight Arrival',4,11), ('MNX','OFD','On the Road',4,12),
 ('MNX','DELIVERED','Delivery Confirmation',5,13), ('MNX','CANCELLED','Cancelled',0,NULL);
INSERT INTO etl.carrier_milestone_road VALUES
 ('MNX','CONFIRMED','Carrier Confirmed',1,1), ('MNX','DISPATCHED','Driver Dispatched',1,4),
 ('MNX','PICKUP','Pickup',1,5), ('MNX','DEPTOAP','Departed',2,6),
 ('MNX','OFD','Departed',2,7), ('MNX','DELIVERED','Delivery Confirmation',3,8),
 ('MDS','NEW','Carrier Confirmed',1,1), ('MDS','DISPATCHED','Driver Dispatched',1,2),
 ('MDS','PICKEDUP','Pickup',2,3), ('MDS','DELIVERED','Delivery Confirmation',3,4);

-- ---- shipments --------------------------------------------------------------
-- SO1001: healthy, delivered
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, ordertype, dosestatus, origin, batchnumber, planneddeliverydate, carrier,
  modeoftransportation, region, currentmilestone, currentmilestonestep, routestatus,
  destinationlatitude, destinationlongitude, lastgps, risk, countofalerts, lastupdateddt,
  rome_status, "3agest2_status", carrier_status, flightnumber, actualdeparted, actualdeliverytime,
  podname, route, etadeliverytime, carriertrackingnumber)
VALUES ('ST-1001','SO1001','Pluvicto','Mount Sinai NY','US',
  to_char(now() - interval '1 day','YYYY-MM-DD'),'Commercial','Delivered','Ivrea IT','B-101',
  to_char(now() - interval '1 day','YYYY-MM-DD'),'MNX','Air','NAM','Delivery Confirmation','5','Completed',
  '40.7128','-74.0060', to_char(now() - interval '20 hours','YYYY-MM-DD HH24:MI:SS'),'Low','0', now() - interval '20 hours',
  'OK','OK','OK','LH400', to_char(now() - interval '2 days','YYYY-MM-DD HH24:MI:SS'),
  to_char(now() - interval '22 hours','YYYY-MM-DD HH24:MI:SS'),'J. Smith','IVR->JFK->NYC',
  to_char(now() - interval '23 hours','YYYY-MM-DD HH24:MI:SS'),'MX998877');

-- SO1002: ACTIVE, missing batch (exists upstream), missing carrier tracking
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, ordertype, origin, batchnumber, planneddeliverydate, carrier, modeoftransportation,
  region, currentmilestone, currentmilestonestep, destinationlatitude, destinationlongitude,
  lastgps, risk, countofalerts, alertstitle, lastupdateddt, rome_status, "3agest2_status",
  carrier_status, route, salesordernumber_3a2)
VALUES ('ST-1002','SO1002','Lutathera','Charité Berlin','DE',
  to_char(now() + interval '2 days','YYYY-MM-DD'),'Commercial','Zaragoza ES','',
  to_char(now() + interval '1 day','YYYY-MM-DD'),'MNX','Air','EU','Carrier Confirmed','1',
  '52.5200','13.4050', to_char(now() - interval '1 hour','YYYY-MM-DD HH24:MI:SS'),'Low','1',
  'Missing Documents Alert', now() - interval '1 hour','OK','OK','OK','ZAZ->BER','SO1002');

-- SO1003: ACTIVE + STALE injection + ghost pings + inferred flight, air, no flightnumber
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, ordertype, origin, batchnumber, planneddeliverydate, carrier, modeoftransportation,
  region, currentmilestone, currentmilestonestep, destinationlatitude, destinationlongitude,
  lastgps, risk, riskbucket, countofalerts, alertstitle, lastupdateddt, rome_status, "3agest2_status",
  carrier_status, actualdeparted, route, dist_threshold)
VALUES ('ST-1003','SO1003','Pluvicto','UCLH London','GB',
  to_char(now() - interval '3 days','YYYY-MM-DD'),'Commercial','Millburn NJ','B-303',
  to_char(now() - interval '2 days','YYYY-MM-DD'),'MNX','Air','EU','On the Road','4',
  '51.5246','-0.1340', to_char(now() - interval '30 hours','YYYY-MM-DD HH24:MI:SS'),'High','High','2',
  'GPS Signal Lost Alert, Potential Injection Miss Alert', now() - interval '26 hours','OK','OK','OK',
  to_char(now() - interval '3 days','YYYY-MM-DD HH24:MI:SS'),'JFK->LHR','');

-- SO1004: ACTIVE-looking but cancelled in ROME
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, origin, batchnumber, planneddeliverydate, carrier, modeoftransportation, region,
  currentmilestone, currentmilestonestep, lastupdateddt, rome_status, "3agest2_status", carrier_status)
VALUES ('ST-1004','SO1004','Lutathera','Gustave Roussy','FR',
  to_char(now() - interval '5 days','YYYY-MM-DD'),'Ivrea IT','B-404',
  to_char(now() - interval '4 days','YYYY-MM-DD'),'MDS','Road','EU','Pickup','1',
  now() - interval '4 days','OK','OK','OK');

-- SO1005: ACTIVE, missing carrier (rejected upstream), stale injection, no pings
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, origin, batchnumber, planneddeliverydate, carrier, region,
  currentmilestone, currentmilestonestep, lastupdateddt, rome_status, "3agest2_status", carrier_status)
VALUES ('ST-1005','SO1005','Pluvicto','MD Anderson','US',
  to_char(now() - interval '2 days','YYYY-MM-DD'),'Millburn NJ','B-505',
  to_char(now() - interval '1 day','YYYY-MM-DD'),'','NAM','Order Confirmed','1',
  now() - interval '30 hours','OK','OK','');

-- SO1006: ACTIVE but carrier already delivered (status never closed)
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, origin, batchnumber, planneddeliverydate, carrier, modeoftransportation, region,
  currentmilestone, currentmilestonestep, destinationlatitude, destinationlongitude, lastgps,
  lastupdateddt, rome_status, "3agest2_status", carrier_status)
VALUES ('ST-1006','SO1006','Lutathera','Peter Mac Melbourne','AU',
  to_char(now() - interval '2 days','YYYY-MM-DD'),'Zaragoza ES','B-606',
  to_char(now() - interval '2 days','YYYY-MM-DD'),'MNX','Air','APAC','On the Road','4',
  '-37.8136','144.9631', to_char(now() - interval '40 hours','YYYY-MM-DD HH24:MI:SS'),
  now() - interval '40 hours','OK','OK','OK');

-- SO1007: healthy ROAD shipment (MDS), correct sequence
INSERT INTO etl.shipment (trackingnumber, salesordernumber, product, destinationname, destinationcountry,
  injectiondate, origin, batchnumber, planneddeliverydate, carrier, modeoftransportation, region,
  currentmilestone, currentmilestonestep, lastupdateddt, rome_status, "3agest2_status", carrier_status,
  lastgps)
VALUES ('ST-1007','SO1007','Pluvicto','Hopkins Baltimore','US',
  to_char(now() + interval '1 day','YYYY-MM-DD'),'Millburn NJ','B-707',
  to_char(now(),'YYYY-MM-DD'),'MDS','Road','NAM','Pickup','2', now() - interval '2 hours',
  'OK','OK','OK', to_char(now() - interval '1 hour','YYYY-MM-DD HH24:MI:SS'));

-- ---- ROME ---------------------------------------------------------------------
INSERT INTO etl.rome_inbound_orders VALUES
 ('SO1001','ORD-1','Delivered','Closed','Commercial',NULL,
  to_char(now() - interval '1 day','YYYY-MM-DD'), to_char(now() - interval '1 day','YYYY-MM-DD'),
  'INVOICED', now() - interval '1 day', 1),
 ('SO1003','ORD-3','In Transit','Open','Commercial',NULL,
  to_char(now() - interval '2 days','YYYY-MM-DD'), to_char(now() - interval '3 days','YYYY-MM-DD'),
  'SHIPPED', now() - interval '2 days', 3),
 ('SO1004','ORD-4','Cancelled','Cancelled','Commercial',
  to_char(now() - interval '5 days','YYYY-MM-DD'), NULL, to_char(now() - interval '5 days','YYYY-MM-DD'),
  'CANCELLED', now() - interval '5 days', 4),
 ('SO1006','ORD-6','In Transit','Open','Commercial',NULL,
  to_char(now() - interval '2 days','YYYY-MM-DD'), to_char(now() - interval '2 days','YYYY-MM-DD'),
  'SHIPPED', now() - interval '2 days', 6);
INSERT INTO etl.rome_inbound_orders (salesordernumber, orderid, orderstatus, orderstatuscategory,
  injectiondate, audit_timestamp, id)
VALUES
 ('SO1002','ORD-2','Confirmed','Open', to_char(now() + interval '2 days','YYYY-MM-DD'), now() - interval '1 day', 2),
 ('SO1007','ORD-7','Confirmed','Open', to_char(now() + interval '1 day','YYYY-MM-DD'), now() - interval '5 hours', 7),
 ('SO1003B','ORD-3B','In Transit','Open', to_char(now() - interval '3 days','YYYY-MM-DD'), now() - interval '2 days', 33);
INSERT INTO etl.rome_inbound_rejects VALUES
 ('SO9001','ORD-9001','New','Open','Commercial',NULL,NULL,NULL,'NEW',
  now() - interval '2 hours', 901, 'deliveryaddressid not found in address master'),
 ('SO9002','ORD-9002','New','Open','PAP',NULL,NULL,NULL,'NEW',
  now() - interval '26 hours', 902, 'invalid ordertype/subordertype combination');

-- ---- carrier events -------------------------------------------------------------
-- SO1001: clean full AIR sequence
INSERT INTO etl.carrier_inbound (salesordernumber, carriername, "event", eventtimestamp, audit_timestamp,
  flightnumber, departure_airport_iata, arrival_airport_iata, actual_deliverytime, pod_name, id)
VALUES
 ('SO1001','MNX','CONFIRMED', now() - interval '3 days',            now() - interval '3 days', NULL,NULL,NULL,NULL,NULL, 11),
 ('SO1001','MNX','PICKUP',    now() - interval '2 days 20 hours',   now() - interval '2 days 20 hours', NULL,NULL,NULL,NULL,NULL, 12),
 ('SO1001','MNX','DEPARTED',  now() - interval '2 days 12 hours',   now() - interval '2 days 12 hours','LH400','MXP','JFK',NULL,NULL, 13),
 ('SO1001','MNX','ARRIVED',   now() - interval '2 days 4 hours',    now() - interval '2 days 4 hours','LH400','MXP','JFK',NULL,NULL, 14),
 ('SO1001','MNX','DELIVERED', now() - interval '22 hours',          now() - interval '21 hours', NULL,NULL,NULL,
   to_char(now() - interval '22 hours','YYYY-MM-DD HH24:MI:SS'),'J. Smith', 15);

-- SO1003: invalid event + out-of-order + audit out-of-order
INSERT INTO etl.carrier_inbound (salesordernumber, carriername, "event", eventtimestamp, audit_timestamp, id)
VALUES
 ('SO1003','MNX','CONFIRMED', now() - interval '3 days 10 hours', now() - interval '3 days 10 hours', 31),
 ('SO1003','MNX','PICKUP',    now() - interval '3 days 8 hours',  now() - interval '3 days 8 hours', 32),
 ('SO1003','MNX','DEPARTED',  now() - interval '3 days 6 hours',  now() - interval '2 days 20 hours', 33),
 ('SO1003','MNX','ARRIVED',   now() - interval '2 days 22 hours', now() - interval '2 days 23 hours', 34),
 ('SO1003','MNX','FOOBAR',    now() - interval '2 days 21 hours', now() - interval '2 days 21 hours', 35),
 ('SO1003','MNX','DISPATCHED',now() - interval '2 days 20 hours', now() - interval '2 days 19 hours', 36);

-- SO1006: delivered by carrier, shipment never closed
INSERT INTO etl.carrier_inbound (salesordernumber, carriername, "event", eventtimestamp, audit_timestamp,
  actual_deliverytime, pod_name, id)
VALUES
 ('SO1006','MNX','CONFIRMED', now() - interval '3 days', now() - interval '3 days', NULL,NULL, 61),
 ('SO1006','MNX','PICKUP',    now() - interval '2 days 18 hours', now() - interval '2 days 18 hours', NULL,NULL, 62),
 ('SO1006','MNX','DELIVERED', now() - interval '40 hours', now() - interval '39 hours',
   to_char(now() - interval '40 hours','YYYY-MM-DD HH24:MI:SS'),'R. Chen', 63);

-- SO1007: clean ROAD sequence (MDS)
INSERT INTO etl.carrier_inbound (salesordernumber, carriername, "event", eventtimestamp, audit_timestamp, id)
VALUES
 ('SO1007','MDS','NEW',        now() - interval '10 hours', now() - interval '10 hours', 71),
 ('SO1007','MDS','DISPATCHED', now() - interval '6 hours',  now() - interval '6 hours', 72),
 ('SO1007','MDS','PICKEDUP',   now() - interval '2 hours',  now() - interval '2 hours', 73);

INSERT INTO etl.carrier_inbound_rejects VALUES
 ('SO1005','MNX','CONFIRMED','Order confirmed', now() - interval '28 hours', 501,
  'salesordernumber not found in shipment master', now() - interval '28 hours'),
 ('SO9003','ASC','CREATED','', now() - interval '3 hours', 502,
  'duplicate event id', now() - interval '3 hours');

-- ---- sensitech pings --------------------------------------------------------------
-- SO1003: JFK area -> ghost teleport -> flight gap -> LHR area  (last ping 30h ago)
INSERT INTO etl.sensitech_inbound_trip (salesordernumber, tripid, deviceserialnumber,
  latitude, longitude, current_address, device_date_time, audit_timestamp, id)
VALUES
 ('SO1003','TRIP-1003','SNS-778', 40.6413, -73.7781, 'JFK Cargo Area, Queens NY', now() - interval '40 hours', now() - interval '40 hours', 1),
 ('SO1003','TRIP-1003','SNS-778', 40.6500, -73.7800, 'Jamaica, Queens NY',        now() - interval '39 hours 30 minutes', now() - interval '39 hours', 2),
 ('SO1003','TRIP-1003','SNS-778', 45.0000,-100.0000, NULL,                        now() - interval '39 hours 28 minutes', now() - interval '39 hours', 3),
 ('SO1003','TRIP-1003','SNS-778', 40.6600, -73.7900, 'JFK Airport, Queens NY',    now() - interval '39 hours', now() - interval '38 hours', 4),
 ('SO1003','TRIP-1003','SNS-778', 51.4700,  -0.4543, 'Heathrow, London',          now() - interval '31 hours', now() - interval '30 hours', 5),
 ('SO1003','TRIP-1003','SNS-778', 51.5000,  -0.4200, 'Hayes, London',             now() - interval '30 hours', now() - interval '30 hours', 6),
 ('SO1003','TRIP-1003','SNS-778',  0.0000,   0.0000, NULL,                        now() - interval '30 hours', now() - interval '29 hours', 7);

-- SO1001: a couple of clean pings (delivered)
INSERT INTO etl.sensitech_inbound_trip (salesordernumber, tripid, deviceserialnumber,
  latitude, longitude, current_address, device_date_time, audit_timestamp, id)
VALUES
 ('SO1001','TRIP-1001','SNS-100', 40.7000, -74.0100, 'Newark NJ', now() - interval '23 hours', now() - interval '23 hours', 8),
 ('SO1001','TRIP-1001','SNS-100', 40.7128, -74.0060, 'New York NY', now() - interval '22 hours', now() - interval '22 hours', 9);

INSERT INTO etl.sensitech_inbound_rejects (salesordernumber, tripid, deviceserialnumber,
  latitude, longitude, device_date_time, audit_timestamp, error_message, id)
VALUES
 ('SO1005','TRIP-1005','SNS-505','','', NULL, now() - interval '20 hours',
  'device_date_time is null', 51);

-- ---- 3A GEST2 -------------------------------------------------------------------
INSERT INTO etl.threeagesttwo_sales_inbound VALUES
 ('1','SO1002','ZAZ','PLV','ACC-9','Confirmed', now() - interval '2 days');
INSERT INTO etl.threeagesttwo_batches_inbound
  (id, batch_no, sales_order_id, batch_status, mode_of_transport, updatedt, audit_timestamp)
VALUES
 (1,  'B-777','SO1002','Released', NULL,   now() - interval '1 day',  now() - interval '1 day'),
 (101,'B-101','SO1001','Released', 'AIR',  now() - interval '2 days', now() - interval '2 days'),
 (103,'B-303','SO1003','Released', 'AIR',  now() - interval '3 days', now() - interval '3 days'),
 (106,'B-606','SO1006','Released', 'AIR',  now() - interval '2 days', now() - interval '2 days'),
 (107,'B-707','SO1007','Released', 'ROAD', now() - interval '1 day',  now() - interval '1 day');
INSERT INTO etl.threeagesttwo_batches_inbound_fullload VALUES
 (1,'B-777','SO1002','Released', now() - interval '6 hours', now() - interval '6 hours'),
 (2,'B-999','SO1008','Released', now() - interval '6 hours', now() - interval '6 hours');

INSERT INTO etl.threeagesttwo_sales_inbound_fullload VALUES
 ('1','SO1002','ZAZ','PLV','ACC-9','Confirmed','s3://mock/sales_1.csv', now() - interval '40 hours', now() - interval '40 hours'),
 ('2','SO1003','MIL','PLV','ACC-3','Confirmed','s3://mock/sales_1.csv', now() - interval '40 hours', now() - interval '40 hours');

-- daily history so the feed-health volume baseline has something to chew on
INSERT INTO etl.carrier_inbound (salesordernumber, carriername, "event", eventtimestamp, audit_timestamp, id)
SELECT 'SO-HIST-'||d, 'MNX', 'CONFIRMED', now() - (d || ' days')::interval, now() - (d || ' days')::interval, 900+d
FROM generate_series(2, 13) AS d;
INSERT INTO etl.rome_inbound_orders (salesordernumber, orderid, orderstatus, audit_timestamp, id)
SELECT 'SO-HIST-'||d, 'ORD-H'||d, 'New', now() - (d || ' days')::interval, 900+d
FROM generate_series(2, 13) AS d;

-- ---- processed milestone history (SO1001 only, for the detail drawer) -------------
INSERT INTO etl.order_milestone_history (salesordernumber, trackingnumber, carriername, "event",
  milestone, milestone_flag, currentstep, event_timestamp, audittimestamp, flightnumber,
  departureairport_iata, arrivalairport_iata, currentleg, totallegs, multileg, milestonetype)
VALUES
 ('SO1001','ST-1001','MNX','CONFIRMED','Carrier Confirmed','1','1', now() - interval '3 days', now() - interval '3 days', NULL,NULL,NULL,'1','1','N','carrier'),
 ('SO1001','ST-1001','MNX','DELIVERED','Delivery Confirmation','5','13', now() - interval '22 hours', now() - interval '21 hours', NULL,NULL,NULL,'1','1','N','carrier');
