# FF Name Check API

Free Fire UID → player name/info API. Node.js + Express, Render free tier ready.
Upstream: Free Fire Community API (developers.freefirecommunity.com).

## Endpoints
- `GET /api/name?uid=8674177274` — name only
- `GET /api/player?uid=8674177274&region=BD` — full info
- `GET /api/stats?uid=...` — career stats
- `GET /api/ban?uid=...&lang=en` — ban check
- `GET /api/wishlist?uid=...`
- `GET /health` — uptime monitor

Region `BD` is mapped to upstream `sg`. If the player is not found there, `ind` and `br` are tried automatically.

## Environment variables
| Name | Purpose |
|---|---|
| `FF_API_KEY` | **Required.** Key from developers.freefirecommunity.com |
| `API_KEYS` | Optional comma-separated keys for your own clients (`x-api-key` header or `?key=`) |
| `DEFAULT_REGION` | Default `BD` |
| `CACHE_TTL_SECONDS` | Default 1800 (upstream free tier is only 100 req/hour, so keep cache long) |
| `RATE_LIMIT_PER_MIN` | Default 60 per IP |
| `FF_API_BASE` | Optional, default `https://developers.freefirecommunity.com/api/v1` |

## Deploy on Render (free)
1. Push these files to GitHub.
2. Render → New → Web Service → connect repo (reads `render.yaml`), plan Free.
3. Set `FF_API_KEY` (and `API_KEYS`), deploy.
4. Free plan sleeps after ~15 min: ping `/health` every 5 min with UptimeRobot.

## Local run
```
npm install
FF_API_KEY=your_key npm start
```
