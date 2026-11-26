/** What a guest sees when the browser will not give the page a camera or microphone, in plain words. */
export type MediaHelp = { title: string; steps: string[] };

export type MediaPlatform = 'ios-safari' | 'android-chrome' | 'other';

/** The browser a phone guest is using, from its user agent. In-app and third-party iOS browsers are 'other'. */
export function mediaPlatform(userAgent: string): MediaPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)) return 'ios-safari';
  if (/Android/.test(userAgent) && /Chrome\//.test(userAgent) && !/EdgA|OPR\/|SamsungBrowser/.test(userAgent)) return 'android-chrome';
  return 'other';
}

function permissionSteps(platform: MediaPlatform): string[] {
  if (platform === 'ios-safari') {
    return [
      'Open the Settings app, then Safari, then Camera and Microphone.',
      'Choose Allow for this site, or Ask, then allow when the page asks.',
      'Come back to this page, reload it, and press Try again.',
    ];
  }
  if (platform === 'android-chrome') {
    return [
      'Tap the lock or tune icon beside the address.',
      'Tap Permissions, then set Camera and Microphone to Allow.',
      'Reload this page, then press Try again.',
    ];
  }
  return [
    'Allow camera and microphone for this site in your browser settings.',
    'Reload this page, then press Try again.',
  ];
}

/** Turns a failed getUserMedia error into a title and steps the guest can follow. */
export function mediaErrorHelp(error: unknown, userAgent: string): MediaHelp {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { title: 'Camera or microphone access is blocked.', steps: permissionSteps(mediaPlatform(userAgent)) };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return {
      title: 'No camera or microphone was found.',
      steps: ['Connect a camera and a microphone, or a headset with a microphone.', 'Press Try again.'],
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'The camera or microphone is in use.',
      steps: ['Close other apps or browser tabs that use the camera or microphone.', 'Press Try again.'],
    };
  }
  return {
    title: 'The camera or microphone could not start.',
    steps: ['Press Try again.', 'If it still fails, reload the page or ask the studio for a new link.'],
  };
}
