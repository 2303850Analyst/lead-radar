"use client";

import { useEffect, useId, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";

import styles from "./SearchAreaMap.module.css";

export type SearchAreaCenter = [longitude: number, latitude: number];

export type SearchAreaMapProps = {
  center: SearchAreaCenter;
  radiusKm: number;
  onCenterChange: (center: SearchAreaCenter) => void;
  className?: string;
};

type MapStatus = "loading" | "ready" | "error";

const DEFAULT_CENTER: SearchAreaCenter = [37.6173, 55.7558];
const DEFAULT_RADIUS_METERS = 15_000;

function isValidCenter(center: SearchAreaCenter) {
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

function isValidRadius(radiusKm: number) {
  return Number.isFinite(radiusKm) && radiusKm > 0;
}

function toLatLng(center: SearchAreaCenter): Leaflet.LatLngExpression {
  return [center[1], center[0]];
}

function centerKey(center: SearchAreaCenter) {
  return `${center[0].toFixed(7)}:${center[1].toFixed(7)}`;
}

function fitSearchArea(
  map: Leaflet.Map,
  circle: Leaflet.Circle,
  animate: boolean,
) {
  const bounds = circle.getBounds();

  if (!bounds.isValid()) return;

  map.fitBounds(bounds, {
    animate,
    maxZoom: 16,
    padding: [28, 28],
  });
}

export default function SearchAreaMap({
  center,
  radiusKm,
  onCenterChange,
  className,
}: SearchAreaMapProps) {
  const instructionsId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const markerRef = useRef<Leaflet.Marker | null>(null);
  const circleRef = useRef<Leaflet.Circle | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const onCenterChangeRef = useRef(onCenterChange);
  const interactionCenterRef = useRef<string | null>(null);
  const previousAreaRef = useRef<{ center: string; radiusKm: number } | null>(
    null,
  );
  const fitFrameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<MapStatus>("loading");

  const inputError = !isValidCenter(center)
    ? "Не удалось показать карту: проверьте координаты центра."
    : !isValidRadius(radiusKm)
      ? "Не удалось показать область: радиус должен быть больше нуля."
      : null;

  useEffect(() => {
    onCenterChangeRef.current = onCenterChange;
  }, [onCenterChange]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame: number | null = null;

    async function initializeMap() {
      try {
        const leaflet = await import("leaflet");

        if (disposed || !containerRef.current) return;

        const initialPosition = toLatLng(DEFAULT_CENTER);
        const map = leaflet.map(containerRef.current, {
          attributionControl: true,
          boxZoom: true,
          doubleClickZoom: true,
          dragging: true,
          keyboard: true,
          scrollWheelZoom: true,
          touchZoom: true,
          zoomControl: true,
        });

        map.setView(initialPosition, 10, { animate: false });

        const tiles = leaflet.tileLayer(
          "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          {
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
          },
        );
        tiles.addTo(map);

        const centerIcon = leaflet.divIcon({
          className: styles.centerIcon,
          html: `<span class="${styles.centerPin}" aria-hidden="true"></span>`,
          iconAnchor: [17, 34],
          iconSize: [34, 34],
        });

        const circle = leaflet.circle(initialPosition, {
          color: "#1769e0",
          fillColor: "#2c7cef",
          fillOpacity: 0.12,
          interactive: false,
          radius: DEFAULT_RADIUS_METERS,
          weight: 2,
        });
        circle.addTo(map);

        const marker = leaflet.marker(initialPosition, {
          alt: "Центр области поиска",
          bubblingMouseEvents: false,
          draggable: true,
          icon: centerIcon,
          keyboard: true,
          riseOnHover: true,
          title: "Перетащите, чтобы изменить центр поиска",
        });
        marker.addTo(map);

        function publishCenter(latLng: Leaflet.LatLng) {
          const nextCenter: SearchAreaCenter = [latLng.lng, latLng.lat];
          interactionCenterRef.current = centerKey(nextCenter);
          marker.setLatLng(latLng);
          circle.setLatLng(latLng);
          onCenterChangeRef.current(nextCenter);
        }

        map.on("click", (event: Leaflet.LeafletMouseEvent) => {
          publishCenter(event.latlng);
        });
        marker.on("drag", () => {
          circle.setLatLng(marker.getLatLng());
        });
        marker.on("dragend", () => {
          publishCenter(marker.getLatLng());
        });

        leafletRef.current = leaflet;
        mapRef.current = map;
        markerRef.current = marker;
        circleRef.current = circle;

        map.whenReady(() => {
          if (!disposed) setStatus("ready");
        });

        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
            resizeFrame = window.requestAnimationFrame(() => {
              map.invalidateSize({ pan: false });
            });
          });
          resizeObserver.observe(containerRef.current);
        } else {
          resizeFrame = window.requestAnimationFrame(() => {
            map.invalidateSize({ pan: false });
          });
        }
      } catch {
        if (!disposed) setStatus("error");
      }
    }

    void initializeMap();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();

      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }

      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      leafletRef.current = null;
      interactionCenterRef.current = null;
      previousAreaRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (status !== "ready" || inputError) return;

    const map = mapRef.current;
    const marker = markerRef.current;
    const circle = circleRef.current;

    if (!map || !marker || !circle) return;

    const nextPosition = toLatLng(center);
    const nextCenterKey = centerKey(center);
    const previousArea = previousAreaRef.current;
    const centerChanged = previousArea?.center !== nextCenterKey;
    const radiusChanged = previousArea?.radiusKm !== radiusKm;
    const followsMapInteraction =
      centerChanged && interactionCenterRef.current === nextCenterKey;

    marker.setLatLng(nextPosition);
    circle.setLatLng(nextPosition);
    circle.setRadius(radiusKm * 1_000);
    previousAreaRef.current = { center: nextCenterKey, radiusKm };

    if (!centerChanged && !radiusChanged) return;

    if (followsMapInteraction) {
      interactionCenterRef.current = null;
      const innerBounds = map.getBounds().pad(-0.15);

      if (!innerBounds.contains(nextPosition)) {
        map.panTo(nextPosition, { animate: true, duration: 0.25 });
      }
      return;
    }

    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitSearchArea(map, circle, previousArea !== null);
      fitFrameRef.current = null;
    });
  }, [center, inputError, radiusKm, status]);

  function handleFitArea() {
    const map = mapRef.current;
    const circle = circleRef.current;

    if (!map || !circle) return;
    fitSearchArea(map, circle, true);
    map.getContainer().focus({ preventScroll: true });
  }

  const rootClassName = className
    ? `${styles.frame} ${className}`
    : styles.frame;

  return (
    <div className={rootClassName}>
      <div
        ref={containerRef}
        className={styles.map}
        role="application"
        aria-describedby={instructionsId}
        aria-label="Интерактивная карта области поиска"
      />

      <p id={instructionsId} className={styles.visuallyHidden}>
        Перемещайте карту мышью, касанием или клавишами со стрелками. Нажмите на
        карту или перетащите маркер, чтобы выбрать новый центр поиска.
      </p>

      {status === "ready" && !inputError && (
        <>
          <div className={styles.areaToolbar}>
            <span>Радиус {radiusKm.toLocaleString("ru-RU")} км</span>
            <button type="button" onClick={handleFitArea}>
              Показать всю область
            </button>
          </div>
          <div className={styles.hint} aria-hidden="true">
            Нажмите на карту или переместите метку
          </div>
        </>
      )}

      {status === "loading" && (
        <div className={styles.state} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          Загружаем интерактивную карту…
        </div>
      )}

      {(status === "error" || inputError) && (
        <div className={styles.state} role="alert">
          {inputError ??
            "Не удалось загрузить карту. Проверьте подключение и обновите страницу."}
        </div>
      )}
    </div>
  );
}
