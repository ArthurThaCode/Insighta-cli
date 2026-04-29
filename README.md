# Insighta CLI

Globally installable CLI for the Insighta Labs+ backend.

## Setup

```bash
npm install -g .
```

## Usage

```bash
insighta login --api https://your-backend.up.railway.app
insighta logout
insighta whoami

insighta profiles list
insighta profiles list --gender male
insighta profiles list --country NG --age-group adult
insighta profiles list --min-age 25 --max-age 40
insighta profiles list --sort-by age --order desc --page 2 --limit 20
insighta profiles get <id>
insighta profiles search "young males from nigeria"
insighta profiles create --name "Harriet Tubman"
insighta profiles export --format csv
insighta profiles export --format csv --gender male --country NG
```

Credentials are stored at `~/.insighta/credentials.json`. Access tokens are refreshed automatically using the backend refresh endpoint. API calls send `X-API-Version: 1`.
