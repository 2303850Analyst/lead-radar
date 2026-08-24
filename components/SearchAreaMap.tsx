"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  loadDgisMapApi,
  radiusBounds,
  useDgisMapKey,
  type DgisCircle,
  type DgisHtmlMarker,
  type DgisMap,
  type DgisMapApi,
} from "./maps/DgisMapProvider";
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
const DEFAULT_RADIUS_KM = 15;

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

function centerKey(center: SearchAreaCenter) {
  return `${center[0].toFixed(7)}:${center[1].toFixed(7)}`;
}

function createSearchCircle(
  api: DgisMapApi,
  map: DgisMap,
  center: SearchAreaCenter,
  radiusKm: number,
) {
  return new api.Circle(map, {
    coordinates: center,
    radius: radiusKm * 1_000,
    color: "#2c7cef1f",
    strokeColor: "#1769e0",
    strokeWidth: 2,
    interactive: false,
    zIndex: 10,
  });
}

function fitSearchArea(
  map: DgisMap,
  center: SearchAreaCenter,
  radiusKm: number,
  animate: boolean,
) {
  map.fitBounds(radiusBounds(center, radiusKm), {
    animation: { duration: animate ? 250 : 0 },
    maxZoom: 16,
    padding: { top: 28, right: 28, bottom: 28, left: 28 },
  });
}

export default function SearchAreaMap({
  center,
  radiusKm,
  onCenterChange,
  className,
}: SearchAreaMapProps) {
  const apiKey = useDgisMapKey();
  const instructionsId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<DgisMap | null>(null);
  const markerRef = useRef<DgisHtmlMarker | null>(null);
  const circleRef = useRef<DgisCircle | null>(null);
  const mapApiRef = useRef<DgisMapApi | null>(null);
  const onCenterChangeRef = useRef(onCenterChange);
  const radiusKmRef = useRef(radiusKm);
  const initialCenterRef = useRef(center);
  const initialRadiusKmRef = useRef(radiusKm);
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
    radiusKmRef.current = radiusKm;
  }, [radiusKm]);

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

        const initialCenter = isValidCenter(initialCenterRef.current)
          ? initialCenterRef.current
          : DEFAULT_CENTER;
        const initialRadius = isValidRadius(initialRadiusKmRef.current)
          ? initialRadiusKmRef.current
          : DEFAULT_RADIUS_KM;
        const map = new api.Map(containerRef.current, {
          center: initialCenter,
          copyright: "bottomRight",
          disablePitchByUserInteraction: true,
          disableRotationByUserInteraction: true,
          key: apiKey,
          lang: "ru",
          scaleControl: false,
          zoom: 10,
          zoomControl: "topLeft",
        });

        const circle = createSearchCircle(
          api,
          map,
          initialCenter,
          initialRadius,
        );
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = styles.centerPin;
        pin.setAttribute("aria-label", "Центр области поиска");
        pin.title = "Перетащите, чтобы изменить центр поиска";

        const marker = new api.HtmlMarker(map, {
          anchor: [17, 34],
          coordinates: initialCenter,
          html: pin,
          interactive: true,
          labeling: { type: "none" },
          preventMapInteractions: true,
          zIndex: 20,
        });

        function replaceCircle(nextCenter: SearchAreaCenter) {
          circleRef.current?.destroy();
          circleRef.current = createSearchCircle(
            api,
            map,
            nextCenter,
            isValidRadius(radiusKmRef.current)
              ? radiusKmRef.current
              : DEFAULT_RADIUS_KM,
          );
        }

        function publishCenter(nextCenter: SearchAreaCenter) {
          interactionCenterRef.current = centerKey(nextCenter);
          marker.setCoordinates(nextCenter);
          replaceCircle(nextCenter);
          onCenterChangeRef.current(nextCenter);
        }

        map.on("click", (event) => {
          publishCenter([event.lngLat[0], event.lngLat[1]]);
        });

        let dragging = false;
        let dragOffset: [number, number] = [0, 0];

        pin.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          dragging = true;
          pin.classList.add(styles.centerPinDragging);
          pin.setPointerCapture(event.pointerId);
          map.setOption("disableDragging", true);

          const bounds = map.getContainer().getBoundingClientRect();
          const pointer = [event.clientX - bounds.left, event.clientY - bounds.top];
          const markerPoint = map.project(marker.getCoordinates());
          dragOffset = [
            markerPoint[0] - pointer[0],
            markerPoint[1] - pointer[1],
          ];
        });

        pin.addEventListener("pointermove", (event) => {
          if (!dragging) return;
          event.preventDefault();

          const bounds = map.getContainer().getBoundingClientRect();
          const nextCoordinates = map.unproject([
            event.clientX - bounds.left + dragOffset[0],
            event.clientY - bounds.top + dragOffset[1],
          ]);
          const nextCenter: SearchAreaCenter = [
            nextCoordinates[0],
            nextCoordinates[1],
          ];
          marker.setCoordinates(nextCenter);
          replaceCircle(nextCenter);
        });

        function finishDragging(event: PointerEvent) {
          if (!dragging) return;
          event.preventDefault();
          dragging = false;
          pin.classList.remove(styles.centerPinDragging);
          map.setOption("disableDragging", false);
          const nextCoordinates = marker.getCoordinates();
          publishCenter([nextCoordinates[0], nextCoordinates[1]]);
        }

        pin.addEventListener("pointerup", finishDragging);
        pin.addEventListener("pointercancel", finishDragging);
        pin.addEventListener("keydown", (event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          ) {
            return;
          }

          event.preventDefault();
          const point = map.project(marker.getCoordinates());
          const delta = event.shiftKey ? 50 : 18;
          if (event.key === "ArrowLeft") point[0] -= delta;
          if (event.key === "ArrowRight") point[0] += delta;
          if (event.key === "ArrowUp") point[1] -= delta;
          if (event.key === "ArrowDown") point[1] += delta;
          const nextCoordinates = map.unproject(point);
          publishCenter([nextCoordinates[0], nextCoordinates[1]]);
        });

        mapApiRef.current = api;
        mapRef.current = map;
        markerRef.current = marker;
        circleRef.current = circle;

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
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }

      markerRef.current?.destroy();
      circleRef.current?.destroy();
      mapRef.current?.destroy();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      mapApiRef.current = null;
      interactionCenterRef.current = null;
      previousAreaRef.current = null;
    };
  }, [apiKey]);

  useEffect(() => {
    if (status !== "ready" || inputError) return;

    const api = mapApiRef.current;
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!api || !map || !marker) return;

    const nextCenterKey = centerKey(center);
    const previousArea = previousAreaRef.current;
    const centerChanged = previousArea?.center !== nextCenterKey;
    const radiusChanged = previousArea?.radiusKm !== radiusKm;
    const followsMapInteraction =
      centerChanged && interactionCenterRef.current === nextCenterKey;

    marker.setCoordinates(center);
    circleRef.current?.destroy();
    circleRef.current = createSearchCircle(api, map, center, radiusKm);
    previousAreaRef.current = { center: nextCenterKey, radiusKm };

    if (!centerChanged && !radiusChanged) return;

    if (followsMapInteraction) {
      interactionCenterRef.current = null;
      return;
    }

    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
    }
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitSearchArea(map, center, radiusKm, previousArea !== null);
      fitFrameRef.current = null;
    });
  }, [center, inputError, radiusKm, status]);

  function handleFitArea() {
    const map = mapRef.current;
    if (!map || inputError) return;
    fitSearchArea(map, center, radiusKm, true);
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
        aria-label="Интерактивная карта 2ГИС области поиска"
      />

      <p id={instructionsId} className={styles.visuallyHidden}>
        Перемещайте карту мышью или касанием. Нажмите на карту, перетащите маркер
        или используйте клавиши со стрелками на маркере, чтобы выбрать центр.
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
          Загружаем карту 2ГИС…
        </div>
      )}

      {(status === "error" || inputError) && (
        <div className={styles.state} role="alert">
          {inputError ??
            "Не удалось загрузить карту 2ГИС. Проверьте доступ Map Tiles и обновите страницу."}
        </div>
      )}
    </div>
  );
}
