// Local stand-in for Pompeii's ApplicationAccessService, for browser checks of a
// service's Access screen. Not Pompeii: in-memory, no real authorization. Never run in production.
// usage: node fake-pompeii-access.mjs <application_access.proto> [port=50087]
// Env: FAKE_CALLER=manager|member (default manager) decides whether the caller holds <app>:access:manage.
// Refusal triggers (so every refusal path can be shown in a browser):
//   token name containing "FORBIDDEN" -> PERMISSION_DENIED; "BADARG" -> INVALID_ARGUMENT; "DOWN" -> UNAVAILABLE
//   revoking token id "missing" or grant id 999 -> NOT_FOUND; grant user_id 503 -> UNAVAILABLE
//   switch off -> CreateMyToken FAILED_PRECONDITION (tokens off); bearer "Bearer expired" -> UNAUTHENTICATED
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { randomUUID, randomBytes } from 'node:crypto';

const [proto, portArg] = process.argv.slice(2);
if (!proto) throw new Error('usage: fake-pompeii-access.mjs <proto> [port]');
const port = Number(portArg ?? 50087);
const def = loader.loadSync(proto, { keepCase: true, longs: Number, defaults: true });
const pkg = grpc.loadPackageDefinition(def).pompeii.access.v1;
const manager = (process.env.FAKE_CALLER ?? 'manager') === 'manager';
const now = () => new Date().toISOString();
let enabled = true;
const tokens = [];
let grants = [{ id: 1, user_id: 7, user_email: 'person@example.test', role_id: 1, role_name: 'Operator', team_id: 0, granted_at: now() }];
const roles = [{ id: 1, name: 'Operator', permissions: ['app:access'] }, { id: 2, name: 'Editor', permissions: ['app:access', 'app:edit'] }];
const history = [];
const note = (action, target, via) => history.unshift({ at: now(), action, actor_email: 'operator@example.test', target, via_application: 'fake', via_client: via || 'console' });
const err = (code, message = 'fake') => ({ code, message });
const guard = (call) => {
  const cred = call.metadata.get('x-pompeii-service-credential')[0];
  if (!cred) return err(grpc.status.UNAUTHENTICATED, 'unknown service credential');
  const r = call.request;
  const bearer = (r.access ?? r).bearer_token ?? '';
  if (!bearer || /expired/.test(bearer)) return err(grpc.status.UNAUTHENTICATED);
  return null;
};
const needManage = () => (manager ? null : err(grpc.status.PERMISSION_DENIED));
const h = (fn) => (call, cb) => { const e = guard(call) ?? fn(call.request, call); if (e && e.code !== undefined && e.message !== undefined && !e.__ok) return cb(e); cb(null, e?.__ok ?? e); };
const ok = (v) => ({ __ok: v });
const impl = {
  ListMyTokens: h(() => ok({ tokens })),
  CreateMyToken: h((r) => {
    const n = r.name ?? '';
    if (/FORBIDDEN/.test(n)) return err(grpc.status.PERMISSION_DENIED);
    if (/BADARG/.test(n) || !n) return err(grpc.status.INVALID_ARGUMENT);
    if (/DOWN/.test(n)) return err(grpc.status.UNAVAILABLE);
    if (!enabled) return err(grpc.status.FAILED_PRECONDITION);
    const t = { id: randomUUID(), name: n, display_prefix: 'pmp_pat_' + randomBytes(2).toString('hex'), permissions: r.all_held_in_application ? ['app:access', 'app:edit'] : r.permissions, created_at: now(), expires_at: r.no_expiry ? '' : new Date(Date.now() + 864e5 * (r.expires_in_days || 30)).toISOString(), last_used_at: '', created_via_application: 'fake', last_used_application: '' };
    tokens.push(t); note('token.create', n, r.access?.via_client);
    return ok({ token: t, value: 'pmp_pat_' + randomBytes(24).toString('base64url') });
  }),
  RevokeMyToken: h((r) => { const i = tokens.findIndex((t) => t.id === r.token_id); if (i < 0) return err(grpc.status.NOT_FOUND); const [t] = tokens.splice(i, 1); note('token.revoke', t.name); return ok({}); }),
  GetTokenSwitch: h(() => ok({ enabled })),
  SetTokenSwitch: h((r) => needManage() ?? (enabled = r.enabled, note('switch.set', String(r.enabled)), ok({ enabled }))),
  ListRoles: h(() => needManage() ?? ok({ roles })),
  ListGrants: h(() => needManage() ?? ok({ grants })),
  Grant: h((r) => {
    const m = needManage(); if (m) return m;
    if (r.user_id === 503) return err(grpc.status.UNAVAILABLE);
    const role = roles.find((x) => x.id === r.role_id); if (!role) return err(grpc.status.NOT_FOUND);
    const g = { id: grants.length + 10, user_id: r.user_id, user_email: `user${r.user_id}@example.test`, role_id: role.id, role_name: role.name, team_id: 0, granted_at: now() };
    grants.push(g); note('grant.add', `${g.user_email} ${role.name}`); return ok(g);
  }),
  Revoke: h((r) => { const m = needManage(); if (m) return m; const i = grants.findIndex((g) => g.id === r.grant_id); if (i < 0) return err(grpc.status.NOT_FOUND); const [g] = grants.splice(i, 1); note('grant.remove', g.user_email); return ok({}); }),
  ListAccessHistory: h((r) => ok({ entries: history.slice(0, r.limit || 50) })),
};
const server = new grpc.Server();
server.addService(pkg.ApplicationAccessService.service, impl);
server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (e, p) => { if (e) throw e; console.log(`fake Pompeii access service on :${p}, caller=${manager ? 'manager' : 'member'}`); });
