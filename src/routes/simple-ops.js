// Simplified Ops routes for the new dashboard
import fastify from 'fastify';

export function registerSimplifiedOpsRoutes(app) {
  // Simplified overview for the new dashboard
  app.get('/ops/simple-overview', { 
    preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] 
  }, async (req) => {
    const admin = app.supabaseAdmin;
    
    // Get key metrics
    const [orgs, docs, orgUsers] = await Promise.all([
      admin.from('organizations').select('id', { count: 'exact', head: true }),
      admin.from('documents').select('id', { count: 'exact', head: true }).not('type', 'eq', 'folder'),
      admin.from('organization_users').select('user_id', { count: 'exact', head: true })
    ]);
    
    // Get recent ops events
    const { data: recentOps } = await admin
      .from('audit_events')
      .select('id, org_id, actor_user_id, type, ts, note')
      .ilike('type', 'ops.%')
      .order('ts', { ascending: false })
      .limit(10);
    
    // Get recent activity
    const { data: recentActivity } = await admin
      .from('audit_events')
      .select('id, org_id, actor_user_id, type, ts, note')
      .order('ts', { ascending: false })
      .limit(10);
    
    return {
      totals: {
        orgs: orgs.count || 0,
        documents: docs.count || 0,
        orgUsers: orgUsers.count || 0
      },
      recentOps: recentOps || [],
      recentActivity: recentActivity || []
    };
  });

  app.get('/ops/orgs/:orgId/analytics', {
    preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin]
  }, async (req) => {
    const { orgId } = req.params;
    const admin = app.supabaseAdmin;

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [docsRes, teamsRes, orgUsersRes, deptUsersRes] = await Promise.all([
      admin
        .from('documents')
        .select('id, file_size_bytes, type, uploaded_at, owner_user_id, department_id')
        .eq('org_id', orgId)
        .neq('type', 'folder'),
      admin
        .from('departments')
        .select('id, name, lead_user_id')
        .eq('org_id', orgId),
      admin
        .from('organization_users')
        .select('user_id, role, expires_at')
        .eq('org_id', orgId),
      admin
        .from('department_users')
        .select('department_id, user_id, role')
        .eq('org_id', orgId)
    ]);

    if (docsRes.error) throw docsRes.error;
    if (teamsRes.error) throw teamsRes.error;
    if (orgUsersRes.error) throw orgUsersRes.error;
    if (deptUsersRes.error) throw deptUsersRes.error;

    const docs = docsRes.data || [];
    const teams = teamsRes.data || [];
    const orgUsers = orgUsersRes.data || [];
    const deptUsers = deptUsersRes.data || [];

    const userIds = Array.from(new Set([
      ...docs.map((d) => d.owner_user_id).filter(Boolean),
      ...orgUsers.map((u) => u.user_id),
      ...deptUsers.map((du) => du.user_id),
      ...teams.map((t) => t.lead_user_id).filter(Boolean)
    ]));

    let profiles = [];
    if (userIds.length) {
      const { data: profileRows, error: profileErr } = await admin
        .from('app_users')
        .select('id, display_name')
        .in('id', userIds);
      if (profileErr) throw profileErr;
      profiles = profileRows || [];
    }

    const teamNameMap = new Map(teams.map((t) => [t.id, t.name]));
    const teamLeadMap = new Map(teams.map((t) => [t.id, t.lead_user_id || null]));
    const userProfileMap = new Map(profiles.map((p) => [p.id, p.display_name || null]));
    const orgUserMap = new Map(orgUsers.map((u) => [u.user_id, u]));

    const totalDocs = docs.length;
    const totalStorage = docs.reduce((sum, doc) => sum + (doc.file_size_bytes || 0), 0);
    const averageSize = totalDocs > 0 ? Math.round(totalStorage / totalDocs) : 0;
    const recentUploads7 = docs.filter((doc) => doc.uploaded_at && new Date(doc.uploaded_at) >= sevenDaysAgo).length;
    const uploads30 = docs.filter((doc) => doc.uploaded_at && new Date(doc.uploaded_at) >= thirtyDaysAgo).length;

    const teamDocs = new Map();
    const userDocs = new Map();

    for (const doc of docs) {
      const docSize = doc.file_size_bytes || 0;
      const teamId = doc.department_id || 'org-wide';
      const teamEntry = teamDocs.get(teamId) || { teamId, documents: 0, storageBytes: 0 };
      teamEntry.documents += 1;
      teamEntry.storageBytes += docSize;
      teamDocs.set(teamId, teamEntry);

      const ownerId = doc.owner_user_id || 'unknown';
      const userEntry = userDocs.get(ownerId) || { userId: ownerId, documents: 0, storageBytes: 0 };
      userEntry.documents += 1;
      userEntry.storageBytes += docSize;
      userDocs.set(ownerId, userEntry);
    }

    const teamSummaries = Array.from(teamDocs.values()).map((entry) => {
      const teamId = entry.teamId;
      const teamMembers = deptUsers.filter((du) => (du.department_id || 'org-wide') === teamId);
      return {
        teamId: teamId === 'org-wide' ? null : teamId,
        teamName: teamId === 'org-wide' ? 'Org-wide' : teamNameMap.get(teamId) || 'Unknown team',
        leadUserId: teamId === 'org-wide' ? null : (teamLeadMap.get(teamId) || null),
        documents: entry.documents,
        storageBytes: entry.storageBytes,
        members: teamMembers.map((member) => ({
          userId: member.user_id,
          role: member.role,
          displayName: userProfileMap.get(member.user_id) || null
        }))
      };
    }).sort((a, b) => b.documents - a.documents);

    const userSummaries = Array.from(userDocs.values()).map((entry) => {
      const profile = userProfileMap.get(entry.userId) || null;
      const orgRole = orgUserMap.get(entry.userId)?.role || null;
      const teamsForUser = deptUsers.filter((du) => du.user_id === entry.userId).map((du) => teamNameMap.get(du.department_id) || 'Org-wide');
      return {
        userId: entry.userId,
        displayName: profile,
        orgRole,
        documents: entry.documents,
        storageBytes: entry.storageBytes,
        teams: teamsForUser
      };
    }).sort((a, b) => b.documents - a.documents);

    const membersByTeam = teams.map((team) => {
      const members = deptUsers.filter((du) => du.department_id === team.id).map((du) => {
        const orgInfo = orgUserMap.get(du.user_id);
        return {
          userId: du.user_id,
          displayName: userProfileMap.get(du.user_id) || null,
          deptRole: du.role,
          orgRole: orgInfo?.role || null,
          expiresAt: orgInfo?.expires_at || null
        };
      });
      return {
        teamId: team.id,
        teamName: team.name,
        leadUserId: team.lead_user_id || null,
        leadName: team.lead_user_id ? (userProfileMap.get(team.lead_user_id) || team.lead_user_id) : null,
        members
      };
    });

    const totalMembers = orgUsers.length;
    const activeMembers = orgUsers.filter((u) => !u.expires_at || new Date(u.expires_at) > now).length;
    const expiring30 = orgUsers.filter((u) => u.expires_at && new Date(u.expires_at) <= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)).length;

    return {
      org: { id: orgId },
      totals: {
        documents: totalDocs,
        storageBytes: totalStorage,
        averageSizeBytes: averageSize,
        members: totalMembers,
        teams: teams.length
      },
      documents: {
        recentUploads7,
        uploads30,
        byTeam: teamSummaries,
        topContributors: userSummaries.slice(0, 5)
      },
      members: {
        total: totalMembers,
        active: activeMembers,
        expiring30,
        byTeam: membersByTeam
      }
    };
  });
}
