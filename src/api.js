import { Capacitor } from "@capacitor/core";
let bearer = null;
const storedServer = () => {
  try {
    return localStorage.getItem("tgs:server") || "";
  } catch {
    return "";
  }
};
export const platform = Capacitor.getPlatform();
const native =
  platform !== "web" ||
  location.protocol === "file:" ||
  location.protocol === "app:";
export function serverUrl() {
  return (
    storedServer() ||
    import.meta.env.VITE_API_URL ||
    (native ? "" : location.origin)
  ).replace(/\/$/, "");
}
export function setServerUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(import.meta.env.DEV && ["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error("Use an HTTPS server URL.");
  localStorage.setItem("tgs:server", url.origin);
  bearer = null;
}
export function setToken(value) {
  bearer = value;
}
export async function api(path, { method = "GET", body, signal } = {}) {
  const base = serverUrl();
  if (!base) throw new Error("Set your TGS server URL to connect.");
  const response = await fetch(`${base}/api${path}`, {
    method,
    credentials: native ? "omit" : "include",
    signal,
    headers: {
      "X-TGS-Client": "1",
      "X-TGS-Platform": platform,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unexpected response.");
  }
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Request failed."), {
      status: response.status,
    });
  return data;
}
export const send = (path, body, method = "POST") =>
  api(path, { method, body });
