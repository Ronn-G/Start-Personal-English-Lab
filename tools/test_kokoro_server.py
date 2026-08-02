from __future__ import annotations

import http.client
import json
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

import kokoro_server


def fake_wav() -> bytes:
    return b"RIFF" + (b"\x00" * 4) + b"WAVE" + (b"\x00" * 40)


class KokoroHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        def synthesize(text: str, voice: str, speed: float, lang: str) -> bytes:
            if text == "provider failure":
                raise RuntimeError("secret raw provider detail")
            if text.startswith("slow"):
                time.sleep(0.2)
            return fake_wav()

        cls.server = kokoro_server.KokoroHTTPServer(
            ("127.0.0.1", 0), kokoro_server.KokoroHandler, synthesize
        )
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = (response.status, {key.lower(): value for key, value in response.getheaders()}, data)
        connection.close()
        return result

    def json_request(self, payload: object, content_type: str = "application/json"):
        body = json.dumps(payload).encode("utf-8")
        return self.request("POST", "/tts", body, {"Content-Type": content_type})

    def test_health_valid_request_and_cors_contract(self) -> None:
        status, headers, _ = self.request("GET", "/health", headers={"Origin": "https://evil.test"})
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)
        status, headers, audio = self.json_request({"text": "Hello", "voice": "af_sarah"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        self.assertTrue(audio.startswith(b"RIFF"))
        status, headers, _ = self.request("OPTIONS", "/tts", headers={"Origin": "https://evil.test"})
        self.assertEqual(status, 405)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_content_type_size_json_and_field_validation(self) -> None:
        self.assertEqual(self.json_request({"text": "Hello"}, "text/plain")[0], 415)
        oversized = b"{" + (b" " * kokoro_server.MAX_REQUEST_BYTES) + b"}"
        self.assertEqual(
            self.request("POST", "/tts", oversized, {"Content-Type": "application/json"})[0],
            413,
        )
        self.assertEqual(
            self.request("POST", "/tts", b"{", {"Content-Type": "application/json"})[0],
            400,
        )
        for payload in (
            {"text": "Hello", "speed": "1"},
            {"text": "Hello", "speed": 99},
            {"text": "Hello", "voice": "../../model"},
            {"text": "Hello", "lang": "../en"},
            {"text": "x" * 651},
        ):
            self.assertEqual(self.json_request(payload)[0], 422)

    def test_provider_error_is_safe_and_next_request_recovers(self) -> None:
        status, _, body = self.json_request({"text": "provider failure"})
        self.assertEqual(status, 500)
        self.assertNotIn(b"secret raw provider detail", body)
        self.assertEqual(self.json_request({"text": "works after failure"})[0], 200)

    def test_storm_is_bounded_health_stays_live_and_capacity_recovers(self) -> None:
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self.json_request, {"text": f"slow {index}"}) for index in range(8)
            ]
            time.sleep(0.04)
            self.assertEqual(self.request("GET", "/health")[0], 200)
            statuses = [future.result()[0] for future in futures]
        self.assertIn(429, statuses)
        self.assertIn(200, statuses)
        self.assertEqual(self.json_request({"text": "works after storm"})[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
