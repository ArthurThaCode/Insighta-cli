# Insighta CLI

Globally installable CLI for the Insighta Labs+ backend.

## Setup

```bash
npm install -g .
```

## Usage

```bash
insighta login --api https://your-backend.up.railway.app
insighta callback --code <code> --state <state>
insighta me
insighta profiles --page 1 --limit 10
insighta search "young males from nigeria"
insighta create "Ada"
insighta delete <profile-id>
insighta export --out profiles.csv
insighta logout
```

Credentials are stored at `~/.insighta/credentials.json`. Access tokens are refreshed automatically using the backend refresh endpoint.
