import { type RouteConfig, index, route, layout } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/protected.tsx', [
    layout('routes/layout.tsx', [
      index('routes/home.tsx'),
      route('control', 'routes/control.tsx'),
      route('instants', 'routes/instants.tsx'),
      route('songs', 'routes/songs.tsx'),
      route('media', 'routes/media.tsx'),
      route('scenes', 'routes/scenes.tsx'),
      route('programs', 'routes/programs.tsx'),
      route('layouts', 'routes/layouts.tsx'),
      route('preview', 'routes/preview.tsx'),
      route('layout-demo', 'routes/layout-demo.tsx')
    ]),
    route('overlay', 'routes/overlay.tsx')
  ]),
  route('program/:id', 'routes/program.tsx'),
] satisfies RouteConfig;
