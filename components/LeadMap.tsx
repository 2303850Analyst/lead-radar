"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

import type { Lead } from "@/lib/types";

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

const DEFAULT_CENTER: Leaflet.LatLngExpression = [55.7558, 37.6173];

function markerColor(score: number) {
  if (score >= 80) return "#27ae60";
  if (score >= 60) return "#f59e0b";
  return "#ef6c45";
}

function hasValidCoordinates(lead: Lead) {
  const [longitude, latitude] = lead.location.coordinates;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
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

export default function LeadMap({
  leads,
  selectedLeadId,
  onSelect,
  className,
  focusCenter,
  focusRadiusKm,
}: LeadMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markersRef = useRef<Leaflet.LayerGroup | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const fittedCoordinatesRef = useRef("");
  const [status, setStatus] = useState<MapStatus>("loading");

  useEffect(() => {
    let disposed = false;
    let resizeFrame: number | undefined;

    async function initializeMap() {
      try {
        const leaflet = await import("leaflet");

        if (disposed || !containerRef.current) return;

        const map = leaflet.map(containerRef.current, {
          attributionControl: true,
          zoomControl: true,
        });

        leaflet
          .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
          })
          .addTo(map);

        const markers = leaflet.layerGroup().addTo(map);
        const initialCenter = hasValidCenter(focusCenter)
          ? ([focusCenter[1], focusCenter[0]] as Leaflet.LatLngExpression)
          : DEFAULT_CENTER;
        map.setView(initialCenter, 10);

        leafletRef.current = leaflet;
        mapRef.current = map;
        markersRef.current = markers;
        setStatus("ready");

        resizeFrame = window.requestAnimationFrame(() => map.invalidateSize());
      } catch {
        if (!disposed) setStatus("error");
      }
    }

    void initializeMap();

    return () => {
      disposed = true;
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);

      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current = null;
      leafletRef.current = null;
      fittedCoordinatesRef.current = "";
    };
  }, [focusCenter]);

  useEffect(() => {
    if (status !== "ready") return;

    const leaflet = leafletRef.current;
    const map = mapRef.current;
    const markerLayer = markersRef.current;

    if (!leaflet || !map || !markerLayer) return;

    markerLayer.clearLayers();

    const mappableLeads = leads.filter(hasValidCoordinates);

    const bounds = leaflet.latLngBounds([]);

    for (const lead of mappableLeads) {
      const [longitude, latitude] = lead.location.coordinates;
      const isSelected = lead.id === selectedLeadId;
      const score = lead.scores.opportunity;
      const position: Leaflet.LatLngExpression = [latitude, longitude];

      const marker = leaflet.circleMarker(position, {
        bubblingMouseEvents: false,
        color: isSelected ? "#1769e0" : "#ffffff",
        fillColor: markerColor(score),
        fillOpacity: 1,
        opacity: 1,
        radius: isSelected ? 11 : 8,
        weight: isSelected ? 4 : 2,
      });

      const tooltip = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = lead.name;
      detail.textContent = `Потенциал: ${Math.round(score)} из 100`;
      tooltip.className = styles.tooltip;
      tooltip.append(title, detail);

      marker.bindTooltip(tooltip, {
        direction: "top",
        offset: [0, -8],
      });
      marker.on("click", () => onSelect(lead));
      marker.addTo(markerLayer);

      if (isSelected) marker.bringToFront();
      bounds.extend(position);
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
        const position: Leaflet.LatLngExpression = [focusCenter[1], focusCenter[0]];
        if (Number.isFinite(focusRadiusKm) && (focusRadiusKm ?? 0) > 0) {
          const focusBounds = leaflet
            .circle(position, { radius: (focusRadiusKm ?? 15) * 1_000 })
            .getBounds();
          map.fitBounds(focusBounds, {
            animate: false,
            maxZoom: 14,
            padding: [40, 40],
          });
        } else {
          map.setView(position, 10, { animate: false });
        }
      } else if (mappableLeads.length === 1) {
        map.setView(bounds.getCenter(), 13, { animate: false });
      } else if (mappableLeads.length > 1) {
        map.fitBounds(bounds, {
          animate: false,
          maxZoom: 14,
          padding: [40, 40],
        });
      } else {
        map.setView(DEFAULT_CENTER, 10, { animate: false });
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
        aria-label="Карта найденных лидов"
      />

      {status === "loading" && (
        <div className={styles.state} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Загружаем карту…
        </div>
      )}

      {status === "error" && (
        <div className={styles.state} role="alert">
          Не удалось загрузить карту. Обновите страницу и попробуйте снова.
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
