import { redirect } from "next/navigation";
import { setupOwnerAction } from "../actions/auth";
import { ownerCount } from "@/server/auth";
import { Button, Field } from "@/components/ui";
import { Flash } from "@/components/flash";

export const metadata = { title: "First-run setup" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  if ((await ownerCount()) > 0) redirect("/login");
  const sp = await searchParams;
  return (
    <main id="main" className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-6">
      <h1 className="mb-1 text-lg font-semibold">Set up owner access</h1>
      <p className="mb-4 text-[13px] text-muted">
        This is a private, single-owner app. Create the owner account first; next you will set your timezone, import your workbook and
        (optionally) connect Gmail or Outlook, Apollo and AI. Every optional step can be skipped.
      </p>
      <Flash sp={sp} />
      <form action={setupOwnerAction} className="flex flex-col gap-3">
        <Field label="Your name" htmlFor="name"><input id="name" name="name" required /></Field>
        <Field label="Email (used only to sign in here)" htmlFor="email"><input id="email" name="email" type="email" required /></Field>
        <Field label="Passphrase (12+ characters)" htmlFor="password" hint="Stored as a salted scrypt hash.">
          <input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required />
        </Field>
        <Button variant="primary" type="submit">Create owner</Button>
      </form>
    </main>
  );
}
