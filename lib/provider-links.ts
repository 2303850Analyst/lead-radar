export type ExternalMapTargetInput = {
  providerId: string;
  discoverySource: string;
  name: string;
  address: string;
  coordinates: [number, number];
  sources?: Array<{ provider: string; externalId: string }>;
};

export function externalMapTarget(input: ExternalMapTargetInput): {
  href: string;
  label: string;
} {
  const [longitude, latitude] = input.coordinates;
  const source = input.discoverySource || input.providerId;
  if (source === "2gis" || input.providerId === "2gis") {
    const externalId = input.sources?.find((item) => item.provider === "2gis")?.externalId.trim();
    return {
      href: externalId
        ? `https://2gis.ru/firm/${encodeURIComponent(externalId)}`
        : `https://2gis.ru/search/${encodeURIComponent(`${input.name} ${input.address}`)}`,
      label: "Открыть в 2GIS",
    };
  }
  if (source === "yandex" || input.providerId === "yandex") {
    return {
      href: `https://yandex.ru/maps/?pt=${longitude},${latitude}&z=16&l=map`,
      label: "Открыть в Яндекс Картах",
    };
  }
  return {
    href: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`,
    label: "Открыть в OpenStreetMap",
  };
}
