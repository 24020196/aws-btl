"""Worker behaviour: dry-run safety, allowlist gating and honest failure reporting."""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"
WORKER_DIR = ROOT / "XRegion-InstanceRecovery"
# The Lambda package ships these as siblings, so the loader mirrors that layout.
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))


def worker():
    spec = importlib.util.spec_from_file_location("recovery_worker", WORKER_DIR / "recovery_worker.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def w(monkeypatch):
    module = worker()
    monkeypatch.setattr(module, "check_health", lambda: {"infra_ok": True, "api_error": None})
    return module


def rec(instance_id="i-1", status="FAILED", **extra):
    """A record whose FAILED verdict is already durable (observed long enough)."""
    import time as _time
    base = {"instance_id": instance_id, "current_status": status, "active_nova_id": "nova-1",
            "last_failure_at": 1, "recovery_decision": "DELETE",
            "recovery_decision_at": int(_time.time()) - 4000, "recovery_observations": 5}
    base.update(extra)
    return base


def test_defaults_to_dry_run(w, monkeypatch):
    """Nothing is destroyed unless live mode is explicitly enabled."""
    for key in ("XREGION_RECOVERY_LIVE", "XREGION_RECOVERY_ALLOWLIST"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [rec()])
    monkeypatch.setattr(w, "get_nova", lambda nid: {"status": "ERROR"})
    called = []
    monkeypatch.setattr(w, "recover", lambda record, reason: called.append(record) or {})
    result = w.lambda_handler({}, None)
    assert result["live"] is False
    assert called == []
    assert result["decisions"].get("DELETE") == 1


def test_live_but_not_allowlisted_does_not_recover(w, monkeypatch):
    monkeypatch.setenv("XREGION_RECOVERY_LIVE", "true")
    monkeypatch.setenv("XREGION_RECOVERY_ALLOWLIST", "i-other")
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [rec()])
    monkeypatch.setattr(w, "get_nova", lambda nid: {"status": "ERROR"})
    called = []
    monkeypatch.setattr(w, "recover", lambda record, reason: called.append(record) or {})
    w.lambda_handler({}, None)
    assert called == []


def test_live_and_allowlisted_recovers_one(w, monkeypatch):
    monkeypatch.setenv("XREGION_RECOVERY_LIVE", "true")
    monkeypatch.setenv("XREGION_RECOVERY_ALLOWLIST", "i-1")
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [rec()])
    monkeypatch.setattr(w, "get_nova", lambda nid: {"status": "ERROR"})
    called = []
    monkeypatch.setattr(w, "recover", lambda record, reason: called.append(record["instance_id"]) or {})
    w.lambda_handler({}, None)
    assert called == ["i-1"]


def test_recovers_every_durable_instance_in_one_sweep(w, monkeypatch):
    """SPEC-SF-04: không circuit breaker — thu hồi tuần tự toàn bộ máy lỗi đủ điều kiện trong một đợt."""
    monkeypatch.setenv("XREGION_RECOVERY_LIVE", "true")
    monkeypatch.setenv("XREGION_RECOVERY_ALLOWLIST", "i-1,i-2,i-3")
    monkeypatch.setattr(w, "scan_candidates",
                        lambda cfg: [rec("i-1"), rec("i-2"), rec("i-3")])
    monkeypatch.setattr(w, "get_nova", lambda nid: {"status": "ERROR"})
    called = []
    monkeypatch.setattr(w, "recover", lambda record, reason: called.append(record["instance_id"]) or {})
    w.lambda_handler({}, None)
    assert called == ["i-1", "i-2", "i-3"]


def test_unhealthy_infrastructure_never_recovers(w, monkeypatch):
    monkeypatch.setattr(w, "check_health",
                        lambda: {"infra_ok": False, "api_error": "nova down"})
    monkeypatch.setenv("XREGION_RECOVERY_LIVE", "true")
    monkeypatch.setenv("XREGION_RECOVERY_ALLOWLIST", "i-1")
    called = []
    monkeypatch.setattr(w, "recover", lambda record, reason: called.append(record) or {})
    result = w.lambda_handler({}, None)
    assert called == []
    assert result["stopped"] == "hạ tầng không khỏe"


def test_recover_reports_failure_instead_of_success(w, monkeypatch):
    """If cleanup cannot start, the record must say CLEANUP_FAILED, never success."""
    marks = []
    monkeypatch.setattr(w, "claim", lambda iid, status: "owner-1")
    monkeypatch.setattr(w, "mark", lambda iid, owner, status, cleanup, reason, extra=None:
                        marks.append((status, cleanup)))
    module_arn = w.TERMINATE_ARN
    monkeypatch.setattr(w, "TERMINATE_ARN", "")
    try:
        result = w.recover(rec(), "Nova ERROR")
    finally:
        w.TERMINATE_ARN = module_arn
    assert result["cleanup_status"] == "CLEANUP_FAILED"
    assert ("FAILED", "CLEANUP_FAILED") in marks


def test_scan_unwraps_dynamodb_items(monkeypatch):
    """P0: scan double-wrapped items and raised KeyError on every record."""
    module = worker()
    monkeypatch.setattr(module, "CONFIG", None)

    class Table:
        def scan(self, **kwargs):
            return {"Items": [{"instance_id": {"S": "i-1"}, "current_status": {"S": "FAILED"},
                               "last_failure_at": {"N": "123"}}]}

    class Sess:
        def client(self, name, **kwargs):
            return Table()

    monkeypatch.setattr(module, "SESSION", Sess())
    records = module.scan_candidates({"limit": 10})
    assert records == [{"instance_id": "i-1", "current_status": "FAILED", "last_failure_at": 123}]


def test_scan_paginates(monkeypatch):
    module = worker()
    pages = [{"Items": [{"instance_id": {"S": "i-1"}}], "LastEvaluatedKey": {"k": {"S": "x"}}},
             {"Items": [{"instance_id": {"S": "i-2"}}]}]
    seen = []

    class Table:
        def scan(self, **kwargs):
            seen.append(kwargs.get("ExclusiveStartKey"))
            return pages[0] if kwargs.get("ExclusiveStartKey") is None else pages[1]

    class Sess:
        def client(self, name, **kwargs):
            return Table()

    monkeypatch.setattr(module, "SESSION", Sess())
    names = [r["instance_id"] for r in module.scan_candidates({"limit": 10})]
    assert names == ["i-1", "i-2"] and seen == [None, {"k": {"S": "x"}}]


def test_observe_mode_writes_nothing(w, monkeypatch):
    """A sweep that mutates while 'dry' would corrupt the state it is measuring."""
    monkeypatch.delenv("XREGION_RECOVERY_LIVE", raising=False)
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [rec()])
    monkeypatch.setattr(w, "read_nova", lambda nid: {"status": "ERROR"})
    writes = []
    monkeypatch.setattr(w, "record_observation",
                        lambda *a, **k: writes.append(("observe", a)))
    monkeypatch.setattr(w, "recover", lambda *a, **k: writes.append(("recover", a)))
    w.lambda_handler({}, None)
    assert writes == []


def test_live_nova_status_overrides_stale_projection(w, monkeypatch):
    """Real Nova state decides; a cached row must not authorize a delete."""
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [rec()])
    seen = {}

    def fake_classify(record, nova, health, policy_cfg, now=None):
        seen["nova"] = nova
        return ("SKIP", "ok", {})

    monkeypatch.setattr(w.policy, "classify", fake_classify)
    monkeypatch.setattr(w, "read_nova", lambda nid: {"status": "ACTIVE", "source": "nova"})
    w.lambda_handler({}, None)
    assert seen["nova"]["source"] == "nova"


def test_nova_read_failure_is_unknown_not_deleted(w, monkeypatch):
    monkeypatch.setattr(w, "NOVA_URL", "http://nova")
    monkeypatch.setattr(w, "keystone_token", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert w.read_nova("nova-1") is None


def test_nova_404_is_reported_as_deleted(w, monkeypatch):
    monkeypatch.setattr(w, "NOVA_URL", "http://nova")
    monkeypatch.setattr(w, "keystone_token", lambda: "token")
    monkeypatch.setattr(w, "http", lambda *a, **k: (404, {}, {}))
    assert w.read_nova("nova-1")["status"] == "DELETED"


def test_durable_requires_observed_history(w, monkeypatch):
    now = 1_000_000
    cfg = {"min_age_s": 1800, "min_observations": 3}
    assert w.durable(None, {}, cfg, now)[0] is False
    assert w.durable(None, {"recovery_decision_at": now - 60, "recovery_observations": 9},
                     cfg, now)[0] is False
    assert w.durable(None, {"recovery_decision_at": now - 4000, "recovery_observations": 1},
                     cfg, now)[0] is False
    assert w.durable(None, {"recovery_decision_at": now - 4000, "recovery_observations": 3},
                     cfg, now)[0] is True


def test_delete_blocked_until_durable(w, monkeypatch):
    """A DELETE verdict fresh this sweep must not act, even if allowlisted and live."""
    monkeypatch.setenv("XREGION_RECOVERY_LIVE", "true")
    monkeypatch.setenv("XREGION_RECOVERY_ALLOWLIST", "i-1")
    fresh = dict(rec(), recovery_decision_at=None, recovery_observations=1)
    monkeypatch.setattr(w, "scan_candidates", lambda cfg: [fresh])
    monkeypatch.setattr(w, "read_nova", lambda nid: {"status": "ERROR"})
    monkeypatch.setattr(w, "record_observation", lambda *a, **k: None)
    called = []
    monkeypatch.setattr(w, "recover", lambda *a, **k: called.append(a) or {})
    w.lambda_handler({}, None)
    assert called == []


def test_track_cleanup_marks_done_only_on_success(w, monkeypatch):
    """UI must not claim data removal until the workflow actually succeeded."""
    marks = []
    monkeypatch.setattr(w, "mark", lambda iid, owner, status, cleanup, reason, extra=None:
                        marks.append(cleanup))

    class Sfn:
        def __init__(self, status):
            self.status = status

        def describe_execution(self, **kwargs):
            return {"status": self.status}

    record_ = {"instance_id": "i-1", "recovery_status": "CLEANUP_REQUESTED",
               "recovery_execution": "arn:exec", "recovery_owner": "owner-1"}

    monkeypatch.setattr(w, "SESSION", type("S", (), {"client": lambda s, n, **k: Sfn("RUNNING")})())
    assert w.track_cleanup(record_, {"live": True}) == "CLEANUP_REQUESTED"
    assert marks == []

    monkeypatch.setattr(w, "SESSION", type("S", (), {"client": lambda s, n, **k: Sfn("SUCCEEDED")})())
    assert w.track_cleanup(record_, {"live": True}) == "CLEANUP_DONE"
    assert marks == ["CLEANUP_DONE"]

    marks.clear()
    monkeypatch.setattr(w, "SESSION", type("S", (), {"client": lambda s, n, **k: Sfn("FAILED")})())
    assert w.track_cleanup(record_, {"live": True}) == "CLEANUP_FAILED"
    assert marks == ["CLEANUP_FAILED"]


def test_track_cleanup_is_read_only_in_observe_mode(w, monkeypatch):
    marks = []
    monkeypatch.setattr(w, "mark", lambda *a, **k: marks.append(a))
    monkeypatch.setattr(w, "SESSION", type("S", (), {
        "client": lambda s, n, **k: type("F", (), {"describe_execution": lambda self, **kw:
                                                   {"status": "SUCCEEDED"}})()})())
    record_ = {"instance_id": "i-1", "recovery_status": "CLEANUP_REQUESTED",
               "recovery_execution": "arn:exec"}
    assert w.track_cleanup(record_, {"live": False}) == "CLEANUP_DONE"
    assert marks == []


def test_track_cleanup_ignores_records_not_in_cleanup(w, monkeypatch):
    assert w.track_cleanup({"instance_id": "i-1"}, {"live": True}) is None


def test_repair_maps_stopped_nova_to_stopped(monkeypatch):
    module = worker()
    updates = []

    class Table:
        def update_item(self, **kwargs):
            updates.append(kwargs)

    class Sess:
        def client(self, name, **kwargs):
            return Table()

    monkeypatch.setattr(module, "SESSION", Sess())
    result = module.repair({"instance_id": "i-1", "current_status": "RUNNING"},
                           {"status": "SHUTOFF"}, "drift")
    assert result["repaired_to"] == "STOPPED"
    assert updates[0]["ConditionExpression"] == "current_status = :expected"


def test_repair_never_deletes_and_guards_concurrent_action(monkeypatch):
    module = worker()

    class Table:
        def update_item(self, **kwargs):
            raise RuntimeError("ConditionalCheckFailedException")

    class Sess:
        def client(self, name, **kwargs):
            return Table()

    monkeypatch.setattr(module, "SESSION", Sess())
    assert module.repair({"instance_id": "i-1", "current_status": "RUNNING"},
                         {"status": "SHUTOFF"}, "drift") is None


def test_recover_skips_when_lease_is_taken(w, monkeypatch):
    monkeypatch.setattr(w, "claim", lambda iid, status: None)
    result = w.recover(rec(), "reason")
    assert result["cleanup_status"] == "SKIPPED_BUSY"
