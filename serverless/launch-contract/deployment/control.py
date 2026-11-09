"""Deployment/diagnostic helpers. Runtime artifacts always live in OS Temp."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import time

import boto3


ACCOUNT = "291634989063"
REGION = "ap-southeast-2"
HOST = "i-056d7f3dd24156234"
ENI = "eni-091eaee3e69e3f42d"
ROOT = Path(__file__).resolve().parents[1]


class Deployment:
    def __init__(self, directory, profile="btl"):
        self.directory = Path(directory).resolve()
        temp = Path(os.environ.get("TEMP", "/tmp")).resolve()
        if not self.directory.is_relative_to(temp):
            raise ValueError("Deployment artifacts must be under OS Temp")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.session = boto3.Session(profile_name=profile, region_name=REGION)
        if self.session.client("sts").get_caller_identity()["Account"] != ACCOUNT:
            raise ValueError("Unexpected AWS account")
        self.clients = {}

    def client(self, service):
        if service not in self.clients:
            self.clients[service] = self.session.client(service)
        return self.clients[service]

    def log(self, operation, status, **fields):
        record = dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      schema_version=1, operation=operation, status=status, **fields)
        with (self.directory / "operations.jsonl").open("a", encoding="utf-8") as out:
            out.write(json.dumps(record, default=str) + "\n")

    def call(self, service, operation, **kwargs):
        self.log(f"{service}.{operation}", "STARTED")
        try:
            result = getattr(self.client(service), operation)(**kwargs)
        except Exception as error:
            self.log(f"{service}.{operation}", "FAILED", error_type=type(error).__name__)
            raise
        self.log(f"{service}.{operation}", "SUCCEEDED",
                 revision=result.get("RevisionId", result.get("revisionId")))
        return result

    def save(self, name, value):
        (self.directory / name).write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")

    def remote(self, script, label, timeout=120):
        r = self.call("ssm", "send_command", InstanceIds=[HOST],
                      DocumentName="AWS-RunShellScript", Parameters={
                          "commands": [script], "executionTimeout": [str(timeout)]},
                      TimeoutSeconds=60)
        cid = r["Command"]["CommandId"]
        self.log(label, "DISPATCHED", ssm_command_id=cid)
        deadline = time.monotonic() + timeout + 90
        while time.monotonic() < deadline:
            try:
                result = self.client("ssm").get_command_invocation(CommandId=cid, InstanceId=HOST)
            except self.client("ssm").exceptions.InvocationDoesNotExist:
                time.sleep(2)
                continue
            if result["Status"] not in ("Pending", "InProgress", "Delayed", "Cancelling"):
                self.save(label + ".json", result)
                self.log(label, result["Status"], ssm_command_id=cid)
                if result["Status"] != "Success":
                    raise RuntimeError(f"{label}: {result['Status']}: "
                                       f"{result.get('StandardErrorContent', '')[:500]}")
                return result["StandardOutputContent"]
            time.sleep(2)
        raise TimeoutError(f"SSM {label}: {cid}")


def checksum(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--remote-file")
    parser.add_argument("--label", default="remote")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    deploy = Deployment(args.directory)
    if args.remote_file:
        print(deploy.remote(Path(args.remote_file).read_text(encoding="utf-8"),
                            args.label, args.timeout))


if __name__ == "__main__":
    main()
