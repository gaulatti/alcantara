// The renderer keys a holder's env file gets from the runtime secret (gaulatti/alcantara#884), as env lines: the shared
// key while it is still accepted, the fleet key, and either every program's key (the return runner) or one program's
// key (a contribution worker, with `program`). Pure, so it is tested without AWS. Never logs a key.

/** A value that cannot be written to an env file as one line. */
const UNSAFE = /[\r\n'"]/;

/**
 * The env lines, or `{ problem }` naming what is wrong. `{ lines: [] }` means the secret holds no renderer key for this
 * holder at all.
 */
export function rendererEnvLines(secret, { program } = {}) {
  const lines = [];
  for (const [field, name] of [
    ['webrtcRendererKey', 'WEBRTC_RENDERER_KEY'],
    ['webrtcFleetKey', 'WEBRTC_FLEET_KEY'],
  ]) {
    const value = secret[field];
    if (value === undefined) continue;
    if (UNSAFE.test(value)) return { problem: `${name} cannot be written to an env file` };
    lines.push(`${name}=${value}`);
  }
  const keys = secret.webrtcProgramKeys ?? {};
  if (program !== undefined) {
    if (keys[program] !== undefined) lines.push(`WEBRTC_PROGRAM_KEY=${keys[program]}`);
  } else if (Object.keys(keys).length) {
    // The contract allows only program ids and alrk_ keys here, so the JSON is one line with no quote a shell reads.
    lines.push(`WEBRTC_PROGRAM_KEYS=${JSON.stringify(keys)}`);
  }
  return { lines };
}
