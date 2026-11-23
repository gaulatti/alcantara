import { describe, expect, it } from "vitest";
import { login, logout, setAuthLoaded, setCurrentUser } from "./dispatchers/auth";
import { setLanguage } from "./dispatchers/preferences";
import { reducers } from "./reducers";
import { authReducer } from "./reducers/auth";
import { preferencesReducer } from "./reducers/preferences";
import { currentUser, isAuthenticated, isLoaded } from "./selectors/auth";
import { selectLanguage } from "./selectors/preferences";
import defaultStore from "./store";
import { getStore } from "./index";

const user = { id: "u1", email: "a@x.test" } as any;

describe("auth state", () => {
  it("starts signed out and not loaded", () => {
    expect(defaultStore).toEqual({ auth: { loaded: false }, preferences: { selectedLanguage: "en" } });
    expect(isAuthenticated(defaultStore)).toBe(false);
    expect(isLoaded(defaultStore)).toBe(false);
    expect(currentUser(defaultStore)).toBeUndefined();
  });
  it("builds actions", () => {
    expect(login(user)).toEqual({ type: "LOGIN", payload: user });
    expect(login()).toEqual({ type: "LOGIN", payload: undefined });
    expect(logout()).toEqual({ type: "LOGOUT" });
    expect(setCurrentUser(user)).toEqual({ type: "SET_CURRENT_USER", payload: user });
    expect(setAuthLoaded()).toEqual({ type: "SET_AUTH_LOADED" });
    expect(setLanguage("es")).toEqual({ type: "SET_LANGUAGE", payload: "es" });
  });
  it("signs in with LOGIN or SET_CURRENT_USER and marks the session loaded", () => {
    for (const action of [login(user), setCurrentUser(user)]) {
      const next = authReducer(undefined, action);
      expect(currentUser(next)).toBe(user);
      expect(isAuthenticated(next)).toBe(true);
      expect(isLoaded(next)).toBe(true);
    }
  });
  it("signs out but stays loaded", () => {
    const next = authReducer(authReducer(undefined, login(user)), logout());
    expect(isAuthenticated(next)).toBe(false);
    expect(isLoaded(next)).toBe(true);
  });
  it("marks the session loaded without a user", () => {
    const next = authReducer(undefined, setAuthLoaded());
    expect(isLoaded(next)).toBe(true);
    expect(isAuthenticated(next)).toBe(false);
  });
  it("rehydrates persisted state and keeps the current loaded flag", () => {
    const loaded = authReducer(undefined, setAuthLoaded());
    const persisted = { auth: { currentUser: user, loaded: false }, preferences: { selectedLanguage: "it" } };
    const next = authReducer(loaded, { type: "persist/REHYDRATE", payload: persisted });
    expect(currentUser(next)).toBe(user);
    expect(isLoaded(next)).toBe(true);
    expect(selectLanguage(next)).toBe("it");
    const fresh = authReducer(undefined, { type: "persist/REHYDRATE", payload: persisted });
    expect(isLoaded(fresh)).toBe(false);
  });
  it("ignores a rehydrate without a payload and unknown actions", () => {
    const state = authReducer(undefined, setAuthLoaded());
    expect(authReducer(state, { type: "persist/REHYDRATE" })).toBe(state);
    expect(authReducer(state, { type: "OTHER" })).toBe(state);
  });
});

describe("preferences state", () => {
  it("changes the language and ignores other actions", () => {
    const next = preferencesReducer(undefined, setLanguage("es"));
    expect(selectLanguage(next)).toBe("es");
    expect(preferencesReducer(next, { type: "OTHER" })).toBe(next);
    expect(selectLanguage(preferencesReducer(undefined, { type: "OTHER" }))).toBe("en");
  });
});

describe("root reducer and store", () => {
  it("combines both reducers", () => {
    let state = reducers(undefined, login(user));
    state = reducers(state, setLanguage("it"));
    expect(currentUser(state)).toBe(user);
    expect(selectLanguage(state)).toBe("it");
  });
  it("creates the store once and runs the root saga", () => {
    const { store } = getStore();
    expect(getStore().store).toBe(store);
    store.dispatch(login(user));
    expect(currentUser(store.getState() as any)).toBe(user);
  });
});
