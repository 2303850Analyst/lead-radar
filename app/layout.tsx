import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "LeadRadar — поиск скрытых B2B-лидов",
    template: "%s · LeadRadar",
  },
  description:
    "Поиск, проверка и приоритизация локальных компаний для точечных B2B-продаж.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "LeadRadar — поиск скрытых B2B-лидов",
    description: "Находим бизнесы, которые не видит обычный поиск.",
    type: "website",
    locale: "ru_RU",
    images: [{ url: "/og-leadradar.png", width: 1731, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og-leadradar.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
