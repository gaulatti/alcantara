// The scene parts Bleecker is about to publish, picked up only when the installed version ships them: a pattern that
// matches no file yields an empty object, so this builds before the release (gaulatti/alcantara, no renderers in the app).
export const bleeckerSceneModules = import.meta.glob(
  '/node_modules/@gaulatti/bleecker/dist/components/{lower-third,full-screen,corner-bug,scene-notice,fade-to-black}.js',
  { eager: true },
) as Record<string, Record<string, unknown>>;
