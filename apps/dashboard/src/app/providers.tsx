'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter, usePathname } from 'next/navigation';
import { ApiError, setUnauthenticatedHandler } from '../lib/api.ts';

/**
 * TanStack Query is the whole data layer (D-130): the server cache *is* the app
 * state, so there is no store here.
 *
 * Two defaults worth stating. `staleTime: 30_000` matches the IA's contract — a
 * navigation between project pages must render cached content immediately and
 * revalidate behind it, never blank the shell. And a 401 is never retried:
 * retrying an expired session three times just delays the redirect by a second
 * and writes three audit rows for the same dead cookie.
 */
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            // A wrong password, a missing project, a forbidden action: retrying
            // cannot change the answer.
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, not per render.
  const [client] = useState(makeClient);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      // `next` so the user lands back where they were, which is the difference
      // between an interruption and losing your place.
      const onAuthPage = pathname === '/login' || pathname === '/signup';
      if (onAuthPage) return;
      const next = encodeURIComponent(pathname);
      router.replace(`/login?next=${next}`);
    });
    return () => setUnauthenticatedHandler(() => {});
  }, [router, pathname]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
