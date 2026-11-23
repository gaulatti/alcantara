import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const amplify = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: amplify }));

const load = async () => {
  vi.resetModules();
  await import("./auth");
};
beforeEach(() => {
  amplify.configure.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("Cognito configuration", () => {
  it("configures the user pool with every sign-in origin and its logout twin", async () => {
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "pool");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "auth.example.test");
    vi.stubEnv("VITE_PORT", "4000");
    vi.stubEnv("VITE_FQDN", "https://app.example.test");
    await load();
    const config = amplify.configure.mock.calls[0][0].Auth.Cognito;
    expect(config).toMatchObject({ userPoolId: "pool", userPoolClientId: "client" });
    expect(config.loginWith.oauth).toMatchObject({ domain: "auth.example.test", responseType: "code", scopes: ["openid", "email", "profile"] });
    expect(config.loginWith.oauth.redirectSignIn).toEqual([window.location.origin, "http://localhost:4000", "https://app.example.test"]);
    expect(config.loginWith.oauth.redirectSignOut).toEqual(config.loginWith.oauth.redirectSignIn.map((o: string) => `${o}/logout`));
  });
  it("defaults the port and origin, and does not duplicate origins", async () => {
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "pool");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "auth.example.test");
    vi.stubEnv("VITE_PORT", "");
    vi.stubEnv("VITE_FQDN", "");
    await load();
    const origins = amplify.configure.mock.calls[0][0].Auth.Cognito.loginWith.oauth.redirectSignIn;
    expect(origins).toContain("http://localhost:5173");
    expect(new Set(origins).size).toBe(origins.length);
  });
  it("omits the runtime origin outside a browser", async () => {
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "pool");
    vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client");
    vi.stubEnv("VITE_COGNITO_DOMAIN", "auth.example.test");
    vi.stubEnv("VITE_PORT", "4000");
    vi.stubGlobal("window", undefined);
    try {
      await load();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(amplify.configure.mock.calls[0][0].Auth.Cognito.loginWith.oauth.redirectSignIn).toEqual(["http://localhost:4000"]);
  });
  it("stays unconfigured without the pool settings", async () => {
    vi.stubEnv("VITE_COGNITO_USER_POOL_ID", "");
    await load();
    expect(amplify.configure).not.toHaveBeenCalled();
  });
});
