# Insighta CLI

Globally installable CLI for the Insighta Labs+ backend.

## Setup

Requires Node.js 22.

```bash
npm install -g .
```

## Usage

```bash
insighta login [--api http://localhost:3000]
insighta logout
insighta whoami

insighta profiles list [--gender male] [--country NG] [--age-group adult]
insighta profiles list [--min-age 25] [--max-age 40] [--sort-by age] [--order desc]
insighta profiles list [--page 2] [--limit 20]
insighta profiles get <id>
insighta profiles search "young males from nigeria"
insighta profiles create --name "Harriet Tubman"
insighta profiles delete <id> [--yes]
insighta profiles export --format csv [--gender male] [--country NG]
```

`create` and `delete` require the `admin` role. `delete` asks for confirmation unless `--yes` is passed.

Login uses GitHub OAuth with PKCE: the CLI generates the verifier locally, sends only the challenge to the backend, and receives the callback on `http://127.0.0.1:53682/callback`.

Credentials are stored at `~/.insighta/credentials.json`. Access tokens are refreshed automatically using the backend refresh endpoint, based on the `expires_in` it returns. API calls send `X-API-Version: 1`.
