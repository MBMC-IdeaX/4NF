// `node --import ./validator/register.mjs ...` — installs the hook in loader.mjs
// before anything from src/ is imported.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

// What Vite would have baked into the browser build. The validator reads the
// same names from its own environment, so one .env serves both.
globalThis.__BHADA_ENV__ = {
  VITE_SYNC_URL: process.env.BHADA_SYNC_URL ?? process.env.VITE_SYNC_URL ?? '',
  VITE_SUPABASE_ANON_KEY: process.env.BHADA_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '',
  VITE_SUPABASE_URL: '',
  DEV: false,
  PROD: true,
};
