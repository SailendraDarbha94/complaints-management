import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NavigationProgress } from './components/navigation-progress';
import './globals.css';
import './screens.css';

export const metadata: Metadata = {
  title: 'Complaints Register — KSDC',
  description: 'Karnataka State Dental Council complaints register and follow-up queue',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        {/* Suspense because it reads the search params; it renders nothing until clicked. */}
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
