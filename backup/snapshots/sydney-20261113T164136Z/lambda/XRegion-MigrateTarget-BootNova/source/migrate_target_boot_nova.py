"""Dedicated BootNova Lambda for MigrateTargetBoot (SPEC-SF-09 v1.2.0)."""
import network_runtime as runtime


def lambda_handler(event, context):
    action = event.get("action") or "boot_nova"
    if action == "boot_nova":
        res = runtime.boot(event)
        if res.get("nova_id"):
            res["target_nova_id"] = res["nova_id"]
        return res
    if action == "delete_nova":
        if not event.get("nova_id") and not event.get("target_nova_id") and not event.get("server_id"):
            return event
        if event.get("network_mode") is None:
            event = dict(event, network_mode=runtime.MODE)
        return runtime.delete_nova(event)
    raise ValueError(f"Unsupported TargetBootNova action: {action}")
