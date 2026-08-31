import type { ReactNode } from 'react';
import { Providers } from './providers.tsx';
import '../styles/tokens.css';
import '../styles/components.css';
import '../styles/app.css';

export const metadata = {
  title: 'Corebase',
  description: 'The backend foundation for modern applications.',
};

/**
 * Two inline scripts, both deliberate.
 *
 * **Theme, before first paint.** The design system ships light and dark as peers
 * (D-178). Reading the stored choice in an effect would paint the wrong theme
 * first and flash — so it runs synchronously in `<head>`, ahead of the body.
 *
 * **Runtime config.** The API base is read from `window.__COREBASE__` rather than
 * inlined by the bundler, so one build serves staging and production. This is the
 * only server-rendered value in the app; everything data-driven is a client
 * component calling the platform API (D-130).
 */
const THEME_BOOTSTRAP = `
(function(){try{
  var s=localStorage.getItem('cb-theme');
  if(s==='dark'||s==='light')document.documentElement.setAttribute('data-theme',s);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const apiBase = process.env.COREBASE_API_BASE ?? 'http://localhost:8099';
  return (
    // suppressHydrationWarning is on <html> and nowhere else: the theme script
    // above deliberately sets data-theme before React hydrates, so the server
    // markup and the live DOM differ by exactly that attribute, by design. React
    // cannot tell an intentional pre-hydration mutation from a bug, so it is said
    // here — scoped to the one element where it is true.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__COREBASE__=${JSON.stringify({ apiBase })};`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
