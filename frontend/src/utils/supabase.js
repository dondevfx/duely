import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,      // keep refreshing the JWT before it expires
    persistSession: true,        // store session in localStorage so it survives refreshes
    detectSessionInUrl: true,    // handle OAuth/magic-link redirects
    storageKey: 'duely_auth',    // custom key so other Supabase apps don't overwrite it
  },
});
