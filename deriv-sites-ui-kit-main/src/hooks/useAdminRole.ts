import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { PlatformRole } from "@reef-sites/shared-types";

type PlatformAccess = {
  role: PlatformRole | "legacy_admin" | null;
  isAdmin: boolean;
  canManageSites: boolean;
  canSupport: boolean;
  canViewFinance: boolean;
  loading: boolean;
  /**
   * Why access could not be resolved. Present only when the check itself broke
   * (network, RLS, missing function). A signed-in user who genuinely has no
   * admin role gets `null` here and `isAdmin: false`.
   */
  error: string | null;
};

type AccessFacts = Omit<PlatformAccess, "loading" | "error">;

const NO_ACCESS: AccessFacts = {
  role: null,
  isAdmin: false,
  canManageSites: false,
  canSupport: false,
  canViewFinance: false,
};

const rank: Array<PlatformRole> = ["super_admin", "operations_admin", "support_admin", "finance_viewer"];

type AccessPayload = {
  role: string | null;
  is_admin: boolean;
  can_manage_sites: boolean;
  can_support: boolean;
  can_view_finance: boolean;
  organisation_roles?: string[] | null;
};

/**
 * Ask the database what this user is.
 *
 * `my_platform_access()` resolves roles from `auth.uid()` under SECURITY DEFINER,
 * so the answer comes from the same tables and helpers the RLS policies use. The
 * previous version inferred access from two RLS-filtered table reads and treated
 * every failure as "not an admin", which is indistinguishable from a real denial.
 */
const fetchServerAccess = async (): Promise<AccessFacts> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("my_platform_access");

  if (error) throw new Error(error.message || "my_platform_access failed");

  const payload = (Array.isArray(data) ? data[0] : data) as AccessPayload | null;
  if (!payload) throw new Error("my_platform_access returned no row for this session");

  const role = payload.role === "legacy_admin" ? "legacy_admin" : (payload.role as PlatformRole | null);

  return {
    role,
    isAdmin: payload.is_admin === true,
    canManageSites: payload.can_manage_sites === true,
    canSupport: payload.can_support === true,
    canViewFinance: payload.can_view_finance === true,
  };
};

/**
 * Fallback for deployments that have not applied the migration yet: read the
 * same two tables the old hook read, but resolve them independently so one
 * failing query cannot hide the role the other one found.
 */
const fetchTableAccess = async (userId: string): Promise<AccessFacts> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const [legacy, memberships] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
    db.from("organisation_members").select("role").eq("user_id", userId).eq("status", "active").in("role", rank),
  ]);

  if (legacy.error && memberships.error) {
    throw new Error(legacy.error.message || memberships.error.message || "role lookup failed");
  }

  const roles = new Set<PlatformRole>(
    ((memberships.data || []) as Array<{ role: PlatformRole }>).map(row => row.role),
  );
  const role = legacy.data ? "legacy_admin" : rank.find(candidate => roles.has(candidate)) || null;
  const full = role === "legacy_admin" || role === "super_admin";

  return {
    role,
    isAdmin: role !== null,
    canManageSites: full || role === "operations_admin",
    canSupport: full || role === "support_admin",
    canViewFinance: full || role === "finance_viewer",
  };
};

export const useAdminRole = (): PlatformAccess => {
  const { user, loading: authLoading } = useAuth();
  const [access, setAccess] = useState<AccessFacts>(NO_ACCESS);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // Auth has not answered yet. Staying in `loading` matters: resolving to
    // "not an admin" here is what made a valid admin see Access Denied.
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!user) {
      setAccess(NO_ACCESS);
      setError(null);
      setLoading(false);
      return;
    }

    if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_AUTH === "true" && user.app_metadata?.provider === "development") {
      setAccess({ role: "super_admin", isAdmin: true, canManageSites: true, canSupport: true, canViewFinance: true });
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const check = async () => {
      try {
        let facts: AccessFacts;
        try {
          facts = await fetchServerAccess();
        } catch (serverError) {
          // The RPC is the intended path. Only fall back when it is missing or
          // broken, and keep the reason so the UI can show something truthful.
          console.warn("my_platform_access unavailable, falling back to table reads:", serverError);
          facts = await fetchTableAccess(user.id);
        }
        if (active) setAccess(facts);
      } catch (checkError) {
        const message = checkError instanceof Error ? checkError.message : String(checkError);
        console.error("Error checking platform permissions:", checkError);
        if (active) {
          setAccess(NO_ACCESS);
          setError(message);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void check();
    return () => { active = false; };
  }, [user, authLoading]);

  return { ...access, loading, error };
};
