#!/usr/bin/env python3
"""Local HTTP server to train Isolation Forest models for the browser extension."""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from train import build_model, validate_session


class TrainingHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/train":
            self.send_error(404, "Not Found")
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self.send_error(400, "Bad Request: Empty Body")
            return

        try:
            body = self.rfile.read(content_length)
            payload = json.loads(body.decode("utf-8"))
            raw_sessions = payload.get("sessions")
            if not isinstance(raw_sessions, list):
                self.send_error(400, "Bad Request: 'sessions' array required")
                return

            valid_sessions = [validate_session(item, index) for index, item in enumerate(raw_sessions, start=1)]
            
            # Default training parameters
            trees = payload.get("trees", 100)
            threshold = payload.get("threshold", 0.6)
            seed = payload.get("seed", 42)

            logging.info(f"Training model with {len(valid_sessions)} sessions...")
            model = build_model(valid_sessions, trees, threshold, seed)
            logging.info("Model trained successfully.")

            response_data = json.dumps(model, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response_data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(response_data)
        except Exception as error:
            logging.error(f"Error during training: {error}")
            self.send_error(500, f"Internal Server Error: {error}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5000, help="Port to listen on (default: 5000)")
    args = parser.parse_args()

    server_address = ("", args.port)
    httpd = HTTPServer(server_address, TrainingHandler)
    logging.info(f"Starting training server on port {args.port}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("Shutting down server...")
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
