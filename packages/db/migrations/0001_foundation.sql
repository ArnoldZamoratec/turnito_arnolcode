-- 0001_foundation.sql — esquemas, identidad, tenancy y núcleo del MVP.
-- Se ejecuta con el rol migrador (dueño de las tablas). El runtime usa app_runtime (sin BYPASSRLS).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA auth;
CREATE SCHEMA core;
CREATE SCHEMA catalog;
CREATE SCHEMA crm;
CREATE SCHEMA agenda;
CREATE SCHEMA pos;
CREATE SCHEMA commissions;
CREATE SCHEMA notifications;
CREATE SCHEMA platform;

-- Contexto de tenant: NULL si no está fijado => las políticas RLS devuelven 0 filas.
CREATE FUNCTION core.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Versión monotónica para la sincronización offline (pull incremental).
CREATE SEQUENCE platform.sync_seq;
CREATE FUNCTION platform.bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := nextval('platform.sync_seq');
  NEW.updated_at  := now();
  RETURN NEW;
END $$;

-- =====================================================================
-- Identidad (tablas de Better Auth, esquema "auth"; identidad global)
-- =====================================================================
CREATE TABLE auth."user" (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  email           citext NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image           text,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.session (
  id          uuid PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token       text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId"    uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON auth.session ("userId");

CREATE TABLE auth.account (
  id                      uuid PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope                   text,
  password                text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user ON auth.account ("userId");

CREATE TABLE auth.verification (
  id          uuid PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier ON auth.verification (identifier);

-- =====================================================================
-- Tenancy
-- =====================================================================
CREATE TABLE core.tenants (
  id            uuid PRIMARY KEY,
  slug          citext NOT NULL UNIQUE,
  name          text   NOT NULL,
  country_code  char(2) NOT NULL DEFAULT 'PE',
  tax_id        varchar(20),
  plan_code     text NOT NULL DEFAULT 'free',
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','grace','read_only','suspended','deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- tenant_id = id: así la plantilla RLS genérica también cubre esta tabla
  tenant_id     uuid GENERATED ALWAYS AS (id) STORED
);

CREATE TABLE core.branches (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES core.tenants(id),
  name             text NOT NULL,
  booking_slug     citext NOT NULL UNIQUE,
  timezone         text NOT NULL DEFAULT 'America/Lima',
  currency         char(3) NOT NULL DEFAULT 'PEN',
  slot_step_min    smallint NOT NULL DEFAULT 15 CHECK (slot_step_min IN (5,10,15,20,30)),
  cancel_min_hours smallint NOT NULL DEFAULT 2 CHECK (cancel_min_hours >= 0),
  address          text,
  phone_e164       varchar(16),
  settings         jsonb NOT NULL DEFAULT '{}',
  row_version      bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id)
);

CREATE TABLE core.memberships (
  tenant_id   uuid NOT NULL REFERENCES core.tenants(id),
  user_id     uuid NOT NULL REFERENCES auth."user"(id),
  role        text NOT NULL CHECK (role IN ('owner','admin','receptionist','stylist')),
  branch_ids  uuid[],
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON core.memberships (user_id);

-- =====================================================================
-- Catálogo
-- =====================================================================
CREATE TABLE catalog.services (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES core.tenants(id),
  name             text NOT NULL,
  category         text,
  duration_min     smallint NOT NULL CHECK (duration_min > 0 AND duration_min % 5 = 0),
  buffer_after_min smallint NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  bookable_online  boolean NOT NULL DEFAULT true,
  active           boolean NOT NULL DEFAULT true,
  row_version      bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id)
);

-- =====================================================================
-- Clientes (CRM)
-- =====================================================================
CREATE TABLE crm.clients (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES core.tenants(id),
  full_name      text NOT NULL,
  phone_e164     varchar(16),
  email          citext,
  birth_date     date,
  doc_type       text CHECK (doc_type IN ('DNI','CE','PAS','RUC')),
  doc_number     varchar(20),
  no_show_count  smallint NOT NULL DEFAULT 0,
  source         text,
  row_version    bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX clients_phone_uq ON crm.clients (tenant_id, phone_e164)
  WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;
CREATE INDEX clients_name_trgm ON crm.clients USING gin (full_name gin_trgm_ops);
CREATE INDEX clients_sync ON crm.clients (tenant_id, row_version);

CREATE TABLE crm.client_notes (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  client_id      uuid NOT NULL,
  author_user_id uuid NOT NULL,
  is_sensitive   boolean NOT NULL DEFAULT false,
  body           text,
  body_cipher    bytea,
  key_version    smallint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_sensitive AND body IS NULL AND body_cipher IS NOT NULL)
      OR (NOT is_sensitive AND body IS NOT NULL AND body_cipher IS NULL)),
  FOREIGN KEY (tenant_id, client_id) REFERENCES crm.clients(tenant_id, id)
);

CREATE TABLE crm.client_consents (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  purpose         text NOT NULL CHECK (purpose IN ('service','reminders','marketing','photos_internal','photos_public','sensitive_data')),
  granted         boolean NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('online_form','in_person','whatsapp')),
  policy_version  text NOT NULL,
  recorded_by     uuid,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES crm.clients(tenant_id, id)
);
CREATE INDEX consents_client ON crm.client_consents (tenant_id, client_id, purpose, recorded_at DESC);

-- =====================================================================
-- Agenda
-- =====================================================================
CREATE TABLE agenda.staff (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  user_id         uuid REFERENCES auth."user"(id),
  display_name    text NOT NULL,
  color           char(7) NOT NULL DEFAULT '#6366F1',
  bookable_online boolean NOT NULL DEFAULT true,
  active          boolean NOT NULL DEFAULT true,
  row_version     bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches(tenant_id, id)
);

CREATE TABLE agenda.staff_services (
  tenant_id             uuid NOT NULL,
  staff_id              uuid NOT NULL,
  service_id            uuid NOT NULL,
  duration_override_min smallint CHECK (duration_override_min > 0),
  price_override_cents  integer CHECK (price_override_cents >= 0),
  PRIMARY KEY (tenant_id, staff_id, service_id),
  FOREIGN KEY (tenant_id, staff_id)   REFERENCES agenda.staff(tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES catalog.services(tenant_id, id)
);

CREATE TABLE agenda.working_hours (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_local time NOT NULL,
  end_local   time NOT NULL,
  valid_from  date NOT NULL DEFAULT current_date,
  valid_to    date,
  CHECK (start_local < end_local),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES agenda.staff(tenant_id, id)
);
CREATE INDEX wh_staff ON agenda.working_hours (tenant_id, staff_id, weekday);

CREATE TABLE agenda.staff_day_overrides (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  staff_id    uuid NOT NULL,
  on_date     date NOT NULL,
  is_off      boolean NOT NULL DEFAULT false,
  start_local time,
  end_local   time,
  reason      text,
  CHECK (is_off OR (start_local IS NOT NULL AND end_local IS NOT NULL AND start_local < end_local)),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES agenda.staff(tenant_id, id)
);
CREATE INDEX sdo_staff_date ON agenda.staff_day_overrides (tenant_id, staff_id, on_date);

CREATE TABLE agenda.appointments (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  client_id       uuid,
  status          text NOT NULL CHECK (status IN
                  ('held','confirmed','checked_in','completed','cancelled','no_show','conflict')),
  source          text NOT NULL CHECK (source IN ('reception','public','offline','waitlist','walk_in')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  hold_expires_at timestamptz,
  notes           text,
  cancel_reason   text,
  cancelled_at    timestamptz,
  cancelled_by    text CHECK (cancelled_by IN ('client','staff','system')),
  created_by      uuid,
  row_version     bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (status <> 'held' OR hold_expires_at IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES crm.clients(tenant_id, id)
);
CREATE INDEX appt_branch_day ON agenda.appointments (tenant_id, branch_id, starts_at);
CREATE INDEX appt_client     ON agenda.appointments (tenant_id, client_id, starts_at DESC);
CREATE INDEX appt_sync       ON agenda.appointments (tenant_id, row_version);

-- Una fila = un intervalo en que un estilista está ocupado (servicio, bloqueo u hold).
CREATE TABLE agenda.staff_bookings (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  branch_id       uuid NOT NULL,
  staff_id        uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('service','block','hold')),
  appointment_id  uuid,
  service_id      uuid,
  period          tstzrange NOT NULL,
  price_cents     integer,
  active          boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  label           text,
  row_version     bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  CHECK ((kind = 'block') = (appointment_id IS NULL)),
  CHECK (kind <> 'hold' OR expires_at IS NOT NULL),
  FOREIGN KEY (tenant_id, staff_id)       REFERENCES agenda.staff(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES agenda.appointments(tenant_id, id),
  FOREIGN KEY (tenant_id, service_id)     REFERENCES catalog.services(tenant_id, id),
  -- I1: un estilista no puede tener dos ocupaciones activas que se solapen
  CONSTRAINT no_overlap_per_staff EXCLUDE USING gist (
    tenant_id WITH =, staff_id WITH =, period WITH &&
  ) WHERE (active)
);
CREATE INDEX sb_branch_period ON agenda.staff_bookings USING gist (tenant_id, branch_id, period) WHERE active;
CREATE INDEX sb_appt          ON agenda.staff_bookings (tenant_id, appointment_id);
CREATE INDEX sb_holds_expiry  ON agenda.staff_bookings (expires_at) WHERE kind = 'hold' AND active;
CREATE INDEX sb_sync          ON agenda.staff_bookings (tenant_id, row_version);

CREATE TABLE agenda.waitlist_entries (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  branch_id        uuid NOT NULL,
  client_id        uuid NOT NULL,
  service_id       uuid NOT NULL,
  staff_id         uuid,
  desired          tstzrange NOT NULL,
  status           text NOT NULL DEFAULT 'waiting'
                   CHECK (status IN ('waiting','offered','booked','expired','cancelled')),
  offered_at       timestamptz,
  offer_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES crm.clients(tenant_id, id)
);
CREATE INDEX wl_match ON agenda.waitlist_entries USING gist (tenant_id, branch_id, desired) WHERE status = 'waiting';

-- =====================================================================
-- Caja y Pagos
-- =====================================================================
CREATE TABLE pos.cash_sessions (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  branch_id            uuid NOT NULL,
  device_id            text NOT NULL,
  opened_by            uuid NOT NULL,
  opened_at            timestamptz NOT NULL,
  opening_float_cents  integer NOT NULL DEFAULT 0,
  closed_by            uuid,
  closed_at            timestamptz,
  expected_cash_cents  integer,
  counted_cash_cents   integer,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches(tenant_id, id)
);
CREATE UNIQUE INDEX one_open_session_per_device
  ON pos.cash_sessions (tenant_id, branch_id, device_id) WHERE status = 'open';

CREATE TABLE pos.sales (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  branch_id         uuid NOT NULL,
  cash_session_id   uuid NOT NULL,
  client_id         uuid,
  appointment_id    uuid,
  number            integer,
  status            text NOT NULL CHECK (status IN ('closed','voided')),
  subtotal_cents    integer NOT NULL,
  discount_cents    integer NOT NULL DEFAULT 0,
  total_cents       integer NOT NULL CHECK (total_cents >= 0),
  closed_at         timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  closed_by         uuid NOT NULL,
  created_offline   boolean NOT NULL DEFAULT false,
  device_id         text NOT NULL,
  void_reason       text,
  voided_at         timestamptz,
  voided_by         uuid,
  row_version       bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cash_session_id) REFERENCES pos.cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id)  REFERENCES agenda.appointments(tenant_id, id)
);
CREATE INDEX sales_branch_day ON pos.sales (tenant_id, branch_id, closed_at);

CREATE TABLE pos.sale_items (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  sale_id           uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('service','product','tip','other')),
  service_id        uuid,
  staff_id          uuid,
  description       text NOT NULL,
  qty               smallint NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents  integer NOT NULL,
  discount_cents    integer NOT NULL DEFAULT 0,
  total_cents       integer NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos.sales(tenant_id, id)
);

CREATE TABLE pos.payments (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  sale_id       uuid NOT NULL,
  method        text NOT NULL CHECK (method IN ('cash','yape','plin','card_pos','transfer','culqi','mercadopago','other')),
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  reference     text,
  FOREIGN KEY (tenant_id, sale_id) REFERENCES pos.sales(tenant_id, id)
);

CREATE TABLE pos.cash_movements (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  cash_session_id  uuid NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  amount_cents     integer NOT NULL CHECK (amount_cents > 0),
  reason           text NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, cash_session_id) REFERENCES pos.cash_sessions(tenant_id, id)
);

-- =====================================================================
-- Comisiones
-- =====================================================================
CREATE TABLE commissions.rules (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  staff_id    uuid,
  service_id  uuid,
  type        text NOT NULL CHECK (type IN ('percent','fixed')),
  value       numeric(10,2) NOT NULL CHECK (value >= 0),
  applies_to  text NOT NULL DEFAULT 'service' CHECK (applies_to IN ('service','product','tip')),
  valid_from  date NOT NULL,
  valid_to    date
);

CREATE TABLE commissions.entries (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  staff_id      uuid NOT NULL,
  sale_item_id  uuid NOT NULL,
  rule_id       uuid,
  base_cents    integer NOT NULL,
  amount_cents  integer NOT NULL,
  earned_on     date NOT NULL,
  settlement_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sale_item_id, amount_cents)
);
CREATE INDEX comm_staff_period ON commissions.entries (tenant_id, staff_id, earned_on);

-- =====================================================================
-- Plataforma y notificaciones
-- =====================================================================
CREATE TABLE platform.outbox (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_pending ON platform.outbox (id) WHERE published_at IS NULL;

CREATE TABLE platform.idempotency_keys (
  tenant_id       uuid NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE platform.audit_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  actor_user_id uuid,
  actor_role    text,
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     uuid,
  changes       jsonb,
  ip            inet,
  user_agent    text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_at ON platform.audit_log (tenant_id, at DESC);

CREATE TABLE notifications.message_log (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  client_id           uuid,
  appointment_id      uuid,
  channel             text NOT NULL CHECK (channel IN ('whatsapp','email','sms','push')),
  template            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed','skipped')),
  provider_message_id text,
  cost_micros_usd     integer,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX msg_tenant_month ON notifications.message_log (tenant_id, created_at);
CREATE UNIQUE INDEX msg_provider_id ON notifications.message_log (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- =====================================================================
-- row_version en las tablas que sincroniza la PWA
-- =====================================================================
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON core.branches        FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON catalog.services     FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON crm.clients          FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON agenda.staff         FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON agenda.appointments  FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON agenda.staff_bookings FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
CREATE TRIGGER t_rv BEFORE INSERT OR UPDATE ON pos.sales            FOR EACH ROW EXECUTE FUNCTION platform.bump_row_version();
