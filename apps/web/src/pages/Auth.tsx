import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { Button, ErrorBox, Field } from "../components/ui";

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const qc = useQueryClient();
  const submit = useMutation({
    mutationFn: (form: FormData) =>
      mode === "signup"
        ? api("/api/auth/sign-up/email", {
            body: { name: form.get("name"), email: form.get("email"), password: form.get("password") },
            tenant: false,
          })
        : api("/api/auth/sign-in/email", { body: { email: form.get("email"), password: form.get("password") }, tenant: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit.mutate(new FormData(e.currentTarget));
  };

  return (
    <main className="mx-auto grid min-h-full max-w-md content-center gap-8 px-4 py-10">
      <div className="grid gap-2">
        <img src="/icon.svg" alt="" className="size-12" />
        <h1 className="font-display text-3xl font-bold text-balance">
          {mode === "signup" ? "Tu agenda lista en 5 minutos" : "Hola de nuevo"}
        </h1>
        <p className="text-muted">
          {mode === "signup"
            ? "Citas, recordatorios por WhatsApp y caja del día para tu salón."
            : "Entra para ver la agenda de hoy."}
        </p>
      </div>
      <form onSubmit={onSubmit} className="grid gap-4">
        {mode === "signup" && <Field name="name" label="Tu nombre" autoComplete="name" required minLength={2} />}
        <Field name="email" type="email" label="Correo" autoComplete="email" required />
        <Field
          name="password"
          type="password"
          label="Contraseña"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={8}
          hint={mode === "signup" ? "Mínimo 8 caracteres" : undefined}
        />
        <ErrorBox error={submit.error} />
        <Button type="submit" loading={submit.isPending}>
          {mode === "signup" ? "Crear cuenta" : "Entrar"}
        </Button>
      </form>
      <button className="text-sm text-plum-700 underline-offset-2 hover:underline" onClick={() => setMode(mode === "signup" ? "login" : "signup")}>
        {mode === "signup" ? "Ya tengo cuenta" : "Crear una cuenta nueva"}
      </button>
    </main>
  );
}
