import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ORG_NAME = process.env.SEED_ORG_NAME || 'Briefly Demo Org';

const USERS = [
  { label: 'System Administrator', username: 'admin', email: 'admin@briefly.local', password: 'Admin#2025', display_name: 'Admin', role: 'orgAdmin' },
  { label: 'Content Manager', username: 'manager', email: 'manager@briefly.local', password: 'Manager#2025', display_name: 'Manager', role: 'contentManager' },
  { label: 'Content Viewer', username: 'viewer', email: 'viewer@briefly.local', password: 'Viewer#2025', display_name: 'Viewer', role: 'contentViewer' },
  { label: 'Guest', username: 'guest', email: 'guest@briefly.local', password: 'Guest#2025', display_name: 'Guest', role: 'guest' },
];

async function findUserByEmail(email) {
  // Supabase Admin API doesn't offer a direct get by email; list and filter
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const found = data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 1000) return null;
    page += 1;
  }
}

async function ensureAuthUser(email, password) {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return data.user;
}

async function ensureAppUser(userId, displayName) {
  const { error } = await supabase.from('app_users').upsert({ id: userId, display_name: displayName });
  if (error) throw error;
}

async function ensureOrg(name) {
  const { data: existing, error: selErr } = await supabase.from('organizations').select('*').eq('name', name).maybeSingle();
  if (selErr && selErr.code !== 'PGRST116') throw selErr;
  if (existing) return existing;
  const { data, error } = await supabase.from('organizations').insert({ name }).select('*').single();
  if (error) throw error;
  return data;
}

async function ensureOrgRole(orgId, userId, role) {
  const { data: existing, error: selErr } = await supabase
    .from('organization_users')
    .select('*')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (selErr && selErr.code !== 'PGRST116') throw selErr;
  if (existing) {
    if (existing.role !== role) {
      const { error } = await supabase.from('organization_users').update({ role }).eq('org_id', orgId).eq('user_id', userId);
      if (error) throw error;
    }
    return existing;
  }
  const { data, error } = await supabase.from('organization_users').insert({ org_id: orgId, user_id: userId, role }).select('*').single();
  if (error) throw error;
  return data;
}

async function main() {
  try {
    console.log('Ensuring organization:', ORG_NAME);
    const org = await ensureOrg(ORG_NAME);
    console.log('Org ID:', org.id);

    for (const u of USERS) {
      console.log(`Ensuring user: ${u.label} <${u.email}>`);
      const authUser = await ensureAuthUser(u.email, u.password);
      await ensureAppUser(authUser.id, u.display_name);
      await ensureOrgRole(org.id, authUser.id, u.role);
      console.log(` - ok: ${u.role}`);
    }

    console.log('Seed complete.');
  } catch (e) {
    console.error('Seed failed:', e);
    process.exit(1);
  }
}

main();