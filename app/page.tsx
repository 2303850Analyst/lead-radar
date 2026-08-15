import type { Metadata } from "next";

import LeadRadarApp from "@/components/LeadRadarApp";

export const metadata: Metadata = {
  title: "LeadRadar — поиск скрытых B2B-лидов",
  description:
    "Локальный инструмент для поиска и приоритизации компаний по данным карт.",
};

export default function Home() {
  return <LeadRadarApp />;
}
