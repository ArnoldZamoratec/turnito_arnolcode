// Página pública de reserva (versión del MVP dentro del panel; la definitiva será Astro SSR en el edge).
import { uuidv7 } from "@salon/kernel";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api, ApiError, type Slot } from "../lib/api";
import { addDays, longDate, money, shortDate, timeIn, today } from "../lib/format";
import { Button, Chip, ErrorBox, Field } from "../components/ui";

interface PublicSalon {
  name: string;
  slug: string;
  address: string | null;
  timezone: string;
  services: { id: string; name: string; category: string | null; durationMin: number; priceCents: number }[];
  staff: { id: string; displayName: string; serviceIds: string[] }[];
}

interface Hold {
  holdId: string;
  startsAt: string;
  expiresAt: string;
  priceCents: number;
}

export function PublicBookingPage({ slug }: { slug: string }) {
  const salon = useQuery({ queryKey: ["public", slug], queryFn: () => api<PublicSalon>(`/v1/public/${slug}`, { tenant: false }) });
  if (salon.error) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="font-display text-2xl font-bold">No encontramos este salón</h1>
        <p className="mt-2 text-muted">Revisa el enlace o pídele uno nuevo al salón.</p>
      </main>
    );
  }
  if (!salon.data) return <p className="p-6 text-muted">Cargando…</p>;
  return <Booking salon={salon.data} />;
}

function Booking({ salon }: { salon: PublicSalon }) {
  const tz = salon.timezone;
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>("");
  const [date, setDate] = useState(() => today(tz));
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdKey, setHoldKey] = useState(() => uuidv7());
  const [done, setDone] = useState<{ startsAt: string; serviceName: string; staffName: string } | null>(null);

  const service = salon.services.find((s) => s.id === serviceId);
  const days = Array.from({ length: 14 }, (_, i) => addDays(today(tz), i));

  const slots = useQuery({
    queryKey: ["public-slots", salon.slug, serviceId, date, staffId],
    queryFn: () =>
      api<{ slots: Slot[] }>(
        `/v1/public/${salon.slug}/availability?serviceId=${serviceId}&date=${date}${staffId ? `&staffId=${staffId}` : ""}`,
        { tenant: false },
      ),
    enabled: Boolean(serviceId) && !hold,
  });

  const takeSlot = useMutation({
    mutationFn: (startsAt: string) =>
      api<Hold>(`/v1/public/${salon.slug}/holds`, {
        body: { serviceId, staffId: staffId || undefined, startsAt },
        idempotencyKey: holdKey,
        tenant: false,
      }),
    onSuccess: setHold,
    onError: () => {
      setHoldKey(uuidv7());
      void slots.refetch();
    },
  });

  const confirm = useMutation({
    mutationFn: (form: FormData) =>
      api<{ startsAt: string; serviceName: string; staffName: string }>(`/v1/public/${salon.slug}/holds/${hold!.holdId}/confirm`, {
        body: {
          fullName: form.get("fullName"),
          phone: form.get("phone"),
          acceptReminders: form.get("reminders") === "on",
          acceptPrivacy: form.get("privacy") === "on",
        },
        tenant: false,
      }),
    onSuccess: setDone,
  });

  const back = () => {
    if (hold) void api(`/v1/public/${salon.slug}/holds/${hold.holdId}/release`, { body: {}, tenant: false }).catch(() => {});
    setHold(null);
    setHoldKey(uuidv7());
  };

  if (done) {
    return (
      <main className="mx-auto grid max-w-md gap-4 px-4 py-12 text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-mint-100 text-3xl text-mint-600">✓</div>
        <h1 className="font-display text-3xl font-bold">¡Listo, te esperamos!</h1>
        <p className="text-lg">
          <strong>{done.serviceName}</strong> con {done.staffName}
          <br />
          <span>{longDate(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(done.startsAt)))}</span>{" "}
          a las <strong className="tabular">{timeIn(done.startsAt, tz)}</strong>
        </p>
        <p className="text-muted">{salon.name}{salon.address ? ` · ${salon.address}` : ""}</p>
      </main>
    );
  }

  const onConfirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    confirm.mutate(new FormData(e.currentTarget));
  };

  return (
    <main className="mx-auto grid max-w-lg gap-7 px-4 pt-8 pb-16">
      <header className="grid gap-1">
        <p className="text-sm font-medium tracking-wide text-plum-700 uppercase">Reserva tu cita</p>
        <h1 className="font-display text-3xl font-bold text-balance">{salon.name}</h1>
        {salon.address && <p className="text-muted">{salon.address}</p>}
      </header>

      {!hold && (
        <>
          <section className="grid gap-3">
            <h2 className="font-display text-lg font-semibold">1. ¿Qué te haces?</h2>
            <ul className="grid gap-2">
              {salon.services.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setServiceId(s.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                      s.id === serviceId ? "border-plum-700 bg-plum-50" : "border-line bg-card hover:border-plum-500"
                    }`}
                  >
                    <span>
                      <span className="font-medium">{s.name}</span>
                      <span className="block text-sm text-muted">{s.durationMin} min</span>
                    </span>
                    <span className="tabular font-semibold">{money(s.priceCents)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {service && (
            <section className="grid gap-3">
              <h2 className="font-display text-lg font-semibold">2. ¿Cuándo?</h2>
              <div className="flex flex-wrap gap-2">
                <Chip active={!staffId} onClick={() => setStaffId("")}>Cualquiera</Chip>
                {salon.staff.filter((st) => st.serviceIds.includes(service.id)).map((st) => (
                  <Chip key={st.id} active={st.id === staffId} onClick={() => setStaffId(st.id)}>{st.displayName}</Chip>
                ))}
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {days.map((d) => (
                  <Chip key={d} active={d === date} onClick={() => setDate(d)}>
                    <span>{d === today(tz) ? "Hoy" : shortDate(d)}</span>
                  </Chip>
                ))}
              </div>
              {slots.isLoading && <p className="text-muted">Buscando horarios…</p>}
              {slots.data && slots.data.slots.length === 0 && (
                <p className="rounded-2xl border border-dashed border-line p-4 text-muted">No quedan horarios este día. Prueba otro.</p>
              )}
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {slots.data?.slots.map((s) => (
                  <button
                    key={s.start}
                    onClick={() => takeSlot.mutate(s.start)}
                    disabled={takeSlot.isPending}
                    className="tabular min-h-11 rounded-xl border border-line bg-card font-medium hover:border-plum-500"
                  >
                    {timeIn(s.start, tz)}
                  </button>
                ))}
              </div>
              {takeSlot.error && (
                <ErrorBox error={takeSlot.error instanceof ApiError && takeSlot.error.code === "SLOT_TAKEN" ? new Error("Alguien acaba de tomar ese horario. Elige otro.") : takeSlot.error} />
              )}
            </section>
          )}
        </>
      )}

      {hold && service && (
        <section className="grid gap-4">
          <div className="rounded-2xl border border-plum-500 bg-plum-50 p-4">
            <p className="font-medium">{service.name} · {money(hold.priceCents)}</p>
            <p className="text-muted">
              {longDate(date)} a las <span className="tabular">{timeIn(hold.startsAt, tz)}</span>
            </p>
            <p className="mt-1 text-sm text-plum-700">Te guardamos este horario por 5 minutos.</p>
          </div>
          <h2 className="font-display text-lg font-semibold">3. Tus datos</h2>
          <form onSubmit={onConfirm} className="grid gap-4">
            <Field name="fullName" label="Nombre y apellido" autoComplete="name" required minLength={2} />
            <Field name="phone" label="Celular (WhatsApp)" inputMode="tel" autoComplete="tel" placeholder="987 654 321" required />
            <label className="flex items-start gap-2 text-sm">
              <input name="reminders" type="checkbox" className="mt-0.5 size-4 accent-plum-700" />
              Quiero recibir el recordatorio de mi cita por WhatsApp.
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input name="privacy" type="checkbox" required className="mt-0.5 size-4 accent-plum-700" />
              <span>
                Acepto que {salon.name} use mis datos para gestionar mi cita, según la Ley N.° 29733 de Protección de Datos Personales.
              </span>
            </label>
            <ErrorBox error={confirm.error} />
            <Button type="submit" loading={confirm.isPending}>Confirmar reserva</Button>
            <Button type="button" variant="ghost" onClick={back}>Elegir otro horario</Button>
          </form>
        </section>
      )}
    </main>
  );
}
