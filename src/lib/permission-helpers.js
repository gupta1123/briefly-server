#!/usr/bin/env node
/**
 * Permission Helpers
 * Centralized functions for permission management and page access control
 */

/**
 * Calculates page permissions from functional permissions
 * This ensures page permissions are always derived from functional permissions
 * Note: dashboard.view is NOT auto-calculated - it must be explicitly set
 * 
 * @param {Object} functionalPermissions - Object with functional permission keys (e.g., documents.create, audit.read)
 * @returns {Object} Object with page permission keys and their calculated values
 */
export function calculatePagePermissions(functionalPermissions) {
  if (!functionalPermissions || typeof functionalPermissions !== 'object') {
    return {};
  }

  return {
    // Upload page: based on documents.create
    'pages.upload': functionalPermissions['documents.create'] === true,
    
    // Documents/Folders page: based on documents.read
    'pages.documents': functionalPermissions['documents.read'] === true,
    
    // Activity/Audit page: based on audit.read
    'pages.activity': functionalPermissions['audit.read'] === true,
    
    // Recycle bin: based on org.manage_members OR documents.delete
    'pages.recycle_bin': functionalPermissions['org.manage_members'] === true || 
                         functionalPermissions['documents.delete'] === true,
    
    // Chat: default to true for backward compatibility
    // Can be restricted via overrides if needed
    'pages.chat': true
    
    // Note: dashboard.view is NOT auto-calculated here
    // It must be explicitly set when creating/updating roles
    // Default behavior: if not set, frontend will use role-based logic
  };
}

/**
 * Merges functional permissions with calculated page permissions
 * Use this whenever creating or updating role permissions
 * 
 * @param {Object} functionalPermissions - Functional permission object
 * @returns {Object} Complete permissions object with both functional and page permissions
 */
export function getCompleteRolePermissions(functionalPermissions) {
  if (!functionalPermissions || typeof functionalPermissions !== 'object') {
    return {};
  }

  return {
    ...functionalPermissions,
    ...calculatePagePermissions(functionalPermissions)
  };
}

/**
 * Validates and normalizes role permissions
 * Ensures page permissions are always present when functional permissions exist
 * 
 * @param {Object} permissions - Permissions object (may or may not have page permissions)
 * @returns {Object} Normalized permissions with page permissions added if functional permissions exist
 */
export function normalizeRolePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') {
    return {};
  }

  // Check if functional permissions exist but page permissions don't
  const hasFunctionalPerms = Object.keys(permissions).some(
    key => !key.startsWith('pages.')
  );

  if (hasFunctionalPerms) {
    // Ensure page permissions are calculated
    return getCompleteRolePermissions(permissions);
  }

  return permissions;
}

