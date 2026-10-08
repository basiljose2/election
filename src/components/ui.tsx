import type { ComponentProps, ReactNode } from "react";

export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </main>
  );
}

export function Field({ label, ...props }: { label: string } & ComponentProps<"input">) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input
        className="h-10 rounded-md border border-zinc-300 bg-transparent px-3 text-base font-normal dark:border-zinc-700"
        {...props}
      />
    </label>
  );
}

export function Button({
  variant = "primary",
  ...props
}: { variant?: "primary" | "danger" | "plain" } & ComponentProps<"button">) {
  const styles = {
    primary: "bg-foreground text-background",
    danger: "bg-red-700 text-white",
    plain: "border border-zinc-300 dark:border-zinc-700",
  }[variant];
  return <button className={`h-10 rounded-md px-4 text-sm font-medium ${styles}`} {...props} />;
}

export function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const styles =
    tone === "error"
      ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
      : "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-4 py-3 text-sm ${styles}`}
    >
      {children}
    </p>
  );
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
