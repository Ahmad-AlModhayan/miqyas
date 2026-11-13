// Clean-twin client bundle referencing Supabase public config and protected API routes.
const supabaseConfig = {
  url: window.location.origin,
  anonKey: 'sb_publishable_clean_demo_key_123456',
};
const TABLES = ['/rest/v1/profiles'];
const APP_ROUTES = ['/api/orders', '/dashboard', '/settings'];
window.__MIQYAS_CLEAN_TWIN__ = { supabaseConfig, TABLES, APP_ROUTES };
