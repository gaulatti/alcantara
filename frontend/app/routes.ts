import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('program', 'routes/program.tsx'),
  route('control', 'routes/control.tsx'),
  route('preview', 'routes/preview.tsx'),
  route('broadcast', 'routes/broadcast.tsx'),
  route('layout-demo', 'routes/layout-demo.tsx')
] satisfies RouteConfig;
