"""Build recovery IaC from the exported snapshot and live read-only resource models."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys

import boto3
from botocore.exceptions import ClientError


def logical(kind, identifier):
    return re.sub(r"[^A-Za-z0-9]", "", kind + identifier)[-170:] + hashlib.sha256(identifier.encode()).hexdigest()[:8]


class Builder:
    def __init__(self, root):
        self.root = root
        manifest_path = self.root / "manifest.json"
        self.region = json.loads(manifest_path.read_text(encoding="utf-8")).get("region", "ap-southeast-2") if manifest_path.exists() else "ap-southeast-2"
        self.session = boto3.Session(region_name=self.region)
        self.cc = self.session.client("cloudcontrol")
        self.cfn = self.session.client("cloudformation")
        self.schemas = {}
        self.mapping = {}
        self.warnings = []
        self.template = {"AWSTemplateFormatVersion": "2010-09-09",
            "Description": "XRegion recovery from deployed source and configuration; preserves integration names and excludes EBS data volumes.",
            "Metadata": {"AWSToolsMetrics": {"AWSAgentToolkit": "aws-cloudformation@3"},
                         "com.aws.cloudformation.Context": {"ref": "../../../README.md", "must": ["Use a recovery environment without conflicting resource names", "EBS and installed disk state are excluded; EC2 uses the selected AMI"]}},
            "Parameters": {"ArtifactBucket": {"Type": "String", "Description": "Existing private S3 bucket in Sydney for the backed-up Lambda ZIPs"},
                           "ArtifactPrefix": {"Type": "String", "Default": "xregion-backup"}},
            "Resources": {}, "Outputs": {}}
        self.private_parameters = []

    def read(self, path):
        return json.loads((self.root / path).read_text(encoding="utf-8"))

    def save(self, path, value):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")

    def remove(self, node, parts):
        if not parts:
            return
        part, *rest = parts
        if part == "*":
            for item in node if isinstance(node, list) else []:
                self.remove(item, rest)
        elif isinstance(node, dict) and part in node:
            if rest:
                self.remove(node[part], rest)
            else:
                node.pop(part, None)

    def model(self, typ, identifier):
        request_identifier = identifier
        if typ == "AWS::EC2::EIP":
            address = next(a for a in self.read("ec2/addresses.json") if a["AllocationId"] == identifier)
            request_identifier = json.dumps({"PublicIp": address["PublicIp"], "AllocationId": identifier})
        cache = self.root / ("resource-models/" + logical(typ, identifier) + ".json")
        if cache.exists():
            original = json.loads(cache.read_text(encoding="utf-8"))["properties"]
        else:
            response = self.cc.get_resource(TypeName=typ, Identifier=request_identifier)
            original = json.loads(response["ResourceDescription"]["Properties"])
        if typ not in self.schemas:
            schema_path = self.root / ("resource-schemas/" + typ.replace("::", "-") + ".json")
            self.schemas[typ] = json.loads(schema_path.read_text()) if schema_path.exists() else json.loads(self.cfn.describe_type(Type="RESOURCE", TypeName=typ)["Schema"])
            self.save("resource-schemas/" + typ.replace("::", "-") + ".json", self.schemas[typ])
        self.save("resource-models/" + logical(typ, identifier) + ".json", {"type": typ, "identifier": identifier, "properties": original})
        properties = json.loads(json.dumps(original))
        for pointer in self.schemas[typ].get("readOnlyProperties", []):
            parts = ["*" if p == "items" else p.replace("~1", "/").replace("~0", "~")
                     for p in pointer.split("/") if p and p != "properties"]
            self.remove(properties, parts)
        return properties

    def add(self, typ, identifier, props, arn=None):
        lid = logical(typ.split("::")[-1], identifier)
        value = {"Type": typ, "Properties": props,
                 "Metadata": {"com.aws.cloudformation.Context": {"why": "Recreate captured project dependency", "must": ["Preserve integration names and review external references before recovery"]}}}
        if typ in {"AWS::DynamoDB::Table", "AWS::EC2::Volume", "AWS::EC2::Instance"}:
            value.update(DeletionPolicy="Retain", UpdateReplacePolicy="Retain")
        self.template["Resources"][lid] = value
        self.mapping[identifier] = {"Fn::GetAtt": [lid, "AllocationId"]} if typ == "AWS::EC2::EIP" else {"Ref": lid}
        if arn:
            self.mapping[arn] = {"Fn::GetAtt": [lid, "Arn"]} if typ != "AWS::StepFunctions::StateMachine" else {"Ref": lid}
        return lid

    def native(self, typ, identifier, arn=None):
        return self.add(typ, identifier, self.model(typ, identifier), arn)

    def network(self):
        managed_tables = {n.get("RouteTableId"): n["NatGatewayId"] for n in self.read("ec2/nat-gateways.json") if n.get("AvailabilityMode") == "regional"}
        for v in self.read("ec2/vpcs.json"):
            self.native("AWS::EC2::VPC", v["VpcId"])
        for filename, typ, key in [("subnets", "Subnet", "SubnetId"), ("internet-gateways", "InternetGateway", "InternetGatewayId"), ("route-tables", "RouteTable", "RouteTableId")]:
            for item in self.read(f"ec2/{filename}.json"):
                if typ == "RouteTable" and item[key] in managed_tables:
                    self.mapping[item[key]] = {"Fn::GetAtt": [logical("NatGateway", managed_tables[item[key]]), "RouteTableId"]}
                    continue
                self.native("AWS::EC2::" + typ, item[key])
                if typ == "InternetGateway":
                    for attachment in item["Attachments"]:
                        self.add("AWS::EC2::VPCGatewayAttachment", "attach-" + item[key], {"VpcId": attachment["VpcId"], "InternetGatewayId": item[key]})
        for group in self.read("ec2/security-groups.json"):
            if group["GroupName"] == "default":
                self.mapping[group["GroupId"]] = {"Fn::GetAtt": [logical("VPC", group["VpcId"]), "DefaultSecurityGroup"]}
                continue
            props = self.model("AWS::EC2::SecurityGroup", group["GroupId"])
            ingress = props.pop("SecurityGroupIngress", [])
            egress = props.pop("SecurityGroupEgress", [])
            self.add("AWS::EC2::SecurityGroup", group["GroupId"], props)
            for suffix, rules in [("Ingress", ingress), ("Egress", egress)]:
                for index, rule in enumerate(rules):
                    self.add("AWS::EC2::SecurityGroup" + suffix, f"{group['GroupId']}-{suffix}-{index}", {"GroupId": group["GroupId"], **rule})
        for address in self.read("ec2/addresses.json"):
            self.native("AWS::EC2::EIP", address["AllocationId"])
        for nat in self.read("ec2/nat-gateways.json"):
            if nat["State"] != "available":
                continue
            props = self.model("AWS::EC2::NatGateway", nat["NatGatewayId"])
            if nat.get("AutoProvisionZones") == "enabled":
                props.pop("AvailabilityZoneAddresses", None)
            lid = self.add("AWS::EC2::NatGateway", nat["NatGatewayId"], props)
            self.template["Resources"][lid]["DependsOn"] = [k for k, v in self.template["Resources"].items() if v["Type"] == "AWS::EC2::VPCGatewayAttachment"]
        route_tables = self.read("ec2/route-tables.json")
        main = {r["VpcId"]: r["RouteTableId"] for r in route_tables if any(a.get("Main") for a in r["Associations"])}
        explicit = {}
        for table in route_tables:
            explicit.update({a["SubnetId"]: table["RouteTableId"] for a in table["Associations"] if a.get("SubnetId")})
            for index, route in enumerate(table["Routes"]):
                if route.get("GatewayId") == "local" or route.get("State") != "active":
                    continue
                if table["RouteTableId"] in managed_tables and route.get("DestinationCidrBlock") == "0.0.0.0/0":
                    continue  # Regional NAT creates its own route table and default IGW route.
                fields = {k: v for k, v in route.items() if k in {"DestinationCidrBlock", "DestinationIpv6CidrBlock", "DestinationPrefixListId", "GatewayId", "NatGatewayId", "NetworkInterfaceId", "VpcPeeringConnectionId", "TransitGatewayId", "EgressOnlyInternetGatewayId"}}
                self.add("AWS::EC2::Route", f"{table['RouteTableId']}-{index}", {"RouteTableId": table["RouteTableId"], **fields})
        for subnet in self.read("ec2/subnets.json"):
            self.add("AWS::EC2::SubnetRouteTableAssociation", "route-" + subnet["SubnetId"], {"SubnetId": subnet["SubnetId"], "RouteTableId": explicit.get(subnet["SubnetId"], main[subnet["VpcId"]])})
        for acl in self.read("ec2/network-acls.json"):
            if acl["IsDefault"]:
                # New VPCs already contain the default allow/deny entries. Preserve the exported ACL for review.
                standard = [e for e in acl["Entries"] if e["RuleNumber"] != 32767]
                if any(e["RuleNumber"] != 100 or e["RuleAction"] != "allow" or e["Protocol"] != "-1" for e in standard):
                    self.warnings.append("Default NACL has custom entries; apply exported entries before admitting traffic")
                continue
            self.native("AWS::EC2::NetworkAcl", acl["NetworkAclId"])
            for index, entry in enumerate(acl["Entries"]):
                if entry["RuleNumber"] == 32767:
                    continue
                props = {k: entry[k] for k in ["Protocol", "RuleNumber", "RuleAction", "Egress", "CidrBlock", "Ipv6CidrBlock", "PortRange", "IcmpTypeCode"] if k in entry}
                if "IcmpTypeCode" in props:
                    props["Icmp"] = props.pop("IcmpTypeCode")
                self.add("AWS::EC2::NetworkAclEntry", f"{acl['NetworkAclId']}-{index}", {"NetworkAclId": acl["NetworkAclId"], **props})
            for association in acl["Associations"]:
                self.add("AWS::EC2::SubnetNetworkAclAssociation", association["NetworkAclAssociationId"], {"SubnetId": association["SubnetId"], "NetworkAclId": acl["NetworkAclId"]})

    def iam(self):
        for folder in (self.root / "iam/roles").iterdir():
            role = self.read(str(folder.relative_to(self.root) / "role.json"))["Role"]
            self.native("AWS::IAM::Role", role["RoleName"], role["Arn"])
        for path in (self.root / "iam/policies").glob("*/policy.json"):
            policy = json.loads(path.read_text())
            if ":aws:policy/" in policy["Arn"]:
                continue
            document = json.loads((path.parent / "document.json").read_text())["PolicyVersion"]["Document"]
            self.add("AWS::IAM::ManagedPolicy", policy["Arn"], {"ManagedPolicyName": policy["PolicyName"], "Path": policy["Path"], "PolicyDocument": document})
        for path in (self.root / "iam/instance-profiles").glob("*.json"):
            profile = json.loads(path.read_text())["InstanceProfile"]
            self.native("AWS::IAM::InstanceProfile", profile["InstanceProfileName"])

    def application(self):
        for url in self.read("inventory/additional-sqs.json"):
            attributes = self.read(f"sqs/{url.rsplit('/', 1)[-1]}/attributes.json")["Attributes"]
            self.native("AWS::SQS::Queue", url, attributes["QueueArn"])
            if attributes.get("Policy"):
                self.add("AWS::SQS::QueuePolicy", url + "policy", {"Queues": [url], "PolicyDocument": json.loads(attributes["Policy"])})
        for folder in (self.root / "dynamodb").iterdir():
            self.native("AWS::DynamoDB::Table", folder.name, self.read(f"dynamodb/{folder.name}/schema.json")["Table"]["TableArn"])
        groups = self.read("cloudwatch/log-groups.json")
        for group in groups:
            self.native("AWS::Logs::LogGroup", group["logGroupName"])
        log_policies = self.session.client("logs").describe_resource_policies().get("resourcePolicies", [])
        self.save("cloudwatch/resource-policies.json", log_policies)
        for policy in log_policies:
            if "xregion" in policy["policyDocument"].lower() or "events.amazonaws.com" in policy["policyDocument"]:
                self.native("AWS::Logs::ResourcePolicy", policy["policyName"])
        for folder in (self.root / "lambda").iterdir():
            cfg = self.read(f"lambda/{folder.name}/configuration.json")
            props = self.model("AWS::Lambda::Function", folder.name)
            props["Code"] = {"S3Bucket": {"Ref": "ArtifactBucket"}, "S3Key": {"Fn::Sub": "${ArtifactPrefix}/" + folder.name + ".zip"}}
            props["Environment"] = cfg.get("Environment", {"Variables": {}})
            props["Environment"].pop("Error", None)
            for key, value in list(props["Environment"].get("Variables", {}).items()):
                if re.search(r"PASSWORD|SECRET|TOKEN|ACCESS_KEY", key, re.I):
                    pname = logical("Secret", key + value)
                    self.template["Parameters"][pname] = {"Type": "String", "NoEcho": True, "Description": f"Recovered environment variable {key}; no default stored in template"}
                    self.private_parameters.append({"ParameterKey": pname, "ParameterValue": value})
                    props["Environment"]["Variables"][key] = {"Ref": pname}
            self.add("AWS::Lambda::Function", folder.name, props, cfg["FunctionArn"])
        for folder in (self.root / "stepfunctions").iterdir():
            cfg = self.read(f"stepfunctions/{folder.name}/configuration.json")
            self.add("AWS::StepFunctions::StateMachine", cfg["stateMachineArn"], {"StateMachineName": cfg["name"], "StateMachineType": cfg["type"], "RoleArn": cfg["roleArn"], "Definition": json.loads(cfg["definition"]),
                **({"LoggingConfiguration": {"Level": cfg["loggingConfiguration"]["level"], "IncludeExecutionData": cfg["loggingConfiguration"].get("includeExecutionData", False), "Destinations": [{"CloudWatchLogsLogGroup": {"LogGroupArn": d["cloudWatchLogsLogGroup"]["logGroupArn"]}} for d in cfg["loggingConfiguration"].get("destinations", [])]}} if cfg.get("loggingConfiguration", {}).get("level", "OFF") != "OFF" else {})}, cfg["stateMachineArn"])
        for path in (self.root / "eventbridge").glob("*/*/rule.json"):
            rule = json.loads(path.read_text())
            targets = json.loads((path.parent / "targets.json").read_text())
            props = {k: rule[k] for k in ["Name", "Description", "State", "ScheduleExpression", "RoleArn"] if k in rule}
            props["EventBusName"] = path.parent.parent.name
            if rule.get("EventPattern"):
                props["EventPattern"] = json.loads(rule["EventPattern"])
            props["Targets"] = targets
            self.add("AWS::Events::Rule", rule["Arn"], props, rule["Arn"])
        for folder in (self.root / "lambda").iterdir():
            path = folder / "resource-policy.json"
            if not path.exists():
                continue
            for index, statement in enumerate(json.loads(json.loads(path.read_text())["Policy"])["Statement"]):
                principal = statement["Principal"]
                props = {"FunctionName": folder.name, "Action": statement["Action"], "Principal": principal.get("Service", principal.get("AWS")) if isinstance(principal, dict) else principal}
                for condition in statement.get("Condition", {}).values():
                    if "AWS:SourceArn" in condition:
                        props["SourceArn"] = condition["AWS:SourceArn"]
                    if "AWS:SourceAccount" in condition:
                        props["SourceAccount"] = condition["AWS:SourceAccount"]
                self.add("AWS::Lambda::Permission", folder.name + str(index), props)
        for folder in (self.root / "apigateway").iterdir():
            if not folder.is_dir():
                continue
            cfg = json.loads((folder / "api.json").read_text())
            stages = json.loads((folder / "stages.json").read_text())
            swagger = json.loads((folder / (stages[0]["stageName"] + ".swagger.json")).read_text())
            lid = self.add("AWS::ApiGateway::RestApi", folder.name, {"Name": cfg["name"], "Body": swagger, "EndpointConfiguration": {"Types": cfg["endpointConfiguration"]["types"]}})
            for stage in stages:
                dep = self.add("AWS::ApiGateway::Deployment", folder.name + stage["stageName"] + "deployment", {"RestApiId": {"Ref": lid}})
                settings = []
                for method, values in stage.get("methodSettings", {}).items():
                    resource_path, verb = method.rsplit("/", 1)
                    settings.append({"ResourcePath": "/" + resource_path if resource_path != "*" else "/*", "HttpMethod": verb,
                                     **{key[0].upper() + key[1:]: value for key, value in values.items() if key not in ["requireAuthorizationForCacheControl", "unauthorizedCacheControlHeaderStrategy"]}})
                    if values.get("cachingEnabled"):
                        self.warnings.append("Review cache-authorization options from stages.json; CloudFormation MethodSettings does not expose them")
                self.add("AWS::ApiGateway::Stage", folder.name + stage["stageName"], {"RestApiId": {"Ref": lid}, "DeploymentId": {"Ref": dep}, "StageName": stage["stageName"], "Variables": stage.get("variables", {}), "TracingEnabled": stage.get("tracingEnabled", False), "MethodSettings": settings, "CacheClusterEnabled": stage.get("cacheClusterEnabled", False)})
            self.template["Outputs"]["EventsApiId"] = {"Value": {"Ref": lid}, "Description": "New API ID; update backend endpoint after recovery"}
        account_path = self.root / "apigateway/account.json"
        if account_path.exists():
            account = json.loads(account_path.read_text())
            if account.get("cloudwatchRoleArn"):
                self.add("AWS::ApiGateway::Account", "gateway-account", {"CloudWatchRoleArn": account["cloudwatchRoleArn"]})

    def compute(self):
        instances = self.read("ec2/instances.json")
        for instance in instances:
            iid = instance["InstanceId"]
            props = self.model("AWS::EC2::Instance", iid)
            pname = logical("RecoveryAmi", iid)
            self.template["Parameters"][pname] = {"Type": "AWS::EC2::Image::Id", "Default": instance["ImageId"], "Description": "Recorded launch AMI; installed OpenStack and current disk data are not backed up"}
            props["ImageId"] = {"Ref": pname}
            props.pop("BlockDeviceMappings", None)
            for field in ["Volumes", "NetworkInterfaces", "SecurityGroups", "SecurityGroupIds", "SubnetId", "PrivateIpAddress", "PlacementGroupName"]:
                props.pop(field, None)
            primary_interface = next(n for n in instance["NetworkInterfaces"] if n["Attachment"]["DeviceIndex"] == 0)
            props["NetworkInterfaces"] = [{"DeviceIndex": "0", "DeleteOnTermination": True,
                "SubnetId": primary_interface["SubnetId"],
                "GroupSet": [g["GroupId"] for g in primary_interface["Groups"]],
                "PrivateIpAddresses": [{"PrivateIpAddress": p["PrivateIpAddress"], "Primary": p["Primary"]} for p in primary_interface["PrivateIpAddresses"]],
                "AssociatePublicIpAddress": bool(primary_interface.get("Association"))}]
            # A key pair's private key cannot be exported from EC2. Reuse an existing public-key pair.
            if props.get("KeyName"):
                keyparam = "RecoverySshKeyName"
                self.template["Parameters"][keyparam] = {"Type": "AWS::EC2::KeyPair::KeyName", "Default": instance["KeyName"], "Description": "Existing key pair; private SSH keys are not exportable and must be retained separately"}
                props["KeyName"] = {"Ref": keyparam}
            self.add("AWS::EC2::Instance", iid, props)
        primary = {n["NetworkInterfaceId"]: i["InstanceId"] for i in instances for n in i["NetworkInterfaces"] if n.get("Attachment", {}).get("DeviceIndex") == 0}
        for eni in self.read("ec2/network-interfaces.json"):
            eid = eni["NetworkInterfaceId"]
            if eid in primary:
                self.mapping[eid] = {"Fn::GetAtt": [logical("Instance", primary[eid]), "PrimaryNetworkInterfaceId"]}
                continue
            if eni.get("InterfaceType") == "ec2_instance_connect_endpoint":
                endpoint_id = re.search(r"eice-[a-z0-9]+", eni.get("Description", ""))
                if endpoint_id:
                    self.native("AWS::EC2::InstanceConnectEndpoint", endpoint_id.group())
                continue
            if eni.get("RequesterManaged") or eni.get("InterfaceType") != "interface":
                continue
            props = self.model("AWS::EC2::NetworkInterface", eid)
            if props.get("PrivateIpAddresses"):
                props.pop("PrivateIpAddress", None)
                props.pop("SecondaryPrivateIpAddressCount", None)
            for field in ["Ipv4Prefixes", "Ipv6Prefixes", "Ipv6Addresses"]:
                if not props.get(field):
                    props.pop(field, None)
            for field in ["Ipv4PrefixCount", "Ipv6PrefixCount", "Ipv6AddressCount"]:
                if not props.get(field):
                    props.pop(field, None)
            self.add("AWS::EC2::NetworkInterface", eid, props)
            if eni.get("Attachment", {}).get("InstanceId"):
                a = eni["Attachment"]
                self.add("AWS::EC2::NetworkInterfaceAttachment", eid + "attach", {"NetworkInterfaceId": eid, "InstanceId": a["InstanceId"], "DeviceIndex": str(a["DeviceIndex"]), "DeleteOnTermination": a.get("DeleteOnTermination", False)})

    def rewrite(self, node, own):
        if isinstance(node, dict):
            if any(k in node for k in ["Ref", "Fn::GetAtt", "Fn::Sub"]):
                return node
            return {k: self.rewrite(v, own) for k, v in node.items()}
        if isinstance(node, list):
            return [self.rewrite(v, own) for v in node]
        if isinstance(node, str) and node in self.mapping:
            ref = self.mapping[node]
            if ref and ref != {"Ref": own} and ref != {"Fn::GetAtt": [own, "Arn"]}:
                return ref
        return node

    def run(self):
        for step in [self.network, self.iam, self.application, self.compute]:
            print(step.__name__, flush=True)
            step()
        for lid, resource in self.template["Resources"].items():
            if resource["Type"] == "AWS::IAM::Role":
                props = resource["Properties"]
                props["ManagedPolicyArns"] = self.rewrite(props.get("ManagedPolicyArns", []), lid)
            elif resource["Type"] != "AWS::IAM::ManagedPolicy":
                resource["Properties"] = self.rewrite(resource["Properties"], lid)
        self.save("restore/template.json", self.template)
        self.save("restore/private-parameters.json", list({p["ParameterKey"]: p for p in self.private_parameters}.values()))
        self.save("restore/resource-map.json", self.mapping)
        self.save("restore/limitations.json", self.warnings + ["DynamoDB data and EBS resources/data are excluded", "EC2 launch AMI does not reproduce manually installed OpenStack or current root disk state", "Existing named resources must be imported or absent; this is not an in-place update stack", "CloudFormation deployment has not been executed"])
        print("Resources:", len(self.template["Resources"]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    args = parser.parse_args()
    Builder(args.snapshot).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
