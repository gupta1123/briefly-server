// Route Registry - Central place to register all route modules
// This keeps the main routes.js clean and organized

import { registerDashboardRoutes } from './dashboard.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAgentRoutes } from './agents.js';
import { registerTestAgentRoutes } from './test-agent.js';

/**
 * Register all route modules with the app
 * @param {Object} app - Fastify app instance
 */
export function registerAllRoutes(app) {
  // Register dashboard routes
  registerDashboardRoutes(app);

  // Register settings routes
  registerSettingsRoutes(app);

  // Register enhanced agent routes
  registerAgentRoutes(app);

  // Register test agent routes
  registerTestAgentRoutes(app);

  // Add new route modules here as you create them:
  // registerAnalyticsRoutes(app);
  // registerReportingRoutes(app);
  // registerUserManagementRoutes(app);
  // etc.

  console.log('✅ All route modules registered successfully');
}