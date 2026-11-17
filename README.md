# FF Name Check API

Free Fire UID → player name/info API. Node.js + Express, Render free tier ready.

## Endpoints
- `GET /api/player?uid=8674177274&region=BD` — full info
- `GET /api/name?uid=8674177274` — name only
- `GET /health` — for uptime monitors

## Environment variables
| Name | Purpose |
|---|---|
| `UPSTREAM_URL` | Your data source URL, with `{uid}` and `{region}` placeholders (required) |
| `UPSTREAM_KEY` | Optional bearer token for the upstream |
| `API_KEYS` | Optional comma-separated keys; if set, clients send `x-api-key` header or `?key=` |
| `DEFAULT_REGION` | Default `BD` |
| `CACHE_TTL_SECONDS` | Default 300 |
| `RATE_LIMIT_PER_MIN` | Default 60 per IP |

## Deploy on Render (free)
1. Push these files to a GitHub repo.
2. Render → New → Web Service → connect repo (it reads `render.yaml`), plan **Free**.
3. Add the env variables above, deploy.
4. Free plan sleeps after ~15 min idle: add https://uptimerobot.com to ping `/health` every 5 min.

## Local run
```
npm install
UPSTREAM_URL="https://source.example/info?uid={uid}&region={region}" npm start
```
