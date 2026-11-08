"""Offline checksums plus resource-schema/dependency checks; no stack creation."""
import argparse
from collections import Counter
import graphlib
import hashlib
import json
from pathlib import Path
import sys

import boto3
from jsonschema import Draft7Validator, validators


def intrinsic(value):
    return isinstance(value, dict) and any(k == "Ref" or k.startswith("Fn::") for k in value)


def wrapped(check):
    def validate(validator, constraint, instance, schema):
        if not intrinsic(instance):
            yield from check(validator, constraint, instance, schema)
    return validate


Validator = validators.extend(Draft7Validator, {k: wrapped(v) for k, v in Draft7Validator.VALIDATORS.items()})


def references(node):
    result = set()
    if isinstance(node, dict):
        if "Ref" in node:
            result.add(node["Ref"])
        if "Fn::GetAtt" in node:
            value = node["Fn::GetAtt"]
            result.add(value[0] if isinstance(value, list) else value.split(".")[0])
        for value in node.values():
            result.update(references(value))
    elif isinstance(node, list):
        for value in node:
            result.update(references(value))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--fetch-schemas", action="store_true", help="Read any missing public schemas from AWS")
    parser.add_argument("--verify-only", action="store_true", help="Verify the sealed backup without changing files or calling AWS")
    args = parser.parse_args()
    root = args.snapshot
    if args.verify_only:
        expected = json.loads((root / "SHA256SUMS.json").read_text())
        bad = [name for name, digest in expected.items() if not (root / name).is_file() or hashlib.sha256((root / name).read_bytes()).hexdigest() != digest]
        print(json.dumps({"files_checked": len(expected), "invalid_files": bad}))
        return 1 if bad else 0
    template = json.loads((root / "restore/template.json").read_text())
    resources = template["Resources"]
    errors = []
    client = None
    schemas = {}
    for typ in sorted({r["Type"] for r in resources.values()}):
        path = root / "resource-schemas" / (typ.replace("::", "-") + ".json")
        if not path.exists() and args.fetch_schemas:
            client = client or boto3.client("cloudformation", region_name="ap-southeast-2")
            path.write_text(client.describe_type(Type="RESOURCE", TypeName=typ)["Schema"], encoding="utf-8")
        if path.exists():
            schemas[typ] = json.loads(path.read_text())
        else:
            errors.append({"type": typ, "error": "No local resource schema"})
    graph = {}
    params = set(template["Parameters"])
    for lid, resource in resources.items():
        if resource["Type"] in schemas:
            for error in Validator(schemas[resource["Type"]]).iter_errors(resource["Properties"]):
                errors.append({"resource": lid, "path": list(error.path), "error": error.message})
        refs = references(resource.get("Properties", {}))
        missing = refs - set(resources) - params - {"AWS::AccountId", "AWS::Region", "AWS::Partition", "AWS::NoValue", "AWS::StackName", "AWS::URLSuffix"}
        for value in missing:
            errors.append({"resource": lid, "error": "Unresolved reference " + value})
        depends = resource.get("DependsOn", [])
        graph[lid] = (refs & set(resources)) | set([depends] if isinstance(depends, str) else depends)
    try:
        order = list(graphlib.TopologicalSorter(graph).static_order())
    except graphlib.CycleError as error:
        errors.append({"error": "Dependency cycle", "cycle": error.args[1]})
        order = []
    checksums = {str(p.relative_to(root)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in root.rglob("*") if p.is_file() and p.name not in {"SHA256SUMS.json", "validation.json"}}
    (root / "SHA256SUMS.json").write_text(json.dumps(checksums, indent=2) + "\n", encoding="utf-8")
    report = {"resources": len(resources), "by_type": dict(Counter(r["Type"] for r in resources.values())),
              "schema_and_dependency_errors": errors, "deployment_order": order,
              "cloudformation_stack_created": False, "live_deployment_tested": False,
              "cfn_lint": "not installed", "cfn_guard": "not installed; security compliance not evaluated",
              "template_bytes": (root / "restore/template.json").stat().st_size,
              "checksummed_files": len(checksums)}
    (root / "validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"resources": len(resources), "errors": errors, "checksummed_files": len(checksums)}, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
