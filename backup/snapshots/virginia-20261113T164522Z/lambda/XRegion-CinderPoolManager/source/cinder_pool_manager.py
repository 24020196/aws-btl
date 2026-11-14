"""Backend-isolated EBS pool replenishment with durable ambiguous-POST guards."""
import os
import time
import urllib.parse
import uuid

from botocore.exceptions import ClientError
import network_runtime as runtime


def validate_pool_volume(volume, image_id):
    if (volume.get("volume_type", volume.get("type")) != runtime.CINDER_VOLUME_TYPE or
            volume.get("volume_image_metadata", {}).get("image_id") != image_id):
        raise ValueError("Pool backend or image mismatch")
    record = dict(storage_backend=runtime.STORAGE_BACKEND,
                  cinder_volume_type=runtime.CINDER_VOLUME_TYPE,
                  cinder_volume_id=volume["id"], ebs_volume_id=volume.get("provider_id", ""))
    runtime.validate_ebs_mapping(record, volume)
    if volume.get("status") != "available" or volume.get("attachments") or str(volume.get("bootable")).lower() != "true":
        return None
    return dict(record, size_gb=volume["size"], image_id=image_id, status="AVAILABLE")


def reconcile(table, project, request):
    base = "/" + project + "/volumes"
    if request.get("cinder_volume_id"):
        volume = runtime.os_api("CINDER", base + "/" + request["cinder_volume_id"])["volume"]
    else:
        name = "xregion-ebs-pool-" + request["request_id"]
        response = runtime.os_api("CINDER", base + "/detail?name=" + urllib.parse.quote(name))
        matches = [v for v in response["volumes"] if v.get("metadata", {}).get("xregion_pool_request") == request["request_id"]]
        if len(matches) > 1:
            raise RuntimeError("Multiple Cinder volumes for a single pool request")
        if not matches:
            # This marker is written before POST. A lost response is never retried blindly.
            if request.get("post_attempted"):
                return False
            table.update_item(Key={"volume_id": request["volume_id"]},
                UpdateExpression="SET post_attempted=:yes",
                ConditionExpression="attribute_not_exists(post_attempted) AND #s=:creating",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":yes": True, ":creating": "CREATING"})
            volume = runtime.os_api("CINDER", base, "POST", {"volume": dict(
                name=name, size=request["size_gb"], imageRef=request["image_id"],
                volume_type=runtime.CINDER_VOLUME_TYPE,
                metadata={"xregion_pool_request": request["request_id"], "storage_backend": runtime.STORAGE_BACKEND})})["volume"]
        else:
            volume = matches[0]
        table.update_item(Key={"volume_id": request["volume_id"]},
            UpdateExpression="SET cinder_volume_id=:id",
            ConditionExpression="#s=:creating", ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":id": volume["id"], ":creating": "CREATING"})
    if str(volume["status"]).startswith("error"):
        # Keep the request and physical resource for diagnosis, do not create replacements indefinitely.
        raise RuntimeError("Cinder pool creation failed: " + volume["id"])
    if volume["status"] != "available":
        return False
    confirmed = validate_pool_volume(volume, request["image_id"])
    if confirmed:
        table.update_item(Key={"volume_id": request["volume_id"]},
            UpdateExpression="SET #s=:available, cinder_volume_id=:id, ebs_volume_id=:ebs, size_gb=:size",
            ConditionExpression="#s=:creating AND cinder_volume_id=:id",
            ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={
                ":available": "AVAILABLE", ":creating": "CREATING", ":id": volume["id"],
                ":ebs": confirmed["ebs_volume_id"], ":size": volume["size"]})
    return bool(confirmed)


def lambda_handler(event, context):
    if os.environ.get("EBS_POOL_ENABLED", "false").lower() != "true":
        return {"status": "PAUSED", "storage_backend": runtime.STORAGE_BACKEND}
    project = str(uuid.UUID(os.environ["OS_PROJECT_ID"])).replace("-", "")
    images = runtime.os_api("GLANCE", "/images?status=active")["images"]
    table = runtime.DDB.Table("XRegion-Volumes")
    outcomes = []
    for image in images:
        image_id = str(uuid.UUID(image["id"]))
        lock = "EBS-POOL-LOCK#" + runtime.REGION + "#" + image_id
        token = str(uuid.uuid4())
        try:
            table.put_item(Item=dict(volume_id=lock, status="CONTROL", lock_token=token,
                                     lock_until=int(time.time()) + 1200),
                ConditionExpression="attribute_not_exists(volume_id) OR lock_until < :now",
                ExpressionAttributeValues={":now": int(time.time())})
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                continue
            raise
        try:
            rows = runtime.scan("XRegion-Volumes", FilterExpression="storage_backend=:backend AND image_id=:image",
                ExpressionAttributeValues={":backend": runtime.STORAGE_BACKEND, ":image": image_id})
            rows = [r for r in rows if r.get("region") == runtime.REGION]
            for row in rows:
                if row["status"] == "CREATING":
                    reconcile(table, project, row)
                elif row["status"] == "AVAILABLE":
                    # R04: Validate AVAILABLE row with real OpenStack Cinder / EBS volume before counting
                    cinder_id = row.get("cinder_volume_id") or (row.get("volume_id")[9:] if str(row.get("volume_id", "")).startswith("EBS-POOL#") else None)
                    if cinder_id and not cinder_id.startswith("EBS-POOL#"):
                        res = runtime.os_api("CINDER", f"/{project}/volumes/{cinder_id}", missing=True)
                        if res is None:
                            # Cinder 404: Volume definitely does not exist
                            is_stale = True
                        else:
                            volume = res.get("volume")
                            if not volume:
                                is_stale = True
                            else:
                                try:
                                    pool_rec = validate_pool_volume(volume, image_id)
                                    is_stale = (pool_rec is None)
                                except (ValueError, getattr(runtime, "StorageUnavailable", Exception)):
                                    # Mismatch in configuration, tags, ownership, bootable, or provider_id
                                    is_stale = True
                                except ClientError as ec2_err:
                                    if ec2_err.response.get("Error", {}).get("Code") == "InvalidVolume.NotFound":
                                        is_stale = True
                                    else:
                                        # Transient EC2 error (throttling, auth, service error)
                                        # Retain slot; do NOT mark STALE or create duplicate volume
                                        is_stale = False
                                except Exception:
                                    # Network/connection error (e.g. EndpointConnectionError, Timeout)
                                    # Retain slot; do NOT mark STALE or create duplicate volume
                                    is_stale = False
                        if is_stale:
                            row["status"] = "STALE"
                            try:
                                table.update_item(Key={"volume_id": row["volume_id"]},
                                    UpdateExpression="SET #s = :stale, updated_at = :now",
                                    ConditionExpression="#s = :avail AND cinder_volume_id = :cid",
                                    ExpressionAttributeNames={"#s": "status"},
                                    ExpressionAttributeValues={":stale": "STALE", ":now": int(time.time()),
                                                                ":avail": "AVAILABLE", ":cid": cinder_id})
                            except ClientError as err:
                                if err.response["Error"]["Code"] != "ConditionalCheckFailedException":
                                    raise
            # Only truly AVAILABLE or currently CREATING rows consume slots
            occupied = sum(r["status"] in ("AVAILABLE", "CREATING") for r in rows)
            # SPEC-SF-03: Warm Pool tối đa 2 đơn vị cho mỗi image_id: max(0, 5 - occupied).
            for _ in range(max(0, 5 - occupied)):
                if context and context.get_remaining_time_in_millis() < 30000:
                    break
                ident = str(uuid.uuid4())
                request = dict(volume_id="EBS-POOL#" + ident, request_id=ident,
                    storage_backend=runtime.STORAGE_BACKEND, cinder_volume_type=runtime.CINDER_VOLUME_TYPE,
                    image_id=image_id, size_gb=max(1, int(image.get("min_disk", 0))),
                    status="CREATING", region=runtime.REGION, created_at=int(time.time()))
                table.put_item(Item=request, ConditionExpression="attribute_not_exists(volume_id)")
                reconcile(table, project, request)
                outcomes.append(request["volume_id"])
        finally:
            table.delete_item(Key={"volume_id": lock}, ConditionExpression="lock_token=:token",
                              ExpressionAttributeValues={":token": token})
    return {"status": "RECONCILED", "storage_backend": runtime.STORAGE_BACKEND, "requests": outcomes}
