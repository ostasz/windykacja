import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Generator KRD',
  description: 'Generowanie pliku CSV dla KRD',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body className="bg-gray-950 text-gray-100 min-h-screen">{children}</body>
    </html>
  )
}
