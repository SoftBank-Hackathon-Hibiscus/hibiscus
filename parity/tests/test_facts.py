import unittest

from parity.facts import SQLITE_MAGIC, classify

CHANGES = [
    ("C", "/app"),
    ("C", "/app/data"),
    ("A", "/app/data/data.db"),
    ("A", "/app/data/data.db-journal"),
    ("C", "/app/uploads"),
    ("A", "/app/uploads/cat.png"),
    ("A", "/app/uploads/notes.txt"),
    ("A", "/app/app.log"),
    ("C", "/tmp"),
    ("A", "/tmp/scratch"),
    ("C", "/app/old"),
    ("D", "/app/old/removed.txt"),
]


def fake_head(path):
    return SQLITE_MAGIC + b"\x10\x00" if path.endswith(".db") else b"\x89PNG"


class ClassifyTest(unittest.TestCase):
    def test_classify(self):
        facts = classify(CHANGES, fake_head)
        self.assertEqual([(f["kind"], f["path"]) for f in facts], [
            ("sqlite", "/app/data/data.db"),
            ("local_upload", "/app/uploads"),
            ("local_file", "/app/app.log"),
        ])
        self.assertTrue(all(f["storage"] == "container_layer" for f in facts))
        self.assertIn("2 file(s)", facts[1]["evidence"])

    def test_db_extension_alone_is_not_sqlite(self):
        facts = classify([("A", "/app/cache.db")], lambda p: b"not sqlite")
        self.assertEqual(facts[0]["kind"], "local_file")

    def test_no_changes(self):
        self.assertEqual(classify([], fake_head), [])


if __name__ == "__main__":
    unittest.main()
