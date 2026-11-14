import json
import logging
import boto3
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name='ap-southeast-2')
table = dynamodb.Table('XRegion-Flavors')

def lambda_handler(event, context):
    logger.info(f"Received Nova Flavor event: {json.dumps(event)}")
    
    detail = event.get('detail', {})
    if not detail:
        detail = event
        
    action = str(detail.get('action', 'sync')).lower()
    flavor_id = detail.get('flavor_id') or detail.get('id')
    
    if not flavor_id:
        logger.warning("No flavor_id provided in event payload, skipping.")
        return {'statusCode': 400, 'body': 'Missing flavor_id'}
        
    if action == 'deleted':
        logger.info(f"Deleting flavor {flavor_id} from XRegion-Flavors")
        table.delete_item(Key={'flavor_id': str(flavor_id)})
        return {'statusCode': 200, 'body': f"Deleted {flavor_id}"}
        
    flavor_name = detail.get('flavor_name') or detail.get('name', 'unknown')
    
    try:
        vcpus = Decimal(str(detail.get('vcpus', 1)))
    except Exception:
        vcpus = Decimal('1')
        
    try:
        ram_mb = Decimal(str(detail.get('ram_mb', detail.get('ram', 512))))
    except Exception:
        ram_mb = Decimal('512')
        
    try:
        disk_gb = Decimal(str(detail.get('disk_gb', detail.get('disk', 1))))
    except Exception:
        disk_gb = Decimal('1')
        
    item = {
        'flavor_id': str(flavor_id),
        'flavor_name': str(flavor_name),
        'vcpus': vcpus,
        'ram_mb': ram_mb,
        'disk_gb': disk_gb
    }
    
    logger.info(f"Upserting flavor into XRegion-Flavors: {item}")
    table.put_item(Item=item)
    
    return {
        'statusCode': 200,
        'body': json.dumps({'message': 'Flavor synchronized successfully', 'flavor_id': flavor_id})
    }
