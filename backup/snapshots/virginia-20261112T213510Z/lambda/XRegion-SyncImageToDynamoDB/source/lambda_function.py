import os
import json
import logging
import boto3
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
table = dynamodb.Table('XRegion-Images')

def lambda_handler(event, context):
    logger.info(f"Received Glance Image event: {json.dumps(event)}")
    
    detail = event.get('detail', {})
    if not detail:
        detail = event
        
    action = str(detail.get('action', 'sync')).lower()
    image_id = detail.get('image_id') or detail.get('id')
    
    if not image_id:
        logger.warning("No image_id provided in event payload, skipping.")
        return {'statusCode': 400, 'body': 'Missing image_id'}
        
    if action == 'deleted':
        logger.info(f"Deleting image {image_id} from XRegion-Images")
        table.delete_item(Key={'image_id': str(image_id)})
        return {'statusCode': 200, 'body': f"Deleted {image_id}"}
        
    image_name = detail.get('image_name') or detail.get('name', 'unknown')
    raw_size = detail.get('size_bytes') or detail.get('size', 0)
    try:
        size_bytes = Decimal(str(raw_size))
    except Exception:
        size_bytes = Decimal('0')
        
    item = {
        'image_id': str(image_id),
        'image_name': str(image_name),
        'size_bytes': size_bytes
    }
    
    logger.info(f"Upserting image into XRegion-Images: {item}")
    table.put_item(Item=item)
    
    return {
        'statusCode': 200,
        'body': json.dumps({'message': 'Image synchronized successfully', 'image_id': image_id})
    }
