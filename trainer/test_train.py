import json
import tempfile
import unittest
from pathlib import Path

from train import import_sessions, train


class TrainerTests(unittest.TestCase):
    def test_import_and_export_inference_model(self):
        sessions = [
            {
                "id": f"s-{index}", "capturedAt": index,
                "keyHoldDurations": [50 + index, 70 + index],
                "keyTransitionDurations": [20 + index],
                "passwordEntryDurationMs": 130 + index, "backspaceCount": index % 2,
            }
            for index in range(4)
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, database, output = root / "sessions.json", root / "sessions.sqlite", root / "model.json"
            source.write_text(json.dumps({"sessions": sessions}), encoding="utf-8")
            self.assertEqual(import_sessions(database, source), 4)
            count, _ = train(database, output, trees=3, sample_limit=256, threshold=0.6, seed=7)
            model = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(count, 4)
        self.assertEqual(model["format"], "isolation-forest-tree-v1")
        self.assertEqual(model["treeCount"], 3)
        self.assertEqual(len(model["featureNames"]), 12)
        def assert_tree(node):
            if "size" in node:
                self.assertEqual(set(node), {"size"})
                return
            self.assertEqual(set(node), {"feature", "threshold", "left", "right"})
            self.assertGreaterEqual(node["feature"], 0)
            self.assertLess(node["feature"], 12)
            assert_tree(node["left"])
            assert_tree(node["right"])

        for tree in model["trees"]:
            assert_tree(tree)


if __name__ == "__main__":
    unittest.main()
