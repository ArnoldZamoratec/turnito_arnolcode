import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Route, Switch } from "wouter";
import { api, ApiError, getActiveTenant, type Me, setActiveTenant } from "./lib/api";
import { AgendaPage } from "./pages/Agenda";
import { AuthPage } from "./pages/Auth";
import { OnboardingPage } from "./pages/Onboarding";
import { PublicBookingPage } from "./pages/PublicBooking";
import { Chip } from "./components/ui";

export function App() {
  return (
    <Switch>
      <Route path="/reservar/:slug">{(p) => <PublicBookingPage slug={p.slug} />}</Route>
      <Route>
        <Panel />
      </Route>
    </Switch>
  );
}

function Panel() {
  const [, force] = useState(0);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/v1/me", { tenant: false }),
    retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2,
  });

  if (me.isLoading) return <p className="p-6 text-muted">Cargando…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) return <AuthPage />;
  if (me.error) return <p className="p-6 text-rose-700">{me.error.message}</p>;

  const { user, salons } = me.data!;
  if (salons.length === 0) return <OnboardingPage userName={user.name} />;

  const active = salons.find((s) => s.tenantId === getActiveTenant());
  if (!active && salons.length > 1) {
    return (
      <main className="mx-auto grid max-w-md gap-4 px-4 py-10">
        <h1 className="font-display text-2xl font-bold">¿En qué salón trabajas hoy?</h1>
        <div className="flex flex-wrap gap-2">
          {salons.map((s) => (
            <Chip key={s.tenantId} onClick={() => { setActiveTenant(s.tenantId); force((n) => n + 1); }}>
              {s.name}
            </Chip>
          ))}
        </div>
      </main>
    );
  }
  const salon = active ?? salons[0]!;
  if (!active) setActiveTenant(salon.tenantId);

  return (
    <AgendaPage
      salon={salon}
      userName={user.name}
      onSwitchSalon={salons.length > 1 ? () => { setActiveTenant(null); force((n) => n + 1); } : undefined}
    />
  );
}
