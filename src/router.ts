import { useEffect, useState } from 'react';

/** Hash routes, so a refresh or a shared link reopens the same screen. */
export type Route =
  | { name: 'workflows' }
  | { name: 'workflow'; id: string }
  | { name: 'runs' }
  | { name: 'run'; id: string }
  | { name: 'approvals' }
  | { name: 'tools' };

export function parseRoute(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'workflows' && b) return { name: 'workflow', id: decodeURIComponent(b) };
  if (a === 'runs' && b) return { name: 'run', id: decodeURIComponent(b) };
  if (a === 'runs') return { name: 'runs' };
  if (a === 'approvals') return { name: 'approvals' };
  if (a === 'tools') return { name: 'tools' };
  return { name: 'workflows' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'workflow':
      return `#/workflows/${encodeURIComponent(route.id)}`;
    case 'run':
      return `#/runs/${encodeURIComponent(route.id)}`;
    default:
      return `#/${route.name}`;
  }
}

export const navigate = (route: Route) => {
  window.location.hash = href(route);
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
