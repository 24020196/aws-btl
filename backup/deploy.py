"""Preview recovery by default. --apply uploads artifacts and creates a new stack."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import boto3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--artifact-bucket", required=True)
    parser.add_argument("--artifact-prefix")
    parser.add_argument("--stack-name", default="XRegion-Recovery")
    parser.add_argument("--parameters-file", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.snapshot.resolve()
    verify = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("validate_snapshot.py")), str(root), "--verify-only"])
    if verify.returncode:
        return verify.returncode
    manifest = json.loads((root / "manifest.json").read_text())
    template = json.loads((root / "restore/template.json").read_text())
    functions = list((root / "lambda").glob("*/deployed.zip"))
    prefix = args.artifact_prefix or "xregion-backup/" + root.name
    print(f"Recovery plan: {len(functions)} Lambda packages, {len(template['Resources'])} resources; Sydney; EBS excluded.")
    if not args.apply:
        print("Preview only; no upload, AWS change or stack creation performed.")
        return 0
    if manifest["region"] != "ap-southeast-2":
        raise ValueError("Expected a Sydney backup")
    session = boto3.Session(region_name="ap-southeast-2")
    if session.client("sts").get_caller_identity()["Account"] != manifest["account"]:
        raise ValueError("AWS account does not match the backup")
    parameters = {p["ParameterKey"]: p["ParameterValue"] for p in json.loads((root / "restore/private-parameters.json").read_text())}
    if args.parameters_file:
        parameters.update({p["ParameterKey"]: p["ParameterValue"] for p in json.loads(args.parameters_file.read_text(encoding="utf-8-sig"))})
    parameters.update(ArtifactBucket=args.artifact_bucket, ArtifactPrefix=prefix)
    for name, definition in template["Parameters"].items():
        if name not in parameters and "Default" not in definition:
            raise ValueError("Missing parameter " + name)
    unknown = set(parameters) - set(template["Parameters"])
    if unknown:
        raise ValueError("Unknown parameters: " + ", ".join(sorted(unknown)))
    s3 = session.client("s3")
    if s3.get_bucket_location(Bucket=args.artifact_bucket).get("LocationConstraint") != "ap-southeast-2":
        raise ValueError("Artifact bucket must be in Sydney")
    for archive in functions:
        s3.upload_file(str(archive), args.artifact_bucket, prefix + "/" + archive.parent.name + ".zip")
    key = prefix + "/restore-template.json"
    s3.upload_file(str(root / "restore/template.json"), args.artifact_bucket, key)
    response = session.client("cloudformation").create_stack(
        StackName=args.stack_name,
        TemplateURL=f"https://{args.artifact_bucket}.s3.ap-southeast-2.amazonaws.com/{key}",
        Parameters=[{"ParameterKey": k, "ParameterValue": str(v)} for k, v in parameters.items()],
        Capabilities=["CAPABILITY_NAMED_IAM"],
    )
    print("Stack creation submitted:", response["StackId"])
    print("Monitor CloudFormation completion before admitting application traffic.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
