import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Campus EVM</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Online election system for campus elections.
      </p>
      <div>
        <Link
          href="/sign-in"
          className="inline-flex h-11 items-center rounded-md bg-foreground px-5 font-medium text-background"
        >
          Staff sign in
        </Link>
      </div>
    </main>
  );
}
