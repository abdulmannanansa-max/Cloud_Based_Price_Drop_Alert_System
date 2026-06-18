# PriceWatch — Quick Deploy Guide
### Go from files to a live, secure URL in ~25 minutes

---

## What you're deploying

```
Browser (index.html)
    │  POST /alerts   (no API key here)
    ▼
Cloudflare Worker  ← API key stored here, never in the browser
    │  POST + x-api-key header
    ▼
AWS API Gateway
    │
    ▼
Lambda (SaveAlert) → DynamoDB
EventBridge (every 6h) → Lambda (CheckPrice) → SNS → SES → Email
```

---

## Part 1 — AWS backend (one-time setup, ~15 min)

Follow the steps in `AWS_INTEGRATION_GUIDE.md` — Steps 1 through 8.
After completing them you will have:
- A DynamoDB table called `price-alerts`
- Two Lambda functions: `SaveAlert` and `CheckPrice`
- An API Gateway endpoint URL (looks like `https://abc123.execute-api.ap-south-1.amazonaws.com/prod`)
- An API key string

Keep both the **URL** and the **API key** — you'll need them in Part 2.

---

## Part 2 — Cloudflare Worker proxy (~5 min)

The Worker is a tiny middleman that holds your AWS API key securely
so it never appears in your website's source code.

### 2a. Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login          # opens a browser tab to authenticate
```

### 2b. Set your secrets

```bash
cd proxy/

wrangler secret put API_KEY
# paste your AWS API Gateway key when prompted, press Enter

wrangler secret put API_GATEWAY_URL
# paste the full URL:  https://abc123.execute-api.ap-south-1.amazonaws.com/prod/alerts
```

Cloudflare encrypts these immediately. They are never visible again —
not in the dashboard, not in logs, not in your code.

### 2c. Deploy the Worker

```bash
wrangler deploy
```

You'll get a URL like:
```
https://pricewatch-proxy.YOUR-NAME.workers.dev
```

Copy it — you need it in Part 3.

---

## Part 3 — Update index.html (~2 min)

Open `index.html` and find the CONFIG line near the bottom of the `<script>` tag:

```js
const PROXY_URL = 'https://pricewatch-proxy.YOUR-NAME.workers.dev/alerts';
```

Replace `YOUR-NAME` with your actual Cloudflare Workers subdomain.

---

## Part 4 — Host the website (~5 min)

Choose one option:

### Option A — Netlify (recommended, free, HTTPS automatic)

1. Go to [netlify.com](https://netlify.com) → Log in → "Add new site" → "Deploy manually"
2. Drag and drop your `index.html` file into the deploy box
3. Netlify gives you a URL like `https://amazing-name-123.netlify.app`
4. Copy that URL

### Option B — GitHub Pages (free, HTTPS automatic)

```bash
# In the pricedrop-site folder:
git init
git add index.html
git commit -m "deploy"
gh repo create pricewatch --public --push --source .
# Enable Pages in repo Settings → Pages → Deploy from branch → main
```

Your URL will be `https://YOUR-GITHUB-USERNAME.github.io/pricewatch`

---

## Part 5 — Lock CORS to your domain (~1 min)

Once you have your hosting URL (from Part 4), open `proxy/wrangler.toml`
and update the `ALLOWED_ORIGIN` line:

```toml
[vars]
ALLOWED_ORIGIN = "https://amazing-name-123.netlify.app"
```

Then redeploy the Worker:

```bash
cd proxy/
wrangler deploy
```

This ensures only your website can call your Worker — no other site can abuse it.

---

## Done! Verify it works

1. Open your hosted URL
2. Fill in the alert form with a real amazon.in URL
3. Submit — you should see "✓ Alert set!" toast
4. Check AWS CloudWatch → Log groups → `/aws/lambda/SaveAlert` to confirm the Lambda ran
5. Check your DynamoDB table → Explore items — your alert should appear there

---

## Security checklist for your presentation

| What | How it's secured |
|---|---|
| AWS API key | Stored as a Cloudflare secret — never in HTML/JS |
| CORS | Locked to your domain in `ALLOWED_ORIGIN` |
| Rate limiting | 5 requests / IP / minute in the Worker |
| Input validation | Both client-side (index.html) and server-side (Worker + Lambda) |
| Input sanitization | HTML escaped, control chars stripped, length capped |
| IAM permissions | Least-privilege policy (only the 4 actions Lambda actually needs) |
| Lambda secrets | TABLE_NAME, ALLOWED_ORIGIN set as env vars — not hardcoded |

---

## File summary

```
pricedrop-site/
├── index.html              ← website (deploy this to Netlify/GitHub Pages)
├── proxy/
│   ├── index.js            ← Cloudflare Worker (holds API key, validates, rate-limits)
│   └── wrangler.toml       ← Worker config (update ALLOWED_ORIGIN)
├── lambda/
│   └── save_alert.py       ← hardened Lambda code (paste into AWS console)
└── AWS_INTEGRATION_GUIDE.md
```
