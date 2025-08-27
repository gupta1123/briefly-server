/**
 * IP Allowlist Validation Middleware
 * Enforces organization-level IP restrictions for authenticated users
 */

import fp from 'fastify-plugin';

/**
 * Get client IP address from request
 * Handles various proxy scenarios (Heroku, Netlify, etc.)
 */
function getClientIp(request) {
  // Check various headers in order of priority
  const headers = [
    'x-forwarded-for',
    'x-real-ip', 
    'x-client-ip',
    'cf-connecting-ip', // Cloudflare
    'x-forwarded',
    'forwarded-for',
    'forwarded'
  ];

  for (const header of headers) {
    const value = request.headers[header];
    if (value) {
      // x-forwarded-for can be a comma-separated list, take the first one
      const ip = value.split(',')[0].trim();
      if (ip && ip !== 'unknown') {
        return ip;
      }
    }
  }

  // Prefer modern socket API; keep legacy fallbacks
  return request.socket?.remoteAddress || 
         request.connection?.remoteAddress || 
         request.connection?.socket?.remoteAddress ||
         request.ip ||
         'unknown';
}

/**
 * Check if IP is in CIDR range (basic implementation)
 * For now, we'll do exact matching, but this can be extended
 */
function isIpInRange(ip, allowedIp) {
  // For now, exact match. TODO: Add CIDR support
  return ip === allowedIp;
}

/**
 * Validate IP against organization allowlist
 */
async function validateIpAccess(app, orgId, clientIp, userRole = null, hasBypass = false) {
  try {
    // Fetch organization IP settings
    const { data: orgSettings, error } = await app.supabaseAdmin
      .from('org_settings')
      .select('ip_allowlist_enabled, ip_allowlist_ips')
      .eq('org_id', orgId)
      .maybeSingle();

    if (error) {
      app.log.error(error, 'Failed to fetch org IP settings');
      // On error, allow access but log the issue
      return { allowed: true, reason: 'settings_fetch_error' };
    }

    // If no settings found or IP allowlist is disabled, allow access
    if (!orgSettings || !orgSettings.ip_allowlist_enabled) {
      return { allowed: true, reason: 'allowlist_disabled' };
    }

    // Bypass: users with security.ip_bypass (or legacy admin role)
    if (hasBypass || userRole === 'orgAdmin') {
      return { allowed: true, reason: 'admin_bypass' };
    }

    // Check if client IP is in the allowlist
    const allowedIps = orgSettings.ip_allowlist_ips || [];
    const isAllowed = allowedIps.some(allowedIp => isIpInRange(clientIp, allowedIp));

    return {
      allowed: isAllowed,
      reason: isAllowed ? 'ip_allowed' : 'ip_blocked',
      clientIp,
      allowedIps: allowedIps.length
    };

  } catch (err) {
    app.log.error(err, 'IP validation error');
    // On unexpected error, allow access but log
    return { allowed: true, reason: 'validation_error' };
  }
}

/**
 * Fastify plugin for IP validation middleware
 */
async function ipValidationPluginImpl(app, options) {
  // Add IP validation method to app instance
  app.decorate('validateIpAccess', validateIpAccess.bind(null, app));
  app.decorate('getClientIp', getClientIp);

  // IP validation middleware - can be used as preHandler
  app.decorate('requireIpAccess', async (request, reply) => {
    try {
      // Only apply to authenticated requests
      if (!request.user?.sub) {
        return; // Let auth middleware handle this
      }

      // Get organization ID from headers or params
      const orgId = request.headers['x-org-id'] || request.params?.orgId;
      if (!orgId) {
        return; // No org context, skip IP validation
      }

      // Get client IP
      const clientIp = getClientIp(request);
      
      // Get user's role, then fetch role permissions
      const { data: membership } = await request.supabase
        .from('organization_users')
        .select('role, expires_at')
        .eq('org_id', orgId)
        .eq('user_id', request.user.sub)
        .maybeSingle();

      const userRole = membership?.role;
      let hasBypass = false;
      if (userRole) {
        const { data: roleRow } = await request.supabase
          .from('org_roles')
          .select('permissions')
          .eq('org_id', orgId)
          .eq('key', userRole)
          .maybeSingle();
        const perms = roleRow?.permissions || {};
        hasBypass = !!perms['security.ip_bypass'];
      }

      // Validate IP access
      const validation = await validateIpAccess(app, orgId, clientIp, userRole, hasBypass);

      // Log the validation attempt
      app.log.info({
        userId: request.user.sub,
        orgId,
        clientIp,
        allowed: validation.allowed,
        reason: validation.reason,
        userRole,
        hasBypass
      }, 'IP validation check');

      // Block if not allowed
      if (!validation.allowed) {
        // Log security event
        try {
          await app.supabaseAdmin.from('audit_events').insert({
            org_id: orgId,
            actor_user_id: request.user.sub,
            type: 'login',
            note: `IP blocked: ${clientIp} (reason: ${validation.reason})`
          });
        } catch (auditError) {
          app.log.error(auditError, 'Failed to log IP block audit event');
        }

        return reply.code(403).send({ 
          error: 'Access denied',
          message: 'Your IP address is not authorized to access this organization',
          clientIp,
          code: 'IP_NOT_ALLOWED'
        });
      }

      // Add IP info to request for potential use in handlers
      request.clientIp = clientIp;
      request.ipValidation = validation;

    } catch (error) {
      app.log.error(error, 'IP validation middleware error');
      // On error, allow the request but log the issue
      // This prevents IP validation from breaking the application
    }
  });
}

// Export with fastify-plugin wrapper
export const ipValidationPlugin = fp(ipValidationPluginImpl, {
  name: 'ip-validation'
});

export { getClientIp, validateIpAccess };
