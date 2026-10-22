import json
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from math import isfinite


BASE_URL = os.environ.get(
    "MATTE_BASE_URL", "https://frontend2.torget.bjarby.com"
).rstrip("/")
CONTROLLER = f"{BASE_URL}/t/babtist/api"
PRESENTATION = f"{BASE_URL}/colony/peter"


def request(path, method="GET", body=None, timeout=15):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"User-Agent": "matte-acceptance/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        path, data=data, headers=headers, method=method
    )
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read().decode("utf-8", "replace")
    with response:
        content_type = response.headers.get("Content-Type", "")
        payload = response.read().decode("utf-8", "replace")
        if "application/json" in content_type:
            payload = json.loads(payload)
        return response.status, payload


def read_sse_event(response):
    event = None
    data = []
    while True:
        line = response.readline().decode("utf-8").rstrip("\r\n")
        if not line:
            if event or data:
                return event, json.loads("\n".join(data))
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())


def skip_if_not_deployed(test_case, code, payload, plugin):
    if code != 404:
        return
    if plugin == "frallan" and "no plugin for frallan" in str(payload):
        test_case.skipTest("frallan risk plugin is not deployed yet")
    if plugin == "babtist" and payload == '{"error":"not found"}':
        test_case.skipTest("babtist train-position endpoint is not deployed yet")


class LiveAcceptanceTests(unittest.TestCase):
    def test_controller_status_is_fresh_aggregated_and_threshold_consistent(self):
        display_id = f"matte-read-{uuid.uuid4().hex[:12]}"
        status_code, status = request(
            f"{CONTROLLER}/status?displayId={urllib.parse.quote(display_id)}"
        )

        self.assertEqual(status_code, 200)
        self.assertEqual(status["displayId"], display_id)
        self.assertIn(status["level"], {"ok", "warning", "severe"})
        self.assertIn(status["upstream"], {"ok", "error", "no-key"})
        self.assertEqual(
            status["level"],
            expected_level(status["lateCount"], status["thresholds"]["trains"]),
        )
        for private_field in ("announcements", "trainId", "station", "scheduled"):
            self.assertNotIn(private_field, status)

        updated_at = datetime.fromisoformat(status["updatedAt"].replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - updated_at).total_seconds()
        if status["upstream"] != "error":
            self.assertLessEqual(abs(age), 90, "controller status is older than 90 seconds")

    def test_per_display_thresholds_are_isolated_and_broadcast_over_sse(self):
        display_id = f"matte-{uuid.uuid4().hex[:16]}"
        other_id = f"matte-{uuid.uuid4().hex[:16]}"
        stream = None
        created = False
        try:
            code, existing = request(f"{CONTROLLER}/displays/{display_id}")
            self.assertEqual(code, 404, existing)

            stream_url = (
                f"{CONTROLLER}/stream?displayId={urllib.parse.quote(display_id)}"
            )
            stream_request = urllib.request.Request(
                stream_url, headers={"Accept": "text/event-stream"}
            )
            stream = urllib.request.urlopen(stream_request, timeout=15)
            first_event, first_status = read_sse_event(stream)
            self.assertEqual(first_event, "status")
            self.assertEqual(first_status["thresholds"], {"trains": 3, "minutes": 5})

            thresholds = {"trains": 2, "minutes": 7}
            code, saved = request(
                f"{CONTROLLER}/displays/{display_id}", "PUT", thresholds
            )
            self.assertEqual(code, 200, saved)
            created = True
            self.assertEqual(saved, {"id": display_id, **thresholds})

            event, streamed_status = read_sse_event(stream)
            self.assertEqual(event, "status")
            self.assertEqual(streamed_status["thresholds"], thresholds)
            self.assertEqual(
                streamed_status["level"],
                expected_level(streamed_status["lateCount"], thresholds["trains"]),
            )

            code, stored = request(f"{CONTROLLER}/displays/{display_id}")
            self.assertEqual(code, 200)
            self.assertEqual(stored, {"id": display_id, **thresholds})

            code, other_status = request(
                f"{CONTROLLER}/status?displayId={urllib.parse.quote(other_id)}"
            )
            self.assertEqual(code, 200)
            self.assertEqual(other_status["thresholds"], {"trains": 3, "minutes": 5})
        finally:
            if stream is not None:
                stream.close()
            if created:
                code, deleted = request(
                    f"{CONTROLLER}/displays/{display_id}", "DELETE"
                )
                self.assertEqual(code, 200, deleted)
                self.assertTrue(deleted["deleted"])
                code, missing = request(f"{CONTROLLER}/displays/{display_id}")
                self.assertEqual(code, 404, missing)

    def test_live_station_map_contract(self):
                display_id = f"matte-stations-{uuid.uuid4().hex[:8]}"
                code, stations = request(
                    f"{CONTROLLER}/stations?displayId={urllib.parse.quote(display_id)}"
                )

                self.assertEqual(code, 200, stations)
                self.assertEqual(stations["displayId"], display_id)
                self.assertEqual(stations["upstream"] in {"ok", "error", "no-key"}, True)
                self.assertEqual(stations["thresholds"], {"trains": 3, "minutes": 5})
                self.assertGreater(len(stations["stations"]), 0)

                for station in stations["stations"]:
                    self.assertTrue(station["station"])
                    self.assertTrue(station["name"])
                    self.assertIn(station["level"], {"ok", "warning", "severe"})
                    self.assertGreaterEqual(station["lateCount"], 0)
                    self.assertGreaterEqual(station["canceledCount"], 0)
                    if station["lat"] is not None:
                        self.assertTrue(isfinite(station["lat"]))
                        self.assertGreaterEqual(station["lat"], -90)
                        self.assertLessEqual(station["lat"], 90)
                    if station["lon"] is not None:
                        self.assertTrue(isfinite(station["lon"]))
                        self.assertGreaterEqual(station["lon"], -180)
                        self.assertLessEqual(station["lon"], 180)

    def test_live_train_positions_contract_when_deployed(self):
                code, trains = request(f"{CONTROLLER}/trains")
                skip_if_not_deployed(self, code, trains, "babtist")
                self.assertEqual(code, 200, trains)
                self.assertIn(trains["upstream"], {"ok", "error", "no-key"})
                self.assertIsInstance(trains["updatedAt"], str)
                self.assertEqual(trains["count"], len(trains["trains"]))

                for train in trains["trains"]:
                    self.assertTrue(train["trainId"])
                    self.assertTrue(train["train"])
                    self.assertTrue(isfinite(train["lat"]))
                    self.assertTrue(isfinite(train["lon"]))
                    self.assertGreaterEqual(train["lat"], -90)
                    self.assertLessEqual(train["lat"], 90)
                    self.assertGreaterEqual(train["lon"], -180)
                    self.assertLessEqual(train["lon"], 180)
                    self.assertTrue(
                        train["bearing"] is None
                        or (isfinite(train["bearing"]) and 0 <= train["bearing"] <= 360)
                    )
                    self.assertIsInstance(train["positionAt"], str)
                    self.assertTrue(
                        train["delayMinutes"] is None
                        or (isfinite(train["delayMinutes"]) and train["delayMinutes"] >= 0)
                    )
                    self.assertIsInstance(train["canceled"], bool)
                    self.assertIsInstance(train["to"], list)
                    for key in ("lastStation", "nextStation"):
                        self.assertTrue(train[key] is None or isinstance(train[key], dict))

    def test_live_risk_advisory_contract_when_deployed(self):
                display_id = f"matte-risk-{uuid.uuid4().hex[:8]}"
                code, risk = request(
                    f"{BASE_URL}/t/frallan/api/risk?displayId="
                    f"{urllib.parse.quote(display_id)}"
                )
                skip_if_not_deployed(self, code, risk, "frallan")
                self.assertIn(code, {200, 503}, risk)
                self.assertEqual(risk["displayId"], display_id)
                self.assertIn(
                    risk["availability"],
                    {"ready", "insufficient", "stale", "unavailable", "demo"},
                )
                self.assertIn(risk["method"], {"station-destination-overlap-v1"})
                self.assertIsInstance(risk["reasons"], list)
                self.assertTrue(all(isinstance(reason, str) for reason in risk["reasons"]))
                if risk["availability"] in {"stale", "unavailable"}:
                    self.assertEqual(code, 503)
                else:
                    self.assertEqual(code, 200)
                if risk["availability"] == "ready":
                    self.assertIn(risk["level"], {"ok", "warning", "severe"})
                    self.assertIsInstance(risk["affectedTrainCount"], int)
                    self.assertIsInstance(risk["canceledTrainCount"], int)
                else:
                    self.assertIsNone(risk["level"])
                    self.assertIsNone(risk["affectedTrainCount"])
                    self.assertIsNone(risk["canceledTrainCount"])

    def test_presentation_serves_single_display_and_wall_assets(self):
        display_id = f"matte-ui-{uuid.uuid4().hex[:8]}"
        single_url = f"{PRESENTATION}/?displayId={display_id}"
        wall_url = f"{PRESENTATION}/?displays={display_id},hall-2&kiosk=1"

        single_code, single_html = request(single_url)
        wall_code, wall_html = request(wall_url)
        self.assertEqual(single_code, 200)
        self.assertEqual(wall_code, 200)
        self.assertIn('id="displayIds"', single_html)
        self.assertIn('id="thresholds"', single_html)
        self.assertIn('src="app.js"', wall_html)

        app_code, app_js = request(f"{PRESENTATION}/app.js")
        style_code, style_css = request(f"{PRESENTATION}/style.css")
        self.assertEqual(app_code, 200)
        self.assertEqual(style_code, 200)
        self.assertIn("WALL_POLL_MS = 15000", app_js)
        self.assertIn("const wall = ids.length > 1", app_js)
        self.assertIn("if (wall)", app_js)
        self.assertIn("new EventSource", app_js)
        wall_branch = app_js.split("if (wall) {", 1)[1].split("} else {", 1)[0]
        self.assertNotIn("EventSource", wall_branch)
        self.assertIn("upstream === 'error'", app_js)
        self.assertIn("upstream === 'no-key'", app_js)
        self.assertIn("No update for over a minute", app_js)
        self.assertIn("body.kiosk", style_css)


def expected_level(late_count, warning_threshold):
    if late_count < warning_threshold:
        return "ok"
    if late_count < 2 * warning_threshold:
        return "warning"
    return "severe"


if __name__ == "__main__":
    unittest.main()
