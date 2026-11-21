"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createFirstOwner, login, logout, requireOwner } from "@/server/auth";
import { back, errMessage } from "@/server/flash";

export async function setupOwnerAction(fd: FormData) {
  try {
    await createFirstOwner(String(fd.get("email") ?? ""), String(fd.get("name") ?? ""), String(fd.get("password") ?? ""));
  } catch (e) {
    back("/setup", { err: errMessage(e) });
  }
  redirect("/settings?setup=1");
}

export async function loginAction(fd: FormData) {
  try {
    await login(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""));
  } catch (e) {
    back("/login", { err: errMessage(e) });
  }
  redirect("/");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

export async function setThemeAction(fd: FormData) {
  await requireOwner();
  const t = String(fd.get("theme"));
  const jar = await cookies();
  if (t === "light" || t === "dark") jar.set("theme", t, { path: "/", sameSite: "lax", maxAge: 31536000 });
  else jar.delete("theme");
  redirect(String(fd.get("back") ?? "/settings"));
}
