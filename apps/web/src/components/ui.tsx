import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useEffect, useId } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-plum-700 text-white hover:bg-plum-600 disabled:bg-plum-100 disabled:text-plum-500",
  secondary: "bg-card text-ink border border-line hover:border-plum-500",
  ghost: "text-plum-700 hover:bg-plum-50",
  danger: "bg-card text-rose-700 border border-rose-100 hover:bg-rose-100",
};

export function Button({
  variant = "primary",
  className = "",
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Un momento…" : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <label htmlFor={props.id ?? id} className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        id={props.id ?? id}
        className="min-h-11 rounded-xl border border-line bg-card px-3 text-base outline-none focus:border-plum-500"
        {...props}
      />
      {error ? <span className="text-sm text-rose-700">{error}</span> : hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Algo salió mal";
  return <p role="alert" className="rounded-xl bg-rose-100 px-3 py-2 text-sm text-rose-700">{message}</p>;
}

/** Panel inferior en el móvil, lateral en escritorio. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 md:items-stretch md:justify-end" onClick={onClose}>
      <section
        role="dialog"
        aria-label={title}
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-paper p-5 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] md:max-h-none md:w-[420px] md:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          <button onClick={onClose} className="grid size-10 place-items-center rounded-full hover:bg-plum-50" aria-label="Cerrar">
            ✕
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Chip({ active, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`min-h-10 rounded-full border px-3.5 text-sm font-medium transition-colors ${
        active ? "border-plum-700 bg-plum-700 text-white" : "border-line bg-card hover:border-plum-500"
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
