import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const DOWNLOAD_SOURCES = [
  (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
];
const UPLOAD_ENDPOINT = 'https://httpbin.org/post';
const LATENCY_URL = 'https://speed.cloudflare.com/__down?bytes=16';
const DL_DURATION_S = 8;
const UL_DURATION_S = 5;
const RTT_PINGS = 12;
const TOTAL_STEPS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtMbps = (bps) => `${(bps / 1e6).toFixed(2)} Mbps`;
const stddev = (arr) => {
  if (!arr.length) return 0;
  const mean = arr.reduce((acc, value) => acc + value, 0) / arr.length;
  const variance = arr.reduce((acc, value) => acc + (value - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
};

function rateCapabilities({ dlMbps, ulMbps, rtt, jitter, loss }) {
  return [
    {
      key: 'Teams audio',
      ok: dlMbps >= 0.3 && ulMbps >= 0.3 && rtt <= 200 && loss <= 5,
      why: '≥0.3/0.3 Mbps, RTT ≤200ms',
    },
    {
      key: 'Teams video 720p',
      ok: dlMbps >= 1.5 && ulMbps >= 1 && rtt <= 150 && loss <= 3,
      why: '≥1.5/1 Mbps, RTT ≤150ms',
    },
    {
      key: 'Streaming 1080p',
      ok: dlMbps >= 5 && loss <= 3,
      why: '≥5 Mbps down',
    },
    {
      key: 'Streaming 4K',
      ok: dlMbps >= 25 && loss <= 2,
      why: '≥25 Mbps down',
    },
    {
      key: 'GeForce NOW 1080p60',
      ok: dlMbps >= 25 && rtt <= 40 && loss <= 1.5,
      why: '≥25 Mbps, RTT ≤40ms',
    },
    {
      key: 'GeForce NOW 720p60',
      ok: dlMbps >= 15 && rtt <= 80 && loss <= 2.5,
      why: '≥15 Mbps, RTT ≤80ms',
    },
  ];
}

export default function NetworkCapabilityTester() {
  const [ipInfo, setIpInfo] = useState({
    ip: '—',
    city: '—',
    region: '—',
    country: '—',
    org: '—',
  });
  const [netInfo, setNetInfo] = useState({
    effectiveType: '—',
    downlink: '—',
    rtt: '—',
  });

  const [dlBps, setDlBps] = useState(null);
  const [ulBps, setUlBps] = useState(null);
  const [latencyMs, setLatencyMs] = useState(null);
  const [jitterMs, setJitterMs] = useState(null);
  const [lossPct, setLossPct] = useState(null);
  const [samples, setSamples] = useState({ dl: 0, ul: 0, rtt: 0 });

  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState({ label: 'Idle', step: 0 });
  const runningRef = useRef(false);
  const abortersRef = useRef([]);

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
    const connection =
      navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    if (!connection) {
      setNetInfo({ effectiveType: 'n/a', downlink: 'n/a', rtt: 'n/a' });
      return undefined;
    }

    const updateConnection = () =>
      setNetInfo({
        effectiveType: connection.effectiveType || '—',
        downlink: connection.downlink ? `${connection.downlink} Mbps` : '—',
        rtt: connection.rtt ? `${connection.rtt} ms` : '—',
      });

    updateConnection();
    connection.addEventListener('change', updateConnection);
    return () => connection.removeEventListener('change', updateConnection);
  }, []);

  useEffect(() => {
    fetchIPInfo();
  }, [fetchIPInfo]);

  const registerAborter = (controller) => {
    abortersRef.current.push(controller);
    return () => {
      abortersRef.current = abortersRef.current.filter((item) => item !== controller);
    };
  };

  const resetAborters = () => {
    abortersRef.current.forEach((aborter) => aborter.abort());
    abortersRef.current = [];
  };

  const measureDownload = useCallback(async () => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);

    const start = performance.now();
    const end = start + DL_DURATION_S * 1000;

    let bytes = 0;
    let count = 0;
    let inFlight = 0;
    const MAX_PAR = 6;

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
          const arrayBuffer = await response.arrayBuffer();
          bytes += arrayBuffer.byteLength;
          count += 1;
        } catch {
          // ignore individual request failures
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

    return {
      bps: (bytes * 8) / ((performance.now() - start) / 1000),
      count,
    };
  }, []);

  const measureUpload = useCallback(async () => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);

    const start = performance.now();
    const end = start + UL_DURATION_S * 1000;

    let bytes = 0;
    let count = 0;
    let inFlight = 0;
    const MAX_PAR = 4;

    const payload = new Uint8Array(2 ** 20 * 2);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(payload);
    }

    async function pump() {
      while (performance.now() < end && runningRef.current) {
        if (inFlight >= MAX_PAR) {
          await sleep(10);
          continue;
        }
        inFlight += 1;
        try {
          const response = await fetch(`${UPLOAD_ENDPOINT}?cacheBust=${Math.random()}`, {
            method: 'POST',
            body: payload,
            signal: controller.signal,
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/octet-stream',
            },
          });
          await response.arrayBuffer();
          bytes += payload.byteLength;
          count += 1;
        } catch {
          // ignore individual request failures
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

    return {
      bps: (bytes * 8) / ((performance.now() - start) / 1000),
      count,
    };
  }, []);

  const measureLatency = useCallback(async () => {
    const controller = new AbortController();
    const unregister = registerAborter(controller);
    const durations = [];
    let drops = 0;

    for (let index = 0; index < RTT_PINGS; index += 1) {
      if (!runningRef.current) break;
      const start = performance.now();
      try {
        const response = await fetch(`${LATENCY_URL}&cacheBust=${Math.random()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        await response.arrayBuffer();
        durations.push(performance.now() - start);
      } catch {
        drops += 1;
      }
      if (!runningRef.current) break;
      await sleep(120);
    }

    const average = durations.reduce((acc, value) => acc + value, 0) / Math.max(1, durations.length);
    const jitter = durations.length > 1 ? stddev(durations) : 0;
    const loss = (drops / (drops + durations.length)) * 100;

    controller.abort();
    unregister();

    return {
      avg: average,
      jit: jitter,
      loss,
      count: durations.length,
    };
  }, []);

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

    setStatus({ label: 'Measuring download speed…', step: 1 });
    console.info('[SpeedTest] Measuring download throughput');
    const download = await measureDownload();
    console.info('[SpeedTest] Download test finished', {
      megabitsPerSecond: download.bps / 1e6,
      requestsCompleted: download.count,
    });
    if (!runningRef.current) {
      console.info('[SpeedTest] Download measurement aborted');
      return;
    }
    setDlBps(download.bps);
    setSamples((previous) => ({ ...previous, dl: download.count }));

    setStatus({ label: 'Measuring upload speed…', step: 2 });
    console.info('[SpeedTest] Measuring upload throughput');
    const upload = await measureUpload();
    console.info('[SpeedTest] Upload test finished', {
      megabitsPerSecond: upload.bps / 1e6,
      requestsCompleted: upload.count,
    });
    if (!runningRef.current) {
      console.info('[SpeedTest] Upload measurement aborted');
      return;
    }
    setUlBps(upload.bps);
    setSamples((previous) => ({ ...previous, ul: upload.count }));

    setStatus({ label: 'Measuring latency & quality…', step: 3 });
    console.info('[SpeedTest] Measuring latency, jitter, and loss');
    const latency = await measureLatency();
    console.info('[SpeedTest] Latency test finished', {
      averageLatencyMs: latency.avg,
      jitterMs: latency.jit,
      lossPercent: latency.loss,
      samplesCollected: latency.count,
    });
    if (!runningRef.current) {
      console.info('[SpeedTest] Latency measurement aborted');
      return;
    }
    setLatencyMs(latency.avg);
    setJitterMs(latency.jit);
    setLossPct(latency.loss);
    setSamples((previous) => ({ ...previous, rtt: latency.count }));

    runningRef.current = false;
    setIsRunning(false);
    setStatus({ label: 'Test complete', step: TOTAL_STEPS });
    console.info('[SpeedTest] Test completed successfully');
  }, [measureDownload, measureLatency, measureUpload]);

  const stopTests = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    resetAborters();
    setStatus({ label: 'Test stopped', step: 0 });
    console.warn('[SpeedTest] Test manually stopped');
  }, []);

  const caps = useMemo(() => {
    if (dlBps == null || ulBps == null || latencyMs == null || lossPct == null) return [];
    return rateCapabilities({
      dlMbps: dlBps / 1e6,
      ulMbps: ulBps / 1e6,
      rtt: latencyMs,
      jitter: jitterMs ?? 0,
      loss: lossPct,
    });
  }, [dlBps, jitterMs, latencyMs, lossPct, ulBps]);

  useEffect(() => {
    if (!isRunning && caps.length > 0) {
      console.info('[SpeedTest] Capability assessment', caps);
    }
  }, [caps, isRunning]);

  useEffect(() => {
    const timer = setTimeout(() => {
      console.info('[SpeedTest] Auto-starting test after initial delay');
      startTests();
    }, 2000);

    return () => clearTimeout(timer);
  }, [startTests]);

  return (
    <div className="app-root">
      <div className="app-container">
        <section className="panel panel--elevated">
          <div className="panel-header">
            <h2 className="panel-title">Speed Test</h2>
            <span className="panel-subtitle">DL/UL ~8s/5s + RTT</span>
          </div>
          <div className="test-progress">
            <span className="test-progress__label">{status.label}</span>
            <span className="test-progress__meter">
              Step {Math.min(status.step, TOTAL_STEPS)} / {TOTAL_STEPS}
            </span>
          </div>
          <div className="stat-grid stat-grid--main">
            <div className="stat-card">
              <div className="stat-card__label">Download</div>
              <div className="stat-card__value">{dlBps == null ? '—' : fmtMbps(dlBps)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">Upload</div>
              <div className="stat-card__value">{ulBps == null ? '—' : fmtMbps(ulBps)}</div>
            </div>
          </div>
          <div className="stat-grid stat-grid--details">
            <div className="stat-card">
              <div className="stat-card__label">Latency</div>
              <div className="stat-card__value">
                {latencyMs == null ? '—' : `${latencyMs.toFixed(0)} ms`}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">Jitter</div>
              <div className="stat-card__value">
                {jitterMs == null ? '—' : `${jitterMs.toFixed(0)} ms`}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">Loss</div>
              <div className="stat-card__value">
                {lossPct == null ? '—' : `${lossPct.toFixed(1)} %`}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">Samples</div>
              <div className="stat-card__value">
                {samples.dl || samples.ul || samples.rtt ? `${samples.dl}/${samples.ul}/${samples.rtt}` : '—'}
              </div>
            </div>
          </div>
        </section>

        <div className="info-grid">
          <section className="panel panel--subtle">
            <h3 className="panel-heading">Network</h3>
            <div className="info-list">
              <div>
                <span className="info-list__label">Type:</span> {netInfo.effectiveType}
              </div>
              <div>
                <span className="info-list__label">Downlink:</span> {netInfo.downlink}
              </div>
              <div>
                <span className="info-list__label">RTT:</span> {netInfo.rtt}
              </div>
            </div>
          </section>
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

        <section className="panel panel--subtle">
          <h3 className="panel-heading">Can I…?</h3>
          <div className="capabilities-grid">
            {caps.length === 0 && (
              <p className="empty-message">
                Run the test for recommendations.
              </p>
            )}
            {caps.map((capability) => (
              <div
                key={capability.key}
                className="capability-item"
              >
                <span className="capability-icon">{capability.ok ? '✅' : '❌'}</span>
                <div className="capability-text">
                  <div className="capability-name">{capability.key}</div>
                  <div className="capability-desc">
                    {capability.why}
                  </div>
                </div>
              </div>
            ))}
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
