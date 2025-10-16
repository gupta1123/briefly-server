/**
 * IP Allowlist Validation Middleware
 * Enforces organization-level IP restrictions for authenticated users
 */

import fp from 'fastify-plugin';
import { getEffectivePermissions } from './routes.js';

// Simple in-memory cache for IP settings
const ipSettingsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
 * Convert IP address to number for range calculations
 */
function ipToNumber(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/**
 * Check if IP is in CIDR range
 * Supports both exact matches and CIDR notation (e.g., 192.168.1.0/24)
 */
function isIpInRange(ip, allowedIp) {
  try {
    // Exact match
    if (ip === allowedIp) {
      return true;
    }
    
    // CIDR notation (e.g., 192.168.1.0/24)
    if (allowedIp.includes('/')) {
      const [network, prefixLength] = allowedIp.split('/');
      const prefix = parseInt(prefixLength, 10);
      
      if (isNaN(prefix) || prefix < 0 || prefix > 32) {
        app.log.warn(`Invalid CIDR prefix length: ${prefixLength}`);
        return false;
      }
      
      try {
        const ipNum = ipToNumber(ip);
        const networkNum = ipToNumber(network);
        const mask = (0xffffffff << (32 - prefix)) >>> 0;
        
        return (ipNum & mask) === (networkNum & mask);
      } catch (error) {
        app.log.warn(`Error processing CIDR ${allowedIp}: ${error.message}`);
        return false;
      }
    }
    
    return false;
  } catch (error) {
    app.log.warn(`Error checking IP range ${ip} against ${allowedIp}: ${error.message}`);
    return false;
  }
}

/**
 * Get cached IP settings or fetch from database
 */
async function getIpSettings(app, orgId) {
  const cacheKey = `ip_settings:${orgId}`;
  const cached = ipSettingsCache.get(cacheKey);
  
  // Check if cache is still valid
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  
  // Fetch from database
  const { data: orgSettings, error } = await app.supabaseAdmin
    .from('org_settings')
    .select('ip_allowlist_enabled, ip_allowlist_ips')
    .eq('org_id', orgId)
    .maybeSingle();
  
  if (error) {
    throw error;
  }
  
  // Cache the result
  ipSettingsCache.set(cacheKey, {
    data: orgSettings,
    timestamp: Date.now()
  });
  
  return orgSettings;
}

/**
 * Validate IP against organization allowlist
 */
async function validateIpAccess(app, orgId, clientIp, userRole = null, hasBypass = false) {
  try {
    // Get organization IP settings (with caching)
    const orgSettings = await getIpSettings(app, orgId);

    // If no settings found or IP allowlist is disabled, allow access
    if (!orgSettings || !orgSettings.ip_allowlist_enabled) {
      return { allowed: true, reason: 'allowlist_disabled' };
    }

    // Bypass: users with security.ip_bypass permission
    if (hasBypass) {
      app.log.info({
        orgId,
        userId: 'unknown', // We don't have userId in this context
        clientIp,
        userRole,
        reason: 'permission_bypass'
      }, 'IP bypass granted via security.ip_bypass permission');
      return { allowed: true, reason: 'permission_bypass' };
    }
    
    // Legacy admin bypass (with enhanced logging)
    if (userRole === 'orgAdmin') {
      app.log.warn({
        orgId,
        userId: 'unknown', // We don't have userId in this context
        clientIp,
        userRole,
        reason: 'admin_bypass'
      }, 'Admin IP bypass used - consider using security.ip_bypass permission instead');
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
  
  // Add cache invalidation method
  app.decorate('invalidateIpSettingsCache', (orgId) => {
    const cacheKey = `ip_settings:${orgId}`;
    ipSettingsCache.delete(cacheKey);
    app.log.info({ orgId }, 'IP settings cache invalidated');
  });

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
      
      // Get user's role to aid in diagnostics
      const { data: membership } = await app.supabaseAdmin
        .from('organization_users')
        .select('role, expires_at')
        .eq('org_id', orgId)
        .eq('user_id', request.user.sub)
        .maybeSingle();

      const userRole = membership?.role;
      let hasBypass = false;
      let bypassMeta = null;
      try {
        const permResult = await getEffectivePermissions(request, String(orgId), app);
        const permissions = permResult.permissions || {};
        request.permissions = permissions;
        request.permissionsMeta = permResult.meta;
        hasBypass = permissions['security.ip_bypass'] === true;
        bypassMeta = permResult.meta?.security?.ip_bypass || null;
      } catch (permError) {
        app.log.warn(permError, 'Failed to compute effective permissions during IP validation');
      }

      // Validate IP access
      const validation = await validateIpAccess(app, orgId, clientIp, userRole, hasBypass);
      request.ipBypassMeta = bypassMeta;

      // Enhanced logging with more context
      app.log.info({
        userId: request.user.sub,
        orgId,
        clientIp,
        userAgent: request.headers['user-agent'],
        endpoint: request.url,
        method: request.method,
        allowed: validation.allowed,
        reason: validation.reason,
        userRole,
        hasBypass,
        bypassSource: bypassMeta?.source || null,
        bypassExpiresAt: bypassMeta?.expiresAt || null,
        bypassGrantId: bypassMeta?.grantId || null,
        timestamp: new Date().toISOString()
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
