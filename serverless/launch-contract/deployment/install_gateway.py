import argparse
import base64
import json
from pathlib import Path

from control import Deployment, ENI, HOST, REGION, ROOT


def install(x):
    eni = x.client("ec2").describe_network_interfaces(NetworkInterfaceIds=[ENI])["NetworkInterfaces"][0]
    config = dict(region=REGION, host_id=HOST, eni_id=ENI, eni_mac=eni["MacAddress"],
                  primary_ip=eni["PrivateIpAddress"], table="XRegion-NetworkMappings")
    files = {
        "/usr/local/libexec/xregion-network/gateway.py": (ROOT / "gateway/gateway.py").read_bytes(),
        "/etc/systemd/system/xregion-network.service": (ROOT / "gateway/xregion-network.service").read_bytes(),
        "/etc/systemd/system/xregion-network.timer": (ROOT / "gateway/xregion-network.timer").read_bytes(),
        "/etc/xregion-network/config.json": json.dumps(config).encode(),
    }
    script = "set -eu\numask 077\ninstall -d /usr/local/libexec/xregion-network /etc/xregion-network /var/lib/xregion-network\n"
    for path, data in files.items():
        encoded = base64.b64encode(data).decode()
        script += f"printf '%s' '{encoded}' | base64 -d > '{path}'\n"
    script += """
python3 -m venv /opt/xregion-network-venv
/opt/xregion-network-venv/bin/pip -q install boto3
if ! command -v conntrack >/dev/null; then
 apt-get update -qq
 DEBIAN_FRONTEND=noninteractive apt-get install -y -qq conntrack
fi
/home/ssm-user/kolla-venv-2024.2/bin/python - <<'PY'
from pathlib import Path
import configparser,yaml
p=Path('/etc/kolla/neutron-server/ml2_conf.ini')
c=configparser.ConfigParser();c.read(p)
networks=c.get('ml2_type_flat','flat_networks').split(',')
if 'physnet_nat' not in networks:
    networks.append('physnet_nat');c.set('ml2_type_flat','flat_networks',','.join(networks))
    with p.open('w') as out:c.write(out)
override=Path('/etc/kolla/config/neutron/ml2_conf.ini');override.parent.mkdir(parents=True,exist_ok=True)
o=configparser.ConfigParser();o.read(override)
if not o.has_section('ml2_type_flat'):o.add_section('ml2_type_flat')
o.set('ml2_type_flat','flat_networks',','.join(networks))
with override.open('w') as out:o.write(out)
p=Path('/etc/netplan/50-cloud-init.yaml');cfg=yaml.safe_load(p.read_text())
eth=cfg['network']['ethernets']['ens6'];eth['dhcp4']=False
eth.pop('routes',None);eth.pop('routing-policy',None);eth.pop('dhcp4-overrides',None)
p.write_text(yaml.safe_dump(cfg,sort_keys=False))
PY
netplan generate
networkctl reload
networkctl reconfigure ens6
docker restart neutron_server >/dev/null
systemctl daemon-reload
systemctl enable xregion-network.service xregion-network.timer >/dev/null
systemctl start xregion-network.service
systemctl start xregion-network.timer
. /etc/kolla/admin-openrc.sh
export OS_PROJECT_NAME=service OS_TENANT_NAME=service
OSC=/home/ssm-user/kolla-venv-2024.2/bin/openstack
for i in $(seq 1 20); do $OSC network list -f value >/dev/null 2>&1 && break; sleep 2; done
NET=$($OSC network list --name xregion-private-net -f value -c ID)
if [ -z "$NET" ]; then
 NET=$($OSC network create --provider-network-type flat --provider-physical-network physnet_nat xregion-private-net -f value -c id)
fi
SUB=$($OSC subnet list --network "$NET" -f value -c ID)
if [ -z "$SUB" ]; then
 SUB=$($OSC subnet create --network "$NET" --subnet-range 192.168.100.0/24 --gateway 192.168.100.1 --allocation-pool start=192.168.100.10,end=192.168.100.240 --dns-nameserver 1.1.1.1 xregion-private-subnet -f value -c id)
fi
printf 'NETWORK_ID=%s\nSUBNET_ID=%s\n' "$NET" "$SUB"
ip -br addr show br-ex
ip -br addr show br-xregion
systemctl is-active xregion-network.timer
"""
    result = x.remote(script, "install-gateway", 240)
    print(result)
    resources = dict(line.split("=", 1) for line in result.splitlines()
                     if line.startswith(("NETWORK_ID=", "SUBNET_ID=")))
    if len(resources) != 2:
        raise RuntimeError("OpenStack network creation did not return IDs")
    x.save("gateway-resources.json", dict(config, **resources))


if __name__ == "__main__":
    p = argparse.ArgumentParser();p.add_argument("--directory", required=True)
    install(Deployment(p.parse_args().directory))
