# AWS Integration Guide — PriceWatch Price Drop Alert System

## Overview of services used

| Service | Role |
|---|---|
| API Gateway | REST endpoint the website POSTs alerts to |
| Lambda (SaveAlert) | Stores the alert in DynamoDB |
| Lambda (CheckPrice) | Fetches live prices and compares against targets |
| DynamoDB | Stores all alerts and price history |
| EventBridge | Cron rule that triggers CheckPrice every 6 hours |
| SNS | Publishes alert messages when a price drops |
| SES | Sends formatted HTML emails to users |
| IAM | Roles and permissions for each service |

---

## Step 1 — IAM Role for Lambda

Create one IAM role that both Lambda functions will use.

Go to **IAM → Roles → Create role → AWS Service → Lambda**, then attach these policies:

- `AmazonDynamoDBFullAccess`
- `AmazonSNSFullAccess`
- `AmazonSESFullAccess`
- `AWSLambdaBasicExecutionRole` (for CloudWatch logs)

Name it `PriceWatchLambdaRole`.

---

## Step 2 — DynamoDB Table

Go to **DynamoDB → Create table**:

- Table name: `price-alerts`
- Partition key: `alertId` (String)
- Sort key: _(none needed)_
- Billing mode: On-demand (pay per request)

After creation, add a **Global Secondary Index** for querying by status:

- Index name: `status-index`
- Partition key: `status` (String)

Your items will look like this:

```json
{
  "alertId":     "alrt_8f2a1c",
  "productUrl":  "https://amazon.in/dp/B0CHHFDTF3",
  "productName": "Sony WH-1000XM5 Headphones",
  "userEmail":   "user@example.com",
  "currentPrice": 24990,
  "targetPrice":  20000,
  "status":       "ACTIVE",
  "priceHistory": [29990, 26500, 24990],
  "createdAt":    "2024-06-14T11:02:31Z",
  "lastChecked":  "2024-06-14T12:00:03Z",
  "lastAlertAt":  null
}
```

---

## Step 3 — SNS Topic

Go to **SNS → Topics → Create topic**:

- Type: Standard
- Name: `PriceDropAlerts`

Copy the **Topic ARN** — you'll need it in the Lambda code.

---

## Step 4 — Verify SES Email / Domain

Go to **SES → Verified identities → Create identity**:

- For testing: verify your personal email address
- For production: verify your domain (requires DNS TXT/CNAME records)

Also request **SES production access** (by default SES is in sandbox mode and can only send to verified emails).

---

## Step 5 — Lambda Function 1: SaveAlert

Go to **Lambda → Create function**:

- Name: `SaveAlert`
- Runtime: Python 3.12
- Architecture: arm64 (cheaper)
- Execution role: `PriceWatchLambdaRole`

Paste this code:

```python
import json
import boto3
import uuid
from datetime import datetime, timezone

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('price-alerts')

def lambda_handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
    except Exception:
        return response(400, {'error': 'Invalid JSON body'})

    required = ['productUrl', 'productName', 'userEmail', 'currentPrice', 'targetPrice']
    for field in required:
        if field not in body:
            return response(400, {'error': f'Missing field: {field}'})

    cur   = float(body['currentPrice'])
    tgt   = float(body['targetPrice'])

    if tgt >= cur:
        return response(400, {'error': 'targetPrice must be less than currentPrice'})

    alert_id = 'alrt_' + uuid.uuid4().hex[:8]

    item = {
        'alertId':      alert_id,
        'productUrl':   body['productUrl'],
        'productName':  body['productName'],
        'userEmail':    body['userEmail'],
        'currentPrice': int(cur),
        'targetPrice':  int(tgt),
        'status':       'ACTIVE',
        'priceHistory': [int(cur)],
        'createdAt':    datetime.now(timezone.utc).isoformat(),
        'lastChecked':  None,
        'lastAlertAt':  None
    }

    table.put_item(Item=item)

    return response(201, {
        'message': 'Alert created successfully',
        'alertId': alert_id
    })


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',   # CORS for your website
            'Access-Control-Allow-Headers': 'Content-Type,x-api-key'
        },
        'body': json.dumps(body)
    }
```

Set **timeout to 10 seconds** in Configuration → General configuration.

---

## Step 6 — Lambda Function 2: CheckPrice

Create another Lambda function:

- Name: `CheckPrice`
- Runtime: Python 3.12
- Architecture: arm64
- Execution role: `PriceWatchLambdaRole`
- Timeout: **60 seconds** (price fetching takes time)
- Memory: 256 MB

You'll need the `requests` and `beautifulsoup4` libraries. The easiest way:

```
# Create a Lambda Layer with these dependencies
pip install requests beautifulsoup4 -t python/
zip -r layer.zip python/
# Upload as a Layer in Lambda → Layers → Create layer
```

Then paste this code:

```python
import json
import boto3
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')
table    = dynamodb.Table('price-alerts')
sns      = boto3.client('sns')
ses      = boto3.client('ses', region_name='ap-south-1')

SNS_TOPIC_ARN  = 'arn:aws:sns:ap-south-1:YOUR_ACCOUNT_ID:PriceDropAlerts'
SES_FROM_EMAIL = 'alerts@yourdomain.com'   # must be SES-verified


def lambda_handler(event, context):
    # Scan for all ACTIVE alerts
    result = table.scan(
        FilterExpression=boto3.dynamodb.conditions.Attr('status').eq('ACTIVE')
    )
    items = result.get('Items', [])
    print(f"Checking {len(items)} active alerts")

    for item in items:
        try:
            check_alert(item)
        except Exception as e:
            print(f"Error checking alert {item['alertId']}: {e}")

    return {'statusCode': 200, 'body': f'Checked {len(items)} alerts'}


def check_alert(item):
    alert_id    = item['alertId']
    url         = item['productUrl']
    target      = int(item['targetPrice'])
    user_email  = item['userEmail']
    product     = item['productName']
    history     = list(item.get('priceHistory', []))

    current_price = fetch_price(url)
    if current_price is None:
        print(f"Could not fetch price for {alert_id}")
        return

    print(f"{product}: current=₹{current_price}, target=₹{target}")

    # Append to price history (keep last 30 checks)
    history.append(current_price)
    if len(history) > 30:
        history = history[-30:]

    now = datetime.now(timezone.utc).isoformat()

    # Update DynamoDB with latest price + history
    table.update_item(
        Key={'alertId': alert_id},
        UpdateExpression='SET currentPrice=:cp, priceHistory=:ph, lastChecked=:lc',
        ExpressionAttributeValues={
            ':cp': Decimal(str(current_price)),
            ':ph': [Decimal(str(p)) for p in history],
            ':lc': now
        }
    )

    # Fire alert if price dropped below target
    if current_price < target:
        send_alert(alert_id, user_email, product, url, current_price, target, item.get('currentPrice', target))
        # Mark as ALERT_SENT so we don't spam the user
        table.update_item(
            Key={'alertId': alert_id},
            UpdateExpression='SET #s=:s, lastAlertAt=:la',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': 'ALERT_SENT', ':la': now}
        )


def fetch_price(url):
    """
    Scrape Amazon India product price.
    Note: For production use a proper price API (e.g. Rainforest API,
    Keepa API, or Oxylabs) to avoid scraping issues.
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
    }
    try:
        res = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(res.text, 'html.parser')

        # Try multiple price selectors (Amazon changes these)
        selectors = [
            '#priceblock_ourprice',
            '#priceblock_dealprice',
            '.a-price .a-offscreen',
            '#price_inside_buybox',
            '.priceToPay .a-offscreen'
        ]
        for sel in selectors:
            el = soup.select_one(sel)
            if el:
                text = el.get_text().strip()
                price = ''.join(c for c in text if c.isdigit() or c == '.')
                if price:
                    return int(float(price))
    except Exception as e:
        print(f"Scraping error: {e}")
    return None


def send_alert(alert_id, user_email, product, url, current, target, original):
    savings = original - current
    pct     = round((savings / original) * 100, 1)

    # Publish to SNS (optional — for fanout or logging)
    sns.publish(
        TopicArn=SNS_TOPIC_ARN,
        Subject=f'Price Drop: {product}',
        Message=json.dumps({
            'alertId': alert_id,
            'product': product,
            'currentPrice': current,
            'targetPrice': target,
            'savings': savings,
            'userEmail': user_email
        })
    )

    # Send email via SES
    html_body = f"""
    <html><body style="font-family:Inter,sans-serif;background:#0A0E1A;color:#F0F2F7;padding:0;margin:0;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="background:#6C63FF;padding:24px 28px;">
        <div style="font-size:22px;font-weight:700;color:#fff;">⚡ PriceWatch</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px;">Your price alert fired</div>
      </div>
      <div style="background:#111827;padding:24px 28px;">
        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:16px 18px;margin-bottom:20px;">
          <div style="font-size:11px;font-weight:600;color:#22C55E;text-transform:uppercase;letter-spacing:.08em;">Price dropped below your target!</div>
          <div style="display:flex;align-items:baseline;gap:12px;margin-top:8px;flex-wrap:wrap;">
            <span style="font-size:16px;color:#555;text-decoration:line-through;">₹{original:,}</span>
            <span style="font-size:28px;font-weight:700;color:#22C55E;">₹{current:,}</span>
            <span style="font-size:12px;font-weight:600;background:rgba(34,197,94,0.15);color:#22C55E;padding:3px 10px;border-radius:99px;">Save ₹{savings:,} ({pct}%)</span>
          </div>
        </div>
        <p style="font-size:14px;color:#8A93A8;line-height:1.7;">
          <strong style="color:#F0F2F7;">{product}</strong> just dropped to
          <strong style="color:#22C55E;">₹{current:,}</strong> — below your target of ₹{target:,}.
        </p>
        <a href="{url}" style="display:inline-block;background:#6C63FF;color:#fff;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;text-decoration:none;margin-top:8px;">View on Amazon →</a>
      </div>
      <div style="background:#0A0E1A;padding:14px 28px;font-size:11px;color:#555F74;border-top:1px solid rgba(255,255,255,0.08);">
        Sent by PriceWatch · Powered by AWS SNS + SES
      </div>
    </div></body></html>
    """

    ses.send_email(
        Source=SES_FROM_EMAIL,
        Destination={'ToAddresses': [user_email]},
        Message={
            'Subject': {'Data': f'🔔 Price Drop Alert — {product}'},
            'Body': {
                'Html': {'Data': html_body},
                'Text': {'Data': f'{product} dropped to ₹{current:,} (target: ₹{target:,}). View: {url}'}
            }
        }
    )
    print(f"Alert email sent to {user_email} for {product}")
```

---

## Step 7 — API Gateway

Go to **API Gateway → Create API → REST API (not HTTP)**:

1. **Create resource**: `/alerts`
2. **Create method**: `POST` on `/alerts`
   - Integration type: Lambda Function
   - Lambda function: `SaveAlert`
   - Enable Lambda proxy integration: ✓
3. **Enable CORS**: Actions → Enable CORS → Deploy
4. **Create API key**:
   - API Keys → Create → name it `PriceWatchWebsiteKey`
5. **Create Usage Plan**: attach the API key and the stage
6. **Deploy API**: Actions → Deploy → Stage name: `prod`

Copy your **Invoke URL** — it looks like:
```
https://abc12345.execute-api.ap-south-1.amazonaws.com/prod
```

---

## Step 8 — EventBridge Rule

Go to **EventBridge → Rules → Create rule**:

- Name: `PriceCheckEvery6Hours`
- Rule type: Schedule
- Schedule pattern: `cron(0 */6 * * ? *)`
- Target: Lambda function → `CheckPrice`

This fires CheckPrice at 00:00, 06:00, 12:00, 18:00 UTC every day.

---

## Step 9 — Wire up the website

In `index.html`, find the CONFIG section near the bottom and update:

```javascript
const API_URL = 'https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com/prod/alerts';
const API_KEY = 'YOUR_API_KEY_HERE';
```

Then **uncomment the real fetch block** in the `addAlert()` function:

```javascript
// Remove the simulated delay and uncomment this:
const res = await fetch(API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY
  },
  body: JSON.stringify({
    productUrl:   url,
    productName:  name,
    userEmail:    email,
    currentPrice: cur,
    targetPrice:  target
  })
});
if (!res.ok) throw new Error('API error ' + res.status);
const data = await res.json();
```

---

## Step 10 — Deploy the website

**Option A — S3 Static Website (simplest)**

```bash
# Create bucket
aws s3 mb s3://pricewatchapp --region ap-south-1

# Enable static website hosting
aws s3 website s3://pricewatchapp \
  --index-document index.html \
  --error-document index.html

# Upload site
aws s3 cp index.html s3://pricewatchapp/

# Make public (update bucket policy too)
aws s3api put-bucket-acl --bucket pricewatchapp --acl public-read
```

Then add a **CloudFront distribution** in front of S3 for HTTPS and CDN performance.

**Option B — Amplify Hosting (easiest)**

```bash
npm install -g @aws-amplify/cli
amplify init
amplify add hosting
amplify publish
```

**Option C — Any static host**

The `index.html` is a single file with no build step. It works on Netlify, Vercel, GitHub Pages, or any web server.

---

## Architecture checklist

Before going live, verify:

- [ ] SES sender email/domain is verified
- [ ] SES production access requested (out of sandbox)
- [ ] API Gateway API key is set in the website config
- [ ] Lambda `CheckPrice` has the correct SNS Topic ARN and SES sender email
- [ ] DynamoDB table name matches (`price-alerts`)
- [ ] EventBridge rule is enabled and targets `CheckPrice`
- [ ] CORS is enabled on API Gateway for your website's domain
- [ ] Both Lambda functions have the `PriceWatchLambdaRole` IAM role
- [ ] Lambda Layer with `requests` + `beautifulsoup4` is attached to `CheckPrice`

---

## Cost estimate (ap-south-1)

Assuming 500 alerts checked every 6 hours:

| Service | Usage | Est. cost/month |
|---|---|---|
| Lambda | ~3,600 invocations/month | < $0.01 |
| DynamoDB | On-demand, ~50K reads | < $0.05 |
| EventBridge | 120 rules/month | Free tier |
| SNS | ~500 notifications | < $0.01 |
| SES | ~500 emails | ~$0.05 |
| API Gateway | ~1,000 calls | < $0.01 |
| **Total** | | **< $0.15/month** |

For production scale (10K alerts), expect roughly $1–3/month.

---

## Optional enhancements

**1. Use a proper price API instead of scraping**

Amazon blocks scrapers aggressively. Consider:
- [Rainforest API](https://rainforestapi.com) — Amazon product data API
- [Keepa API](https://keepa.com/#!api) — price history + current price
- [Oxylabs](https://oxylabs.io) — web scraping proxy with Amazon support

Replace `fetch_price()` in CheckPrice Lambda with an API call to whichever you choose.

**2. Add a price history endpoint**

Add a `GET /alerts/{alertId}/history` API Gateway method backed by a Lambda that reads the `priceHistory` array from DynamoDB and returns it as JSON for the chart.

**3. Add authentication**

Use Amazon Cognito to let users register, log in, and see only their own alerts. Replace the API key with Cognito JWT tokens.

**4. Re-alert on further drops**

After sending an alert, reset the status back to `ACTIVE` and update `targetPrice` to `currentPrice * 0.95` so users get alerted again if the price drops another 5%.

**5. Multi-retailer support**

Add Flipkart, Croma, or Reliance Digital by writing retailer-specific `fetch_price_*()` functions keyed on the URL domain.
