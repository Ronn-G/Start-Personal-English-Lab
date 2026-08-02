from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import socket
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any, Callable


DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "models" / "kokoro-v1.0.onnx"
DEFAULT_VOICES_PATH = Path(__file__).resolve().parent / "models" / "voices-v1.0.bin"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5050
DEFAULT_VOICE = "af_sarah"
DEFAULT_LANG = "en-us"
DEFAULT_SPEED = 1.0
SUPPORTED_VOICES = frozenset({DEFAULT_VOICE})
SUPPORTED_LANGUAGES = frozenset({DEFAULT_LANG})
MIN_SPEED = 0.65
MAX_SPEED = 1.35
MAX_TEXT_CHARS = 650
MAX_TEXT_BYTES = 2_600
MAX_REQUEST_BYTES = 12 * 1024
SOCKET_TIMEOUT_SECONDS = 5
MAX_TTS_REQUESTS = 4
MAX_REQUEST_THREADS = 16

kokoro: Any | None = None
kokoro_lock = Lock()
tts_slots = BoundedSemaphore(MAX_TTS_REQUESTS)
model_path = DEFAULT_MODEL_PATH
voices_path = DEFAULT_VOICES_PATH


class RequestFailure(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def get_kokoro() -> Any:
    global kokoro
    if kokoro is None:
        if not model_path.exists() or not voices_path.exists():
            raise FileNotFoundError("Kokoro runtime files are unavailable.")
        from kokoro_onnx import Kokoro

        kokoro = Kokoro(str(model_path), str(voices_path))
    return kokoro


def validate_payload(body: Any) -> tuple[str, str, float, str]:
    if not isinstance(body, dict):
        raise RequestFailure(422, "INVALID_PAYLOAD", "JSON body must be an object.")
    text = body.get("text")
    voice = body.get("voice", DEFAULT_VOICE)
    speed = body.get("speed", DEFAULT_SPEED)
    lang = body.get("lang", DEFAULT_LANG)
    if not isinstance(text, str):
        raise RequestFailure(422, "INVALID_TEXT", "Text must be a string.")
    normalized = clean_text(text)
    if not normalized:
        raise RequestFailure(422, "INVALID_TEXT", "Text cannot be empty.")
    if len(normalized) > MAX_TEXT_CHARS or len(normalized.encode("utf-8")) > MAX_TEXT_BYTES:
        raise RequestFailure(422, "TEXT_TOO_LONG", "Text exceeds the supported limit.")
    if not isinstance(speed, (int, float)) or isinstance(speed, bool) or not math.isfinite(speed):
        raise RequestFailure(422, "INVALID_SPEED", "Speed must be a finite number.")
    parsed_speed = float(speed)
    if parsed_speed < MIN_SPEED or parsed_speed > MAX_SPEED:
        raise RequestFailure(422, "INVALID_SPEED", "Speed is outside the supported range.")
    if not isinstance(voice, str) or voice not in SUPPORTED_VOICES:
        raise RequestFailure(422, "INVALID_VOICE", "Voice is not supported.")
    if not isinstance(lang, str) or lang not in SUPPORTED_LANGUAGES:
        raise RequestFailure(422, "INVALID_LANGUAGE", "Language is not supported.")
    return normalized, voice, parsed_speed, lang


def synthesize_wav(text: str, voice: str, speed: float, lang: str) -> bytes:
    import numpy as np
    import soundfile as sf

    with kokoro_lock:
        engine = get_kokoro()
        samples, sample_rate = engine.create(text, voice=voice, speed=speed, lang=lang)
    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(samples, dtype=np.float32), int(sample_rate), format="WAV")
    return buffer.getvalue()


class KokoroHandler(BaseHTTPRequestHandler):
    server_version = "KokoroLocalTTS/2.0"
    protocol_version = "HTTP/1.1"

    @property
    def kokoro_server(self) -> "KokoroHTTPServer":
        return self.server  # type: ignore[return-value]

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(SOCKET_TIMEOUT_SECONDS)

    def do_OPTIONS(self) -> None:
        self.send_json(
            {"ok": False, "error": "METHOD_NOT_ALLOWED"},
            status=405,
            extra_headers={"Allow": "GET, POST"},
        )

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json({"ok": False, "error": "NOT_FOUND"}, status=404)
            return
        self.send_json(
            {
                "status": "ok",
                "modelLoaded": kokoro is not None,
                "host": self.server.server_address[0],
                "port": self.server.server_address[1],
                "ttsCapacity": MAX_TTS_REQUESTS,
            }
        )

    def do_POST(self) -> None:
        if self.path != "/tts":
            self.send_json({"ok": False, "error": "NOT_FOUND"}, status=404)
            return
        request_id = uuid.uuid4().hex[:12]
        started = time.monotonic()
        text_length = 0
        text_hash = "none"
        status = 500
        error_code = "INTERNAL_ERROR"
        try:
            body = self.read_json_body()
            text, voice, speed, lang = validate_payload(body)
            text_length = len(text)
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
            if not tts_slots.acquire(blocking=False):
                raise RequestFailure(429, "TTS_CAPACITY_EXCEEDED", "TTS is busy. Try again shortly.")
            try:
                audio = self.kokoro_server.synthesizer(text, voice, speed, lang)
            finally:
                tts_slots.release()
            self.send_wav(audio)
            status = 200
            error_code = "none"
        except RequestFailure as failure:
            status = failure.status
            error_code = failure.code
            self.send_json({"ok": False, "error": failure.code, "message": failure.message}, status)
        except (TimeoutError, socket.timeout):
            status = 504
            error_code = "REQUEST_TIMEOUT"
            self.send_json({"ok": False, "error": error_code, "message": "Request timed out."}, status)
        except FileNotFoundError:
            status = 503
            error_code = "MODEL_UNAVAILABLE"
            self.send_json(
                {"ok": False, "error": error_code, "message": "Kokoro model is unavailable."},
                status,
            )
        except Exception:
            status = 500
            error_code = "SYNTHESIS_FAILED"
            self.send_json(
                {"ok": False, "error": error_code, "message": "Audio synthesis failed."}, status
            )
        finally:
            print(
                "[kokoro]",
                json.dumps(
                    {
                        "requestId": request_id,
                        "textLength": text_length,
                        "textHash": text_hash,
                        "status": status,
                        "errorCode": error_code,
                        "durationMs": round((time.monotonic() - started) * 1000),
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )

    def read_json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "").strip().lower()
        if not re.fullmatch(r"application/json(?:\s*;\s*charset=utf-8)?", content_type):
            raise RequestFailure(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise RequestFailure(411, "CONTENT_LENGTH_REQUIRED", "Content-Length is required.")
        if not raw_length.isdigit():
            raise RequestFailure(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.")
        length = int(raw_length)
        if length > MAX_REQUEST_BYTES:
            raise RequestFailure(413, "REQUEST_TOO_LARGE", "Request body is too large.")
        if length < 1:
            raise RequestFailure(400, "MALFORMED_JSON", "JSON body is required.")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise RequestFailure(400, "INCOMPLETE_BODY", "Request body is incomplete.")
        try:
            decoded = raw.decode("utf-8", errors="strict")
            body = json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RequestFailure(400, "MALFORMED_JSON", "JSON body is invalid.") from None
        if not isinstance(body, dict):
            raise RequestFailure(422, "INVALID_PAYLOAD", "JSON body must be an object.")
        return body

    def send_wav(self, audio: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)

    def send_json(
        self,
        payload: dict[str, Any],
        status: int = 200,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            return

    def log_message(self, format: str, *args: Any) -> None:
        return


class KokoroHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        synthesizer: Callable[[str, str, float, str], bytes] = synthesize_wav,
    ) -> None:
        self.worker_slots = BoundedSemaphore(MAX_REQUEST_THREADS)
        self.synthesizer = synthesizer
        super().__init__(server_address, handler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self.worker_slots.acquire(blocking=False):
            payload = b'{"ok":false,"error":"SERVER_CAPACITY_EXCEEDED"}'
            response = (
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Content-Type: application/json; charset=utf-8\r\n"
                + f"Content-Length: {len(payload)}\r\n".encode("ascii")
                + b"Connection: close\r\n\r\n"
                + payload
            )
            try:
                request.sendall(response)
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.worker_slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.worker_slots.release()


def main() -> None:
    global model_path, voices_path
    parser = argparse.ArgumentParser(description="Local Kokoro ONNX TTS server")
    parser.add_argument("--host", default=DEFAULT_HOST, choices=["127.0.0.1", "localhost"])
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument("--voices", default=str(DEFAULT_VOICES_PATH))
    args = parser.parse_args()
    if args.port < 1 or args.port > 65_535:
        parser.error("port must be between 1 and 65535")
    model_path = Path(args.model)
    voices_path = Path(args.voices)
    print("Loading Kokoro model and voices...", flush=True)
    get_kokoro()
    server = KokoroHTTPServer((args.host, args.port), KokoroHandler)
    print(f"Kokoro TTS server ready at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
