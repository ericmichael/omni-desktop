"""Reproduce Table 2 zero-shot eval numbers.

Usage:
    python scripts/reproduce_table_2.py --model 8b --output results/
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path


def evaluate(model_name: str, benchmarks: list[str]) -> dict[str, float]:
    """Placeholder — wire up lm-evaluation-harness here."""
    # TODO(ticket spec-harness): run lm-eval on each benchmark.
    return {bench: 0.0 for bench in benchmarks}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="8b")
    parser.add_argument("--output", default="results/")
    args = parser.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    benchmarks = ["mmlu", "arc_challenge", "hellaswag"]
    scores = evaluate(args.model, benchmarks)

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    payload = {
        "run_id": run_id,
        "model": args.model,
        "scores": scores,
        "seed": 42,
        "precision": "bf16",
        "batch_size": 8,
    }
    out_file = out_dir / f"table_2_{run_id}.json"
    out_file.write_text(json.dumps(payload, indent=2))
    print(f"wrote {out_file}")


if __name__ == "__main__":
    main()
