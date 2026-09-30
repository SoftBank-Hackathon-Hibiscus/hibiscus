import json
import unittest

from parity.redact import (REDACTED, is_sensitive, mask_cookie_header, mask_set_cookie, redact_body,
                           redact_headers, redact_json, redact_path)


class NameTest(unittest.TestCase):
    def test_sensitive_names(self):
        for name in ("Authorization", "Proxy-Authorization", "X-Api-Key", "api_key", "apiKey",
                     "X-Auth-Token", "access_token", "refreshToken", "password", "client_secret",
                     "X-CSRF-Token", "sid", "X-Amz-Signature"):
            self.assertTrue(is_sensitive(name), name)

    def test_ordinary_names(self):
        for name in ("author", "Content-Type", "User-Agent", "message", "name", "created_at", "id", "size"):
            self.assertFalse(is_sensitive(name), name)


class HeaderTest(unittest.TestCase):
    def test_headers(self):
        headers = [["Authorization", "Bearer s3cr3t"], ["Cookie", "sid=abc; theme=dark"],
                   ["X-Api-Key", "k-123"], ["User-Agent", "ua"]]
        self.assertEqual(redact_headers(headers), [
            ["Authorization", REDACTED], ["Cookie", f"sid={REDACTED}; theme={REDACTED}"],
            ["X-Api-Key", REDACTED], ["User-Agent", "ua"]])

    def test_set_cookie_keeps_name_and_attributes(self):
        self.assertEqual(mask_set_cookie("sid=abc123; Path=/; HttpOnly"), f"sid={REDACTED}; Path=/; HttpOnly")

    def test_deletion_cookie_is_unchanged(self):
        self.assertEqual(mask_set_cookie("sid=; Path=/; Max-Age=0"), "sid=; Path=/; Max-Age=0")

    def test_cookie_header(self):
        self.assertEqual(mask_cookie_header("a=1"), f"a={REDACTED}")


class BodyTest(unittest.TestCase):
    def test_json_nested(self):
        value = {"user": {"name": "a", "password": "pw"}, "tokens": [{"token": "t1"}],
                 "credentials": {"id": "x", "n": 1}, "author": "bob", "token": None}
        self.assertEqual(redact_json(value), {
            "user": {"name": "a", "password": REDACTED}, "tokens": [{"token": REDACTED}],
            "credentials": {"id": REDACTED, "n": REDACTED}, "author": "bob", "token": None})

    def test_json_body_bytes(self):
        out = redact_body(b'{"name":"alice","password":"pw"}', "application/json")
        self.assertEqual(json.loads(out), {"name": "alice", "password": REDACTED})

    def test_unchanged_body_keeps_original_bytes(self):
        raw = b'{ "author": "bob" ,  "message": "hi" }'
        self.assertIs(redact_body(raw, "application/json"), raw)

    def test_form_body(self):
        self.assertEqual(redact_body(b"user=a&password=p%40ss&next=%2F", "application/x-www-form-urlencoded"),
                         f"user=a&password={REDACTED}&next=%2F".encode())

    def test_other_content_types_are_untouched(self):
        self.assertEqual(redact_body(b"password=x", "text/plain"), b"password=x")

    def test_query(self):
        self.assertEqual(redact_path("/cb?code=1&access_token=xyz&page=2"),
                         f"/cb?code=1&access_token={REDACTED}&page=2")
        self.assertEqual(redact_path("/posts"), "/posts")


if __name__ == "__main__":
    unittest.main()
