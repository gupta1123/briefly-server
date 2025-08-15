import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sse from 'fastify-sse-v2';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './env.js';
import { registerRoutes } from './routes.js';

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(sse);
  await app.register(jwt, { secret: env.SUPABASE_JWT_SECRET });
  await app.register(multipart);

  // Service-role client for privileged server-side ops (e.g., storage uploads)
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  app.decorate('supabaseAdmin', supabaseAdmin);

  // Auth pre-handler: verify JWT and create a request-scoped Supabase client that enforces RLS
  app.decorate('verifyAuth', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (token) {
        const payload = await app.jwt.verify(token);
        request.user = payload;
        // Create RLS-enforced client for this request
        request.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        return;
      }

      return reply.code(401).send({ error: 'Unauthorized' });
    } catch (e) {
      request.log.error(e, 'Auth check failed');
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerRoutes(app);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});