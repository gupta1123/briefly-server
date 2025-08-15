# Server (Node.js + Fastify, JavaScript ESM)

This is the Node.js backend for the project (plain JavaScript, ESM).

## Dev

1. Create `.env` with:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `PORT=8787`
2. Install deps: `npm i`
3. Run dev: `npm run dev`

## Scripts
- `dev`: Node with watch
- `start`: Node start

## Notes
- All endpoints are ESM modules in `src/*.js`.
- Every org-scoped route requires `X-Org-Id` header or `:orgId` param and is protected by Supabase RLS.