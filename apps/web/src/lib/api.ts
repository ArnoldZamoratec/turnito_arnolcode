// Cliente HTTP del panel. La sesión viaja en cookie httpOnly; el salón activo en X-Tenant-Id
// (el servidor verifica la membresía en cada request, así que solo elige entre los salones del usuario).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const TENANT_KEY = "turnito.tenant";

export function getActiveTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenant(id: string | null): void {
  try {
    if (id) localStorage.setItem(TENANT_KEY, id);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    /* almacenamiento bloqueado: se vuelve a elegir al recargar */
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; tenant?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const tenant = getActiveTenant();
  if (init.tenant !== false && tenant) headers["x-tenant-id"] = tenant;
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      credentials: "include",
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "Sin conexión. Revisa tu internet e intenta de nuevo.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.title ?? data?.message ?? "Algo salió mal";
    throw new ApiError(res.status, data?.code ?? "HTTP_ERROR", message, data?.details);
  }
  return data as T;
}

// ---- Tipos que devuelve la API ----
export interface Salon {
  tenantId: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "receptionist" | "stylist";
  branchIds: string[] | null;
}

export interface Me {
  user: { id: string; email: string; name: string };
  salons: Salon[];
}

export interface Service {
  id: string;
  name: string;
  category: string | null;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number;
  bookableOnline: boolean;
  active: boolean;
}

export interface Staff {
  id: string;
  branchId: string;
  displayName: string;
  color: string;
  active: boolean;
  serviceIds: string[];
  weekly: { weekday: number; start: string; end: string }[];
}

export interface AgendaItem {
  bookingId: string;
  kind: "service" | "block" | "hold";
  label: string | null;
  staffId: string;
  start: string;
  end: string;
  appointmentId: string | null;
  status: "held" | "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show" | "conflict" | null;
  source: string | null;
  notes: string | null;
  priceCents: number | null;
  serviceName: string | null;
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  clientNoShows: number | null;
}

export interface Client {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  noShowCount: number;
}

export interface Slot {
  start: string;
  staffIds?: string[];
}
