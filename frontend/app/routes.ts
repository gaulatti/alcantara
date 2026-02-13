import { type RouteConfig, index, route, layout } from '@react-router/dev/routes';

export default [
  layout('routes/layout.tsx', [
    index('routes/home.tsx'),
    route('control', 'routes/control.tsx'),
    route('preview', 'routes/preview.tsx'),
    route('broadcast', 'routes/broadcast.tsx'),
    route('layout-demo', 'routes/layout-demo.tsx')
  ]),
  route('program/:id', 'routes/program.tsx')
] satisfies RouteConfig;
