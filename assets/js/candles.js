/**
 * Smooth Candlestick Ticker (no libraries)
 * - Fixed y-scale (no reflow), min/max per-step randomness, bounce at bounds
 * - Stable start (waits for size to settle), debounced ResizeObserver
 * - Fixed timestep physics; offscreen grid for cheap redraws
 */
(function () {
    const canvas = document.getElementById('tape');
    if (!canvas) return;
    const ctx = canvas.getContext('2d', {alpha: true});

    // ------- CONFIG -------
    const PRICE_MIN = 88;
    const PRICE_MAX = 112;
    const START_PRICE = 100;
    const BAR_W = 6;         // candle body width (px)
    const GAP = 3;         // gap between candles (px)
    const STEP = BAR_W + GAP; // pixels per candle
    const SPEED = 28;        // px/sec horizontal scroll
    const PAD = 10;        // inner padding (px)
    const SERIES_INIT = 200; // initial bars
    const SERIES_MAX = 260; // keep this many max

    const MIN_MOVE = 0.25;   // min absolute move per bar
    const MAX_MOVE = 1.4;    // max absolute move per bar
    const DRIFT = 0.01;  // tiny drift up bias (feel free to set 0)

    const COLORS = {up: '#1f4b99', down: '#ffffff', wick: '#cfd2d7', grid: '#2b2d34'};

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ------- SIZE / DPR -------
    let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const dprFreezeUntil = performance.now() + 1500; // ignore DPR changes for 1.5s (startup stability)

    let cssW = 0, cssH = 0;   // CSS px (logical)
    let pxW = 0, pxH = 0;    // canvas size in CSS px (after scaling)
    let needsResize = true;

    // Offscreen grid cache
    let gridCanvas = null, gridCtx = null;

    function buildGrid(w, h) {
        gridCanvas = document.createElement('canvas');
        gridCtx = gridCanvas.getContext('2d');
        gridCanvas.width = Math.max(1, Math.floor(w * dpr));
        gridCanvas.height = Math.max(1, Math.floor(h * dpr));
        gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        gridCtx.clearRect(0, 0, w, h);
        gridCtx.globalAlpha = 0.22;
        gridCtx.strokeStyle = COLORS.grid;
        for (let gy = 0; gy <= 4; gy++) {
            const y = Math.round((h / 4) * gy) + 0.5;
            gridCtx.beginPath();
            gridCtx.moveTo(0, y);
            gridCtx.lineTo(w, y);
            gridCtx.stroke();
        }
        gridCtx.globalAlpha = 1;
    }

    function applySizeNow() {
        const now = performance.now();
        const live = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        if (now > dprFreezeUntil && live !== dpr) dpr = live;

        const wantW = Math.max(1, Math.floor(cssW * dpr));
        const wantH = Math.max(1, Math.floor(cssH * dpr));
        if (canvas.width !== wantW || canvas.height !== wantH) {
            canvas.width = wantW;
            canvas.height = wantH;
            pxW = Math.floor(canvas.width / dpr);
            pxH = Math.floor(canvas.height / dpr);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
            buildGrid(pxW, pxH);
            // Re-align latest candles to be visible on first frame
            if (!offsetInitialized && pxW > 0) {
                initOffsetToLatest();
                offsetInitialized = true;
            }
        }
    }

    const ro = new ResizeObserver(entries => {
        const cr = entries[0].contentRect;
        cssW = Math.max(1, cr.width);
        cssH = Math.max(1, cr.height);
        needsResize = true;
    });
    ro.observe(canvas);

    // Fallback initial size
    queueMicrotask(() => {
        if (!cssW || !cssH) {
            const r = canvas.getBoundingClientRect();
            cssW = Math.max(1, r.width || canvas.clientWidth || canvas.offsetWidth || 600);
            cssH = Math.max(1, r.height || canvas.clientHeight || canvas.offsetHeight || 320);
            needsResize = true;
        }
    });

    // ------- PRICE SERIES -------
    const series = [];

    function randBetween(a, b) {
        return a + Math.random() * (b - a);
    }

    function nextClose(prev) {
        // pick a random step with min/max magnitude, random sign, plus tiny drift
        let mag = randBetween(MIN_MOVE, MAX_MOVE);
        let sign = Math.random() < 0.5 ? -1 : 1;
        let proposed = prev + sign * mag + DRIFT;

        // bounce at bounds (push back inside with some vigor)
        if (proposed < PRICE_MIN) {
            proposed = Math.min(PRICE_MIN + randBetween(0.2, 1.2), prev + Math.abs(mag));
        } else if (proposed > PRICE_MAX) {
            proposed = Math.max(PRICE_MAX - randBetween(0.2, 1.2), prev - Math.abs(mag));
        }
        return proposed;
    }

    function makeBar(prev) {
        const close = nextClose(prev);
        const open = prev;
        const high = Math.max(open, close) + randBetween(0.0, 0.9);
        const low = Math.min(open, close) - randBetween(0.0, 0.9);
        return {open, high, low, close};
    }

    // Seed initial series
    let last = START_PRICE;
    for (let i = 0; i < SERIES_INIT; i++) {
        const b = makeBar(last);
        series.push(b);
        last = b.close;
    }

    // ------- SCROLL STATE -------
    let offset = 0; // how many px we’ve scrolled into the series
    function initOffsetToLatest() {
        // make the newest bar visible on first render
        const viewport = Math.max(0, pxW - 2 * PAD);
        const totalW = series.length * STEP;
        if (totalW <= viewport) {
            offset = 0;
            return;
        }
        // align so last bar is inside viewport; keep offset < STEP for natural loop
        const needed = totalW - viewport;
        offset = needed % STEP;
    }

    let offsetInitialized = false;

    // ------- TIMING -------
    const TICK = 1 / 60; // 60Hz logic
    let acc = 0, lastTime = 0;
    let started = false, sizeStableFrames = 0, lastCssW = 0, lastCssH = 0;

    function update(dt) {
        offset += SPEED * dt;
        while (offset >= STEP) {
            offset -= STEP;
            const b = makeBar(series[series.length - 1].close);
            series.push(b);
            if (series.length > SERIES_MAX) series.shift();
        }
    }

    function draw() {
        if (!pxW || !pxH) return;

        // grid
        if (gridCanvas) ctx.drawImage(gridCanvas, 0, 0, pxW, pxH);

        const w = pxW, h = pxH;
        const y = v => h - PAD - ((v - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * (h - 2 * PAD);

        let x = PAD - offset;

        for (let i = 0; i < series.length; i++) {
            const b = series[i];
            if (x > w - PAD) break;
            if (x + BAR_W < 0) {
                x += STEP;
                continue;
            }

            // wick
            ctx.strokeStyle = COLORS.wick;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + BAR_W / 2, y(b.high));
            ctx.lineTo(x + BAR_W / 2, y(b.low));
            ctx.stroke();

            // body
            const top = y(Math.max(b.open, b.close));
            const bot = y(Math.min(b.open, b.close));
            ctx.fillStyle = (b.close >= b.open) ? COLORS.up : COLORS.down;
            ctx.fillRect(x, top, BAR_W, Math.max(1, bot - top));

            x += STEP;
        }
    }

    function frame(ts) {
        if (needsResize) {
            applySizeNow();
            needsResize = false;
        }

        // wait for 2 stable frames of size (avoids startup judder)
        if (cssW === lastCssW && cssH === lastCssH) sizeStableFrames++;
        else {
            sizeStableFrames = 0;
            lastCssW = cssW;
            lastCssH = cssH;
        }
        if (!started && sizeStableFrames >= 2) {
            started = true;
            lastTime = ts;
        }

        if (started && !prefersReduced) {
            let dt = (ts - lastTime) / 1000;
            lastTime = ts;
            if (dt > 0.25) dt = 0.25;
            acc += dt;
            while (acc >= TICK) {
                update(TICK);
                acc -= TICK;
            }
        }

        // clear and draw
        if (pxW && pxH) {
            ctx.clearRect(0, 0, pxW, pxH);
            draw();
        }

        requestAnimationFrame(frame);
    }

    // Start after load (lets fonts/images settle), or immediately in DOMContent if very light page
    const start = () => requestAnimationFrame(frame);
    if ('requestIdleCallback' in window) requestIdleCallback(start, {timeout: 800});
    else if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, {once: true});

    // Visibility: avoid huge dt spikes on return
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') lastTime = 0;
    });

    // Reduced motion: render one static frame only
    if (prefersReduced) {
        // ensure size, then draw once
        const once = () => {
            if (needsResize) {
                applySizeNow();
                needsResize = false;
            }
            ctx.clearRect(0, 0, pxW, pxH);
            draw();
        };
        if (document.readyState === 'complete') once();
        else window.addEventListener('load', once, {once: true});
    }
})();
