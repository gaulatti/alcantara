import { describe, expect, it } from 'vitest';
import { mediaErrorHelp, mediaPlatform } from './guestMediaHelp';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/120.0.0.0 Mobile Safari/537.36';

const failure = (name: string) => Object.assign(new Error(name), { name });

describe('mediaPlatform', () => {
  it('tells iOS Safari, Android Chrome and everything else apart', () => {
    expect(mediaPlatform(IPHONE_SAFARI)).toBe('ios-safari');
    expect(mediaPlatform(IPHONE_CHROME)).toBe('other');
    expect(mediaPlatform(ANDROID_CHROME)).toBe('android-chrome');
    expect(mediaPlatform(ANDROID_SAMSUNG)).toBe('other');
    expect(mediaPlatform('')).toBe('other');
  });
});

describe('mediaErrorHelp', () => {
  it('gives iOS Safari its own settings path for a denied permission', () => {
    const help = mediaErrorHelp(failure('NotAllowedError'), IPHONE_SAFARI);
    expect(help.title).toBe('Camera or microphone access is blocked.');
    expect(help.steps.join(' ')).toContain('Settings app, then Safari');
  });

  it('gives Android Chrome its own permissions path for a denied permission', () => {
    const help = mediaErrorHelp(failure('NotAllowedError'), ANDROID_CHROME);
    expect(help.steps.join(' ')).toContain('Tap Permissions');
  });

  it('gives other browsers the general instruction', () => {
    const help = mediaErrorHelp(failure('PermissionDeniedError'), ANDROID_SAMSUNG);
    expect(help.steps[0]).toBe('Allow camera and microphone for this site in your browser settings.');
  });

  it('says when no camera or microphone exists', () => {
    expect(mediaErrorHelp(failure('NotFoundError'), IPHONE_SAFARI).title).toBe('No camera or microphone was found.');
    expect(mediaErrorHelp(failure('OverconstrainedError'), ANDROID_CHROME).title).toBe('No camera or microphone was found.');
  });

  it('says when another app holds the camera or microphone', () => {
    expect(mediaErrorHelp(failure('NotReadableError'), ANDROID_CHROME).title).toBe('The camera or microphone is in use.');
  });

  it('falls back to a general message for anything else, including non-errors', () => {
    expect(mediaErrorHelp(failure('TypeError'), ANDROID_CHROME).title).toBe('The camera or microphone could not start.');
    expect(mediaErrorHelp('boom', ANDROID_CHROME).steps).toHaveLength(2);
  });
});
