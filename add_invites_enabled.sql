-- Friend game invites: per-user toggle to opt out of receiving invites.
-- Run this in the Supabase SQL editor. Safe to run more than once.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS invites_enabled boolean NOT NULL DEFAULT true;
