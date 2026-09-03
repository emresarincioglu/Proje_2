#!/usr/bin/env python3
"""Import raw keystroke sessions and export an inference-only Isolation Forest."""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sklearn.ensemble import IsolationForest


FEATURE_SCHEMA = [
    {"name": "keyHoldCount", "source": "keyHoldDurations", "statistic": "count"},
    {"name": "keyHoldMinMs", "source": "keyHoldDurations", "statistic": "min"},
    {"name": "keyHoldMaxMs", "source": "keyHoldDurations", "statistic": "max"},
    {"name": "keyHoldMedianMs", "source": "keyHoldDurations", "statistic": "median"},
    {"name": "keyHoldP90Ms", "source": "keyHoldDurations", "statistic": "p90"},
    {"name": "keyTransitionCount", "source": "keyTransitionDurations", "statistic": "count"},
    {"name": "keyTransitionMinMs", "source": "keyTransitionDurations", "statistic": "min"},
    {"name": "keyTransitionMaxMs", "source": "keyTransitionDurations", "statistic": "max"},
    {"name": "keyTransitionMedianMs", "source": "keyTransitionDurations", "statistic": "median"},
    {"name": "keyTransitionP90Ms", "source": "keyTransitionDurations", "statistic": "p90"},
    {"name": "passwordEntryDurationMs", "source": "passwordEntryDurationMs", "statistic": "value"},
    {"name": "backspaceCount", "source": "backspaceCount", "statistic": "value"},
]
REQUIRED_FIELDS = {"keyHoldDurations", "keyTransitionDurations", "passwordEntryDurationMs", "backspaceCount"}


def initialize_database(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS keystroke_sessions (
            id TEXT PRIMARY KEY,
            captured_at INTEGER NOT NULL,
            key_hold_durations_json TEXT NOT NULL,
            key_transition_durations_json TEXT NOT NULL,
            password_entry_duration_ms REAL NOT NULL,
            backspace_count INTEGER NOT NULL
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS idx_keystroke_sessions_captured_at ON keystroke_sessions(captured_at)")


def finite_nonnegative_numbers(values: Any, name: str) -> list[float]:
    if not isinstance(values, list):
        raise ValueError(f"{name} must be an array")
    converted = [float(value) for value in values]
    if any(not math.isfinite(value) or value < 0 for value in converted):
        raise ValueError(f"{name} must contain finite, non-negative numbers")
    return converted


def validate_session(session: Any, row_number: int) -> dict[str, Any]:
    if not isinstance(session, dict) or not REQUIRED_FIELDS.issubset(session):
        raise ValueError(f"record {row_number} is missing required session fields")
    holds = finite_nonnegative_numbers(session["keyHoldDurations"], "keyHoldDurations")
    transitions = finite_nonnegative_numbers(session["keyTransitionDurations"], "keyTransitionDurations")
    duration = float(session["passwordEntryDurationMs"])
    backspaces = float(session["backspaceCount"])
    if not math.isfinite(duration) or duration < 0 or not math.isfinite(backspaces) or backspaces < 0:
        raise ValueError(f"record {row_number} has invalid scalar values")
    return {
        "id": str(session.get("id") or f"import-{row_number}-{session.get('capturedAt', 0)}"),
        "capturedAt": int(session.get("capturedAt") or 0),
        "keyHoldDurations": holds,
        "keyTransitionDurations": transitions,
        "passwordEntryDurationMs": duration,
        "backspaceCount": int(backspaces),
    }


def import_sessions(database: Path, input_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    sessions = payload.get("sessions") if isinstance(payload, dict) else payload
    if not isinstance(sessions, list):
        raise ValueError("input must be an array or an object containing a sessions array")
    valid = [validate_session(item, index) for index, item in enumerate(sessions, start=1)]
    with sqlite3.connect(database) as connection:
        initialize_database(connection)
        connection.executemany("""
            INSERT INTO keystroke_sessions (
                id, captured_at, key_hold_durations_json, key_transition_durations_json,
                password_entry_duration_ms, backspace_count
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                captured_at=excluded.captured_at,
                key_hold_durations_json=excluded.key_hold_durations_json,
                key_transition_durations_json=excluded.key_transition_durations_json,
                password_entry_duration_ms=excluded.password_entry_duration_ms,
                backspace_count=excluded.backspace_count
        """, [
            (record["id"], record["capturedAt"], json.dumps(record["keyHoldDurations"]),
             json.dumps(record["keyTransitionDurations"]), record["passwordEntryDurationMs"], record["backspaceCount"])
            for record in valid
        ])
    return len(valid)


def percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    position = (len(sorted_values) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (position - lower)


def timing_features(values: list[float]) -> list[float]:
    ordered = sorted(values)
    return [float(len(ordered)), ordered[0] if ordered else 0.0, ordered[-1] if ordered else 0.0,
            percentile(ordered, 0.5), percentile(ordered, 0.9)]


def feature_vector(record: dict[str, Any]) -> list[float]:
    return (timing_features(record["keyHoldDurations"]) + timing_features(record["keyTransitionDurations"]) +
            [record["passwordEntryDurationMs"], float(record["backspaceCount"])])


def read_sessions(database: Path, limit: int) -> list[dict[str, Any]]:
    with sqlite3.connect(database) as connection:
        initialize_database(connection)
        rows = connection.execute("""
            SELECT id, captured_at, key_hold_durations_json, key_transition_durations_json,
                   password_entry_duration_ms, backspace_count
            FROM keystroke_sessions ORDER BY captured_at DESC LIMIT ?
        """, (limit,)).fetchall()
    return [validate_session({
        "id": row[0], "capturedAt": row[1], "keyHoldDurations": json.loads(row[2]),
        "keyTransitionDurations": json.loads(row[3]), "passwordEntryDurationMs": row[4], "backspaceCount": row[5],
    }, index) for index, row in enumerate(rows, start=1)]


def export_node(tree: Any, node_id: int = 0) -> dict[str, Any]:
    left, right = int(tree.children_left[node_id]), int(tree.children_right[node_id])
    if left == right:
        return {"size": int(tree.n_node_samples[node_id])}
    return {
        "feature": int(tree.feature[node_id]), "threshold": float(tree.threshold[node_id]),
        "left": export_node(tree, left), "right": export_node(tree, right),
    }


def build_model(sessions: list[dict[str, Any]], trees: int, threshold: float, seed: int) -> dict[str, Any]:
    if len(sessions) < 2:
        raise ValueError("at least two valid sessions are required to train an Isolation Forest")
    matrix = [feature_vector(record) for record in sessions]
    forest = IsolationForest(
        n_estimators=trees, max_samples="auto", max_features=1.0, contamination="auto",
        random_state=seed, bootstrap=False,
    ).fit(matrix)
    return {
        "format": "isolation-forest-tree-v1", "featureSchemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(), "featureSchema": FEATURE_SCHEMA,
        "featureNames": [item["name"] for item in FEATURE_SCHEMA], "sampleSize": int(forest.max_samples_),
        "treeCount": len(forest.estimators_), "anomalyThreshold": threshold, "offset": float(forest.offset_),
        "trees": [export_node(estimator.tree_) for estimator in forest.estimators_],
    }


def train(database: Path, output: Path, trees: int, sample_limit: int, threshold: float, seed: int) -> tuple[int, Path]:
    sessions = read_sessions(database, sample_limit)
    model = build_model(sessions, trees, threshold, seed)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(sessions), output


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import", help="import exported raw sessions into SQLite")
    importer.add_argument("--database", type=Path, required=True)
    importer.add_argument("--input", type=Path, required=True)
    trainer = commands.add_parser("train", help="train and export a browser inference model")
    trainer.add_argument("--database", type=Path, required=True)
    trainer.add_argument("--output", type=Path, required=True)
    trainer.add_argument("--trees", type=int, default=100)
    trainer.add_argument("--sample-limit", type=int, default=256)
    trainer.add_argument("--threshold", type=float, default=0.6)
    trainer.add_argument("--seed", type=int, default=42)
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "import":
            print(f"Imported {import_sessions(arguments.database, arguments.input)} session(s).")
        else:
            count, path = train(arguments.database, arguments.output, arguments.trees, arguments.sample_limit,
                                arguments.threshold, arguments.seed)
            print(f"Trained from {count} session(s); wrote {path}.")
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
