"""Unit test SPEC-02 §5 cho XRegion-EIPPoolManager."""
import os
import sys
import unittest
from unittest import mock

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-southeast-2")
sys.path.insert(0, os.path.dirname(__file__))
import eip_pool_manager as m  # noqa: E402


def spare_addr(alloc, idle):
    return {"AllocationId": alloc, "PublicIp": alloc + "-ip",
            "Tags": [{"Key": "Project", "Value": "xregion"},
                     {"Key": "IdleSince", "Value": str(idle)}]}


def attached_addr(alloc):
    return {"AllocationId": alloc, "PublicIp": alloc + "-ip", "AssociationId": "eipassoc-" + alloc,
            "NetworkInterfaceId": "eni-1", "Tags": [{"Key": "Project", "Value": "xregion"}]}


class EipPoolManagerTest(unittest.TestCase):
    def run_with(self, addresses):
        ec2 = mock.Mock()
        ec2.describe_addresses.return_value = {"Addresses": addresses}
        ec2.allocate_address.return_value = {"AllocationId": "new", "PublicIp": "new-ip"}
        with mock.patch.object(m, "ec2_client", ec2), mock.patch.object(m, "dynamodb", mock.Mock()):
            result = m.lambda_handler({}, None)
        return ec2, result

    def test_pool_size_under_limit(self):
        for count in (1, 2):
            addresses = [spare_addr(f"a{i}", 100 + i) for i in range(count)]
            ec2, result = self.run_with(addresses)
            ec2.release_address.assert_not_called()
            self.assertEqual(result["released"], [])

    def test_pool_size_exceeded_fifo_purge(self):
        addresses = [spare_addr(f"a{i}", 100 + i) for i in range(5)]
        ec2, result = self.run_with(list(reversed(addresses)))
        released = [c.kwargs["AllocationId"] for c in ec2.release_address.call_args_list]
        self.assertEqual(released, ["a0", "a1", "a2"])
        self.assertEqual([s["allocation_id"] for s in result["spare_eips"]], ["a3", "a4"])
        self.assertEqual(result["status"], "PURGED_TO_LIMIT")

    def test_attached_resources_ignored(self):
        addresses = [attached_addr(f"in{i}") for i in range(4)] + [spare_addr("a0", 1), spare_addr("a1", 2)]
        ec2, result = self.run_with(addresses)
        ec2.release_address.assert_not_called()
        self.assertEqual(result["associated_count"], 4)
        self.assertEqual(result["status"], "SUFFICIENT")


if __name__ == "__main__":
    unittest.main()
