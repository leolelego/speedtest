import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const DOWNLOAD_SOURCES = [
  (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
];

const ENV_UPLOAD_ENDPOINTS = ((import.meta.env?.VITE_UPLOAD_ENDPOINTS ?? import.meta.env?.VITE_UPLOAD_ENDPOINT ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((url, index) => ({ name: `Custom endpoint ${index + 1}`, url })));

const DEFAULT_UPLOAD_TARGETS = [
  { name: 'Cloudflare Speed Test', url: 'https://speed.cloudflare.com/__up' },
  { name: 'Postman Echo', url: 'https://postman-echo.com/post' },
  { name: 'HTTPBin', url: 'https://httpbin.org/post' },
];

const UPLOAD_TARGETS = [...ENV_UPLOAD_ENDPOINTS, ...DEFAULT_UPLOAD_TARGETS].filter(
  (target, index, array) => array.findIndex((item) => item.url === target.url) === index,
);

const CAPABILITY_GROUPS = [
  {
    service: 'Teams',
    qualities: [
      {
        key: 'teams-720p',
        label: 'Video 720p',
        detail: '≥1.5/1 Mbps, RTT ≤150ms',
        thresholds: { minDl: 1.5, minUl: 1, maxRtt: 150, maxLoss: 3 },
      },
      {
        key: 'teams-audio',
        label: 'Audio only',
        detail: '≥0.3/0.3 Mbps, RTT ≤200ms',
        thresholds: { minDl: 0.3, minUl: 0.3, maxRtt: 200, maxLoss: 5 },
      },
    ],
  },
  {
    service: 'Streaming',
    qualities: [
      {
        key: 'streaming-4k',
        label: '4K',
        detail: '≥25 Mbps down',
        thresholds: { minDl: 25, maxLoss: 2 },
      },
      {
        key: 'streaming-1080p',
        label: '1080p',
        detail: '≥5 Mbps down',
        thresholds: { minDl: 5, maxLoss: 3 },
      },
    ],
  },
  {
    service: 'GeForce NOW',
    qualities: [
      {
        key: 'geforce-1080p60',
        label: '1080p60',
        detail: '≥25 Mbps, RTT ≤40ms',
        thresholds: { minDl: 25, maxRtt: 40, maxLoss: 1.5 },
      },
      {
        key: 'geforce-720p60',
        label: '720p60',
        detail: '≥15 Mbps, RTT ≤80ms',
        thresholds: { minDl: 15, maxRtt: 80, maxLoss: 2.5 },
      },
    ],
  },
];
const LATENCY_URL = 'https://speed.cloudflare.com/__down?bytes=16';
const DL_DURATION_S = 6;
const UL_DURATION_S = 5;
const RTT_PINGS = 12;
const TOTAL_STEPS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtMbps = (bps) => `${(bps / 1e6).toFixed(2)} Mbps`;
const cacheBust = () => Math.random().toString(36).slice(2);

const fillRandomBytes = (array) => {
  if (typeof window === 'undefined' || !window.crypto?.getRandomValues) {
    return;
  }

  const MAX_CHUNK_SIZE = 65536;
  for (let offset = 0; offset < array.length; offset += MAX_CHUNK_SIZE) {
    const chunk = array.subarray(offset, Math.min(offset + MAX_CHUNK_SIZE, array.length));
    window.crypto.getRandomValues(chunk);
  }
};
const withCacheBust = (url) => {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cacheBust', cacheBust());
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}cacheBust=${cacheBust()}`;
  }
};
const stddev = (arr) => {
  if (!arr.length) return 0;
  const mean = arr.reduce((acc, value) => acc + value, 0) / arr.length;
  const variance = arr.reduce((acc, value) => acc + (value - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
};

function rateCapabilities({ dlMbps, ulMbps, rtt, loss }) {
  return CAPABILITY_GROUPS.map((group) => {
    const options = group.qualities.map((quality) => {
      const missing = [];
      const limiting = [];

      if (quality.thresholds.minDl != null) {
        if (dlMbps == null || Number.isNaN(dlMbps)) {
          missing.push('download speed');
        } else if (dlMbps + Number.EPSILON < quality.thresholds.minDl) {
          limiting.push(`download speed (${dlMbps.toFixed(1)} < ${quality.thresholds.minDl} Mbps)`);
        }
      }

      if (quality.thresholds.minUl != null) {
        if (ulMbps == null || Number.isNaN(ulMbps)) {
          missing.push('upload speed');
        } else if (ulMbps + Number.EPSILON < quality.thresholds.minUl) {
          limiting.push(`upload speed (${ulMbps.toFixed(1)} < ${quality.thresholds.minUl} Mbps)`);
        }
      }

      if (quality.thresholds.maxRtt != null) {
        if (rtt == null || Number.isNaN(rtt)) {
          missing.push('latency');
        } else if (rtt - Number.EPSILON > quality.thresholds.maxRtt) {
          limiting.push(`latency (${rtt.toFixed(0)} ms > ${quality.thresholds.maxRtt} ms)`);
        }
      }

      if (quality.thresholds.maxLoss != null) {
        if (loss == null || Number.isNaN(loss)) {
          missing.push('packet loss');
        } else if (loss - Number.EPSILON > quality.thresholds.maxLoss) {
          limiting.push(`packet loss (${loss.toFixed(1)}% > ${quality.thresholds.maxLoss}%)`);
        }
      }

      const status = limiting.length > 0 ? false : missing.length > 0 ? null : true;

      return {
        key: quality.key,
        label: quality.label,
        detail: quality.detail,
        status,
        missing,
        limiting,
      };
    });

    const passingOptions = options.filter((option) => option.status === true);
    const unknownOption = options.find((option) => option.status == null);
    const failingOption = [...options].reverse().find((option) => option.status === false);

    let ok;
    let why;
    let missing = [];
    let limiting = [];

    if (passingOptions.length > 0) {
      const top = passingOptions[0];
      ok = true;
      why = `Highest supported quality: ${top.label} (${top.detail})`;
    } else if (unknownOption) {
      ok = null;
      missing = unknownOption.missing;
      why = `Need more data to evaluate ${group.service}.`;
    } else {
      ok = false;
      limiting = failingOption?.limiting ?? [];
      const label = failingOption?.label ?? group.service;
      why = `Requirements not met for ${label}.`;
    }

    return {
      key: group.service,
      ok,
      why,
      missing,
      limiting,
      options,
    };
  });
}

export default function NetworkCapabilityTester() {
  const [ipInfo, setIpInfo] = useState({
    ip: '—',
    city: '—',
    region: '—',
    country: '—',
    org: '—',
  });

  const [dlBps, setDlBps] = useState(null);
  const [ulBps, setUlBps] = useState(null);
  const [latencyMs, setLatencyMs] = useState(null);
  const [jitterMs, setJitterMs] = useState(null);
  const [lossPct, setLossPct] = useState(null);
  const [samples, setSamples] = useState({ dl: 0, ul: 0, rtt: 0 });
  const [stepErrors, setStepErrors] = useState({ dl: null, ul: null, rtt: null });
  const [progressDetails, setProgressDetails] = useState([]);

  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState({ label: 'Idle', step: 0 });
  const runningRef = useRef(false);
  const abortersRef = useRef([]);
  const startTimeRef = useRef(null);

  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const applyScheme = () => {
      if (query.matches) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    };

    applyScheme();
    query.addEventListener('change', applyScheme);
    return () => query.removeEventListener('change', applyScheme);
  }, []);

  const fetchIPInfo = useCallback(async () => {
    try {
      const response = await fetch('https://ipapi.co/json/');
      const json = await response.json();
      setIpInfo({
        ip: json.ip || '—',
        city: json.city || '—',
        region: json.region || '—',
        country: json.country_name || json.country || '—',
        org: json.org || json.asn || '—',
      });
    } catch {
      setIpInfo((previous) => ({ ...previous, ip: 'Failed' }));
    }
  }, []);

  useEffect(() => {
    fetchIPInfo();
  }, [fetchIPInfo]);

  const registerAborter = useCallback((controller) => {
    abortersRef.current.push(controller);
    return () => {
      abortersRef.current = abortersRef.current.filter((item) => item !== controller);
    };
  }, []);

  const resetAborters = useCallback(() => {
    abortersRef.current.forEach((aborter) => aborter.abort());
    abortersRef.current = [];
  }, []);

  const logProgress = useCallback((message) => {
    setProgressDetails((previous) => {
      const timestamp =
        startTimeRef.current && typeof performance !== 'undefined'
          ? (performance.now() - startTimeRef.current) / 1000
          : 0;
      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        message,
        timestamp,
      };
      return [...previous, entry];
    });
  }, []);

  const handleTestError = useCallback(
    (error) => {
      const isError = error instanceof Error;
      const message = isError && error.message ? error.message : 'Unknown error occurred.';
      console.error('[SpeedTest] Test failed', error);
      runningRef.current = false;
      resetAborters();
      setIsRunning(false);
      setStatus({ label: 'Test failed', step: 0 });
      logProgress(`❌ Fatal error: ${message}`);
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`Speed test failed: ${message}`);
      }
    },
    [logProgress, resetAborters],
  );

  const measureDownload = useCallback(async (onProgress) => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);

    const start = performance.now();
    const end = start + DL_DURATION_S * 1000;

    let bytes = 0;
    let count = 0;
    let inFlight = 0;
    const MAX_PAR = 6;
    let lastError = null;
    let lastProgressEmit = start;

    async function pump() {
      while (performance.now() < end && runningRef.current) {
        if (inFlight >= MAX_PAR) {
          await sleep(10);
          continue;
        }
        inFlight += 1;
        try {
          const response = await fetch(
            `${DOWNLOAD_SOURCES[0](2 ** 20 * 8)}&cacheBust=${Math.random()}`,
            { signal: controller.signal, cache: 'no-store' },
          );
          if (!response.ok) {
            throw new Error(
              response.status === 429
                ? 'Download test was rate limited (HTTP 429).'
                : `Download request failed with status ${response.status}.`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          bytes += arrayBuffer.byteLength;
          count += 1;
          lastError = null;
          const now = performance.now();
          if (onProgress && now - lastProgressEmit >= 500) {
            lastProgressEmit = now;
            const elapsed = (now - start) / 1000;
            const duration = Math.max(elapsed, 0.001);
            onProgress({
              bytes,
              count,
              elapsed,
              bps: (bytes * 8) / duration,
            });
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            return;
          }
          lastError = error instanceof Error ? error : new Error('Download request failed.');
        } finally {
          inFlight -= 1;
        }
      }
    }

    await Promise.race([
      Promise.allSettled(Array.from({ length: MAX_PAR }, pump)),
      sleep(DL_DURATION_S * 1000 + 2000),
    ]);

    controller.abort();
    unregister();

    if (bytes === 0 && lastError) {
      throw lastError;
    }

    return {
      bps: (bytes * 8) / Math.max((performance.now() - start) / 1000, 0.001),
      count,
    };
  }, [registerAborter]);

  const measureUpload = useCallback(async ({ onProgress, onTargetChange } = {}) => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);

    if (UPLOAD_TARGETS.length === 0) {
      unregister();
      throw new Error(
        'No upload endpoints configured. Set VITE_UPLOAD_ENDPOINTS or VITE_UPLOAD_ENDPOINT to provide at least one target.',
      );
    }

    const start = performance.now();
    const end = start + UL_DURATION_S * 1000;

    let bytes = 0;
    let count = 0;
    let inFlight = 0;
    const MAX_PAR = 4;
    let lastError = null;
    let lastProgressEmit = start;

    const payload = new Uint8Array(2 ** 20 * 2);
    fillRandomBytes(payload);

    let activeTargetIndex = 0;
    let lastNotifiedTarget = -1;
    const failureCounts = new Array(UPLOAD_TARGETS.length).fill(0);

    const notifyTargetChange = (reason) => {
      if (typeof onTargetChange !== 'function') return;
      if (lastNotifiedTarget === activeTargetIndex && reason !== 'retry') {
        return;
      }
      lastNotifiedTarget = activeTargetIndex;
      const target = UPLOAD_TARGETS[activeTargetIndex];
      onTargetChange({
        name: target.name,
        url: target.url,
        reason,
      });
    };

    notifyTargetChange('initial');

    const advanceTarget = (reason) => {
      if (UPLOAD_TARGETS.length <= 1) {
        return;
      }
      const previousIndex = activeTargetIndex;
      activeTargetIndex = (activeTargetIndex + 1) % UPLOAD_TARGETS.length;
      if (activeTargetIndex !== previousIndex) {
        failureCounts[activeTargetIndex] = 0;
        notifyTargetChange(reason);
      }
    };

    async function pump() {
      while (performance.now() < end && runningRef.current) {
        if (inFlight >= MAX_PAR) {
          await sleep(10);
          continue;
        }
        inFlight += 1;
        try {
          const target = UPLOAD_TARGETS[activeTargetIndex];
          const response = await fetch(withCacheBust(target.url), {
            method: 'POST',
            body: payload,
            signal: controller.signal,
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
          });
          if (!response.ok) {
            const error = new Error(
              response.status === 429
                ? 'Upload test was rate limited (HTTP 429).'
                : `Upload request failed with status ${response.status}.`,
            );
            error.status = response.status;
            throw error;
          }
          await response.arrayBuffer();
          bytes += payload.byteLength;
          count += 1;
          lastError = null;
          failureCounts[activeTargetIndex] = 0;
          const now = performance.now();
          if (onProgress && now - lastProgressEmit >= 500) {
            lastProgressEmit = now;
            const elapsed = (now - start) / 1000;
            const duration = Math.max(elapsed, 0.001);
            onProgress({
              bytes,
              count,
              elapsed,
              bps: (bytes * 8) / duration,
            });
          }
        } catch (error) {
          if (error?.name === 'AbortError') {
            return;
          }
          const normalizedError = error instanceof Error ? error : new Error('Upload request failed.');
          lastError = normalizedError;
          const status =
            typeof normalizedError.status === 'number'
              ? normalizedError.status
              : normalizedError.name === 'TypeError'
                ? 0
                : undefined;
          failureCounts[activeTargetIndex] += 1;
          if (
            UPLOAD_TARGETS.length > 1 &&
            (status === 429 || status === 403 || status === 0 || failureCounts[activeTargetIndex] >= 3)
          ) {
            advanceTarget('fallback');
          }
        } finally {
          inFlight -= 1;
        }
      }
    }

    await Promise.race([
      Promise.allSettled(Array.from({ length: MAX_PAR }, pump)),
      sleep(UL_DURATION_S * 1000 + 2000),
    ]);

    controller.abort();
    unregister();

    if (bytes === 0 && lastError) {
      throw lastError;
    }

    return {
      bps: (bytes * 8) / Math.max((performance.now() - start) / 1000, 0.001),
      count,
    };
  }, [registerAborter]);

  const measureLatency = useCallback(async (onProgress) => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);
    const durations = [];
    let drops = 0;
    let lastError = null;

    for (let index = 0; index < RTT_PINGS; index += 1) {
      if (!runningRef.current) break;
      const start = performance.now();
      try {
        const response = await fetch(`${LATENCY_URL}&cacheBust=${Math.random()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            response.status === 429
              ? 'Latency test was rate limited (HTTP 429).'
              : `Latency request failed with status ${response.status}.`,
          );
        }
        await response.arrayBuffer();
        durations.push(performance.now() - start);
        lastError = null;
        if (onProgress) {
          onProgress({
            count: durations.length,
            drops,
            last: durations[durations.length - 1],
          });
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastError = null;
          break;
        }
        drops += 1;
        lastError = error instanceof Error ? error : new Error('Latency request failed.');
        if (onProgress) {
          onProgress({
            count: durations.length,
            drops,
            last: null,
            error: lastError,
          });
        }
      }
      if (!runningRef.current) break;
      await sleep(120);
    }

    const average = durations.reduce((acc, value) => acc + value, 0) / Math.max(1, durations.length);
    const jitter = durations.length > 1 ? stddev(durations) : 0;
    const loss = (drops / (drops + durations.length)) * 100;

    controller.abort();
    unregister();

    if (durations.length === 0 && lastError) {
      throw lastError;
    }

    return {
      avg: average,
      jit: jitter,
      loss,
      count: durations.length,
    };
  }, [registerAborter]);

  const startTests = useCallback(async () => {
    if (runningRef.current) return;

    resetAborters();
    runningRef.current = true;
    setIsRunning(true);
    setStatus({ label: 'Preparing test…', step: 0 });
    console.info('[SpeedTest] Starting network capability test');

    setDlBps(null);
    setUlBps(null);
    setLatencyMs(null);
    setJitterMs(null);
    setLossPct(null);
    setSamples({ dl: 0, ul: 0, rtt: 0 });
    setStepErrors({ dl: null, ul: null, rtt: null });
    setProgressDetails([]);
    startTimeRef.current = typeof performance !== 'undefined' ? performance.now() : null;
    logProgress('Initializing test environment…');

    try {
      const encounteredErrors = { dl: false, ul: false, rtt: false };

      setStatus({ label: 'Measuring download speed…', step: 1 });
      logProgress('Download test started.');
      console.info('[SpeedTest] Measuring download throughput');
      try {
        const download = await measureDownload((progress) => {
          logProgress(
            `Download progress: ${(progress.bytes / 1e6).toFixed(1)} MB transferred, ${fmtMbps(
              progress.bps,
            )}`,
          );
        });
        console.info('[SpeedTest] Download test finished', {
          megabitsPerSecond: download.bps / 1e6,
          requestsCompleted: download.count,
        });
        if (!runningRef.current) {
          console.info('[SpeedTest] Download measurement aborted');
          logProgress('Download measurement aborted.');
          return;
        }
        setDlBps(download.bps);
        setSamples((previous) => ({ ...previous, dl: download.count }));
        logProgress('Download test completed successfully.');
      } catch (error) {
        encounteredErrors.dl = true;
        const message = error instanceof Error ? error.message : 'Unknown error.';
        setStepErrors((previous) => ({ ...previous, dl: message }));
        logProgress(`⚠️ Download test error: ${message}`);
        console.warn('[SpeedTest] Download test failed but continuing', error);
      }

      if (!runningRef.current) {
        return;
      }

      setStatus({ label: 'Measuring upload speed…', step: 2 });
      logProgress('Upload test started.');
      console.info('[SpeedTest] Measuring upload throughput');
      try {
        const upload = await measureUpload({
          onProgress: (progress) => {
            logProgress(
              `Upload progress: ${(progress.bytes / 1e6).toFixed(1)} MB sent, ${fmtMbps(
                progress.bps,
              )}`,
            );
          },
          onTargetChange: (target) => {
            const label = target.name || 'alternate endpoint';
            let description = label;
            try {
              const url = new URL(target.url);
              description = `${label} (${url.host})`;
            } catch {
              description = label;
            }
            if (target.reason === 'initial') {
              logProgress(`Upload endpoint: ${description}`);
            } else if (target.reason === 'fallback') {
              logProgress(`Switched upload endpoint to ${description}`);
            }
          },
        });
        console.info('[SpeedTest] Upload test finished', {
          megabitsPerSecond: upload.bps / 1e6,
          requestsCompleted: upload.count,
        });
        if (!runningRef.current) {
          console.info('[SpeedTest] Upload measurement aborted');
          logProgress('Upload measurement aborted.');
          return;
        }
        setUlBps(upload.bps);
        setSamples((previous) => ({ ...previous, ul: upload.count }));
        logProgress('Upload test completed successfully.');
      } catch (error) {
        encounteredErrors.ul = true;
        const message = error instanceof Error ? error.message : 'Unknown error.';
        setStepErrors((previous) => ({ ...previous, ul: message }));
        logProgress(`⚠️ Upload test error: ${message}`);
        console.warn('[SpeedTest] Upload test failed but continuing', error);
      }

      if (!runningRef.current) {
        return;
      }

      setStatus({ label: 'Measuring latency & quality…', step: 3 });
      logProgress('Latency test started.');
      console.info('[SpeedTest] Measuring latency, jitter, and loss');
      try {
        const latency = await measureLatency((progress) => {
          if (progress.error) {
            logProgress('⚠️ Latency request failed, retrying…');
            return;
          }
          if (progress.last != null) {
            logProgress(
              `Latency sample ${progress.count}: ${progress.last.toFixed(1)} ms (${progress.drops} drops)`,
            );
          }
        });
        console.info('[SpeedTest] Latency test finished', {
          averageLatencyMs: latency.avg,
          jitterMs: latency.jit,
          lossPercent: latency.loss,
          samplesCollected: latency.count,
        });
        if (!runningRef.current) {
          console.info('[SpeedTest] Latency measurement aborted');
          logProgress('Latency measurement aborted.');
          return;
        }
        setLatencyMs(latency.avg);
        setJitterMs(latency.jit);
        setLossPct(latency.loss);
        setSamples((previous) => ({ ...previous, rtt: latency.count }));
        logProgress('Latency test completed successfully.');
      } catch (error) {
        encounteredErrors.rtt = true;
        const message = error instanceof Error ? error.message : 'Unknown error.';
        setStepErrors((previous) => ({ ...previous, rtt: message }));
        logProgress(`⚠️ Latency test error: ${message}`);
        console.warn('[SpeedTest] Latency test failed but continuing', error);
      }

      if (!runningRef.current) {
        return;
      }

      const hasErrors = encounteredErrors.dl || encounteredErrors.ul || encounteredErrors.rtt;
      runningRef.current = false;
      setIsRunning(false);
      const finalLabel = hasErrors ? 'Test finished with warnings' : 'Test complete';
      setStatus({ label: finalLabel, step: TOTAL_STEPS });
      logProgress(`${finalLabel}.`);
      if (!hasErrors) {
        console.info('[SpeedTest] Test completed successfully');
      } else {
        console.warn('[SpeedTest] Test completed with warnings');
      }
    } catch (error) {
      handleTestError(error);
    }
  }, [
    handleTestError,
    logProgress,
    measureDownload,
    measureLatency,
    measureUpload,
    resetAborters,
  ]);

  const stopTests = useCallback(() => {
    if (!runningRef.current) return;
    runningRef.current = false;
    setIsRunning(false);
    resetAborters();
    setStatus({ label: 'Test stopped', step: 0 });
    logProgress('Test stopped by user.');
    console.warn('[SpeedTest] Test manually stopped');
  }, [logProgress, resetAborters]);

  const caps = useMemo(() => {
    const hasAnyMeasurements = [dlBps, ulBps, latencyMs, lossPct].some((value) => value != null);
    if (!hasAnyMeasurements && !stepErrors.dl && !stepErrors.ul && !stepErrors.rtt) {
      return [];
    }
    return rateCapabilities({
      dlMbps: dlBps != null ? dlBps / 1e6 : null,
      ulMbps: ulBps != null ? ulBps / 1e6 : null,
      rtt: latencyMs,
      loss: lossPct,
    });
  }, [dlBps, latencyMs, lossPct, stepErrors.dl, stepErrors.rtt, stepErrors.ul, ulBps]);

  useEffect(() => {
    if (!isRunning && caps.length > 0) {
      console.info('[SpeedTest] Capability assessment', caps);
    }
  }, [caps, isRunning]);

  const renderThroughput = useCallback((value, error) => {
    if (error) return 'Not accessible';
    if (value == null) return '—';
    return fmtMbps(value);
  }, []);

  const renderLatencyMetric = useCallback((value, error, formatter) => {
    if (error) return 'Not accessible';
    if (value == null) return '—';
    return formatter(value);
  }, []);

  const formatList = useCallback((items) => {
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }, []);

  const formatMissingMeasurements = useCallback(
    (missing) => {
      if (!missing.length) return '';
      return `${formatList(missing)} ${missing.length === 1 ? 'measurement' : 'measurements'}`;
    },
    [formatList],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      console.info('[SpeedTest] Auto-starting test after initial delay');
      startTests();
    }, 2000);

    return () => clearTimeout(timer);
  }, [startTests]);

  return (
    <div className="app-root">
      {isRunning && (
        <div className="loading-banner" role="status" aria-live="polite">
          <span className="loading-banner__spinner" aria-hidden="true" />
          <span className="loading-banner__text">Running speed test…</span>
        </div>
      )}
      <div className="app-container">
        <section className={`panel panel--elevated ${isRunning ? 'panel--loading' : ''}`}>
          {isRunning && (
            <div className="panel-skeleton panel-skeleton--speedtest" aria-hidden="true">
              <div className="panel-skeleton__header">
                <span className="skeleton skeleton--title" />
                <span className="skeleton skeleton--pill" />
              </div>
              <div className="panel-skeleton__subheader">
                <span className="skeleton skeleton--text" />
                <span className="skeleton skeleton--text skeleton--short" />
              </div>
              <div className="panel-skeleton__grid panel-skeleton__grid--main">
                <span className="skeleton skeleton--card" />
                <span className="skeleton skeleton--card" />
              </div>
              <div className="panel-skeleton__grid panel-skeleton__grid--details">
                <span className="skeleton skeleton--card" />
                <span className="skeleton skeleton--card" />
                <span className="skeleton skeleton--card" />
                <span className="skeleton skeleton--card" />
              </div>
              <span className="skeleton skeleton--feed" />
            </div>
          )}
          <div className="panel__content" aria-hidden={isRunning}>
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Speed Test</h2>
                <span className="panel-subtitle">DL/UL ~6s/5s + RTT</span>
              </div>
              <div className="test-progress">
                <span className="test-progress__label">{status.label}</span>
                <span className="test-progress__meter">
                  Step {Math.min(status.step, TOTAL_STEPS)} / {TOTAL_STEPS}
                </span>
              </div>
            </div>
            {Object.values(stepErrors).some(Boolean) && (
              <div className="test-progress__errors">
                {stepErrors.dl && <div>Download error: {stepErrors.dl}</div>}
                {stepErrors.ul && <div>Upload error: {stepErrors.ul}</div>}
                {stepErrors.rtt && <div>Latency error: {stepErrors.rtt}</div>}
              </div>
            )}
            <div className="stat-grid stat-grid--main">
              <div className="stat-card">
                <div className="stat-card__label">Download</div>
                <div className="stat-card__value">
                  {renderThroughput(dlBps, stepErrors.dl)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Upload</div>
                <div className="stat-card__value">
                  {renderThroughput(ulBps, stepErrors.ul)}
                </div>
              </div>
            </div>
            <div className="stat-grid stat-grid--details">
              <div className="stat-card">
                <div className="stat-card__label">Latency</div>
                <div className="stat-card__value">
                  {renderLatencyMetric(latencyMs, stepErrors.rtt, (value) => `${value.toFixed(0)} ms`)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Jitter</div>
                <div className="stat-card__value">
                  {renderLatencyMetric(jitterMs, stepErrors.rtt, (value) => `${value.toFixed(0)} ms`)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Loss</div>
                <div className="stat-card__value">
                  {renderLatencyMetric(lossPct, stepErrors.rtt, (value) => `${value.toFixed(1)} %`)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">Samples</div>
                <div className="stat-card__value">
                  {samples.dl || samples.ul || samples.rtt ? `${samples.dl}/${samples.ul}/${samples.rtt}` : '—'}
                </div>
              </div>
            </div>
            {progressDetails.length > 0 && (
              <div className="progress-feed">
                <h4 className="progress-feed__title">Live progress</h4>
                <ul className="progress-feed__list">
                  {progressDetails.map((entry) => (
                    <li key={entry.id} className="progress-feed__item">
                      <span className="progress-feed__timestamp">{entry.timestamp.toFixed(1)}s</span>
                      <span className="progress-feed__message">{entry.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <div className="info-grid">
          <section className="panel panel--subtle">
            <h3 className="panel-heading">IP &amp; Location</h3>
            <div className="info-list">
              <div>
                <span className="info-list__label">IP:</span> {ipInfo.ip}
              </div>
              <div>
                <span className="info-list__label">City:</span> {ipInfo.city}
              </div>
              <div>
                <span className="info-list__label">Region:</span> {ipInfo.region}
              </div>
              <div>
                <span className="info-list__label">Country:</span> {ipInfo.country}
              </div>
              <div>
                <span className="info-list__label">ISP:</span> {ipInfo.org}
              </div>
            </div>
          </section>
        </div>

        <section className={`panel panel--subtle ${isRunning ? 'panel--loading' : ''}`}>
          {isRunning && (
            <div className="panel-skeleton panel-skeleton--capabilities" aria-hidden="true">
              <span className="skeleton skeleton--heading" />
              <div className="panel-skeleton__list">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="panel-skeleton__list-item">
                    <span className="skeleton skeleton--icon" />
                    <div className="panel-skeleton__list-text">
                      <span className="skeleton skeleton--text" />
                      <span className="skeleton skeleton--subtext" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="panel__content" aria-hidden={isRunning}>
            <h3 className="panel-heading">Can I…?</h3>
            <div className="capabilities-grid">
              {caps.length === 0 && (
                <p className="empty-message">
                  Run the test for recommendations.
                </p>
              )}
              {caps.map((capability) => {
                const blockedOption = capability.options?.find(
                  (option) => option.status === false && option.limiting.length > 0,
                );
                return (
                  <div
                    key={capability.key}
                    className="capability-item"
                  >
                    <span className="capability-icon">
                      {capability.ok === true ? '✅' : capability.ok === false ? '❌' : '❔'}
                    </span>
                    <div className="capability-text">
                      <div className="capability-name">{capability.key}</div>
                      <div className="capability-desc">
                        {capability.why}
                      </div>
                      {capability.options?.length > 0 && (
                        <div className="capability-options">
                          {capability.options.map((option) => (
                            <span
                              key={option.key}
                              className={`capability-pill ${
                                option.status === true
                                  ? 'capability-pill--available'
                                  : option.status == null
                                    ? 'capability-pill--unknown'
                                    : 'capability-pill--unavailable'
                              }`}
                              title={option.detail}
                            >
                              {option.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {capability.ok === null && capability.missing.length > 0 && (
                        <div className="capability-note">
                          Missing {formatMissingMeasurements(capability.missing)}.
                        </div>
                      )}
                      {capability.ok === false && capability.limiting.length > 0 && (
                        <div className="capability-note">
                          Limited by {formatList(capability.limiting)}.
                        </div>
                      )}
                      {capability.ok === true && blockedOption && (
                        <div className="capability-note">
                          Higher tiers limited by {formatList(blockedOption.limiting)}.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <div className="app-footer">
        <div className="app-footer__inner">
          <button
            type="button"
            onClick={isRunning ? stopTests : startTests}
            className={`action-button ${isRunning ? 'action-button--stop' : 'action-button--start'}`}
          >
            {isRunning ? 'Stop' : 'Run test'}
          </button>
        </div>
      </div>
    </div>
  );
}
