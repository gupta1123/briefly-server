// Dashboard-specific routes
// Contains APIs for admin team stats and team lead member stats

function requireOrg(req) {
  const orgId = req.headers['x-org-id'] || req.params?.orgId;
  if (!orgId) {
    const err = new Error('Missing org id');
    err.statusCode = 400;
    throw err;
  }
  return orgId;
}

async function ensureActiveMember(req) {
  const db = req.supabase;
  const orgId = requireOrg(req);
  const userId = req.user?.sub;
  if (!userId) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await db
    .from('organization_users')
    .select('role, created_at, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Not a member of this organization');
    err.statusCode = 403;
    throw err;
  }
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    const err = new Error('Membership expired');
    err.statusCode = 403;
    throw err;
  }
  return orgId;
}

export function registerDashboardRoutes(app) {
  // Admin: Get team statistics (docs uploaded today, yesterday, this week, member count)
  app.get('/orgs/:orgId/dashboard/teams', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Check if user is admin
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();

    if (userRole?.role !== 'orgAdmin') {
      return { error: 'Access denied. Admin only.' };
    }

    // Get all departments except Core (which is restricted)
    const { data: departments, error: deptError } = await db
      .from('departments')
      .select('id, name, lead_user_id')
      .eq('org_id', orgId)
      .neq('name', 'Core'); // Exclude restricted Core department

    if (deptError) throw deptError;

    // For each department, get stats
    const teamStats = await Promise.all(
      (departments || []).map(async (dept) => {
        // Get member count
        const { count: memberCount } = await db
          .from('department_users')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id);

        // Get document upload stats
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        // Documents uploaded today
        const { count: todayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .gte('uploaded_at', today.toISOString());

        // Documents uploaded yesterday
        const { count: yesterdayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .gte('uploaded_at', yesterday.toISOString())
          .lt('uploaded_at', today.toISOString());

        // Documents uploaded this week
        const { count: weekCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .gte('uploaded_at', weekAgo.toISOString());

        return {
          id: dept.id,
          name: dept.name,
          memberCount: memberCount || 0,
          docsToday: todayCount || 0,
          docsYesterday: yesterdayCount || 0,
          docsThisWeek: weekCount || 0,
          leadUserId: dept.lead_user_id
        };
      })
    );

    return { teams: teamStats };
  });

  // Team Lead: Get member statistics for their teams
  app.get('/orgs/:orgId/dashboard/members', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Get user's departments where they are team lead
    const { data: userDepts, error: deptError } = await db
      .from('department_users')
      .select('department_id, departments(name)')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('role', 'lead');

    if (deptError) throw deptError;

    if (!userDepts || userDepts.length === 0) {
      return { error: 'No teams found where you are team lead.' };
    }

    // Get all members in the user's departments
    const deptIds = userDepts.map(ud => ud.department_id);
    const { data: allMembers, error: memberError } = await db
      .from('department_users')
      .select(`
        user_id,
        role,
        department_id,
        departments(name),
        app_users(display_name)
      `)
      .eq('org_id', orgId)
      .in('department_id', deptIds);

    if (memberError) throw memberError;

    // Group members by department and get their upload stats
    const memberStats = await Promise.all(
      (allMembers || []).map(async (member) => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        // Documents uploaded by this user today
        const { count: todayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('uploaded_by', member.user_id)
          .gte('uploaded_at', today.toISOString());

        // Documents uploaded by this user yesterday
        const { count: yesterdayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('uploaded_by', member.user_id)
          .gte('uploaded_at', yesterday.toISOString())
          .lt('uploaded_at', today.toISOString());

        // Documents uploaded by this user this week
        const { count: weekCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('uploaded_by', member.user_id)
          .gte('uploaded_at', weekAgo.toISOString());

        return {
          userId: member.user_id,
          displayName: member.app_users?.display_name || 'Unknown',
          role: member.role,
          departmentName: member.departments?.name || 'Unknown',
          docsToday: todayCount || 0,
          docsYesterday: yesterdayCount || 0,
          docsThisWeek: weekCount || 0
        };
      })
    );

    return { members: memberStats };
  });
}
