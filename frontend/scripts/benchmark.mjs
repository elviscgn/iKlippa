import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..');
const APP_URL = process.env.IKLIPPA_BENCHMARK_URL || 'http://localhost:8080/';
const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAYBACK_MS = Number(process.env.IKLIPPA_BENCHMARK_PLAYBACK_MS || 12_000);
const READY_TIMEOUT_MS = 45_000;

const profiles = [
  { name: 'baseline', cpuSlowdown: 1, port: 9331 },
  { name: 'constrained-cpu', cpuSlowdown: 4, port: 9332 },
];

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome DevTools connection timed out.')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Chrome DevTools connection failed.'));
      });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerReady() {
  try {
    const response = await fetch(APP_URL, { redirect: 'manual' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady()) return;
    await wait(250);
  }
  throw new Error(`Vite did not become ready at ${APP_URL}.`);
}

async function startViteIfNeeded() {
  if (await isServerReady()) return null;
  const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
    cwd: FRONTEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  try {
    await waitForServer();
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n${output.trim()}`);
  }
  return child;
}

async function waitForChrome(port, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await wait(100);
  }
  throw new Error(`Chrome DevTools did not open on port ${port}.`);
}

async function createTarget(port) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`Could not create a Chrome target (${response.status}).`);
  return response.json();
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'Browser evaluation failed.');
  }
  return response.result?.value;
}

async function waitForExpression(cdp, expression, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(cdp, expression)) return;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function setupScript() {
  const setup = {
    version: 1,
    script: 'I am creating a fast-paced rugby highlights video for South Africa versus Wales.',
    brandName: 'iKlippa Benchmark',
    guidelines: 'Cinematic, direct, clean captions, fast pacing.',
    paletteId: 'township-teal',
    primaryColor: '#0d9488',
    accentHover: '#14b8a6',
    accentGlow: 'rgba(13,148,136,0.22)',
    captionFont: 'Plus Jakarta Sans',
    keywords: ['rugby', 'highlights', 'south', 'africa', 'wales'],
    tone: 'Bold and direct',
    pacing: 'Fast, punchy cuts',
    createdAt: Date.now(),
  };
  return `
    (() => {
      localStorage.setItem('iklippa.project-setup.v1', ${JSON.stringify(JSON.stringify(setup))});
      localStorage.removeItem('iklippa-project');
      window.__iklippaBenchmarkNavigationStart = performance.now();
    })();
  `;
}

async function runProfile(profile) {
  const profileDir = await mkdtemp(path.join(tmpdir(), `iklippa-${profile.name}-`));
  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${profile.port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForChrome(profile.port);
    const target = await createTarget(profile.port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();

    const browserErrors = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      browserErrors.push(exceptionDetails?.exception?.description || exceptionDetails?.text || 'Unknown error');
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry?.level === 'error') browserErrors.push(entry.text);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: setupScript() });
    await cdp.send('Page.navigate', { url: APP_URL });

    await waitForExpression(
      cdp,
      `document.readyState === 'complete'`,
      READY_TIMEOUT_MS,
      'the page load',
    );
    try {
      await waitForExpression(
        cdp,
        `Boolean(
          window.IKState?.isReady?.() &&
          window.mediaPool?.footage?.some?.((item) => item.isReal) &&
          typeof window.iklippaPerfSnapshot === 'function' &&
          typeof window.iklippaPerfReset === 'function'
        )`,
        READY_TIMEOUT_MS,
        'the editor and bundled video',
      );
    } catch (error) {
      const diagnostic = await evaluate(cdp, `(() => ({
        readyState: document.readyState,
        bodyClass: document.body.className,
        statePresent: Boolean(window.IKState),
        projectReady: Boolean(window.IKState?.isReady?.()),
        videoClipCount: window.IKState?.getVideoClips?.().length || 0,
        perfHookPresent: typeof window.iklippaPerfSnapshot === 'function',
        status: document.querySelector('.status-badge')?.textContent?.trim() || null,
      }))()`);
      throw new Error(
        `${error.message}\nDiagnostic: ${JSON.stringify(diagnostic)}\nBrowser errors: ${JSON.stringify(browserErrors.slice(0, 5))}`,
      );
    }

    await evaluate(cdp, `(() => {
      if (window.IKState.getVideoClips().length > 0) return true;
      const source = window.mediaPool.footage.find((item) => item.isReal);
      if (!source) throw new Error('The benchmark source was not imported.');
      const durationSec = Number.parseFloat(source.dur) || 36;
      const clip = window.IKState.addVideoClip(
        source.id,
        0,
        Math.round(durationSec * 1_000_000),
        { name: source.name, isReal: true, width: source.width, height: source.height },
      );
      if (!clip) throw new Error('The benchmark clip could not be added to the timeline.');
      window.calculateTimelineDuration();
      window.renderRuler();
      window.renderClips();
      return true;
    })()`);

    const startup = await evaluate(cdp, `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      return {
        editorReadyMs: Number((performance.now() - window.__iklippaBenchmarkNavigationStart).toFixed(1)),
        domContentLoadedMs: Number((nav.domContentLoadedEventEnd).toFixed(1)),
        loadEventMs: Number((nav.loadEventEnd).toFixed(1)),
        requestCount: resources.length,
        transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
        decodedBytes: resources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
      };
    })()`);

    await evaluate(cdp, `(() => {
      window.S.time = 0;
      window.onPlayheadScrub?.(0, true);
      return true;
    })()`);
    await wait(1_000);
    await evaluate(cdp, `window.iklippaPerfReset(); window.togglePlay(); true`);
    await wait(PLAYBACK_MS);

    const playback = await evaluate(cdp, `(() => {
      if (window.S.playing) window.togglePlay();
      return {
        timelineAdvanceSec: Number(window.S.time.toFixed(2)),
        metrics: window.iklippaPerfSnapshot(),
      };
    })()`);

    const environment = await evaluate(cdp, `(() => {
      const project = window.IKState.getProject?.();
      const canvas = document.querySelector('#canvas-img');
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGb: navigator.deviceMemory || null,
        crossOriginIsolated,
        projectResolution: project ? project.width + 'x' + project.height : null,
        projectDurationSec: window.IKState.getDurationSec?.() || null,
        canvasResolution: canvas ? canvas.width + 'x' + canvas.height : null,
        videoClipCount: window.IKState.getVideoClips?.().length || 0,
      };
    })()`);

    const performanceMetrics = await cdp.send('Performance.getMetrics');
    const metricsMap = Object.fromEntries(
      performanceMetrics.metrics.map(({ name, value }) => [name, value]),
    );

    return {
      profile: profile.name,
      cpuSlowdown: profile.cpuSlowdown,
      playbackWindowMs: PLAYBACK_MS,
      startup,
      playback,
      environment,
      process: {
        taskDurationSec: Number((metricsMap.TaskDuration || 0).toFixed(3)),
        jsHeapUsedMb: Number(((metricsMap.JSHeapUsedSize || 0) / 1_048_576).toFixed(1)),
        jsHeapTotalMb: Number(((metricsMap.JSHeapTotalSize || 0) / 1_048_576).toFixed(1)),
      },
      browserErrorCount: browserErrors.length,
      browserErrors: browserErrors.slice(0, 5),
    };
  } finally {
    cdp?.close();
    chrome.kill('SIGTERM');
    await wait(300);
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  const vite = await startViteIfNeeded();
  const startedAt = new Date().toISOString();
  try {
    const results = [];
    for (const profile of profiles) {
      results.push(await runProfile(profile));
    }
    console.log(JSON.stringify({
      benchmark: 'iKlippa editor playback',
      startedAt,
      appUrl: APP_URL,
      media: 'frontend/test.mp4',
      methodology: {
        browser: 'Installed Google Chrome, headless mode',
        baseline: 'No CPU slowdown',
        constrained: 'Chrome DevTools 4x CPU slowdown',
        note: 'CPU slowdown is a repeatable constraint, not a full emulation of low RAM, storage, GPU, or hardware video decoding.',
      },
      results,
    }, null, 2));
  } finally {
    vite?.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
