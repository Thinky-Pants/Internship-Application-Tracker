export const dynamic = "force-static";
export const metadata = { title: "Offline" };

export default function Offline() {
  return (
    <main id="main" className="mx-auto mt-24 max-w-md rounded-lg border border-line bg-surface p-6">
      <h1 className="text-lg font-semibold">You are offline</h1>
      <p className="mt-2 text-[13px] text-muted">The app cannot confirm server state, so drafting, approving, scheduling and sending are disabled until the connection returns. Scheduled sends continue on the server if you use a cloud deployment.</p>
    </main>
  );
}
