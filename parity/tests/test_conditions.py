import unittest

from parity import docker_ops
from parity.conditions import NoneCondition, RestartCondition, build, parse_index_list
from parity.replay import HookAbort

INDICES = list(range(1, 21))


def make(**kwargs):
    calls, logs = [], []
    cond = RestartCondition(
        "guestbook", "http://x/healthz",
        restart=lambda c: calls.append(("restart", c)),
        wait_healthy=lambda url, timeout: calls.append(("wait", url, timeout)) or 0.5,
        log=logs.append, **kwargs)
    return cond, calls, logs


class ScheduleTest(unittest.TestCase):
    def test_default_is_middle(self):
        cond, _, _ = make()
        self.assertEqual(cond.schedule(INDICES), [10])

    def test_every_is_between_all_requests(self):
        cond, _, _ = make(every=True)
        self.assertEqual(cond.schedule(INDICES), list(range(1, 20)))

    def test_after_drops_last_and_out_of_range(self):
        cond, _, logs = make(after=[3, 7, 20, 25])
        self.assertEqual(cond.schedule(INDICES), [3, 7])
        self.assertIn("[20, 25]", logs[0])

    def test_single_request_has_no_restart(self):
        cond, _, _ = make()
        self.assertEqual(cond.schedule([1]), [])

    def test_after_and_every_are_exclusive(self):
        with self.assertRaises(ValueError):
            make(after=[3], every=True)


class HookTest(unittest.TestCase):
    def test_restart_then_wait_only_at_scheduled_points(self):
        cond, calls, _ = make(after=[3, 7])
        cond.before_run(INDICES)
        for i in INDICES:
            cond.after_request(i)
        self.assertEqual(calls, [
            ("restart", "guestbook"), ("wait", "http://x/healthz", 30.0),
            ("restart", "guestbook"), ("wait", "http://x/healthz", 30.0),
        ])

    def test_health_timeout_aborts_replay(self):
        def never_healthy(url, timeout):
            raise TimeoutError("30초 초과")
        cond = RestartCondition("guestbook", "http://x/healthz", after=[1],
                                restart=lambda c: None, wait_healthy=never_healthy, log=lambda m: None)
        cond.before_run(INDICES)
        with self.assertRaises(HookAbort):
            cond.after_request(1)

    def test_docker_failure_aborts_replay(self):
        def broken(c):
            raise docker_ops.DockerError("no such container")
        cond = RestartCondition("guestbook", "http://x/healthz", after=[1],
                                restart=broken, wait_healthy=lambda u, t: 0, log=lambda m: None)
        cond.before_run(INDICES)
        with self.assertRaises(HookAbort):
            cond.after_request(1)

    def test_none_condition_does_nothing(self):
        cond = NoneCondition()
        cond.before_run(INDICES)
        cond.after_request(1)  # 예외 없이 지나가면 된다


class ParseTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_index_list("3,7"), [3, 7])
        self.assertEqual(parse_index_list(" 3 , 7 ,"), [3, 7])

    def test_parse_rejects_bad_input(self):
        for bad in ("a,b", "0", "", "-1"):
            with self.assertRaises(ValueError, msg=bad):
                parse_index_list(bad)

    def test_build(self):
        conds = build(["none", "restart"], "guestbook", "http://x/healthz", log=lambda m: None)
        self.assertEqual([c.name for c in conds], ["none", "restart"])
        with self.assertRaises(ValueError):
            build(["scale"], "guestbook", "http://x/healthz")


if __name__ == "__main__":
    unittest.main()
