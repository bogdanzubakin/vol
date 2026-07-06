#!/usr/bin/env python3
"""
Train pullback signal GBM heads and export ONNX + sync GBM JSON for backtests.

  python3 -m pip install -r scripts/requirements-onnx.txt
  python scripts/train-pullback-signal-onnx.py samples.json out-dir --feature-count 17
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
except ImportError:
    convert_sklearn = None


def load_samples(path: str):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        return data
    return data


def split_head(samples, head: str, bull_kind: str, bear_kind: str):
    kind = bear_kind if head == "bear" else bull_kind
    rows = [s for s in samples if s.get("signalKind") == kind]
    if not rows:
        return None, None
    x = np.array([s["vec"] for s in rows], dtype=np.float32)
    y = np.array([int(s["label"]) for s in rows], dtype=np.int64)
    return x, y


def export_gbm(clf: GradientBoostingClassifier, out_path: str):
    init = 0.0
    try:
        prior = clf.init_.class_prior_
        if prior is not None and len(prior) >= 2 and prior[0] > 0:
            init = float(np.log(prior[1] / prior[0]))
    except Exception:
        init = 0.0

    trees = []
    estimators = clf.estimators_.ravel()
    for est in estimators:
        t = est.tree_
        values = []
        for node in range(t.node_count):
            values.append(float(t.value[node][0][0]))
        trees.append(
            {
                "children_left": t.children_left.tolist(),
                "children_right": t.children_right.tolist(),
                "feature": t.feature.tolist(),
                "threshold": t.threshold.tolist(),
                "value": values,
            }
        )

    payload = {
        "learningRate": float(clf.learning_rate),
        "initScore": init,
        "trees": trees,
        "nEstimators": int(clf.n_estimators),
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


def export_onnx(clf: GradientBoostingClassifier, out_path: str, feature_count: int):
    if convert_sklearn is None:
        print("skl2onnx not installed — skipping ONNX export", file=sys.stderr)
        return False
    initial_type = [("input", FloatTensorType([None, feature_count]))]
    onnx_model = convert_sklearn(
        clf,
        initial_types=initial_type,
        options={id(clf): {"zipmap": False}},
    )
    with open(out_path, "wb") as f:
        f.write(onnx_model.SerializeToString())
    return True


def train_head(x, y, head: str):
    if x is None or len(x) < 12:
        print(f"skip {head}: too few samples ({0 if x is None else len(x)})", file=sys.stderr)
        return None
    pos = int((y == 1).sum())
    neg = int((y == 0).sum())
    if pos < 4 or neg < 4:
        print(f"skip {head}: need both classes (pos={pos}, neg={neg})", file=sys.stderr)
        return None
    clf = GradientBoostingClassifier(
        n_estimators=80,
        max_depth=3,
        learning_rate=0.08,
        subsample=0.85,
        random_state=42,
    )
    clf.fit(x, y)
    acc = float((clf.predict(x) == y).mean())
    print(f"{head}: n={len(x)} pos={pos} train_acc={acc:.3f}", file=sys.stderr)
    return clf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("samples")
    parser.add_argument("out_dir")
    parser.add_argument("--feature-count", type=int, default=17)
    parser.add_argument("--prefix", default="pullback-signal")
    parser.add_argument("--bull-kind", default="pullback")
    parser.add_argument("--bear-kind", default="pullback_bear")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    raw = load_samples(args.samples)
    samples = raw.get("samples") if isinstance(raw, dict) else raw
    if not samples:
        raise SystemExit("no samples in input")

    meta = {
        "featureCount": args.feature_count,
        "sampleCount": len(samples),
        "heads": {},
    }

    for head in ("bull", "bear"):
        x, y = split_head(samples, head, args.bull_kind, args.bear_kind)
        clf = train_head(x, y, head)
        if clf is None:
            continue
        gbm_path = os.path.join(args.out_dir, f"{args.prefix}-{head}.gbm.json")
        onnx_path = os.path.join(args.out_dir, f"{args.prefix}-{head}.onnx")
        export_gbm(clf, gbm_path)
        onnx_ok = export_onnx(clf, onnx_path, args.feature_count)
        meta["heads"][head] = {
            "gbm": gbm_path,
            "onnx": onnx_path if onnx_ok else None,
            "samples": int(len(x)),
        }

    meta_path = os.path.join(args.out_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
