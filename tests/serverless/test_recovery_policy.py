"""Rules that decide whether a broken instance may be destroyed (XR-RISK-002/004).

These tests are the safety boundary for auto-cleanup: getting them wrong deletes a
user's VM. They assert that unclear conditions never turn into DELETE.
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "serverless" / "launch-contract"
POLICY_PATH = ROOT / "XRegion-InstanceRecovery" / "recovery_policy.py"

NOW = 1_800_000_000
POLICY = {"min_age_s": 1800, "max_delete_per_run": 1}
HEALTHY = {"infra_ok": True, "api_error": None}
SICK = {"infra_ok": False, "api_error": "Nova timeout"}


def policy_module():
    spec = importlib.util.spec_from_file_location("recovery_policy", POLICY_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = policy_module()


def record(**overrides):
    base = {"instance_id": "i-1", "current_status": "RUNNING", "active_nova_id": "nova-1",
            "last_migration_timestamp": NOW - 60, "migration_lock": False}
    base.update(overrides)
    return base


def nova(status):
    return {"nova_id": "nova-1", "instance_id": "i-1", "status": status}


def classify(rec, nv, health=HEALTHY, policy=POLICY):
    return P.classify(rec, nv, health, policy, now=NOW)


def test_healthy_running_instance_is_skipped():
    assert classify(record(), nova("ACTIVE"))[0] == P.SKIP


def test_failed_record_is_recoverable_candidate():
    """FAILED is the application's own verdict, so it is a delete candidate (worker still
    requires the verdict to be durable)."""
    record_ = record(current_status="FAILED", last_failure_at=NOW - 60)
    decision, reason, _ = classify(record_, nova("ACTIVE"))
    assert decision == P.DELETE
    assert "FAILED" in reason


def test_user_stopped_vm_is_never_deleted():
    """STOPPED/SHUTOFF is a user choice, not a fault."""
    for status in ("STOPPED", "SHUTOFF", "SHELVED", "SHELVED_OFFLOADED"):
        assert classify(record(current_status="STOPPED"), nova(status))[0] == P.SKIP


def test_infrastructure_outage_holds_everything():
    """If OpenStack is unreachable we cannot judge, so nothing is destroyed."""
    assert classify(record(current_status="PENDING"), nova("ERROR"), health=SICK)[0] == P.HOLD


def test_nova_error_old_enough_is_deleted():
    rec = record(current_status="FAILED", last_failure_at=NOW - 3600)
    decision, reason, _ = classify(rec, nova("ERROR"))
    assert decision == P.DELETE
    assert "quá" in reason


def test_nova_error_recent_is_only_observed():
    rec = record(current_status="FAILED", last_failure_at=NOW - 30)
    assert classify(rec, nova("ERROR"))[0] == P.OBSERVE


def test_nova_error_without_timestamp_is_not_deleted():
    """No timestamp means we cannot prove the fault is durable: observe, never delete."""
    rec = record(current_status="FAILED", last_failure_at=None, last_migration_timestamp=None)
    assert classify(rec, nova("ERROR"))[0] == P.OBSERVE


def test_missing_nova_row_repairs_instead_of_deleting():
    """A missing bookkeeping row must never destroy a possibly working VM."""
    old = record(last_migration_timestamp=NOW - 3600)
    assert classify(old, None)[0] == P.REPAIR
    # Recent bookkeeping gaps stay observational rather than being acted on.
    assert classify(record(), None)[0] == P.OBSERVE
    # Either way it is never DELETE.
    assert classify(record(), None)[0] != P.DELETE


def test_running_record_with_stopped_nova_is_repaired():
    decision, reason, _ = classify(record(), nova("SHUTOFF"))
    assert decision == P.REPAIR
    assert "SHUTOFF" in reason


def test_stuck_pending_old_enough_is_repaired_not_deleted():
    rec = record(current_status="PENDING", last_migration_timestamp=NOW - 3600)
    assert classify(rec, nova("ACTIVE"))[0] == P.REPAIR


def test_pending_without_nova_is_repaired():
    rec = record(current_status="PENDING", active_nova_id="", last_migration_timestamp=NOW - 3600)
    assert classify(rec, None)[0] == P.REPAIR


def test_recent_pending_is_only_observed():
    rec = record(current_status="PENDING", last_migration_timestamp=NOW - 10)
    assert classify(rec, nova("ACTIVE"))[0] == P.OBSERVE


def test_migration_lock_blocks_any_action():
    rec = record(current_status="FAILED", migration_lock=True, last_failure_at=NOW - 9999)
    assert classify(rec, nova("ERROR"))[0] == P.HOLD


def test_migrating_status_blocks_any_action():
    rec = record(current_status="MIGRATING", last_failure_at=NOW - 9999)
    assert classify(rec, nova("ERROR"))[0] == P.HOLD


def test_unknown_status_is_observed_not_deleted():
    assert classify(record(current_status=""), nova("ACTIVE"))[0] == P.OBSERVE


def test_summarize_counts_decisions():
    counts = P.summarize([(P.SKIP, "", {}), (P.SKIP, "", {}), (P.DELETE, "", {})])
    assert counts == {P.SKIP: 2, P.DELETE: 1}
