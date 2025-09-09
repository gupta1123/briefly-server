// Caching layer for improved performance

// In-memory cache with TTL
class InMemoryCache {
  constructor(defaultTTL = 300000) { // 5 minutes default
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Clean up every minute
  }

  set(key, value, ttl = this.defaultTTL) {
    const expiry = Date.now() + ttl;
    this.cache.set(key, { value, expiry });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiry) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

// Initialize caches
const userCache = new InMemoryCache(300000); // 5 minutes for user profiles
const orgCache = new InMemoryCache(600000); // 10 minutes for org data
const permissionCache = new InMemoryCache(180000); // 3 minutes for permissions
const departmentCache = new InMemoryCache(600000); // 10 minutes for department data
const settingsCache = new InMemoryCache(900000); // 15 minutes for settings

// Cache keys generator
const CacheKeys = {
  userProfile: (userId) => `user_profile_${userId}`,
  orgMembership: (userId, orgId) => `org_membership_${userId}_${orgId}`,
  orgDepartments: (orgId) => `org_departments_${orgId}`,
  userDepartments: (userId, orgId) => `user_departments_${userId}_${orgId}`,
  orgSettings: (orgId) => `org_settings_${orgId}`,
  userSettings: (userId) => `user_settings_${userId}`,
  userPermissions: (userId, orgId) => `user_permissions_${userId}_${orgId}`,
  departmentMembers: (deptId) => `dept_members_${deptId}`,
};

// Enhanced user profile fetching with caching
async function getCachedUserProfile(app, userId) {
  const cacheKey = CacheKeys.userProfile(userId);
  let profile = userCache.get(cacheKey);
  
  if (!profile) {
    try {
      // Try Supabase first
      const { data: appUser } = await app.supabase
        .from('app_users')
        .select('id, display_name')
        .eq('id', userId)
        .maybeSingle();
      
      if (appUser) {
        profile = {
          id: appUser.id,
          displayName: appUser.display_name
        };
      } else {
        // Fallback to Auth API
        const authUser = await getAdminUserCached(app, userId);
        profile = {
          id: userId,
          displayName: authUser.displayName,
          email: authUser.email
        };
      }
      
      userCache.set(cacheKey, profile);
    } catch (error) {
      console.error('Error fetching user profile:', error);
      profile = { id: userId, displayName: null };
    }
  }
  
  return profile;
}

// Enhanced organization membership with caching
async function getCachedOrgMembership(db, userId, orgId) {
  const cacheKey = CacheKeys.orgMembership(userId, orgId);
  let membership = orgCache.get(cacheKey);
  
  if (!membership) {
    const { data, error } = await db
      .from('organization_users')
      .select('role, created_at, expires_at')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    
    if (error) throw error;
    
    membership = data;
    orgCache.set(cacheKey, membership, 180000); // 3 minutes
  }
  
  return membership;
}

// Enhanced department data with caching
async function getCachedOrgDepartments(db, orgId) {
  const cacheKey = CacheKeys.orgDepartments(orgId);
  let departments = departmentCache.get(cacheKey);
  
  if (!departments) {
    const { data, error } = await db
      .from('departments')
      .select('id, org_id, name, lead_user_id, color, categories, created_at, updated_at')
      .eq('org_id', orgId)
      .order('name');
    
    if (error) throw error;
    
    departments = data || [];
    departmentCache.set(cacheKey, departments);
  }
  
  return departments;
}

// Enhanced user departments with caching
async function getCachedUserDepartments(db, userId, orgId) {
  const cacheKey = CacheKeys.userDepartments(userId, orgId);
  let departments = departmentCache.get(cacheKey);
  
  if (!departments) {
    const { data: myDU } = await db
      .from('department_users')
      .select('department_id, role')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    departments = myDU || [];
    departmentCache.set(cacheKey, departments);
  }
  
  return departments;
}

// Enhanced organization settings with caching
async function getCachedOrgSettings(db, orgId) {
  const cacheKey = CacheKeys.orgSettings(orgId);
  let settings = settingsCache.get(cacheKey);
  
  if (!settings) {
    const { data: orgSettingsRow } = await db
      .from('org_settings')
      .select('*')
      .eq('org_id', orgId)
      .maybeSingle();
    
    settings = orgSettingsRow || {
      org_id: orgId,
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'],
    };
    
    settingsCache.set(cacheKey, settings);
  }
  
  return settings;
}

// Enhanced user settings with caching
async function getCachedUserSettings(db, userId) {
  const cacheKey = CacheKeys.userSettings(userId);
  let settings = settingsCache.get(cacheKey);
  
  if (!settings) {
    let { data: userSettings } = await db
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (!userSettings) {
      const defaults = {
        user_id: userId,
        date_format: 'd MMM yyyy',
        accent_color: 'default',
        dark_mode: false,
        chat_filters_enabled: false,
      };
      
      try {
        const { data: created } = await db
          .from('user_settings')
          .upsert(defaults, { onConflict: 'user_id' })
          .select('*')
          .single();
        userSettings = created || defaults;
      } catch {
        userSettings = defaults;
      }
    }
    
    settings = userSettings;
    settingsCache.set(cacheKey, settings);
  }
  
  return settings;
}

// Enhanced permissions with caching
async function getCachedUserPermissions(req, orgId) {
  const userId = req.user?.sub;
  const cacheKey = CacheKeys.userPermissions(userId, orgId);
  let permissions = permissionCache.get(cacheKey);
  
  if (!permissions) {
    try {
      const { data: permMap, error } = await req.supabase.rpc('get_my_permissions', { p_org_id: orgId });
      if (!error && permMap) {
        permissions = permMap;
      } else {
        permissions = await getMyPermissions(req, orgId);
      }
    } catch {
      permissions = await getMyPermissions(req, orgId);
    }
    
    permissionCache.set(cacheKey, permissions);
  }
  
  return permissions;
}

// Cache invalidation functions
function invalidateUserCache(userId) {
  const userProfileKey = CacheKeys.userProfile(userId);
  userCache.delete(userProfileKey);
}

function invalidateOrgCache(orgId) {
  // Invalidate all cached data for this org
  for (const key of orgCache.cache.keys()) {
    if (key.includes(`_${orgId}_`)) {
      orgCache.delete(key);
    }
  }
  for (const key of departmentCache.cache.keys()) {
    if (key.includes(`_${orgId}_`)) {
      departmentCache.delete(key);
    }
  }
  for (const key of settingsCache.cache.keys()) {
    if (key.includes(`_${orgId}`)) {
      settingsCache.delete(key);
    }
  }
}

function invalidateUserOrgCache(userId, orgId) {
  const orgMembershipKey = CacheKeys.orgMembership(userId, orgId);
  const userDepartmentsKey = CacheKeys.userDepartments(userId, orgId);
  const userPermissionsKey = CacheKeys.userPermissions(userId, orgId);
  
  orgCache.delete(orgMembershipKey);
  departmentCache.delete(userDepartmentsKey);
  permissionCache.delete(userPermissionsKey);
}

// Enhanced bootstrap endpoint with caching
export async function getOptimizedBootstrapData(app, req) {
  console.log('Optimized Bootstrap endpoint called for user:', req.user?.sub);
  const db = req.supabase;
  const userId = req.user?.sub;
  
  // Parallel fetch with caching
  const [
    userRow,
    orgRows,
    orgSettingsRow,
    userSettingsRow
  ] = await Promise.all([
    getCachedUserProfile(app, userId),
    db.from('organization_users')
      .select('org_id, role, expires_at, organizations(name)')
      .eq('user_id', userId),
    req.headers['x-org-id'] 
      ? getCachedOrgSettings(db, req.headers['x-org-id'])
      : Promise.resolve(null),
    getCachedUserSettings(db, userId)
  ]);
  
  if (orgRows.error) throw orgRows.error;
  
  const now = Date.now();
  const orgs = (orgRows.data || []).filter((r) => 
    !r.expires_at || new Date(r.expires_at).getTime() > now
  );
  
  // Choose selected org id
  const hdrOrg = req.headers['x-org-id'] ? String(req.headers['x-org-id']) : null;
  const roleOrder = { guest: 0, contentViewer: 1, member: 2, contentManager: 2, teamLead: 3, orgAdmin: 4 };
  let selectedOrgId = null;
  
  if (hdrOrg && orgs.some((o) => String(o.org_id) === hdrOrg)) {
    selectedOrgId = hdrOrg;
  } else if (orgs.length > 0) {
    const best = orgs.reduce((acc, r) => 
      (roleOrder[r.role] > roleOrder[acc.role] ? r : acc), orgs[0]);
    selectedOrgId = String(best.org_id);
  }
  
  // Get departments with caching
  let departments = [];
  if (selectedOrgId) {
    const [depts, myDU] = await Promise.all([
      getCachedOrgDepartments(db, selectedOrgId),
      getCachedUserDepartments(db, userId, selectedOrgId)
    ]);
    
    const memSet = new Set((myDU || []).map((r) => r.department_id));
    const leadSet = new Set((myDU || []).filter((r) => r.role === 'lead').map((r) => r.department_id));
    
    departments = (depts || []).map((d) => ({ 
      ...d, 
      is_member: memSet.has(d.id), 
      is_lead: leadSet.has(d.id),
      categories: d.categories || [
        'General', 'Legal', 'Financial', 'HR', 'Marketing', 
        'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'
      ]
    }));
  }
  
  const result = {
    user: userRow,
    orgs: orgs.map((r) => ({ 
      orgId: r.org_id, 
      role: r.role, 
      name: r.organizations?.name, 
      expiresAt: r.expires_at 
    })),
    selectedOrgId,
    orgSettings: orgSettingsRow || {
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: [
        'General', 'Legal', 'Financial', 'HR', 'Marketing', 
        'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'
      ],
    },
    userSettings: userSettingsRow,
    permissions: selectedOrgId ? await getCachedUserPermissions(req, selectedOrgId) : {},
    departments,
  };
  
  console.log('Optimized bootstrap returning data:', {
    userId,
    selectedOrgId,
    orgCount: orgs.length,
    departmentCount: departments.length
  });
  
  return result;
}

// Export cache instances for external management
export { 
  userCache, 
  orgCache, 
  permissionCache, 
  departmentCache, 
  settingsCache,
  CacheKeys,
  invalidateUserCache,
  invalidateOrgCache,
  invalidateUserOrgCache
};