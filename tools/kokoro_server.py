from __future__ import annotations

import argparse
import io
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "models" / "kokoro-v1.0.onnx"
DEFAULT_VOICES_PATH = Path(__file__).resolve().parent / "models" / "voices-v1.0.bin"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5050
DEFAULT_VOICE = "af_sarah"
DEFAULT_LANG = "en-us"
DEFAULT_SPEED = 1.0
MAX_TEXT_CHARS = 650

kokoro: Kokoro | None = None
kokoro_lock = Lock()
model_path = DEFAULT_MODEL_PATH
voices_path = DEFAULT_VOICES_PATH


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def get_kokoro() -> Kokoro:
    global kokoro

    if kokoro is None:
        if not model_path.exists():
            raise FileNotFoundError(f"Missing Kokoro model: {model_path}")
        if not voices_path.exists():
            raise FileNotFoundError(f"Missing Kokoro voices file: {voices_path}")
        kokoro = Kokoro(str(model_path), str(voices_path))

    return kokoro


def synthesize_wav(text: str, voice: str, speed: float, lang: str) -> bytes:
    normalized = clean_text(text)
    if not normalized:
        raise ValueError("Text is empty.")
    if len(normalized) > MAX_TEXT_CHARS:
        normalized = normalized[:MAX_TEXT_CHARS].rsplit(" ", 1)[0].strip()

    # kokoro-onnx and its phonemizer share mutable native state. The HTTP
    # server may remain threaded for health checks, but synthesis must be
    # serialized to keep parallel requests from corrupting phoneme output.
    with kokoro_lock:
        engine = get_kokoro()
        samples, sample_rate = engine.create(
            normalized,
            voice=voice or DEFAULT_VOICE,
            speed=speed or DEFAULT_SPEED,
            lang=lang or DEFAULT_LANG,
        )

    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(samples, dtype=np.float32), int(sample_rate), format="WAV")
    return buffer.getvalue()


class KokoroHandler(BaseHTTPRequestHandler):
    server_version = "KokoroLocalTTS/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return

        self.send_json(
            {
                "status": "ok",
                "modelLoaded": kokoro is not None,
                "host": self.server.server_address[0],
                "port": self.server.server_address[1],
            }
        )

    def do_POST(self) -> None:
        if self.path != "/tts":
            self.send_error(404)
            return

        try:
            body = self.read_json_body()
            text = str(body.get("text", ""))
            voice = str(body.get("voice", DEFAULT_VOICE))
            lang = str(body.get("lang", DEFAULT_LANG))
            speed = float(body.get("speed", DEFAULT_SPEED))
            audio = synthesize_wav(text, voice=voice, speed=speed, lang=lang)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=400)
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[kokoro] {self.address_string()} - {format % args}")


class KokoroHTTPServer(ThreadingHTTPServer):
    # TCPServer defaults to a backlog of 5. A browser/app batch can open more
    # sockets before the request threads reach the serialized synthesis lock,
    # so keep enough pending connections for the bounded local workload.
    request_queue_size = 64


def main() -> None:
    global model_path, voices_path

    parser = argparse.ArgumentParser(description="Local Kokoro ONNX TTS server")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument("--voices", default=str(DEFAULT_VOICES_PATH))
    args = parser.parse_args()

    model_path = Path(args.model)
    voices_path = Path(args.voices)

    print("Loading Kokoro model and voices...", flush=True)
    get_kokoro()
    server = KokoroHTTPServer((args.host, args.port), KokoroHandler)
    print(f"Kokoro TTS server ready at http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
