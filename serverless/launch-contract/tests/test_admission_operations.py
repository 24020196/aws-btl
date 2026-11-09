import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from unittest import TestCase, mock

DEPLOYMENT = Path(__file__).resolve().parents[1] / "deployment"


class AdmissionOperationTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        sys.path.insert(0, str(DEPLOYMENT))
        self.addCleanup(lambda: sys.path.remove(str(DEPLOYMENT)))
        spec = importlib.util.spec_from_file_location("size_admission_tests", DEPLOYMENT / "size_admission.py")
        self.h = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.h)
        self.x = mock.MagicMock()
        self.x.directory = Path(self.directory.name)

    def test_existing_launch_marker_prevents_post_and_config_mutation(self):
        (self.x.directory / "backend-launch-attempt.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "already attempted"):
            self.h.launch(self.x)
        self.x.call.assert_not_called()

    def test_incomplete_verification_cannot_open_admission(self):
        (self.x.directory / "final-verification.json").write_text("{}")
        with mock.patch.object(self.h, "no_running"), self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.h.finish(self.x)
        self.x.call.assert_not_called()

    def test_failed_termination_cannot_replenish_pool(self):
        (self.x.directory / "canary-terminate-status.json").write_text(json.dumps({"status": "FAILED"}))
        with mock.patch.object(self.h, "no_running"), self.assertRaisesRegex(RuntimeError, "cleanup"):
            self.h.replenish(self.x)
        self.x.call.assert_not_called()

    def test_json_lvm_inventory_ignores_non_inventory_uuid(self):
        import lifecycle
        vid = "80dbbd15-f606-4f06-8ca0-a24011355b4e"
        other = "33333333-3333-4333-8333-333333333333"
        baseline = "LOOP_RO=0\n" + json.dumps({"report": [{"lv": [{"lv_name": "volume-" + vid}]}]})
        baseline += "\n" + json.dumps({"description": "volume-" + other})
        self.assertEqual(lifecycle.pool_volume_delta(baseline, [vid, other]), [other])
