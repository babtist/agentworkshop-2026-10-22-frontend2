import json
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone


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
