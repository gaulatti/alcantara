import { type RouteConfig, index, route, layout } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/protected.tsx', [
    layout('routes/layout.tsx', [
      index('routes/control.tsx'),
      route('control', 'routes/control-legacy.tsx'),
      route('instants', 'routes/instants.tsx'),
      route('stingers', 'routes/stingers.tsx'),
      route('songs', 'routes/songs.tsx'),
      route('media', 'routes/media.tsx'),
      route('calls', 'routes/calls.tsx'),
      route('scenes', 'routes/scenes.tsx'),
      route('programs', 'routes/programs.tsx'),
      route('layouts', 'routes/layouts.tsx'),
      route('preview', 'routes/preview.tsx'),
      route('layout-demo', 'routes/layout-demo.tsx'),
      route('console-fixture', 'routes/console-fixture.tsx'),
      route('song-intro-fixture', 'routes/song-intro-fixture.tsx'),
      route('flight', 'routes/flight.tsx')
    ]),
    route('overlay', 'routes/overlay.tsx')
  ]),
  route('guest/:invitation', 'routes/guest.tsx'),
  route('return-router/:programId', 'routes/return-router.tsx'),
  route('program/:id', 'routes/program.tsx')
] satisfies RouteConfig;
