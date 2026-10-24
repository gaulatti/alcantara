import { describe, expect, it } from 'vitest';
import { login, logout, setAuthLoaded, setCurrentUser } from './dispatchers/auth';
import { setLanguage } from './dispatchers/preferences';
import { reducers } from './reducers';
import { authReducer } from './reducers/auth';
import { preferencesReducer } from './reducers/preferences';
import { currentUser, isAuthenticated, isLoaded } from './selectors/auth';
import { selectLanguage } from './selectors/preferences';
import defaultState, { type State } from './store';
import type { User } from '../models/user';

const user: User = { id: 'operator-a', email: 'operator@example.invalid', name: 'Fictional operator' };

describe('operator authentication state', () => {
  it('starts unauthenticated and unloaded while preserving the default locale', () => {
    const state = reducers(undefined, { type: 'initial' });
    expect(state).toBe(defaultState);
    expect(isAuthenticated(state)).toBe(false);
    expect(isLoaded(state)).toBe(false);
    expect(currentUser(state)).toBeUndefined();
    expect(selectLanguage(state)).toBe('en');
    expect(authReducer(undefined, { type: 'initial' })).toBe(defaultState);
    expect(preferencesReducer(undefined, { type: 'initial' })).toBe(defaultState);
  });
  it('updates login and logout without erasing the selected language', () => {
    const spanish = reducers(undefined, setLanguage('es')) as State;
    const loggedIn = reducers(spanish, login(user));
    expect(isAuthenticated(loggedIn)).toBe(true);
    expect(isLoaded(loggedIn)).toBe(true);
    expect(currentUser(loggedIn)).toEqual(user);
    expect(selectLanguage(loggedIn)).toBe('es');
    const loggedOut = reducers(loggedIn, logout());
    expect(currentUser(loggedOut)).toBeUndefined();
    expect(isLoaded(loggedOut)).toBe(true);
    expect(selectLanguage(loggedOut)).toBe('es');
    expect(currentUser(spanish)).toBeUndefined();
  });
  it('can finish an unauthenticated login lookup and later replace the user', () => {
    const checked = reducers(undefined, login());
    expect(isAuthenticated(checked)).toBe(false);
    expect(isLoaded(checked)).toBe(true);
    const identified = reducers(checked, setCurrentUser(user));
    expect(currentUser(identified)).toEqual(user);
    expect(isLoaded(identified)).toBe(true);
    expect(reducers(undefined, setAuthLoaded()).auth).toEqual({ loaded: true });
  });
  it('rehydrates stored preferences without trusting persisted authentication readiness', () => {
    const payload = { auth: { currentUser: user, loaded: true }, preferences: { selectedLanguage: 'it' } };
    const fresh = reducers(undefined, { type: 'persist/REHYDRATE', payload });
    expect(currentUser(fresh)).toEqual(user);
    expect(isLoaded(fresh)).toBe(false);
    expect(selectLanguage(fresh)).toBe('it');
    const alreadyLoaded = reducers(reducers(undefined, setAuthLoaded()), { type: 'persist/REHYDRATE', payload });
    expect(isLoaded(alreadyLoaded)).toBe(true);
    expect(reducers(defaultState, { type: 'persist/REHYDRATE' })).toBe(defaultState);
  });
});
