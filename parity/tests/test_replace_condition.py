import unittest

from parity import docker_ops
from parity.conditions import ReplaceCondition, build
from parity.replay import HookAbort

INDICES = list(range(1, 21))


def make(**kwargs):
    calls = []
    cond = ReplaceCondition(
        "guestbook", "http://x/healthz",
        recreate=lambda c: calls.append(("recreate", c)),
        wait_healthy=lambda url, timeout: calls.append(("wait", url, timeout)) or 0.5,
        log=lambda m: None, **kwargs)
    return cond, calls


class ReplaceConditionTest(unittest.TestCase):
    def test_recreate_then_wait_only_at_scheduled_points(self):
        cond, calls = make(after=[3, 7])
        cond.before_run(INDICES)
        for i in INDICES:
            cond.after_request(i)
        self.assertEqual(calls, [
            ("recreate", "guestbook"), ("wait", "http://x/healthz", 30.0),
            ("recreate", "guestbook"), ("wait", "http://x/healthz", 30.0),
        ])

    def test_same_default_point_as_restart(self):
        cond, _ = make()
        self.assertEqual(cond.schedule(INDICES), [10])

    def test_recreate_failure_aborts_replay(self):
        def broken(c):
            raise docker_ops.DockerError("no such container")
        cond = ReplaceCondition("guestbook", "http://x/healthz", after=[1],
                                recreate=broken, wait_healthy=lambda u, t: 0, log=lambda m: None)
        cond.before_run(INDICES)
        with self.assertRaises(HookAbort):
            cond.after_request(1)

    def test_uses_docker_recreate_by_default(self):
        cond = ReplaceCondition("guestbook", "http://x/healthz", log=lambda m: None)
        self.assertIs(cond._restart, docker_ops.recreate)

    def test_name_and_description(self):
        cond, _ = make(after=[3])
        self.assertEqual(cond.name, "replace")
        self.assertEqual(cond.describe(), "요청 3 뒤 교체")

    def test_build_accepts_replace(self):
        conds = build(["none", "restart", "replace"], "guestbook", "http://x/healthz", log=lambda m: None)
        self.assertEqual([c.name for c in conds], ["none", "restart", "replace"])
        self.assertIsInstance(conds[2], ReplaceCondition)


if __name__ == "__main__":
    unittest.main()
