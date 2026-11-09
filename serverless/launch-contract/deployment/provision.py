"""Provision the explicitly named NAT dependencies; reruns validate existing schema."""
import argparse
import json
import time

from control import ACCOUNT, ENI, HOST, REGION, Deployment

TABLES = ("XRegion-NetworkMappings", "XRegion-NetworkReservations")
DOCUMENT = "XRegion-NetworkGateway"
ROLE = "XRegion-NetworkLambdaRole"


def provision(x):
    d, iam = x.client("dynamodb"), x.client("iam")
    parameter = f"/xregion/{REGION}/launch/admission"
    try:
        x.client("ssm").get_parameter(Name=parameter)
    except x.client("ssm").exceptions.ParameterNotFound:
        x.call("ssm", "put_parameter", Name=parameter, Type="String", Value=json.dumps({"mode": "maintenance"}))
    for name, key in zip(TABLES, ("nova_id", "resource_key")):
        try:
            existing = d.describe_table(TableName=name)["Table"]
            assert existing["KeySchema"] == [{"AttributeName": key, "KeyType": "HASH"}]
        except d.exceptions.ResourceNotFoundException:
            attrs = [{"AttributeName": key, "AttributeType": "S"}]
            kw = {}
            if key == "nova_id":
                attrs.append({"AttributeName": "gateway_host_id", "AttributeType": "S"})
                kw["GlobalSecondaryIndexes"] = [{"IndexName": "gateway_host_id-index",
                    "KeySchema": [{"AttributeName": "gateway_host_id", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"}}]
            x.call("dynamodb", "create_table", TableName=name,
                   KeySchema=[{"AttributeName": key, "KeyType": "HASH"}],
                   AttributeDefinitions=attrs, BillingMode="PAY_PER_REQUEST", **kw)
        d.get_waiter("table_exists").wait(TableName=name)
    document = {"schemaVersion": "2.2", "description": "Apply a validated Nova NAT mapping",
        "parameters": {
            "operation": {"type": "String", "allowedValues": ["APPLY", "REMOVE", "VERIFY"],
                          "interpolationType": "ENV_VAR"},
            "novaId": {"type": "String", "allowedPattern": "^[0-9a-fA-F-]{36}$",
                       "interpolationType": "ENV_VAR"}},
        "mainSteps": [{"action": "aws:runShellScript", "name": "networkMapping", "inputs": {
            "timeoutSeconds": "600", "runCommand": [
                '/opt/xregion-network-venv/bin/python /usr/local/libexec/xregion-network/gateway.py "$SSM_operation" "$SSM_novaId"']}}]}
    try:
        x.call("ssm", "create_document", Name=DOCUMENT, DocumentType="Command",
               DocumentFormat="JSON", Content=json.dumps(document))
    except x.client("ssm").exceptions.DocumentAlreadyExists:
        current = json.loads(x.client("ssm").get_document(Name=DOCUMENT)["Content"])
        if current != document:
            r = x.call("ssm", "update_document", Name=DOCUMENT, DocumentVersion="$LATEST",
                       DocumentFormat="JSON", Content=json.dumps(document))
            x.call("ssm", "update_document_default_version", Name=DOCUMENT,
                   DocumentVersion=r["DocumentDescription"]["DocumentVersion"])
    for group in ["/aws/vendedlogs/states/XRegion-LaunchInstance",
                  "/aws/vendedlogs/states/XRegion-TerminateInstance", "/xregion/network/ssm"]:
        try:
            x.call("logs", "create_log_group", logGroupName=group)
        except x.client("logs").exceptions.ResourceAlreadyExistsException:
            pass
        x.call("logs", "put_retention_policy", logGroupName=group, retentionInDays=30)
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
    try:
        x.call("iam", "create_role", RoleName=ROLE, AssumeRolePolicyDocument=json.dumps(trust))
    except iam.exceptions.EntityAlreadyExistsException:
        pass
    tables = [f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/{t}" for t in TABLES]
    statements = [
        {"Effect": "Allow", "Action": ["ssm:GetParameter"],
         "Resource": f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter/xregion/{REGION}/launch/admission"},
        {"Effect": "Allow", "Action": ["dynamodb:GetItem"],
         "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Volumes"},
        {"Effect": "Allow", "Action": ["dynamodb:UpdateItem"],
         "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Volumes"},
        {"Effect": "Allow", "Action": ["dynamodb:GetItem"],
         "Resource": f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/XRegion-Instances"},
        {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
            "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:TransactWriteItems"],
         "Resource": tables + [tables[0] + "/index/*"]},
        {"Effect": "Allow", "Action": ["ssm:SendCommand"], "Resource": [
            f"arn:aws:ssm:{REGION}:{ACCOUNT}:document/{DOCUMENT}", f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{HOST}"]},
        {"Effect": "Allow", "Action": ["ssm:GetCommandInvocation"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["ec2:DescribeAddresses", "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeSubnets", "ec2:DescribeInstanceTypes", "ec2:DescribeInstances"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"],
         "Resource": f"arn:aws:ec2:{REGION}:{ACCOUNT}:network-interface/{ENI}"},
        {"Effect": "Allow", "Action": ["ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:CreateTags", "ec2:DeleteTags"],
         "Resource": [f"arn:aws:ec2:{REGION}:{ACCOUNT}:elastic-ip/*",
                      f"arn:aws:ec2:{REGION}:{ACCOUNT}:network-interface/{ENI}"]},
        {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
         "Resource": [f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/XRegion-Network-*:*",
                      f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/xregion/network/ssm:*"]},
    ]
    policy = {"Version": "2012-10-17", "Statement": statements}
    for role in (ROLE, "DB-AccessRole"):
        try:
            x.save(role + "-before-role.json", iam.get_role(RoleName=role))
        except iam.exceptions.NoSuchEntityException:
            raise
        x.call("iam", "put_role_policy", RoleName=role, PolicyName="XRegion-NetworkV1",
               PolicyDocument=json.dumps(policy))
    x.call("iam", "put_role_policy", RoleName="DB-AccessRole", PolicyName="XRegion-PoolReplenishment",
        PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
            "Action": "lambda:InvokeFunction", "Resource": [
                f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:XRegion-CinderPoolManager",
                f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:XRegion-EIPPoolManager"]}]}))
    x.call("iam", "attach_role_policy", RoleName=ROLE,
           PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole")
    profile = iam.get_instance_profile(InstanceProfileName="SSMInstanceRole")
    hostrole = profile["InstanceProfile"]["Roles"][0]["RoleName"]
    hostpolicy = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
        "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
        "Resource": [tables[0], tables[0] + "/index/gateway_host_id-index"]}]}
    x.call("iam", "put_role_policy", RoleName=hostrole, PolicyName="XRegion-GatewayMappings",
           PolicyDocument=json.dumps(hostpolicy))
    x.save("ssm-document.json", document)
    x.save("network-policy.json", policy)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--directory", required=True)
    provision(Deployment(p.parse_args().directory))
