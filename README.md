# SignalQ — Kolkata traffic & air command

Real-time traffic simulation on OpenStreetMap: adaptive signals, ambulance green corridors with live ETA,
AI congestion/AQI forecasting with recommended actions, and a junction lane-conflict graph.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build into dist/
```

Needs Node 22+.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo.
3. Leave the defaults (Framework: Vite, Build: `npm run build`, Output: `dist`) and click **Deploy**.

`vercel.json` already contains these settings. No environment variables are required.

Or with the CLI: `npx vercel --prod`.
