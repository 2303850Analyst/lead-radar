"use client";

import { useEffect, useRef, useState } from "react";

import type { Lead } from "@/lib/types";

import {
  loadDgisMapApi,
  radiusBounds,
  useDgisMapKey,
  type DgisCircleMarker,
  type DgisHtmlMarker,
  type DgisMap,
  type DgisMapApi,
} from "./maps/DgisMapProvider";
import styles from "./LeadMap.module.css";

type LeadMapProps = {
  leads: Lead[];
  selectedLeadId?: string | null;
  onSelect: (lead: Lead) => void;
  className?: string;
  focusCenter?: [longitude: number, latitude: number];
  focusRadiusKm?: number;
};

type MapStatus = "loading" | "ready" | "error";
type MapObject = DgisCircleMarker | DgisHtmlMarker;

const DEFAULT_CENTER: [longitude: number, latitude: number] = [
  37.6173, 55.7558,
];

function markerColor(score: number) {
  if (score >= 80) return "#27ae60";
  if (score >= 60) return "#f59e0b";
  return "#ef6c45";
}

function hasValidCoordinates(lead: Lead) {
  return hasValidCenter(lead.location.coordinates);
}

function hasValidCenter(
  center: [longitude: number, latitude: number] | undefined,
): center is [longitude: number, latitude: number] {
  if (!center) return false;
  const [longitude, latitude] = center;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function coordinateBounds(
  coordinates: Array<[longitude: number, latitude: number]>,
) {
  let minLongitude = coordinates[0][0];
  let maxLongitude = coordinates[0][0];
  let minLatitude = coordinates[0][1];
  let maxLatitude = coordinates[0][1];

  for (const [longitude, latitude] of coordinates.slice(1)) {
    minLongitude = Math.min(minLongitude, longitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLatitude = Math.max(maxLatitude, latitude);
  }

  return {
    southWest: [minLongitude, minLatitude],
    northEast: [maxLongitude, maxLatitude],
  };
}

function createTooltip(lead: Lead, score: number) {
  const tooltip = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  title.textContent = lead.name;
  detail.textContent = `Потенциал: ${Math.round(score)} из 100`;
  tooltip.className = styles.tooltip;
  tooltip.append(title, detail);
  return tooltip;
}

export default function LeadMap({
  leads,
  selectedLeadId,
  onSelect,
  className,
  focusCenter,
  focusRadiusKm,
}: LeadMapProps) {
  const apiKey = useDgisMapKey();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<DgisMap | null>(null);
  const mapApiRef = useRef<DgisMapApi | null>(null);
  const objectsRef = useRef<MapObject[]>([]);
  const fittedCoordinatesRef = useRef("");
  const initialFocusCenterRef = useRef(focusCenter);
  const [status, setStatus] = useState<MapStatus>("loading");

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame: number | null = null;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    async function initializeMap() {
      try {
        if (!apiKey) throw new Error("DGIS map key is not configured");
        const api = await loadDgisMapApi();
        if (disposed || !containerRef.current) return;

        const initialCenter = hasValidCenter(initialFocusCenterRef.current)
          ? initialFocusCenterRef.current
          : DEFAULT_CENTER;
        const map = new api.Map(containerRef.current, {
          center: initialCenter,
          copyright: "bottomRight",
          disablePitchByUserInteraction: true,
          disableRotationByUserInteraction: true,
          key: apiKey,
          lang: "ru",
          zoom: 10,
          zoomControl: "topLeft",
        });

        mapRef.current = map;
        mapApiRef.current = api;

        map.once("styleload", () => {
          if (disposed) return;
          if (readyTimeout) clearTimeout(readyTimeout);
          setStatus("ready");
        });
        map.once("styleloaderror", () => {
          if (!disposed) setStatus("error");
        });
        readyTimeout = setTimeout(() => {
          if (!disposed) setStatus("error");
        }, 15_000);

        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
            resizeFrame = window.requestAnimationFrame(() => map.invalidateSize());
          });
          resizeObserver.observe(containerRef.current);
        } else {
          resizeFrame = window.requestAnimationFrame(() => map.invalidateSize());
        }
      } catch {
        if (!disposed) setStatus("error");
      }
    }

    void initializeMap();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (readyTimeout) clearTimeout(readyTimeout);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      for (const object of objectsRef.current) object.destroy();
      objectsRef.current = [];
      mapRef.current?.destroy();
      mapRef.current = null;
      mapApiRef.current = null;
      fittedCoordinatesRef.current = "";
    };
  }, [apiKey]);

  useEffect(() => {
    if (status !== "ready") return;

    const api = mapApiRef.current;
    const map = mapRef.current;
    if (!api || !map) return;

    for (const object of objectsRef.current) object.destroy();
    objectsRef.current = [];

    const mappableLeads = leads.filter(hasValidCoordinates);
    const coordinates: Array<[number, number]> = [];

    for (const lead of mappableLeads) {
      const position: [number, number] = [
        lead.location.coordinates[0],
        lead.location.coordinates[1],
      ];
      const isSelected = lead.id === selectedLeadId;
      const score = lead.scores.opportunity;
      let tooltip: DgisHtmlMarker | null = null;

      const marker = new api.CircleMarker(map, {
        color: markerColor(score),
        coordinates: position,
        diameter: isSelected ? 22 : 16,
        interactive: true,
        strokeColor: isSelected ? "#1769e0" : "#ffffff",
        strokeWidth: isSelected ? 4 : 2,
        userData: { leadId: lead.id },
        zIndex: isSelected ? 30 : 20,
      });

      marker.on("click", () => onSelect(lead));
      marker.on("mouseover", () => {
        tooltip?.destroy();
        tooltip = new api.HtmlMarker(map, {
          anchor: [0, 14],
          coordinates: position,
          html: createTooltip(lead, score),
          interactive: false,
          labeling: { type: "none" },
          preventMapInteractions: false,
          zIndex: 50,
        });
        objectsRef.current.push(tooltip);
      });
      marker.on("mouseout", () => {
        tooltip?.destroy();
        if (tooltip) {
          objectsRef.current = objectsRef.current.filter(
            (object) => object !== tooltip,
          );
        }
        tooltip = null;
      });

      objectsRef.current.push(marker);
      coordinates.push(position);
    }

    const coordinatesKey = mappableLeads
      .map(
        (lead) =>
          `${lead.id}:${lead.location.coordinates[0]}:${lead.location.coordinates[1]}`,
      )
      .join("|");
    const focusKey = hasValidCenter(focusCenter)
      ? `${focusCenter[0]}:${focusCenter[1]}:${focusRadiusKm ?? ""}`
      : "auto";
    const viewportKey = `${focusKey}|${coordinatesKey}`;

    if (viewportKey !== fittedCoordinatesRef.current) {
      fittedCoordinatesRef.current = viewportKey;

      if (hasValidCenter(focusCenter)) {
        if (Number.isFinite(focusRadiusKm) && (focusRadiusKm ?? 0) > 0) {
          map.fitBounds(radiusBounds(focusCenter, focusRadiusKm ?? 15), {
            animation: { duration: 0 },
            maxZoom: 14,
            padding: { top: 40, right: 40, bottom: 40, left: 40 },
          });
        } else {
          map.setCenter(focusCenter, { duration: 0 });
          map.setZoom(10, { duration: 0 });
        }
      } else if (coordinates.length === 1) {
        map.setCenter(coordinates[0], { duration: 0 });
        map.setZoom(13, { duration: 0 });
      } else if (coordinates.length > 1) {
        map.fitBounds(coordinateBounds(coordinates), {
          animation: { duration: 0 },
          maxZoom: 14,
          padding: { top: 40, right: 40, bottom: 40, left: 40 },
        });
      } else {
        map.setCenter(DEFAULT_CENTER, { duration: 0 });
        map.setZoom(10, { duration: 0 });
      }
    }
  }, [focusCenter, focusRadiusKm, leads, onSelect, selectedLeadId, status]);

  const rootClassName = className
    ? `${styles.frame} ${className}`
    : styles.frame;
  const hasMappableLeads = leads.some(hasValidCoordinates);

  return (
    <div className={rootClassName}>
      <div
        ref={containerRef}
        className={styles.map}
        aria-label="Карта 2ГИС найденных лидов"
      />

      {status === "loading" && (
        <div className={styles.state} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Загружаем карту 2ГИС…
        </div>
      )}

      {status === "error" && (
        <div className={styles.state} role="alert">
          Не удалось загрузить карту 2ГИС. Проверьте доступ Map Tiles и обновите
          страницу.
        </div>
      )}

      {status === "ready" && !hasMappableLeads && (
        <div className={`${styles.state} ${styles.empty}`}>
          В этой выборке пока нет лидов с координатами
        </div>
      )}
    </div>
  );
}
