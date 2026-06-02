# Deploy on Railway with persistent storage

Ephemeral deploy filesystems are wiped on each build. This app stores durable data outside the image:

| File / folder | Purpose |
|---------------|---------|
| `klines/` | Candle cache |
| `futures-exchangeInfo.json` | Exchange info cache |
| `results.json` | Scanner dashboard state |
| `positions-history-comments.json` | History tab comments |
| `ui-settings.json` | Tab form preferences (movers, top movers, fast corridor) |

## Setup

1. Create a [Railway](https://railway.com/) project from this repo (uses `railway.json`: `node index.js --all`, healthcheck `/health`).

2. **Add a volume** to the web service (Railway dashboard → service → **Volumes** → mount path e.g. `/app/data`).

3. Optional: set variable `DATA_DIR=/app/data` if you use a custom mount path. Railway also sets `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached.

4. Set secrets in Railway (same as `.env.example`): `TELEGRAM_*`, `BINANCE_*`, `DASHBOARD_AUTH_SECRET`, etc.

On first boot with a volume, existing `./.cache` and `public/results.json` are copied into the volume automatically.

Startup logs include: `Persistent data: /app/data` (or your path).
