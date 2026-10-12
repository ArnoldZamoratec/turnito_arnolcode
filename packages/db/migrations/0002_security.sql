-- 0002_security.sql — rol de runtime, permisos y Row Level Security.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Permisos del runtime. Nunca es dueño de las tablas (si lo fuera, FORCE RLS seguiría aplicando,
-- pero podría desactivar políticas con ALTER TABLE).
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['auth','core','catalog','crm','agenda','pos','commissions','notifications','platform'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_runtime', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO app_runtime', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO app_runtime', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO app_runtime', s);
  END LOOP;
END $$;

-- Tablas append-only: hechos que no se editan ni se borran.
REVOKE UPDATE, DELETE ON platform.audit_log FROM app_runtime;
REVOKE DELETE ON pos.sales, pos.sale_items, pos.payments, pos.cash_movements, commissions.entries FROM app_runtime;
REVOKE UPDATE ON pos.sale_items, pos.payments, pos.cash_movements, commissions.entries FROM app_runtime;

-- RLS forzada en toda tabla de negocio con tenant_id.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema IN ('core','catalog','crm','agenda','pos','commissions','notifications','platform')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',  r.table_schema, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant())',
                   r.table_schema, r.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Funciones SECURITY DEFINER: únicas lecturas permitidas SIN contexto de tenant.
-- Devuelven lo mínimo y fijan search_path para no ser secuestrables.
-- ---------------------------------------------------------------------

-- Salones a los que pertenece un usuario (para el login y el selector de salón).
CREATE FUNCTION core.memberships_for_user(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, role text, branch_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core AS $$
  SELECT m.tenant_id, t.name, t.slug::text, m.role, m.branch_ids
  FROM core.memberships m
  JOIN core.tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id AND m.status = 'active' AND t.status <> 'deleted'
  ORDER BY m.created_at
$$;

-- Página pública: slug de reserva -> (tenant, sucursal).
CREATE FUNCTION core.resolve_booking_slug(p_slug text)
RETURNS TABLE (tenant_id uuid, branch_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core AS $$
  SELECT b.tenant_id, b.id
  FROM core.branches b
  JOIN core.tenants t ON t.id = b.tenant_id
  WHERE lower(b.booking_slug::text) = lower(p_slug) AND b.deleted_at IS NULL AND t.status IN ('active','grace')
$$;

-- Disponibilidad de slugs en el onboarding (sin revelar a qué salón pertenecen).
CREATE FUNCTION core.is_slug_taken(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core AS $$
  SELECT EXISTS (SELECT 1 FROM core.tenants WHERE lower(slug::text) = lower(p_slug))
      OR EXISTS (SELECT 1 FROM core.branches WHERE lower(booking_slug::text) = lower(p_slug))
$$;

REVOKE ALL ON FUNCTION core.memberships_for_user(uuid), core.resolve_booking_slug(text), core.is_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.memberships_for_user(uuid), core.resolve_booking_slug(text), core.is_slug_taken(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION core.current_tenant() TO app_runtime;
GRANT EXECUTE ON FUNCTION platform.bump_row_version() TO app_runtime;
