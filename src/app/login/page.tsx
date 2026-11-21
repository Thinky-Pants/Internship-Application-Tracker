import { redirect } from "next/navigation";
import { loginAction } from "../actions/auth";
import { currentOwner, ownerCount } from "@/server/auth";
import { Button, Field } from "@/components/ui";
import { Flash } from "@/components/flash";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  if ((await ownerCount()) === 0) redirect("/setup");
  if (await currentOwner()) redirect("/");
  const sp = await searchParams;
  return (
    <main id="main" className="mx-auto mt-24 max-w-sm rounded-lg border border-line bg-surface p-6">
      <h1 className="mb-1 text-lg font-semibold">Outreach Manager</h1>
      <p className="mb-4 text-[13px] text-muted">Owner sign-in. This app never asks for your mailbox password.</p>
      <Flash sp={sp} />
      <form action={loginAction} className="flex flex-col gap-3">
        <Field label="Email" htmlFor="email"><input id="email" name="email" type="email" autoComplete="username" required /></Field>
        <Field label="Passphrase" htmlFor="password"><input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
        <Button variant="primary" type="submit">Sign in</Button>
      </form>
    </main>
  );
}
