import unittest

from parity.compare import View, diff_paths, flatten, generalize, render, significant_diffs, view_replayed
from parity.redact import REDACTED
from parity.replay import Response


def v(status, body):
    return View(status, body)


class FlattenTest(unittest.TestCase):
    def test_nested(self):
        view = {"status": 200, "body": [{"id": 1, "tags": []}, {"id": 2}]}
        self.assertEqual(flatten(view), {
            "status": 200, "body[0].id": 1, "body[0].tags": [], "body[1].id": 2,
        })

    def test_empty_body_is_leaf(self):
        self.assertEqual(flatten({"status": 200, "body": []}), {"status": 200, "body": []})


class DiffTest(unittest.TestCase):
    def test_missing_list_item_is_diff(self):
        self.assertEqual(diff_paths(v(200, [{"id": 1}, {"id": 2}]), v(200, [{"id": 1}])), ["body[1].id"])

    def test_bool_and_int_differ(self):
        self.assertEqual(diff_paths(v(200, {"ok": True}), v(200, {"ok": 1})), ["body.ok"])

    def test_generalize(self):
        self.assertEqual(generalize("body[12].items[0].created_at"), "body[*].items[*].created_at")

    def test_noise_forgives_value_change_only(self):
        expected = v(200, [{"id": 1, "created_at": "a"}, {"id": 2, "created_at": "b"}])
        actual = v(200, [{"id": 1, "created_at": "x"}])
        # body[1] 이 통째로 없으므로 body[1].created_at 누락도 용서하지 않는다
        self.assertEqual([d.path for d in significant_diffs(expected, actual, {"body[*].created_at"})],
                         ["body[1].created_at", "body[1].id"])

    def test_status_diff(self):
        self.assertEqual(diff_paths(v(200, {"name": "alice"}), v(401, {"error": "login required"})),
                         ["body.error", "body.name", "status"])


class HardBanTest(unittest.TestCase):
    """노이즈 규칙에 있어도 무시하면 안 되는 차이들."""

    def assert_not_forgiven(self, expected, actual, rules):
        self.assertTrue(significant_diffs(expected, actual, rules))

    def test_status_is_never_forgiven(self):
        self.assert_not_forgiven(v(200, {}), v(500, {}), {"status"})

    def test_missing_required_field_is_never_forgiven(self):
        self.assert_not_forgiven(v(201, {"id": 1, "created_at": "t"}), v(201, {"id": 1}), {"body.created_at"})

    def test_type_change_is_never_forgiven(self):
        self.assert_not_forgiven(v(201, {"created_at": "t"}), v(201, {"created_at": None}), {"body.created_at"})

    def test_connection_failure_is_never_forgiven(self):
        failed = view_replayed(Response(0, [], b"", error="ConnectionRefusedError"))
        self.assert_not_forgiven(v(200, "ok"), failed, {"status", "body"})

    def test_not_replayed_is_never_forgiven(self):
        self.assert_not_forgiven(v(200, "ok"), view_replayed(None), {"status", "body"})

    def test_same_type_value_change_is_forgiven(self):
        self.assertEqual(significant_diffs(v(201, {"created_at": "t1"}), v(201, {"created_at": "t2"}),
                                           {"body.created_at"}), [])

    def test_number_int_and_float_are_same_type(self):
        self.assertEqual(significant_diffs(v(200, {"ms": 1}), v(200, {"ms": 1.5}), {"body.ms"}), [])


class RedactedFieldTest(unittest.TestCase):
    def test_redacted_expected_accepts_any_present_value(self):
        self.assertEqual(diff_paths(v(200, {"token": REDACTED}), v(200, {"token": "live-abc"})), [])

    def test_redacted_expected_still_requires_presence(self):
        self.assertEqual(diff_paths(v(200, {"token": REDACTED}), v(200, {})), ["body", "body.token"])


class RenderTest(unittest.TestCase):
    def test_render_json(self):
        self.assertEqual(render(v(200, {"name": "앨리스"})), '200 {"name":"앨리스"}')

    def test_render_truncates(self):
        line = render(v(200, "x" * 500), limit=50)
        self.assertEqual(len(line), 50)
        self.assertTrue(line.endswith("…"))

    def test_render_hides_live_secrets(self):
        self.assertEqual(render(v(200, {"access_token": "live-abc", "name": "a"})),
                         '200 {"access_token":"<redacted>","name":"a"}')


if __name__ == "__main__":
    unittest.main()
