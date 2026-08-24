"use client";

import { load } from "@2gis/mapgl";
import { createContext, useContext, type ReactNode } from "react";

export type DgisMapApi = Awaited<ReturnType<typeof load>>;
export type DgisMap = InstanceType<DgisMapApi["Map"]>;
export type DgisCircle = InstanceType<DgisMapApi["Circle"]>;
export type DgisCircleMarker = InstanceType<DgisMapApi["CircleMarker"]>;
export type DgisHtmlMarker = InstanceType<DgisMapApi["HtmlMarker"]>;

type DgisMapProviderProps = {
  apiKey: string | null;
  children: ReactNode;
};

const DgisMapKeyContext = createContext<string | null>(null);
let mapApiPromise: Promise<DgisMapApi> | null = null;

export function DgisMapProvider({ apiKey, children }: DgisMapProviderProps) {
  return (
    <DgisMapKeyContext.Provider value={apiKey}>
      {children}
    </DgisMapKeyContext.Provider>
  );
}

export function useDgisMapKey() {
  return useContext(DgisMapKeyContext);
}

export function loadDgisMapApi() {
  mapApiPromise ??= load().catch((error: unknown) => {
    mapApiPromise = null;
    throw error;
  });
  return mapApiPromise;
}

export function radiusBounds(
  center: [longitude: number, latitude: number],
  radiusKm: number,
) {
  const [longitude, latitude] = center;
  const latitudeDelta = radiusKm / 111.32;
  const longitudeScale = Math.max(
    Math.cos((latitude * Math.PI) / 180),
    0.01,
  );
  const longitudeDelta = radiusKm / (111.32 * longitudeScale);

  return {
    southWest: [longitude - longitudeDelta, latitude - latitudeDelta],
    northEast: [longitude + longitudeDelta, latitude + latitudeDelta],
  };
}
