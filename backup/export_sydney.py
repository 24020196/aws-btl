"""Read-only AWS export. Snapshots contain private environment configuration."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import zipfile

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DEFAULT_REGION = "ap-southeast-2"
ACCOUNT = "291634989063"
REGION_PREFIX = {
    "ap-southeast-2": "sydney",
    "us-east-1": "virginia",
}


class Exporter:
    def __init__(self, root, region=DEFAULT_REGION):
        self.root = root
        self.region = region
        self.session = boto3.Session(region_name=region)
        self.clients = {}
        self.errors = []
        self.counts = {}
        self.roles = set()
        self.vpcs = set()
        self.layers = set()
        self.cfg = Config(connect_timeout=5, read_timeout=30,
                          retries={"total_max_attempts": 3, "mode": "standard"})

    def client(self, service):
        if service not in self.clients:
            self.clients[service] = self.session.client(service, config=self.cfg)
        return self.clients[service]

    def save(self, path, value):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(value, indent=2, default=str, ensure_ascii=False) + "\n", encoding="utf-8")

    def pages(self, service, operation, key, **kwargs):
        client = self.client(service)
        pages = client.get_paginator(operation).paginate(**kwargs) if client.can_paginate(operation) else [getattr(client, operation)(**kwargs)]
        return [item for page in pages for item in page.get(key, [])]

    def optional(self, path, service, operation, **kwargs):
        try:
            result = getattr(self.client(service), operation)(**kwargs)
            result.pop("ResponseMetadata", None)
            self.save(path, result)
            return result
        except ClientError as error:
            # Recording failures makes coverage auditable instead of reporting an incomplete export as complete.
            code = error.response["Error"]["Code"]
            self.errors.append({"path": path, "service": service, "operation": operation, "code": code})
            return None

    def lambdas(self):
        functions = [f for f in self.pages("lambda", "list_functions", "Functions") if "xregion" in f["FunctionName"].lower()]
        self.save("inventory/lambda.json", functions)
        self.counts["lambda"] = len(functions)
        client = self.client("lambda")
        for f in functions:
            name = f["FunctionName"]
            folder = f"lambda/{name}"
            response = client.get_function(FunctionName=name)
            config = response["Configuration"]
            self.save(f"{folder}/configuration.json", config)
            self.save(f"{folder}/tags.json", response.get("Tags", {}))
            self.roles.add(config["Role"])
            if config.get("VpcConfig", {}).get("VpcId"):
                self.vpcs.add(config["VpcConfig"]["VpcId"])
            self.layers.update(x["Arn"] for x in config.get("Layers", []))
            data = urllib.request.urlopen(response["Code"]["Location"], timeout=60).read()
            if base64.b64encode(hashlib.sha256(data).digest()).decode() != config["CodeSha256"]:
                raise RuntimeError(f"Lambda checksum mismatch: {name}")
            archive = self.root / folder / "deployed.zip"
            archive.write_bytes(data)
            with zipfile.ZipFile(archive) as package:
                for member in package.infolist():
                    target = (archive.parent / "source" / member.filename).resolve()
                    allowed = (archive.parent / "source").resolve()
                    if not target.is_relative_to(allowed):
                        raise ValueError("Unsafe Lambda archive entry")
                    if not member.is_dir():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(package.read(member))
            self.save(f"{folder}/aliases.json", self.pages("lambda", "list_aliases", "Aliases", FunctionName=name))
            versions = self.pages("lambda", "list_versions_by_function", "Versions", FunctionName=name)
            self.save(f"{folder}/versions.json", versions)
            for version in versions:
                if version["Version"] == "$LATEST":
                    continue
                deployed = client.get_function(FunctionName=name, Qualifier=version["Version"])
                content = urllib.request.urlopen(deployed["Code"]["Location"], timeout=60).read()
                if base64.b64encode(hashlib.sha256(content).digest()).decode() != version["CodeSha256"]:
                    raise RuntimeError("Published version checksum mismatch")
                (archive.parent / f"version-{version['Version']}.zip").write_bytes(content)
            self.optional(f"{folder}/resource-policy.json", "lambda", "get_policy", FunctionName=name)
            self.optional(f"{folder}/concurrency.json", "lambda", "get_function_concurrency", FunctionName=name)
            self.save(f"{folder}/event-invoke-configs.json", self.pages("lambda", "list_function_event_invoke_configs", "FunctionEventInvokeConfigs", FunctionName=name))
            self.save(f"{folder}/event-source-mappings.json", self.pages("lambda", "list_event_source_mappings", "EventSourceMappings", FunctionName=name))
            self.optional(f"{folder}/url.json", "lambda", "get_function_url_config", FunctionName=name)
        for arn in sorted(self.layers):
            layer = client.get_layer_version_by_arn(Arn=arn)
            path = "layers/" + arn.split(":layer:")[-1].replace(":", "-")
            self.save(path + ".json", {k: v for k, v in layer.items() if k != "Content"})
            data = urllib.request.urlopen(layer["Content"]["Location"], timeout=60).read()
            (self.root / (path + ".zip")).write_bytes(data)
        print(f"Lambda: {len(functions)} exported and verified", flush=True)

    def workflows(self):
        count = 0
        for machine in self.pages("stepfunctions", "list_state_machines", "stateMachines"):
            config = self.client("stepfunctions").describe_state_machine(stateMachineArn=machine["stateMachineArn"])
            if "xregion" not in json.dumps(config, default=str).lower():
                continue
            count += 1
            self.roles.add(config["roleArn"])
            self.save(f"stepfunctions/{machine['name']}/configuration.json", config)
            self.save(f"stepfunctions/{machine['name']}/definition.asl.json", json.loads(config["definition"]))
        self.counts["stepfunctions"] = count

    def tables(self):
        tables = [name for name in self.pages("dynamodb", "list_tables", "TableNames") if name.lower().startswith("xregion")]
        for name in tables:
            self.optional(f"dynamodb/{name}/schema.json", "dynamodb", "describe_table", TableName=name)
            self.optional(f"dynamodb/{name}/ttl.json", "dynamodb", "describe_time_to_live", TableName=name)
            self.optional(f"dynamodb/{name}/continuous-backups.json", "dynamodb", "describe_continuous_backups", TableName=name)
        self.counts["dynamodb"] = len(tables)

    def events(self):
        count = 0
        for bus in self.pages("events", "list_event_buses", "EventBuses"):
            selected = []
            for rule in self.pages("events", "list_rules", "Rules", EventBusName=bus["Name"]):
                targets = self.pages("events", "list_targets_by_rule", "Targets", Rule=rule["Name"], EventBusName=bus["Name"])
                if "xregion" not in json.dumps([rule, targets]).lower():
                    continue
                count += 1
                selected.append(rule)
                self.save(f"eventbridge/{bus['Name']}/{rule['Name']}/rule.json", rule)
                self.save(f"eventbridge/{bus['Name']}/{rule['Name']}/targets.json", targets)
                self.roles.update(t["RoleArn"] for t in targets if t.get("RoleArn"))
            if selected:
                self.optional(f"eventbridge/{bus['Name']}/bus.json", "events", "describe_event_bus", Name=bus["Name"])
        self.counts["eventbridge_rules"] = count

    def apis(self):
        account = self.optional("apigateway/account.json", "apigateway", "get_account")
        if account:
            self._find_roles(account)
        apis = [api for api in self.pages("apigateway", "get_rest_apis", "items") if "xregion" in api.get("name", "").lower()]
        for api in apis:
            aid = api["id"]
            self.save(f"apigateway/{aid}/api.json", api)
            stages = self.client("apigateway").get_stages(restApiId=aid)["item"]
            self.save(f"apigateway/{aid}/stages.json", stages)
            self.save(f"apigateway/{aid}/resources.json", self.pages("apigateway", "get_resources", "items", restApiId=aid, embed=["methods"]))
            self.save(f"apigateway/{aid}/authorizers.json", self.pages("apigateway", "get_authorizers", "items", restApiId=aid))
            self.save(f"apigateway/{aid}/gateway-responses.json", self.pages("apigateway", "get_gateway_responses", "items", restApiId=aid))
            for stage in stages:
                export = self.client("apigateway").get_export(restApiId=aid, stageName=stage["stageName"], exportType="swagger", parameters={"extensions": "integrations"})
                with export["body"] as stream:
                    body = stream.read()
                (self.root / f"apigateway/{aid}/{stage['stageName']}.swagger.json").write_bytes(body)
                self._find_roles(json.loads(body))
        self.counts["rest_apis"] = len(apis)

    def additional_inventory(self):
        checks = [("sns", "list_topics", "Topics"), ("sqs", "list_queues", "QueueUrls"),
                  ("ecr", "describe_repositories", "repositories"),
                  ("scheduler", "list_schedules", "Schedules"),
                  ("secretsmanager", "list_secrets", "SecretList")]
        for service, operation, key in checks:
            values = [x for x in self.pages(service, operation, key) if "xregion" in json.dumps(x, default=str).lower()]
            self.save(f"inventory/additional-{service}.json", values)
            if service == "sqs":
                self.counts["sqs_queues"] = len(values)
                for url in values:
                    self.optional(f"sqs/{url.rsplit('/', 1)[-1]}/attributes.json", "sqs", "get_queue_attributes", QueueUrl=url, AttributeNames=["All"])
                    self.optional(f"sqs/{url.rsplit('/', 1)[-1]}/tags.json", "sqs", "list_queue_tags", QueueUrl=url)
            elif service == "scheduler":
                self.counts["schedules"] = len(values)
                for sched in values:
                    detail = self.optional(
                        f"eventbridge/schedules/{sched['Name']}.json",
                        "scheduler",
                        "get_schedule",
                        Name=sched["Name"],
                        GroupName=sched.get("GroupName", "default"),
                    )
                    if detail and detail.get("Target", {}).get("RoleArn"):
                        self.roles.add(detail["Target"]["RoleArn"])
        buckets = []
        s3 = self.client("s3")
        for bucket in self.pages("s3", "list_buckets", "Buckets"):
            if "xregion" in bucket["Name"].lower():
                location = s3.get_bucket_location(Bucket=bucket["Name"]).get("LocationConstraint") or "us-east-1"
                if location == self.region:
                    buckets.append(bucket)
        self.save("inventory/additional-s3.json", buckets)

    def ssm(self):
        doc_count = 0
        doc = self.optional("ssm/documents/XRegion-NetworkGateway/description.json", "ssm", "describe_document", Name="XRegion-NetworkGateway")
        if doc:
            doc_count += 1
            self.optional("ssm/documents/XRegion-NetworkGateway/content.json", "ssm", "get_document", Name="XRegion-NetworkGateway")
        param_name = f"/xregion/{self.region}/launch/admission"
        param = self.optional("ssm/parameters/launch-admission.json", "ssm", "get_parameter", Name=param_name)
        self.counts["ssm_documents"] = doc_count
        self.counts["ssm_parameters"] = 1 if param else 0

    def _find_roles(self, node):
        if isinstance(node, dict):
            for value in node.values():
                self._find_roles(value)
        elif isinstance(node, list):
            for value in node:
                self._find_roles(value)
        elif isinstance(node, str) and node.startswith("arn:aws:iam:") and ":role/" in node:
            self.roles.add(node)

    def infrastructure(self):
        ec2 = self.client("ec2")
        instances = [
            i
            for r in self.pages("ec2", "describe_instances", "Reservations")
            for i in r["Instances"]
            if i["State"]["Name"] != "terminated"
        ]
        for i in instances:
            tags_lower = json.dumps(i.get("Tags", [])).lower()
            if (
                i["InstanceId"] in {"i-056d7f3dd24156234", "i-07738a186534cb5ba"}
                or "xregion" in tags_lower
                or "regiona-tempec2" in tags_lower
                or "regionb-tempec2" in tags_lower
            ):
                if i.get("VpcId"):
                    self.vpcs.add(i["VpcId"])
        instances = [i for i in instances if i.get("VpcId") in self.vpcs]
        self.save("ec2/instances.json", instances)
        self.counts["ec2_instances"] = len(instances)
        profile_names = [i["IamInstanceProfile"]["Arn"].split("/")[-1] for i in instances if i.get("IamInstanceProfile")]
        for name in set(profile_names):
            response = self.optional(f"iam/instance-profiles/{name}.json", "iam", "get_instance_profile", InstanceProfileName=name)
            if response:
                self.roles.update(r["Arn"] for r in response["InstanceProfile"]["Roles"])
        for op, key, filename in [("describe_vpcs", "Vpcs", "vpcs"), ("describe_subnets", "Subnets", "subnets"),
                                  ("describe_security_groups", "SecurityGroups", "security-groups"),
                                  ("describe_route_tables", "RouteTables", "route-tables"),
                                  ("describe_network_acls", "NetworkAcls", "network-acls"),
                                  ("describe_nat_gateways", "NatGateways", "nat-gateways"),
                                  ("describe_vpc_endpoints", "VpcEndpoints", "endpoints")]:
            filters = {"Filter" if op == "describe_nat_gateways" else "Filters": [{"Name": "vpc-id", "Values": sorted(self.vpcs)}]}
            self.save(f"ec2/{filename}.json", self.pages("ec2", op, key, **filters) if self.vpcs else [])
        self.save("ec2/internet-gateways.json", [g for g in self.pages("ec2", "describe_internet_gateways", "InternetGateways") if any(a["VpcId"] in self.vpcs for a in g.get("Attachments", []))])
        self.save("ec2/addresses.json", [a for a in ec2.describe_addresses()["Addresses"] if "xregion" in json.dumps(a.get("Tags", [])).lower()])
        self.save("ec2/network-interfaces.json", [n for n in self.pages("ec2", "describe_network_interfaces", "NetworkInterfaces") if n.get("VpcId") in self.vpcs])
        self.counts["vpcs"] = len(self.vpcs)
        for instance in instances:
            self.optional(f"ec2/user-data/{instance['InstanceId']}.json", "ec2", "describe_instance_attribute", InstanceId=instance["InstanceId"], Attribute="userData")

    def iam(self):
        for arn in sorted(self.roles):
            name = arn.split("/")[-1]
            self.optional(f"iam/roles/{name}/role.json", "iam", "get_role", RoleName=name)
            attached = self.pages("iam", "list_attached_role_policies", "AttachedPolicies", RoleName=name)
            self.save(f"iam/roles/{name}/attached-policies.json", attached)
            for p in self.pages("iam", "list_role_policies", "PolicyNames", RoleName=name):
                self.optional(f"iam/roles/{name}/inline-{p}.json", "iam", "get_role_policy", RoleName=name, PolicyName=p)
            for p in attached:
                policy = self.client("iam").get_policy(PolicyArn=p["PolicyArn"])["Policy"]
                self.save(f"iam/policies/{policy['PolicyId']}/policy.json", policy)
                self.optional(f"iam/policies/{policy['PolicyId']}/document.json", "iam", "get_policy_version", PolicyArn=policy["Arn"], VersionId=policy["DefaultVersionId"])
            self.optional(f"iam/roles/{name}/tags.json", "iam", "list_role_tags", RoleName=name)
        self.counts["iam_roles"] = len(self.roles)

    def monitoring(self):
        groups = [g for g in self.pages("logs", "describe_log_groups", "logGroups") if "xregion" in g["logGroupName"].lower()]
        self.save("cloudwatch/log-groups.json", groups)
        for index, group in enumerate(groups):
            self.save(f"cloudwatch/subscriptions-{index}.json", self.pages("logs", "describe_subscription_filters", "subscriptionFilters", logGroupName=group["logGroupName"]))
        alarms = self.client("cloudwatch").describe_alarms()
        self.save("cloudwatch/alarms.json", {k: [a for a in alarms.get(k, []) if "xregion" in json.dumps(a, default=str).lower()] for k in ["MetricAlarms", "CompositeAlarms"]})
        tagged = [v for v in self.pages("resourcegroupstaggingapi", "get_resources", "ResourceTagMappingList") if "xregion" in json.dumps(v).lower()]
        self.save("inventory/tagged-resources.json", tagged)
        self.counts["log_groups"] = len(groups)

    def run(self):
        identity = self.client("sts").get_caller_identity()
        if identity["Account"] != ACCOUNT:
            raise RuntimeError("Wrong account; export refused")
        self.save("identity.json", identity)
        for step in [self.lambdas, self.workflows, self.tables, self.events, self.apis, self.infrastructure, self.ssm, self.iam, self.monitoring, self.additional_inventory]:
            print(step.__name__, flush=True)
            step()
        checksums = {str(p.relative_to(self.root)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in self.root.rglob("*") if p.is_file()}
        self.save("SHA256SUMS.json", checksums)
        self.save("manifest.json", {"account": ACCOUNT, "region": self.region, "counts": self.counts,
                  "read_errors_or_absent_optional_features": self.errors,
                  "database_items_exported": False, "ebs_included": False, "ebs_snapshots_created": False,
                  "source": "live AWS deployed resources; phase1 candidate excluded"})
        print(json.dumps(self.counts), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default=DEFAULT_REGION, help="AWS region to export (e.g. ap-southeast-2, us-east-1)")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume", action="store_true", help="Retry a retained partial export")
    args = parser.parse_args()
    prefix = REGION_PREFIX.get(args.region, args.region)
    output = args.output or Path(__file__).parent / "snapshots" / datetime.now(timezone.utc).strftime(f"{prefix}-%Y%m%dT%H%M%SZ")
    if output.exists() and not args.resume:
        raise SystemExit("Output already exists; choose a new directory")
    output.mkdir(parents=True, exist_ok=args.resume)
    try:
        Exporter(output, region=args.region).run()
    except Exception:
        print(f"Partial export retained at {output}", file=sys.stderr)
        raise
    print(f"BACKUP={output.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
