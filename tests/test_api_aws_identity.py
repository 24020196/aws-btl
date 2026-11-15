from unittest.mock import patch

import pytest

from tests.apiTest import conftest as api_config


def test_wrong_account_blocks_api_setup(monkeypatch):
    monkeypatch.setenv("AWS_ACCOUNT_ID", "348498387626")
    with patch("tests.apiTest.conftest.boto3.client") as client, patch("requests.post") as post:
        client.return_value.get_caller_identity.return_value = {
            "Account": "291634989063", "Arn": "arn:aws:iam::291634989063:user/lam"
        }
        with pytest.raises(pytest.fail.Exception, match="AWS account mismatch"):
            api_config.verified_aws_identity.__wrapped__()
        post.assert_not_called()


def test_correct_account_allows_api_setup(monkeypatch):
    monkeypatch.setenv("AWS_ACCOUNT_ID", "348498387626")
    identity = {"Account": "348498387626", "Arn": "arn:aws:iam::348498387626:role/backend"}
    with patch("tests.apiTest.conftest.boto3.client") as client:
        client.return_value.get_caller_identity.return_value = identity
        assert api_config.verified_aws_identity.__wrapped__() == identity


def test_missing_account_blocks_before_sts(monkeypatch):
    monkeypatch.delenv("AWS_ACCOUNT_ID", raising=False)
    with patch("tests.apiTest.conftest.boto3.client") as client:
        with pytest.raises(pytest.fail.Exception, match="AWS_ACCOUNT_ID"):
            api_config.verified_aws_identity.__wrapped__()
        client.assert_not_called()


def test_image_selection_uses_regional_pool_and_all_pages():
    images = [
        {"id": "virginia-image", "name": "cirros virginia"},
        {"id": "sydney-alpine", "name": "alpine", "sizeGb": 1},
        {"id": "sydney-cirros", "name": "cirros", "sizeGb": 1},
    ]
    with patch("tests.apiTest.conftest.boto3.client") as client:
        paginate = client.return_value.get_paginator.return_value.paginate
        paginate.return_value = [
            {"Items": [{"image_id": {"S": "sydney-alpine"}, "ebs_volume_id": {"S": "vol-12345678"}}]},
            {"Items": [{"image_id": {"S": "sydney-cirros"}, "ebs_volume_id": {"S": "vol-1234567890abcdef0"}}]},
        ]
        assert api_config.select_regional_test_image(images, "ap-southeast-2") == "sydney-cirros"
        assert paginate.call_args.kwargs["ExpressionAttributeValues"][":region"] == {"S": "ap-southeast-2"}
        assert paginate.call_args.kwargs["ConsistentRead"] is True


def test_image_selection_refuses_missing_or_invalid_pool_records():
    with patch("tests.apiTest.conftest.boto3.client") as client:
        client.return_value.get_paginator.return_value.paginate.return_value = [
            {"Items": [{"image_id": {"S": "catalog-image"}, "ebs_volume_id": {"S": "invalid-volume"}}]}
        ]
        with pytest.raises(AssertionError, match="No catalog image"):
            api_config.select_regional_test_image([{"id": "catalog-image", "name": "cirros"}], "ap-southeast-2")
