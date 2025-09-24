// Test file for the new simple-orgs endpoint
import fastify from 'fastify';

export function registerSimpleOrgsTestRoute(app) {
  // Test route to verify the simple orgs endpoint is working
  app.get('/ops/test-simple-orgs', { 
    preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] 
  }, async (req, reply) => {
    try {
      // This will call our new endpoint internally
      const res = await app.inject({
        method: 'GET',
        url: '/ops/simple-orgs',
        headers: {
          authorization: req.headers.authorization,
          'x-forwarded-for': req.ip
        }
      });
      
      return {
        status: 'success',
        data: JSON.parse(res.body)
      };
    } catch (error) {
      return reply.status(500).send({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}