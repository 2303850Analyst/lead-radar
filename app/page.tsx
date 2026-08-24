import type { Metadata } from "next";

import LeadRadarApp from "@/components/LeadRadarApp";
import { DgisMapProvider } from "@/components/maps/DgisMapProvider";

export const metadata: Metadata = {
  title: "LeadRadar — поиск скрытых B2B-лидов",
  description:
    "Локальный инструмент для поиска и приоритизации компаний по данным карт.",
};

export default function Home() {
  const mapApiKey =
    process.env.DGIS_MAP_KEY?.trim() || process.env.DGIS_API_KEY?.trim() || null;

  return (
    <DgisMapProvider apiKey={mapApiKey}>
      <LeadRadarApp />
    </DgisMapProvider>
  );
}
