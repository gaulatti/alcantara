import { chromium } from "playwright";
const API = "http://localhost:13000", APP = "http://localhost:15173";
const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const op = await (await b.newContext()).newPage();
await op.goto(`${APP}/calls`); await op.getByText(/Guest calls/).first().waitFor({ timeout: 30000 });
const token = (await (await fetch(`${API}/__test/session?identity=operator-a`)).json()).accessToken;
const inv = await (await fetch(`${API}/webrtc/invitations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ programId: "main", displayName: "Probe waiting guest", expiresInHours: 1, returnVideo: "none", returnAudioBus: "master" }) })).json();
const guest = await (await b.newContext({ permissions: ["camera", "microphone"] })).newPage();
await guest.goto(`${APP}${inv.invitationPath}`);
await guest.getByRole("button", { name: /Speaker test/ }).click(); await guest.getByLabel(/I am wearing headphones/).check(); await guest.getByRole("button", { name: /Join studio/ }).click();
const t0 = Date.now(); let seen = null;
while (Date.now() - t0 < 30000) { const text = await op.locator("body").innerText(); if (/Probe waiting guest[\s\S]{0,200}waiting to be let in|waiting to be let in[\s\S]{0,40}/.test(text) && text.includes("Probe waiting guest")) { seen = Date.now() - t0; break; } await op.waitForTimeout(500); }
console.log(JSON.stringify({ waitingShownAfterMs: seen, opText: seen ? null : (await op.locator("body").innerText()).slice(0, 600) }));
await fetch(`${API}/webrtc/invitations/${inv.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
await b.close();
