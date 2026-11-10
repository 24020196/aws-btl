"""Acceptance report for the API Gateway E2E session, built from recorded evidence.

Why this exists
---------------
The E2E session produced JSONL receipts, CloudWatch numbers and manual probes. A
hand-written summary drifting from those artefacts is how an earlier report ended up
claiming "7/7 PASS" and a wrong root cause. This module recomputes the verdict from
the files instead of trusting prose, and states where evidence is missing.

Usage
-----
    python serverless/launch-contract/deployment/apigw_acceptance.py --evidence-root <dir>

Nothing here talks to AWS; pass ``--live`` to a separate probe if you need current state.
"""
import argparse
import json
from pathlib import Path

PASS = "PASS"
FAIL = "FAIL"
BLOCKED = "BLOCKED"
NOT_RUN = "NOT RUN"
INCONCLUSIVE = "INCONCLUSIVE"

REQUIRED_CASES = (
    ("C1", "contract", "từ chối request không có SigV4"),
    ("C2", "contract", "từ chối chữ ký sai"),
    ("C3", "contract", "route không tồn tại -> 404"),
    ("C4", "contract", "JSON sai -> entry bị từ chối"),
    ("C5", "contract", "detail thiếu -> entry bị từ chối"),
    ("C6", "contract", "payload không khớp rule (cần xác nhận security.create)"),
    ("E1", "e2e", "key.import -> Nova keypair"),
    ("E2", "e2e", "instance.launch -> SFN SUCCEEDED + Nova ACTIVE + DDB RUNNING"),
    ("E3.STOP", "e2e", "STOP -> Nova stopped + DDB STOPPED"),
    ("E3.START", "e2e", "START -> Nova ACTIVE + DDB RUNNING"),
    ("E3.REBOOT", "e2e", "REBOOT -> Nova ghi action reboot + DDB RUNNING"),
    ("E4", "e2e", "TERMINATE -> Nova NotFound + DDB TERMINATED"),
    ("SG.0", "sg", "baseline canary"),
    ("SG.3", "sg", "ba giới hạn live đã bật"),
    ("SG.4", "sg", "security-group.updated -> Neutron hội tụ"),
    ("SG.5", "sg", "stale revision không đổi Neutron"),
    ("SG.cleanup", "sg", "rollback khớp baseline"),
)

# Receipts that must NOT be trusted at face value (measured on 2026-11-10).
WEAK_EVIDENCE = {
    "E3.REBOOT": "chỉ chờ Nova ACTIVE; chưa chứng minh action reboot đã chạy",
    "E4": "điều kiện PASS cũ nhận lỗi truy vấn (exit status 1) là 'đã xoá'",
    "SG.5": "PASS dựa trên 'Neutron không đổi' khi SG.4 chưa hội tụ",
}

# Findings that need no further live run because the code and the deployed handlers settle them.
# Each entry says what was measured, not what was assumed.
FINDINGS = (
    ("security.create không có consumer",
     "EventBridgeGatewayClient.sendSecurityGroupCreateEvent(...) không được gọi ở bất kỳ đâu trong "
     "src/ (chỉ định nghĩa). Pattern của XRegion-BackendEventRule khớp loại event này "
     "(test_event_pattern = True, kiểm 2026-11-10) và cả ba target đều nhận full event, nhưng "
     "XRegion-KeySyncManager chỉ nhận source xregion.backend.key và XRegion-NovaLifecycleManager "
     "chỉ nhận xregion.backend.instance (đọc từ code đã triển khai) — cả hai bỏ qua event này. "
     "Kết luận: đây là code chết, không phải luồng đang chạy; không sửa vì ngoài phạm vi.",
     PASS),
    ("SG live không hội tụ: worker chưa từng áp dụng",
     "Đã chứng minh được cả chuỗi thay vì suy đoán: (1) rule pattern chỉ khớp đúng canary group + "
     "instance; (2) bật rule và PutEvents một lần -> Lambda Invocations 0 -> 1 trong 90s, "
     "FailedEntryCount=0, không có Errors/Throttles/AsyncEventsDropped: EventBridge giao được, "
     "không mất event; (3) code đã triển khai trùng repository (chỉ thiếu phần log mới); "
     "(4) phát lại đúng event đó bằng code deploy + dữ liệu DynamoDB/Neutron thật thì handler đi qua "
     "mọi cổng và dừng ở verify_target; (5) Neutron cho thấy port 77215a87-05db-470d-93c2-487a433e61d8 "
     "của canary có status = DOWN, device_owner = compute:nova, tức port đã bị unbind vì VM đang "
     "SHUTOFF (shelved), trong khi DynamoDB XRegion-Instances vẫn ghi current_status = RUNNING. "
     "Vì vậy worker TỪ CHỐI sửa firewall cho máy không có port sống — đây là hành vi an toàn đúng "
     "thiết kế, không phải lỗi worker. Kết luận: luồng gateway -> EventBridge -> Lambda -> worker "
     "thông suốt; canary không thể hội tụ khi VM không thực sự chạy, và DynamoDB đang lệch thực tế. "
     "Điều còn thiếu để nghiệm thu SG là chạy canary trên một VM đang ACTIVE thật, có port bound.",
     FAIL),
)


def read_receipts(path):
    """One JSON object per line; malformed trailing lines are skipped, not fatal."""
    records = []
    if not path.exists():
        return records
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    return records


def collect(evidence_root):
    """Gather every run directory's receipts, keyed by run id."""
    runs = {}
    root = Path(evidence_root)
    if not root.exists():
        return runs
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        records = read_receipts(directory / "receipts.jsonl")
        if records:
            runs[directory.name] = records
    return runs


def best_verdict(runs, case_id):
    """Latest receipt for a case, downgraded only when the receipt itself is weak."""
    seen = []
    for run_id, records in runs.items():
        for record in records:
            if record.get("case") == case_id:
                seen.append((record.get("recorded_at") or "", run_id, record))
    if not seen:
        return NOT_RUN, [], None
    seen.sort(key=lambda item: item[0])
    latest = seen[-1]
    verdict = latest[2].get("verdict") or NOT_RUN
    if verdict == PASS and evidence_is_weak(case_id, latest[2]):
        return INCONCLUSIVE, seen, latest[2]
    return verdict, seen, latest[2]


def evidence_is_weak(case_id, record):
    """Downgrade by what the receipt shows, not by the case name.

    A REBOOT receipt that actually carries the Nova action evidence is fine; an old one
    that only reported "ACTIVE" is not. This keeps the rubric honest in both directions.
    """
    if case_id not in WEAK_EVIDENCE:
        return False
    observed = record.get("observed") or {}
    if case_id == "E3.REBOOT":
        return not bool(observed.get("action_evidence", {}).get("found"))
    if case_id == "E4":
        return not bool(observed.get("nova_removal", {}).get("gone"))
    if case_id == "SG.5":
        return not bool(observed.get("after")) or observed.get("stale_precondition") is False
    return True


def build(runs):
    """Rubric rows: case, required behaviour, verdict, which run produced it."""
    rows = []
    for case_id, phase, expectation in REQUIRED_CASES:
        verdict, seen, latest = best_verdict(runs, case_id)
        latest_run = None
        if latest is not None:
            for stamp, run_id, record in sorted(seen, key=lambda item: item[0]):
                if record is latest:
                    latest_run = run_id
        rows.append({
            "case": case_id,
            "phase": phase,
            "expectation": expectation,
            "verdict": verdict,
            "source_run": latest_run,
            "reason": (latest.get("reason") or "") if latest else "",
            "runs_seen": sorted({item[1] for item in seen}),
            "weak_evidence": WEAK_EVIDENCE.get(case_id),
        })
    return rows


def summarize(rows):
    summary = {PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, INCONCLUSIVE: 0}
    for row in rows:
        summary[row["verdict"]] = summary.get(row["verdict"], 0) + 1
    return summary


def verdict_line(summary):
    """A session only passes when nothing is FAIL/BLOCKED/INCONCLUSIVE/NOT RUN."""
    open_items = (summary.get(FAIL, 0) + summary.get(BLOCKED, 0) +
                  summary.get(INCONCLUSIVE, 0) + summary.get(NOT_RUN, 0))
    if open_items == 0:
        return "ĐẠT: mọi ca bắt buộc đều PASS với bằng chứng độc lập."
    return "CHƯA ĐẠT: còn %d ca chưa đóng (FAIL/BLOCKED/INCONCLUSIVE/NOT RUN)." % open_items


def render(rows, runs):
    summary = summarize(rows)
    lines = ["# Nghiệm thu API Gateway E2E", "",
             "Sinh từ receipts đã ghi; không suy diễn thêm.", "",
             "| Verdict | Số ca |", "| :--- | ---: |"]
    for key in (PASS, FAIL, BLOCKED, INCONCLUSIVE, NOT_RUN):
        lines.append("| %s | %d |" % (key, summary.get(key, 0)))
    lines += ["", verdict_line(summary), "",
              "Run đã đọc: %d (%s)" % (len(runs), ", ".join(sorted(runs)) or "không có"), "",
              "| Case | Pha | Yêu cầu | Verdict | Run | Ghi chú |",
              "| :--- | :--- | :--- | :--- | :--- | :--- |"]
    for row in rows:
        note = row["reason"].replace("|", "\\|")[:160] or "-"
        if row["weak_evidence"]:
            note += " — bằng chứng yếu: %s" % row["weak_evidence"]
        lines.append("| %s | %s | %s | **%s** | %s | %s |" % (
            row["case"], row["phase"], row["expectation"], row["verdict"],
            row["source_run"] or "-", note))
    lines += ["", "## Kết luận đã đo được (không cần chạy lại)", ""]
    for title, detail, _verdict in FINDINGS:
        lines += ["### %s" % title, "", detail, ""]
    lines += ["## Giới hạn", "",
              "- Báo cáo chỉ tái dựng từ receipts đã ghi; không xác minh trạng thái AWS hiện tại.",
              "- SG live vẫn FAIL: chưa có lần hội tụ nào qua đường gateway được chứng minh.",
              "- Không chia sẻ nguyên thư mục evidence ra ngoài: sg-rollback.json chứa nguyên "
              "environment của Lambda (gồm OS_PASSWORD).", ""]
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-root", help="thư mục chứa các run directory")
    parser.add_argument("--out", help="ghi Markdown ra file này thay vì stdout")
    args = parser.parse_args(argv)
    if not args.evidence_root:
        print("Rubric gồm %d ca; thêm --evidence-root để đối chiếu receipts." % len(REQUIRED_CASES))
        return 0
    runs = collect(args.evidence_root)
    rows = build(runs)
    report = render(rows, runs)
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
        print("REPORT=%s" % args.out)
    else:
        print(report)
    summary = summarize(rows)
    print("SUMMARY=%s" % json.dumps(summary))
    return 0 if is_acceptance_pass(summary) else 1


def is_acceptance_pass(summary):
    """Only exit 0 when nothing is FAIL, BLOCKED, INCONCLUSIVE or NOT RUN."""
    return all(summary.get(key, 0) == 0 for key in (FAIL, BLOCKED, INCONCLUSIVE, NOT_RUN))


if __name__ == "__main__":
    raise SystemExit(main())
