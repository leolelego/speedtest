import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DOWNLOAD_SOURCES = [
  (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
];
const UPLOAD_ENDPOINT = 'https://httpbin.org/post';
const LATENCY_URL = 'https://speed.cloudflare.com/__down?bytes=16';
const DL_DURATION_S = 8;
const UL_DURATION_S = 5;
const RTT_PINGS = 12;

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

  const resetAborters = () => {
    abortersRef.current.forEach((aborter) => aborter.abort());
    abortersRef.current = [];
  };

  const measureDownload = useCallback(async () => {
    const controller = new AbortController();
    abortersRef.current.push(controller);

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

    return {
      bps: (bytes * 8) / ((performance.now() - start) / 1000),
      count,
    };
  }, []);

  const measureUpload = useCallback(async () => {
    const controller = new AbortController();
    abortersRef.current.push(controller);

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

    return {
      bps: (bytes * 8) / ((performance.now() - start) / 1000),
      count,
    };
  }, []);

  const measureLatency = useCallback(async () => {
    const durations = [];
    let drops = 0;

    for (let index = 0; index < RTT_PINGS; index += 1) {
      const start = performance.now();
      try {
        const response = await fetch(`${LATENCY_URL}&cacheBust=${Math.random()}`, {
          cache: 'no-store',
        });
        await response.arrayBuffer();
        durations.push(performance.now() - start);
      } catch {
        drops += 1;
      }
      await sleep(120);
    }

    const average = durations.reduce((acc, value) => acc + value, 0) / Math.max(1, durations.length);
    const jitter = durations.length > 1 ? stddev(durations) : 0;
    const loss = (drops / (drops + durations.length)) * 100;

    return {
      avg: average,
      jit: jitter,
      loss,
      count: durations.length,
    };
  }, []);

  const startTests = useCallback(async () => {
    if (runningRef.current) return;

    runningRef.current = true;
    setIsRunning(true);

    setDlBps(null);
    setUlBps(null);
    setLatencyMs(null);
    setJitterMs(null);
    setLossPct(null);
    setSamples({ dl: 0, ul: 0, rtt: 0 });

    const download = await measureDownload();
    if (!runningRef.current) return;
    setDlBps(download.bps);
    setSamples((previous) => ({ ...previous, dl: download.count }));

    const upload = await measureUpload();
    if (!runningRef.current) return;
    setUlBps(upload.bps);
    setSamples((previous) => ({ ...previous, ul: upload.count }));

    const latency = await measureLatency();
    if (!runningRef.current) return;
    setLatencyMs(latency.avg);
    setJitterMs(latency.jit);
    setLossPct(latency.loss);
    setSamples((previous) => ({ ...previous, rtt: latency.count }));

    runningRef.current = false;
    setIsRunning(false);
  }, [measureDownload, measureUpload, measureLatency]);

  const stopTests = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    resetAborters();
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

  return (
    <div className="min-h-screen bg-white text-black dark:bg-black dark:text-white pb-24 transition-colors">
      <div className="max-w-xl mx-auto p-3">
        <section className="rounded-2xl p-3 shadow-sm bg-gray-100 dark:bg-[#111]">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">Speed Test</h2>
            <span className="text-[11px] text-gray-500">DL/UL ~8s/5s + RTT</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-gray-200 p-2 text-center dark:bg-[#1a1a1a]">
              <div className="text-xs text-gray-600 dark:text-gray-300">Download</div>
              <div className="text-lg font-semibold">{dlBps == null ? '—' : fmtMbps(dlBps)}</div>
            </div>
            <div className="rounded-xl bg-gray-200 p-2 text-center dark:bg-[#1a1a1a]">
              <div className="text-xs text-gray-600 dark:text-gray-300">Upload</div>
              <div className="text-lg font-semibold">{ulBps == null ? '—' : fmtMbps(ulBps)}</div>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg bg-gray-200 p-2 dark:bg-[#1a1a1a]">
              <div className="text-[11px] text-gray-600 dark:text-gray-300">Latency</div>
              <div className="text-base font-semibold">
                {latencyMs == null ? '—' : `${latencyMs.toFixed(0)} ms`}
              </div>
            </div>
            <div className="rounded-lg bg-gray-200 p-2 dark:bg-[#1a1a1a]">
              <div className="text-[11px] text-gray-600 dark:text-gray-300">Jitter</div>
              <div className="text-base font-semibold">
                {jitterMs == null ? '—' : `${jitterMs.toFixed(0)} ms`}
              </div>
            </div>
            <div className="rounded-lg bg-gray-200 p-2 dark:bg-[#1a1a1a]">
              <div className="text-[11px] text-gray-600 dark:text-gray-300">Loss</div>
              <div className="text-base font-semibold">
                {lossPct == null ? '—' : `${lossPct.toFixed(1)} %`}
              </div>
            </div>
            <div className="rounded-lg bg-gray-200 p-2 dark:bg-[#1a1a1a]">
              <div className="text-[11px] text-gray-600 dark:text-gray-300">Samples</div>
              <div className="text-base font-semibold">
                {samples.dl || samples.ul || samples.rtt ? `${samples.dl}/${samples.ul}/${samples.rtt}` : '—'}
              </div>
            </div>
          </div>
        </section>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <section className="rounded-2xl bg-gray-100 p-3 dark:bg-[#111]">
            <h3 className="mb-1 text-sm font-semibold">Network</h3>
            <div className="space-y-0.5 text-xs">
              <div>
                <span className="font-medium">Type:</span> {netInfo.effectiveType}
              </div>
              <div>
                <span className="font-medium">Downlink:</span> {netInfo.downlink}
              </div>
              <div>
                <span className="font-medium">RTT:</span> {netInfo.rtt}
              </div>
            </div>
          </section>
          <section className="rounded-2xl bg-gray-100 p-3 dark:bg-[#111]">
            <h3 className="mb-1 text-sm font-semibold">IP &amp; Location</h3>
            <div className="space-y-0.5 text-xs">
              <div>
                <span className="font-medium">IP:</span> {ipInfo.ip}
              </div>
              <div>
                <span className="font-medium">City:</span> {ipInfo.city}
              </div>
              <div>
                <span className="font-medium">Region:</span> {ipInfo.region}
              </div>
              <div>
                <span className="font-medium">Country:</span> {ipInfo.country}
              </div>
              <div>
                <span className="font-medium">ISP:</span> {ipInfo.org}
              </div>
            </div>
          </section>
        </div>

        <section className="mt-2 rounded-2xl bg-gray-100 p-3 dark:bg-[#111]">
          <h3 className="mb-1 text-sm font-semibold">Can I…?</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {caps.length === 0 && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                Run the test for recommendations.
              </p>
            )}
            {caps.map((capability) => (
              <div
                key={capability.key}
                className="flex items-center gap-2 rounded-lg border border-gray-300 p-2 dark:border-[#222]"
              >
                <span className="text-base">{capability.ok ? '✅' : '❌'}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{capability.key}</div>
                  <div className="truncate text-[11px] text-gray-600 dark:text-gray-400">
                    {capability.why}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white dark:border-[#222] dark:bg-black">
        <div className="mx-auto max-w-xl px-3 pb-6">
          <button
            type="button"
            onClick={isRunning ? stopTests : startTests}
            className={`my-2 w-full rounded-2xl py-4 text-lg font-semibold shadow-lg transition active:scale-95 ${
              isRunning ? 'bg-red-600 text-white' : 'bg-indigo-600 text-white'
            }`}
          >
            {isRunning ? 'Stop' : 'Run test'}
          </button>
        </div>
      </div>
    </div>
  );
}
