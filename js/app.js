let currentInterval = '1h';
        /** Siempre 150 velas japonesas para cálculos, indicadores y proyecciones */
        const CANDLE_LIMIT = 150;
        /** Par activo (debe existir en Binance + Bybit + OKX spot USDT) */
        let currentSymbol = 'BTCUSDT'; // Binance/Bybit format
        function okxInstId(sym) {
            // BTCUSDT → BTC-USDT
            if (!sym) return 'BTC-USDT';
            if (sym.includes('-')) return sym;
            if (sym.endsWith('USDT')) return sym.slice(0, -4) + '-USDT';
            return sym;
        }
        function baseAsset(sym) {
            return (sym || 'BTCUSDT').replace(/USDT$/i, '').replace(/-/g, '');
        }
        const CUSTOM_TF_MINUTES = { "9m": 9, "20m": 20 };
        const BYBIT_INTERVAL_MAP = {
            "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
            "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
            "1d": "D", "1w": "W", "1M": "M"
        };
        let fetchGeneration = 0;
        let rawKlines = [];
        let candlestickSeries = null;
        let lineSeriesMain = null;
        let areaSeriesMain = null;
        let volumeSeries = null;
        let ema50Series = null; // SMMA 50
        let smma20Series = null; // SMMA 20
        let supertrendSeries = null; // Yoshi SuperTrend (compat)
        let supertrendUpSeries = null;
        let supertrendDnSeries = null;
        let yoshiObPriceLines = []; // price lines for OB zones
        let yoshiLatest = {
            trend: 0, stValue: 0, structure: 'Neutral',
            bos: 'none', eq: 'none', state: 0, signal: 'NONE',
            entry: null, sl: null, tp1: null, tp2: null, tp3: null
        };
        let mainChart = null;
        let trendiloChart = null;
        let trendiloHistSeries = null;
        let trendiloAlmaSeries = null;
        let trendiloRmsUpper = null;
        let trendiloRmsLower = null;
        let trendiloZeroSeries = null;
        let stochKSeries = null;
        let stochDSeries = null;
        let chartType = 'candle'; // candle | heikin | line | area
        let volumeVisible = true;
        let ema50Visible = true;
        let hlineToolActive = false;
        let userPriceLines = [];
        let syncingTimeScale = false;
        let tradeSide = 'LONG';
        let journalHistory = [];
        let currentPendingTrade = null;
        let lastConfirmedTrade = null;
        let chartPriceLines = [];
        const LS_JOURNAL = 'terminalmx_journal';
        const LS_LAST_TRADE = 'terminalmx_last_trade';
        const LS_CHART_PREFS = 'terminalmx_chart_prefs';

        function loadJournalFromStorage() {
            try {
                const raw = localStorage.getItem(LS_JOURNAL);
                if (raw) journalHistory = JSON.parse(raw) || [];
                const last = localStorage.getItem(LS_LAST_TRADE);
                if (last) lastConfirmedTrade = JSON.parse(last);
            } catch (e) {
                console.warn('localStorage journal:', e);
                journalHistory = [];
            }
        }

        function saveJournalToStorage() {
            try {
                localStorage.setItem(LS_JOURNAL, JSON.stringify(journalHistory.slice(0, 200)));
                if (lastConfirmedTrade) {
                    localStorage.setItem(LS_LAST_TRADE, JSON.stringify(lastConfirmedTrade));
                }
            } catch (e) {
                console.warn('localStorage save:', e);
            }
        }

        function loadChartPrefs() {
            try {
                const p = JSON.parse(localStorage.getItem(LS_CHART_PREFS) || '{}');
                return {
                    mainVisible: p.mainVisible !== false,
                    subVisible: p.subVisible !== false,
                    mainFlex: p.mainFlex || 2,
                    subFlex: p.subFlex || 1
                };
            } catch (e) {
                return { mainVisible: true, subVisible: true, mainFlex: 2, subFlex: 1 };
            }
        }

        function saveChartPrefs(partial) {
            try {
                const cur = loadChartPrefs();
                const next = { ...cur, ...partial };
                localStorage.setItem(LS_CHART_PREFS, JSON.stringify(next));
            } catch (e) {}
        }

        // Technical Analysis Variables
        let calculatedPivots = { supports: [], resistances: [] };
        let volumeProfileData = { poc: 0, vah: 0, val: 0, profile: [] };
        let trendiloLatest = { value: 0, direction: 'Neutral', zScore: 0 };
        let stochRsiLatest = { k: 0, d: 0 };
        let dmiLatest = { pDI: 0, nDI: 0, diSpread: 0, direction: 'Neutral', trendStrength: 'Neutral' };
        let lsrLatest = 1.0;
        let wyckoffLatest = {
            phase: 'Neutral', signal: 'NONE', imbalance: 0,
            bidVol: 0, askVol: 0, bias: 'Neutral',
            walls: { bid: null, ask: null },
            exchanges: {}, desc: 'Cargando order books...', count: 0
        };

        // ========== SETUP ÓPTIMO: TF superior guía todo (proyección + indicadores por P(acierto)) ==========
        // Orden = mayor probabilidad de acierto relativa por temporalidad (pesos normalizados ~100)
        // El TF del header es la fuente de verdad: proyección, filtros, confluencia y modal usan este mapa.
        const OPTIMAL_SETUP_BY_TF = {
            '1m':  { profile: 'scalp',    horizon: '1m',  order: [['stoch',28],['yoshi',24],['wyckoff',22],['sr',16],['trendilo',6],['dmi',4]] },
            '3m':  { profile: 'scalp',    horizon: '3m',  order: [['stoch',26],['yoshi',24],['wyckoff',22],['sr',16],['trendilo',7],['dmi',5]] },
            '5m':  { profile: 'scalp',    horizon: '5m',  order: [['stoch',24],['yoshi',24],['wyckoff',22],['sr',16],['trendilo',8],['dmi',6]] },
            '9m':  { profile: 'scalp',    horizon: '9m',  order: [['yoshi',24],['stoch',22],['wyckoff',22],['sr',16],['trendilo',10],['dmi',6]] },
            '15m': { profile: 'intraday', horizon: '20m', order: [['yoshi',22],['wyckoff',20],['stoch',18],['trendilo',16],['dmi',12],['sr',12]] },
            '20m': { profile: 'intraday', horizon: '20m', order: [['yoshi',22],['wyckoff',20],['trendilo',18],['stoch',16],['dmi',12],['sr',12]] },
            '1h':  { profile: 'intraday', horizon: '1h',  order: [['yoshi',22],['trendilo',20],['dmi',18],['wyckoff',16],['sr',14],['stoch',10]] },
            '4h':  { profile: 'swing',    horizon: '4h',  order: [['yoshi',24],['trendilo',22],['dmi',20],['wyckoff',14],['sr',14],['stoch',6]] },
            '1d':  { profile: 'swing',    horizon: '1d',  order: [['trendilo',24],['yoshi',22],['dmi',20],['sr',16],['wyckoff',12],['stoch',6]] },
            '1w':  { profile: 'swing',    horizon: '1d',  order: [['trendilo',26],['yoshi',22],['dmi',20],['sr',16],['wyckoff',10],['stoch',6]] }
        };
        // Activos por defecto: top indicadores con peso >= 12 (resto opcionales)
        const OPTIMAL_ACTIVE_WEIGHT_MIN = 12;

        const INDICATOR_PRESETS = {
            scalp: {
                trendilo: false, stoch: true, dmi: false, yoshi: true, wyckoff: true, sr: true,
                label: 'Scalp (óptimo TF bajos)',
                hint: 'Setup óptimo scalp: StochRSI + Yoshi + Wyckoff + S/R (mayor P(acierto) en 1m–9m).'
            },
            intradaily: {
                trendilo: true, stoch: true, dmi: true, yoshi: true, wyckoff: true, sr: true,
                label: 'Intradía (óptimo 15m–1h)',
                hint: 'Setup óptimo intradía: Yoshi + Wyckoff + Trendilo + Stoch + DMI + S/R.'
            },
            intraday: {
                trendilo: true, stoch: true, dmi: true, yoshi: true, wyckoff: true, sr: true,
                label: 'Intradía (óptimo 15m–1h)',
                hint: 'Setup óptimo intradía: Yoshi + Wyckoff + Trendilo + Stoch + DMI + S/R.'
            },
            swing: {
                trendilo: true, stoch: false, dmi: true, yoshi: true, wyckoff: true, sr: true,
                label: 'Swing (óptimo 4h–1D)',
                hint: 'Setup óptimo swing: Trendilo + Yoshi + DMI + S/R + Wyckoff (Stoch menos fiable en TF altos).'
            },
            all: {
                trendilo: true, stoch: true, dmi: true, yoshi: true, wyckoff: true, sr: true,
                label: 'Todos',
                hint: 'Todos activos (sin priorizar por P(acierto)).'
            },
            optimal: {
                // se rellena dinámicamente desde OPTIMAL_SETUP_BY_TF
                trendilo: true, stoch: true, dmi: true, yoshi: true, wyckoff: true, sr: true,
                label: 'Óptimo (TF actual)',
                hint: 'Indicadores ordenados por mayor probabilidad de acierto según el TF del gráfico.'
            }
        };
        let activeIndicatorFilters = {
            trendilo: true, stoch: true, dmi: true, yoshi: true, wyckoff: true, sr: true
        };
        let currentFilterPreset = 'optimal';
        let indicatorWeightMap = { trendilo: 1, stoch: 1, dmi: 1, yoshi: 1, wyckoff: 1, sr: 1 };
        let userLockedFilters = false; // true si el usuario tocó toggles manualmente

        function getOptimalSetup(tf) {
            const t = String(tf || currentInterval || '1h');
            return OPTIMAL_SETUP_BY_TF[t] || OPTIMAL_SETUP_BY_TF['1h'];
        }

        function getIndicatorWeight(key) {
            return indicatorWeightMap[key] != null ? indicatorWeightMap[key] : 1;
        }

        function isIndActive(key) {
            return activeIndicatorFilters[key] !== false;
        }

        /** Aplica setup óptimo del TF del header: pesos, filtros, horizonte de proyección */
        function applyOptimalSetupForTf(tf, opts) {
            opts = opts || {};
            const setup = getOptimalSetup(tf);
            const force = !!opts.force; // ignorar lock de usuario
            // Pesos siempre se actualizan (guían proyección/confluencia)
            indicatorWeightMap = {};
            (setup.order || []).forEach(([k, w]) => { indicatorWeightMap[k] = w / 100; });

            // Horizonte de proyección = TF superior (o mapeo del setup)
            try {
                if (typeof setProjectionHorizon === 'function' && setup.horizon) {
                    setProjectionHorizon(setup.horizon);
                }
            } catch (e) {}

            // Filtros: solo si no hay lock personalizado o force
            if (!userLockedFilters || force) {
                const filters = { trendilo: false, stoch: false, dmi: false, yoshi: false, wyckoff: false, sr: false };
                (setup.order || []).forEach(([k, w]) => {
                    filters[k] = w >= OPTIMAL_ACTIVE_WEIGHT_MIN;
                });
                activeIndicatorFilters = filters;
                currentFilterPreset = 'optimal';
                const map = {
                    trendilo: 'filtTrendilo', stoch: 'filtStoch', dmi: 'filtDmi',
                    yoshi: 'filtYoshi', wyckoff: 'filtWyckoff', sr: 'filtSR'
                };
                Object.keys(map).forEach(k => {
                    const el = document.getElementById(map[k]);
                    if (el) el.checked = !!activeIndicatorFilters[k];
                });
                document.querySelectorAll('.preset-btn').forEach(btn => {
                    btn.classList.remove('border-accentYellow/50', 'bg-accentYellow/15', 'text-accentYellow');
                    btn.classList.add('border-borderBg', 'bg-panelBg', 'text-slate-300');
                });
                const modeEl = document.getElementById('filterModeLabel');
                if (modeEl) modeEl.innerText = `Óptimo ${tf || currentInterval}`;
                updateOptimalRankUI(setup, tf);
            } else {
                updateOptimalRankUI(setup, tf);
            }
            return setup;
        }
        window.applyOptimalSetupForTf = applyOptimalSetupForTf;

        function updateOptimalRankUI(setup, tf) {
            const hintEl = document.getElementById('filterHint');
            const rankEl = document.getElementById('optimalRankList');
            const order = (setup && setup.order) || getOptimalSetup(tf).order || [];
            const lines = order.map(([k, w], i) => {
                const names = { trendilo: 'Trendilo', stoch: 'StochRSI', dmi: 'DMI', yoshi: 'Yoshi', wyckoff: 'Wyckoff OB', sr: 'S/R+POC' };
                const on = isIndActive(k);
                return `${i + 1}. ${names[k] || k} ${w}%${on ? '' : ' (off)'}`;
            });
            if (hintEl) {
                hintEl.innerHTML = `<span class="text-accentYellow">TF ${tf || currentInterval} guía proyección.</span> Orden por P(acierto): ${lines.slice(0, 4).join(' · ')}…`;
            }
            if (rankEl) {
                rankEl.innerHTML = order.map(([k, w], i) => {
                    const names = { trendilo: 'Trendilo', stoch: 'StochRSI', dmi: 'DMI', yoshi: 'Yoshi', wyckoff: 'Wyckoff', sr: 'S/R' };
                    const on = isIndActive(k);
                    const bar = Math.min(100, w * 3);
                    return `<div class="flex items-center gap-1.5 text-[10px]">
                        <span class="text-slate-500 w-3">${i + 1}</span>
                        <span class="flex-1 ${on ? 'text-slate-200' : 'text-slate-500 line-through'}">${names[k]}</span>
                        <span class="font-mono text-accentYellow w-8 text-right">${w}%</span>
                        <div class="w-12 h-1 rounded bg-borderBg overflow-hidden"><div class="h-full ${on ? 'bg-accentYellow' : 'bg-slate-600'}" style="width:${bar}%"></div></div>
                    </div>`;
                }).join('');
            }
        }

        function applyIndicatorPreset(name) {
            if (name === 'optimal') {
                userLockedFilters = false;
                applyOptimalSetupForTf(currentInterval, { force: true });
                recalculateWithFilters();
                return;
            }
            const p = INDICATOR_PRESETS[name] || INDICATOR_PRESETS.all;
            userLockedFilters = false;
            currentFilterPreset = name;
            activeIndicatorFilters = {
                trendilo: !!p.trendilo,
                stoch: !!p.stoch,
                dmi: !!p.dmi,
                yoshi: !!p.yoshi,
                wyckoff: !!p.wyckoff,
                sr: !!p.sr
            };
            // Mantener pesos del TF actual aunque el preset sea genérico
            try {
                const setup = getOptimalSetup(currentInterval);
                indicatorWeightMap = {};
                (setup.order || []).forEach(([k, w]) => { indicatorWeightMap[k] = w / 100; });
                updateOptimalRankUI(setup, currentInterval);
            } catch (e) {}
            // Sync checkboxes
            const map = {
                trendilo: 'filtTrendilo', stoch: 'filtStoch', dmi: 'filtDmi',
                yoshi: 'filtYoshi', wyckoff: 'filtWyckoff', sr: 'filtSR'
            };
            Object.keys(map).forEach(k => {
                const el = document.getElementById(map[k]);
                if (el) el.checked = !!activeIndicatorFilters[k];
            });
            // Highlight preset buttons
            document.querySelectorAll('.preset-btn').forEach(btn => {
                btn.classList.remove('border-accentYellow/50', 'bg-accentYellow/15', 'text-accentYellow');
                btn.classList.add('border-borderBg', 'bg-panelBg', 'text-slate-300');
            });
            const presetBtn = document.getElementById(
                name === 'scalp' ? 'presetScalp' : name === 'swing' ? 'presetSwing' : name === 'all' ? null : 'presetIntraday'
            );
            if (presetBtn) {
                presetBtn.classList.remove('border-borderBg', 'bg-panelBg', 'text-slate-300');
                presetBtn.classList.add('border-accentYellow/50', 'bg-accentYellow/15', 'text-accentYellow');
            }
            const modeEl = document.getElementById('filterModeLabel');
            if (modeEl) modeEl.innerText = p.label || name;
            const hintEl = document.getElementById('filterHint');
            if (hintEl) hintEl.innerText = p.hint || '';
            recalculateWithFilters();
        }
        window.applyIndicatorPreset = applyIndicatorPreset;

        function onIndicatorFilterChange() {
            userLockedFilters = true;
            currentFilterPreset = 'custom';
            activeIndicatorFilters = {
                trendilo: !!(document.getElementById('filtTrendilo') || {}).checked,
                stoch: !!(document.getElementById('filtStoch') || {}).checked,
                dmi: !!(document.getElementById('filtDmi') || {}).checked,
                yoshi: !!(document.getElementById('filtYoshi') || {}).checked,
                wyckoff: !!(document.getElementById('filtWyckoff') || {}).checked,
                sr: !!(document.getElementById('filtSR') || {}).checked
            };
            document.querySelectorAll('.preset-btn').forEach(btn => {
                btn.classList.remove('border-accentYellow/50', 'bg-accentYellow/15', 'text-accentYellow');
                btn.classList.add('border-borderBg', 'bg-panelBg', 'text-slate-300');
            });
            const modeEl = document.getElementById('filterModeLabel');
            if (modeEl) modeEl.innerText = 'Personalizado';
            const active = Object.keys(activeIndicatorFilters).filter(k => activeIndicatorFilters[k]);
            const hintEl = document.getElementById('filterHint');
            if (hintEl) hintEl.innerText = `Manual: ${active.length}/6 activos. El TF ${currentInterval} sigue guiando la proyección; pesos óptimos se mantienen.`;
            updateOptimalRankUI(getOptimalSetup(currentInterval), currentInterval);
            recalculateWithFilters();
        }
        window.onIndicatorFilterChange = onIndicatorFilterChange;

        function recalculateWithFilters() {
            try {
                if (typeof updateSignalsTable === 'function') updateSignalsTable();
            } catch (e) { console.warn('recalc signals', e); }
            try {
                if (typeof projectNextHourBias === 'function') projectNextHourBias();
            } catch (e) {}
            try {
                if (typeof projectWyckoffOrderBook === 'function' && isIndActive('wyckoff')) {
                    // no forzar fetch de nuevo; solo UI si ya hay datos
                }
            } catch (e) {}
            // Visual pulse on filter box
            const box = document.getElementById('indicatorFilterToggles');
            if (box) {
                box.classList.add('ring-1', 'ring-accentYellow/40');
                setTimeout(() => box.classList.remove('ring-1', 'ring-accentYellow/40'), 600);
            }
        }
        window.recalculateWithFilters = recalculateWithFilters;

        // Auto-sugerir preset según TF del gráfico
        function suggestFilterPresetForTf(tf) {
            const setup = getOptimalSetup(tf);
            return setup.profile || 'intraday';
        }

        function switchBottomTab(tab) {
            const map = {
                signals: { btn: 'tabBtnSignals', content: 'tabContentSignals' },
                journal: { btn: 'tabBtnJournal', content: 'tabContentJournal' },
                palacios: { btn: 'tabBtnPalacios', content: 'tabContentPalacios' },
                confluencias: { btn: 'tabBtnConfluencias', content: 'tabContentConfluencias' },
                trendiloProj: { btn: 'tabBtnTrendiloProj', content: 'tabContentTrendiloProj' },
                alts: { btn: 'tabBtnAlts', content: 'tabContentAlts' },
                orderblock: { btn: 'tabBtnOrderBlock', content: 'tabContentOrderBlock' },
                calendar: { btn: 'tabBtnCalendar', content: 'tabContentCalendar' }
            };
            if (!map[tab]) tab = 'signals';

            const inactive = 'font-medium px-2 sm:px-3 py-1.5 rounded-lg text-slate-400 hover:text-white flex items-center gap-1 sm:gap-1.5 transition whitespace-nowrap text-[10px] sm:text-xs';
            const active = 'font-bold px-2 sm:px-3 py-1.5 rounded-lg bg-accentYellow text-slate-950 flex items-center gap-1 sm:gap-1.5 transition whitespace-nowrap text-[10px] sm:text-xs';

            Object.keys(map).forEach(key => {
                const b = document.getElementById(map[key].btn);
                const c = document.getElementById(map[key].content);
                if (b) b.className = inactive;
                if (c) {
                    c.classList.add('hidden');
                    c.style.display = 'none';
                }
            });

            const statsHeader = document.getElementById('journalStatsHeader');
            const btStatsHeader = document.getElementById('backtestStatsHeader');
            if (statsHeader) { statsHeader.classList.add('hidden'); statsHeader.style.display = 'none'; }
            if (btStatsHeader) { btStatsHeader.classList.add('hidden'); btStatsHeader.style.display = 'none'; }

            const sel = map[tab];
            const btn = document.getElementById(sel.btn);
            const content = document.getElementById(sel.content);
            if (btn) btn.className = active;
            if (content) {
                content.classList.remove('hidden');
                content.style.display = 'flex';
                content.style.flexDirection = 'column';
                content.style.flex = '1 1 auto';
                content.style.minHeight = '0';
                content.style.overflow = 'auto';
            }

            if (tab === 'journal' && statsHeader) {
                statsHeader.classList.remove('hidden');
                statsHeader.style.display = 'flex';
            }
            if (tab === 'backtest' && btStatsHeader) {
                btStatsHeader.classList.remove('hidden');
                btStatsHeader.style.display = 'flex';
            }
            if (tab === 'projection') {
                try { projectNextHourBias(); } catch (e) {}
                try { projectWyckoffOrderBook(); } catch (e) {}
            }
            if (tab === 'signals') {
                try { if (typeof updateSignalsTable === 'function') updateSignalsTable(); } catch (e) {}
            }
            if (tab === 'calendar') {
                try { loadEconomicCalendar(false); } catch (e) {}
            }
            if (tab === 'alts') {
                try { loadAltsList(false); } catch (e) {}
            }
            if (tab === 'rankings') {
                // No auto-run (costoso); mostrar estado si ya hay cache
                try {
                    if (comboRankingsCache && comboRankingsCache.length) renderComboRankings(comboRankingsCache);
                } catch (e) {}
            }
            if (tab === 'palacios') {
                try { runPalaciosIndicator(false); } catch (e) {}
            }
            if (tab === 'confluencias') {
                try {
                    if (mejoresConfluenciasCache && (mejoresConfluenciasCache.scalp || mejoresConfluenciasCache.intraday)) {
                        renderMejoresConfluencias(mejoresConfluenciasCache);
                        if (confluenciasHorizonRecs) renderHorizonRecommendations(confluenciasHorizonRecs);
                    }
                    runMejoresConfluencias(false);
                    startConfluenciasAutoRefresh();
                } catch (e) {}
            }
            if (tab === 'trendiloProj') {
                try {
                    setTimeout(() => {
                        ensureTrendiloProjChart();
                        initTrendiloProjChartResize();
                        runTrendiloProjection(false);
                        try {
                            if (trendiloProjChart) {
                                const el = document.getElementById('trendiloProjChart');
                                if (el) trendiloProjChart.applyOptions({
                                    width: Math.max(el.clientWidth || 280, 260),
                                    height: Math.max(el.clientHeight || 200, 160)
                                });
                            }
                        } catch (e2) {}
                    }, 80);
                } catch (e) {}
            }
        }
        window.switchBottomTab = switchBottomTab;

        // ========== PROYECCIÓN TRENDILO ==========
        let trendiloProjTf = '1h';
        let trendiloProjChart = null;
        let tpAlmaSeries = null, tpRmsUp = null, tpRmsDn = null, tpZero = null, tpProjSeries = null;
        let trendiloProjLatest = { signal: 'NONE', alma: 0, rms: 0, proj: 0, conf: 0 };
        let trendiloProjRunning = false;
        let trendiloProjCacheAt = 0;

        function setTrendiloProjTf(tf) {
            trendiloProjTf = String(tf || '1h');
            document.querySelectorAll('.tptf-btn').forEach(btn => {
                const on = btn.getAttribute('data-tptf') === trendiloProjTf;
                btn.className = on
                    ? 'tptf-btn px-2 py-1 rounded text-[10px] font-mono border border-accentYellow/50 bg-accentYellow/15 text-accentYellow'
                    : 'tptf-btn px-2 py-1 rounded text-[10px] font-mono border border-borderBg text-slate-400 hover:text-white';
            });
            const lab = document.getElementById('tpTfLabel');
            if (lab) lab.innerText = trendiloProjTf;
            runTrendiloProjection(true);
        }
        window.setTrendiloProjTf = setTrendiloProjTf;

        function ensureTrendiloProjChart() {
            const el = document.getElementById('trendiloProjChart');
            if (!el || typeof LightweightCharts === 'undefined') return;
            if (trendiloProjChart) {
                try {
                    trendiloProjChart.applyOptions({
                        width: Math.max(el.clientWidth || 300, 280),
                        height: Math.max(el.clientHeight || 220, 200)
                    });
                } catch (e) {}
                return;
            }
            const w = Math.max(el.clientWidth || 400, 280);
            const h = Math.max(el.clientHeight || 240, 200);
            trendiloProjChart = LightweightCharts.createChart(el, {
                width: w,
                height: h,
                layout: { background: { color: '#000000' }, textColor: '#b2b5be', fontFamily: "'Inter', sans-serif" },
                grid: { vertLines: { color: 'rgba(42,46,57,0.45)' }, horzLines: { color: 'rgba(42,46,57,0.45)' } },
                rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
                timeScale: { borderVisible: false, timeVisible: true, rightOffset: 12, barSpacing: 6 },
                crosshair: {
                    vertLine: { color: 'rgba(178,181,190,0.35)', style: 2 },
                    horzLine: { color: 'rgba(178,181,190,0.35)', style: 2 }
                }
            });
            try {
                tpAlmaSeries = addChartSeries(trendiloProjChart, 'Baseline', {
                    baseValue: { type: 'price', price: 0 },
                    topLineColor: 'rgba(180,190,200,0.95)',
                    topFillColor1: 'rgba(38,166,154,0.45)',
                    topFillColor2: 'rgba(38,166,154,0.05)',
                    bottomLineColor: 'rgba(180,190,200,0.95)',
                    bottomFillColor1: 'rgba(255,152,0,0.08)',
                    bottomFillColor2: 'rgba(239,83,80,0.40)',
                    lineWidth: 2,
                    lastValueVisible: true,
                    priceLineVisible: false,
                    title: 'ALMA'
                });
            } catch (e) {
                tpAlmaSeries = addChartSeries(trendiloProjChart, 'Line', {
                    color: '#b0bec5', lineWidth: 2, lastValueVisible: true, title: 'ALMA'
                });
            }
            tpRmsUp = addChartSeries(trendiloProjChart, 'Line', {
                color: '#ab47bc', lineWidth: 2, lastValueVisible: true, priceLineVisible: false, title: '+RMS'
            });
            tpRmsDn = addChartSeries(trendiloProjChart, 'Line', {
                color: '#ab47bc', lineWidth: 2, lastValueVisible: true, priceLineVisible: false, title: '-RMS'
            });
            tpZero = addChartSeries(trendiloProjChart, 'Line', {
                color: 'rgba(145,155,155,0.5)', lineWidth: 1, lineStyle: 2,
                lastValueVisible: false, priceLineVisible: false
            });
            tpProjSeries = addChartSeries(trendiloProjChart, 'Line', {
                color: '#f0b90b', lineWidth: 2, lineStyle: 2,
                lastValueVisible: true, priceLineVisible: false, title: 'Proy.'
            });
        }


        /** TrendiloMX estrategia ratio ALMA/RMS */
        const TRENDILO_EXTREME = 0.85;
        const TRENDILO_BIAS = 0.50;

        function trendiloRatio(alma, rms) {
            const r = Math.abs(rms) < 1e-12 ? 0 : alma / rms;
            return r;
        }

        /**
         * Evalúa zona y señales Bounce/Reversal sobre series ALMA/RMS alineadas.
         * almaLine/rmsUp: arrays {time,value}
         */
        function evaluateTrendiloRatioStrategy(almaLine, rmsUp) {
            const markers = [];
            let last = {
                ratio: 0, zone: 'NONE', signal: 'NONE', conf: 40,
                extreme: false, slope: 0, alma: 0, rms: 0
            };
            if (!almaLine || !rmsUp || almaLine.length < 3) return { markers, last };

            for (let i = 0; i < almaLine.length; i++) {
                const alma = almaLine[i].value;
                const rms = Math.abs(rmsUp[i] ? rmsUp[i].value : 0);
                const ratio = trendiloRatio(alma, rms);
                const t = almaLine[i].time;
                const prev = i > 0 ? almaLine[i - 1].value : alma;
                const slope = alma - prev;
                const extreme = Math.abs(ratio) >= TRENDILO_EXTREME;

                // Círculo rojo en zona extrema
                if (extreme) {
                    markers.push({
                        time: t,
                        position: 'inBar',
                        color: '#f6465d',
                        shape: 'circle',
                        text: '',
                        size: 1.5
                    });
                }

                // Giro en zona extrema → Bounce / Reversal
                if (i >= 2) {
                    const a1 = almaLine[i - 1].value;
                    const a2 = almaLine[i - 2].value;
                    const wasDown = a1 < a2;
                    const wasUp = a1 > a2;
                    const ratioPrev = trendiloRatio(a1, Math.abs(rmsUp[i - 1] ? rmsUp[i - 1].value : rms));
                    if (ratio <= -TRENDILO_EXTREME && wasDown && slope > 0) {
                        markers.push({
                            time: t, position: 'belowBar', color: '#0ecb81',
                            shape: 'arrowUp', text: 'Bounce', size: 1.5
                        });
                    } else if (ratio >= TRENDILO_EXTREME && wasUp && slope < 0) {
                        markers.push({
                            time: t, position: 'aboveBar', color: '#f6465d',
                            shape: 'arrowDown', text: 'Rev', size: 1.5
                        });
                    } else if (ratioPrev <= -TRENDILO_EXTREME && ratio > -TRENDILO_EXTREME && slope > 0) {
                        markers.push({
                            time: t, position: 'belowBar', color: '#0ecb81',
                            shape: 'arrowUp', text: 'Bounce', size: 1.2
                        });
                    } else if (ratioPrev >= TRENDILO_EXTREME && ratio < TRENDILO_EXTREME && slope < 0) {
                        markers.push({
                            time: t, position: 'aboveBar', color: '#f6465d',
                            shape: 'arrowDown', text: 'Rev', size: 1.2
                        });
                    }
                }
            }

            // Último estado
            const n = almaLine.length;
            const alma = almaLine[n - 1].value;
            const rms = Math.abs(rmsUp[n - 1] ? rmsUp[n - 1].value : 0);
            const ratio = trendiloRatio(alma, rms);
            const slope = alma - almaLine[n - 2].value;
            let zone = 'NEUTRAL', signal = 'NONE', conf = 42;
            if (ratio <= -TRENDILO_EXTREME) {
                zone = 'EXTREME_BEAR';
                if (slope > 0) { signal = 'BUY'; conf = 78; zone = 'BOUNCE'; }
                else { signal = 'BUY'; conf = 62; } // potencial bounce
            } else if (ratio >= TRENDILO_EXTREME) {
                zone = 'EXTREME_BULL';
                if (slope < 0) { signal = 'SELL'; conf = 78; zone = 'REVERSAL'; }
                else { signal = 'SELL'; conf = 62; }
            } else if (ratio >= TRENDILO_BIAS) {
                zone = 'BULL_BIAS'; signal = 'BUY'; conf = 52;
            } else if (ratio <= -TRENDILO_BIAS) {
                zone = 'BEAR_BIAS'; signal = 'SELL'; conf = 52;
            }

            last = { ratio, zone, signal, conf, extreme: Math.abs(ratio) >= TRENDILO_EXTREME, slope, alma, rms };

            // Deduplicar markers por time+shape (quedarse con el de señal si hay círculo)
            const byKey = new Map();
            markers.forEach(m => {
                const key = String(m.time) + '|' + m.shape + '|' + (m.text || '');
                byKey.set(key, m);
            });
            return { markers: Array.from(byKey.values()).sort((a, b) => a.time - b.time), last };
        }

        function applyTrendiloMarkers(series, markers) {
            if (!series) return;
            try {
                if (typeof series.setMarkers === 'function') {
                    series.setMarkers(markers || []);
                }
            } catch (e) {
                console.warn('Trendilo markers', e);
            }
        }

        function computeTrendiloSeriesFromKlines(klines) {
            const almaLen = 20, almaOffset = 0.85, almaSigma = 6, rmsLen = 20, smoothLen = 3;
            if (!klines || klines.length < almaLen + 5) return null;
            const pctChange = [];
            for (let i = 0; i < klines.length; i++) {
                if (i === 0) pctChange.push(0);
                else {
                    const prev = klines[i - 1].close || 1;
                    pctChange.push(((klines[i].close - prev) / prev) * 100);
                }
            }
            const smoothed = [];
            const alpha = 2 / (smoothLen + 1);
            let emaS = pctChange[0];
            for (let i = 0; i < pctChange.length; i++) {
                emaS = pctChange[i] * alpha + emaS * (1 - alpha);
                smoothed.push(emaS);
            }
            const almaArr = [];
            for (let i = 0; i < smoothed.length; i++) {
                almaArr.push(typeof almaValue === 'function' ? almaValue(smoothed, i, almaLen, almaOffset, almaSigma) : smoothed[i]);
            }
            const almaLine = [], rmsUp = [], rmsDn = [], zero = [];
            let lastRms = 0;
            for (let i = 0; i < klines.length; i++) {
                const alma = almaArr[i];
                if (alma === null || i < almaLen) continue;
                let sumSq = 0, cnt = 0;
                for (let j = 0; j < rmsLen && i - j >= 0; j++) {
                    const a = almaArr[i - j];
                    if (a !== null) { sumSq += a * a; cnt++; }
                }
                const rms = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
                lastRms = rms;
                almaLine.push({ time: klines[i].time, value: alma });
                rmsUp.push({ time: klines[i].time, value: rms });
                rmsDn.push({ time: klines[i].time, value: -rms });
                zero.push({ time: klines[i].time, value: 0 });
            }
            if (almaLine.length < 4) return null;
            // Proyección lineal simple (3 barras) sobre el ALMA
            const n = almaLine.length;
            const y1 = almaLine[n - 3].value, y2 = almaLine[n - 1].value;
            const slope = (y2 - y1) / 2;
            const lastT = almaLine[n - 1].time;
            const barSec = (typeof lastT === 'number')
                ? Math.max(60, (almaLine[n - 1].time - almaLine[n - 2].time) || 3600)
                : 3600;
            const proj = [{ time: lastT, value: y2 }];
            for (let k = 1; k <= 3; k++) {
                const tNext = (typeof lastT === 'number') ? lastT + barSec * k : lastT;
                proj.push({ time: tNext, value: y2 + slope * k });
            }
            const projEnd = proj[proj.length - 1].value;
            const strat = evaluateTrendiloRatioStrategy(almaLine, rmsUp);
            let signal = strat.last.signal;
            let conf = strat.last.conf;
            const alma = y2;
            const ratio = strat.last.ratio;
            const zone = strat.last.zone;
            const extreme = strat.last.extreme;
            const markers = strat.markers;
            // Acierto histórico: señal en barra i vs movimiento de precio en las siguientes 3 velas
            let hits = 0, total = 0;
            const look = 3;
            const almaByTime = {};
            almaLine.forEach(p => { almaByTime[p.time] = p.value; });
            for (let i = almaLen; i < klines.length - look; i++) {
                const a0 = almaArr[i];
                const a1 = almaArr[i - 2] != null ? almaArr[i - 2] : a0;
                if (a0 == null) continue;
                const slopeI = (a0 - a1) / 2;
                let sig = 'NONE';
                // RMS local
                let sumSq = 0, cnt = 0;
                for (let j = 0; j < rmsLen && i - j >= 0; j++) {
                    const a = almaArr[i - j];
                    if (a !== null) { sumSq += a * a; cnt++; }
                }
                const rmsI = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
                if (a0 > rmsI * 0.45 && slopeI > 0) sig = 'BUY';
                else if (a0 < -rmsI * 0.45 && slopeI < 0) sig = 'SELL';
                else if (a0 > 0 && slopeI > 0) sig = 'BUY';
                else if (a0 < 0 && slopeI < 0) sig = 'SELL';
                if (sig === 'NONE') continue;
                const p0 = klines[i].close;
                const p1 = klines[i + look].close;
                const up = p1 > p0 * 1.0001;
                const dn = p1 < p0 * 0.9999;
                if (!up && !dn) continue;
                total++;
                if (sig === 'BUY' && up) hits++;
                if (sig === 'SELL' && dn) hits++;
            }
            const hitRate = total > 0 ? (hits / total) * 100 : null;
            const hitSamples = total;

            return {
                almaLine, rmsUp, rmsDn, zero, proj,
                alma: y2, rms: lastRms, projEnd, slope, signal, conf,
                ratio, zone, extreme, markers,
                hitRate, hitSamples, hits
            };
        }

        async function runTrendiloProjection(force) {
            if (trendiloProjRunning) return;
            if (!force && trendiloProjCacheAt && Date.now() - trendiloProjCacheAt < 12000 && trendiloProjLatest.alma) {
                renderTrendiloProjUI(trendiloProjLatest);
                return;
            }
            trendiloProjRunning = true;
            const icon = document.getElementById('trendiloProjIcon');
            const status = document.getElementById('tpStatus');
            if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
            if (status) status.innerText = `Cargando Trendilo ${trendiloProjTf}…`;
            try {
                ensureTrendiloProjChart();
                let klines = null;
                // Reutilizar rawKlines si el TF del gráfico coincide
                if (currentInterval === trendiloProjTf && rawKlines && rawKlines.length > 40) {
                    klines = rawKlines.slice(-150);
                } else if (typeof fetchKlinesForRanking === 'function') {
                    klines = await fetchKlinesForRanking(trendiloProjTf, 150);
                }
                const series = computeTrendiloSeriesFromKlines(klines);
                if (!series) {
                    if (status) status.innerText = 'Datos insuficientes para Trendilo.';
                    return;
                }
                if (tpAlmaSeries) tpAlmaSeries.setData(series.almaLine);
                if (tpRmsUp) tpRmsUp.setData(series.rmsUp);
                if (tpRmsDn) tpRmsDn.setData(series.rmsDn);
                if (tpZero) tpZero.setData(series.zero);
                if (tpProjSeries) tpProjSeries.setData(series.proj);
                try { trendiloProjChart.timeScale().fitContent(); } catch (e) {}

                trendiloProjLatest = {
                    signal: series.signal,
                    alma: series.alma,
                    rms: series.rms,
                    proj: series.projEnd,
                    slope: series.slope,
                    conf: series.conf,
                    ratio: series.ratio,
                    zone: series.zone,
                    extreme: series.extreme,
                    tf: trendiloProjTf,
                    hitRate: series.hitRate,
                    hitSamples: series.hitSamples,
                    hits: series.hits,
                    updatedAt: Date.now()
                };
                if (tpAlmaSeries) applyTrendiloMarkers(tpAlmaSeries, series.markers || []);
                trendiloProjCacheAt = Date.now();
                renderTrendiloProjUI(trendiloProjLatest);
                const hitTxt = series.hitRate != null
                    ? ` · acierto ${series.hitRate.toFixed(0)}% (${series.hits}/${series.hitSamples})`
                    : '';
                if (status) status.innerText = `TF ${trendiloProjTf} · auto 35s · ${new Date().toLocaleTimeString()}${hitTxt}`;
            } catch (e) {
                console.error('Trendilo proj', e);
                if (status) status.innerText = 'Error: ' + (e.message || e);
            } finally {
                trendiloProjRunning = false;
                if (icon) icon.className = 'fa-solid fa-rotate';
            }
        }

        function renderTrendiloConfluenceList(p) {
            const el = document.getElementById('tpConfluenceList');
            if (!el) return;
            let stochK = null;
            try {
                if (typeof stochRsiLatest !== 'undefined' && stochRsiLatest && stochRsiLatest.k != null) stochK = stochRsiLatest.k;
            } catch (e) {}
            let yoshiBuy = false, yoshiSell = false;
            try {
                if (typeof yoshiLatest !== 'undefined' && yoshiLatest) {
                    yoshiBuy = /buy|long|compra/i.test(String(yoshiLatest.signal || yoshiLatest.bias || ''));
                    yoshiSell = /sell|short|venta/i.test(String(yoshiLatest.signal || yoshiLatest.bias || ''));
                }
            } catch (e) {}
            let dmiNeg = false, dmiPos = false;
            try {
                if (typeof dmiLatest !== 'undefined' && dmiLatest) {
                    dmiNeg = (dmiLatest.minusDI || 0) >= (dmiLatest.plusDI || 0);
                    dmiPos = (dmiLatest.plusDI || 0) > (dmiLatest.minusDI || 0);
                }
            } catch (e) {}

            const items = [];
            if (stochK != null) {
                const ok = (p.signal === 'BUY' && stochK < 30) || (p.signal === 'SELL' && stochK > 70);
                items.push(`${ok ? '✓' : '○'} StochRSI K=${Number(stochK).toFixed(0)} (ideal ${p.signal === 'BUY' ? '<30' : p.signal === 'SELL' ? '>70' : 'extremo'})`);
            } else {
                items.push('○ StochRSI (sin dato aún)');
            }
            if (p.signal === 'BUY') {
                items.push(`${yoshiBuy ? '✓' : '○'} Yoshi OB compra / señal BUY`);
                items.push(`${dmiNeg ? '✓' : '○'} DMI aún −DI≥+DI (contexto bajista)`);
            } else if (p.signal === 'SELL') {
                items.push(`${yoshiSell ? '✓' : '○'} Yoshi CHoCH/ST sell`);
                items.push(`${dmiPos ? '✓' : '○'} DMI +DI perdiendo / aún dominante`);
            } else {
                items.push('○ Yoshi / DMI — esperando zona extrema');
            }
            items.push(`TF actual: ${p.tf || trendiloProjTf} · Mejor en 15m / 1H / 4H / 1D`);
            el.innerHTML = items.map(s => `<li class="${s.charAt(0) === '✓' ? 'text-accentGreen' : 'text-slate-400'}">${s}</li>`).join('');
        }

        window.runTrendiloProjection = runTrendiloProjection;

        function renderTrendiloProjUI(p) {
            if (!p) return;
            const badge = document.getElementById('tpBiasBadge');
            const main = document.getElementById('tpBiasMain');
            const hint = document.getElementById('tpBiasHint');
            const btnL = document.getElementById('btnTpApplyLong');
            const btnS = document.getElementById('btnTpApplyShort');
            const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
            setTxt('tpAlmaVal', Number(p.alma).toFixed(4));
            setTxt('tpRmsVal', '±' + Number(p.rms).toFixed(4));
            setTxt('tpProjVal', Number(p.proj).toFixed(4) + (p.slope >= 0 ? ' ↑' : ' ↓'));
            setTxt('tpConfVal', Math.round(p.conf) + '%');
            const ratio = p.ratio != null ? p.ratio : trendiloRatio(p.alma, p.rms);
            setTxt('tpRatioVal', (ratio >= 0 ? '+' : '') + Number(ratio).toFixed(3));
            const zoneEl = document.getElementById('tpZoneVal');
            const barFill = document.getElementById('tpZoneBarFill');
            const absR = Math.abs(ratio);
            const barPct = Math.min(100, (absR / TRENDILO_EXTREME) * 100);
            if (barFill) {
                barFill.style.width = barPct + '%';
                barFill.className = 'h-full rounded-full transition-all ' + (
                    absR >= TRENDILO_EXTREME ? 'bg-accentRed' : absR >= TRENDILO_BIAS ? 'bg-accentYellow' : 'bg-slate-500'
                );
            }
            if (zoneEl) {
                let ztxt = 'Neutral · |ratio| < 0.50';
                let zcls = 'text-sm font-black text-slate-300';
                if (p.zone === 'BOUNCE' || (p.zone === 'EXTREME_BEAR' && p.slope > 0)) {
                    ztxt = 'BOUNCE · buscar long (rebote)';
                    zcls = 'text-sm font-black text-accentGreen';
                } else if (p.zone === 'REVERSAL' || (p.zone === 'EXTREME_BULL' && p.slope < 0)) {
                    ztxt = 'REVERSAL · buscar short';
                    zcls = 'text-sm font-black text-accentRed';
                } else if (p.zone === 'EXTREME_BEAR' || ratio <= -TRENDILO_EXTREME) {
                    ztxt = 'Zona extrema BAJISTA (rebote potencial)';
                    zcls = 'text-sm font-black text-accentRed';
                } else if (p.zone === 'EXTREME_BULL' || ratio >= TRENDILO_EXTREME) {
                    ztxt = 'Zona extrema ALCISTA (reversal potencial)';
                    zcls = 'text-sm font-black text-accentRed';
                } else if (p.zone === 'BULL_BIAS' || ratio >= TRENDILO_BIAS) {
                    ztxt = 'Sesgo alcista (|ratio| ≥ 0.50)';
                    zcls = 'text-sm font-black text-accentGreen';
                } else if (p.zone === 'BEAR_BIAS' || ratio <= -TRENDILO_BIAS) {
                    ztxt = 'Sesgo bajista (|ratio| ≤ −0.50)';
                    zcls = 'text-sm font-black text-accentRed';
                }
                zoneEl.innerText = ztxt;
                zoneEl.className = zcls;
            }
            // Confluencia checklist
            try { renderTrendiloConfluenceList(p); } catch (e) {}
            // % acierto proyección vs movimiento real del precio
            const hrEl = document.getElementById('tpHitRateVal');
            const hrBar = document.getElementById('tpHitRateBar');
            const hrDet = document.getElementById('tpHitRateDetail');
            if (p.hitRate != null && p.hitSamples > 0) {
                const hr = Number(p.hitRate);
                if (hrEl) {
                    hrEl.innerText = hr.toFixed(0) + '%';
                    hrEl.className = 'text-lg font-black ' + (
                        hr >= 58 ? 'text-accentGreen' : hr >= 48 ? 'text-accentYellow' : 'text-accentRed'
                    );
                }
                if (hrBar) {
                    hrBar.style.width = Math.max(0, Math.min(100, hr)) + '%';
                    hrBar.className = 'h-full rounded-full transition-all ' + (
                        hr >= 58 ? 'bg-accentGreen' : hr >= 48 ? 'bg-accentYellow' : 'bg-accentRed'
                    );
                }
                if (hrDet) {
                    hrDet.innerText = `Aciertos ${p.hits || 0}/${p.hitSamples} · señal Trendilo vs precio +3 velas (${p.tf || trendiloProjTf})`;
                }
            } else {
                if (hrEl) { hrEl.innerText = '—'; hrEl.className = 'text-lg font-black text-slate-500'; }
                if (hrBar) { hrBar.style.width = '0%'; }
                if (hrDet) hrDet.innerText = 'Calculando acierto vs movimiento real…';
            }

            if (p.signal === 'BUY') {
                const isBounce = p.zone === 'BOUNCE' || (p.extreme && p.ratio < 0);
                if (badge) { badge.innerText = isBounce ? 'BOUNCE' : 'LONG'; badge.className = 'px-2.5 py-0.5 rounded text-[10px] font-black bg-accentGreen text-slate-950'; }
                if (main) { main.innerText = isBounce ? 'ZONA EXTREMA · REBOTE' : 'PROYECCIÓN ALCISTA'; main.className = 'text-2xl font-black text-accentGreen mb-1'; }
                if (hint) hint.innerText = `ratio ${Number(p.ratio).toFixed(3)} · ALMA ${Number(p.alma).toFixed(3)} · RMS ${Number(p.rms).toFixed(3)}. ${isBounce ? 'Buscar LONG (rebote) con confluencia StochRSI/Yoshi/DMI.' : 'Sesgo alcista; confirma en 15m/1H/4H/1D.'}`;
                if (btnL) { btnL.disabled = false; btnL.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else if (p.signal === 'SELL') {
                const isRev = p.zone === 'REVERSAL' || (p.extreme && p.ratio > 0);
                if (badge) { badge.innerText = isRev ? 'REVERSAL' : 'SHORT'; badge.className = 'px-2.5 py-0.5 rounded text-[10px] font-black bg-accentRed text-white'; }
                if (main) { main.innerText = isRev ? 'ZONA EXTREMA · REVERSAL' : 'PROYECCIÓN BAJISTA'; main.className = 'text-2xl font-black text-accentRed mb-1'; }
                if (hint) hint.innerText = `ratio ${Number(p.ratio).toFixed(3)} · ALMA ${Number(p.alma).toFixed(3)} · RMS ${Number(p.rms).toFixed(3)}. ${isRev ? 'Buscar SHORT (cambio de tendencia) con confluencia.' : 'Sesgo bajista; confirma en TF altos.'}`;
                if (btnS) { btnS.disabled = false; btnS.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else {
                if (badge) { badge.innerText = 'NEUTRAL'; badge.className = 'px-2.5 py-0.5 rounded text-[10px] font-black bg-accentYellow text-slate-950'; }
                if (main) { main.innerText = 'SIN IMPULSO CLARO'; main.className = 'text-2xl font-black text-accentYellow mb-1'; }
                if (hint) hint.innerText = `ALMA cerca de 0 o dentro de ±RMS. Esperar cruce o rechazo de banda antes de operar.`;
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            }
        }

        function applyTrendiloProjection(side) {
            if (!trendiloProjLatest || trendiloProjLatest.signal === 'NONE') {
                alert('Sin sesgo Trendilo claro. Espera cruce de 0 o de banda RMS.');
                return;
            }
            if (trendiloProjLatest.signal === 'BUY' && side !== 'LONG') return;
            if (trendiloProjLatest.signal === 'SELL' && side !== 'SHORT') return;
            try {
                if (typeof changeTimeframe === 'function') changeTimeframe(trendiloProjTf);
                const trade = registerAppliedPosition(side, {
                    source: 'Trendilo ' + trendiloProjTf,
                    score: trendiloProjLatest.conf || 55,
                    tf: trendiloProjTf,
                    note: `ALMA ${Number(trendiloProjLatest.alma).toFixed(3)} · RMS ±${Number(trendiloProjLatest.rms).toFixed(3)} · proy ${Number(trendiloProjLatest.proj).toFixed(3)}`
                });
                const status = document.getElementById('tpStatus');
                if (status && trade) {
                    status.innerHTML = `<span class="text-accentGreen">Registrado ${side}</span> · TF ${trendiloProjTf} · Entrada $${trade.entry.toFixed(1)} · TP1/2/3 listos en Historial`;
                }
            } catch (e) {
                console.error(e);
                alert('Error: ' + (e.message || e));
            }
        }
        window.applyTrendiloProjection = applyTrendiloProjection;

        // ========== Calendario económico (impacto BTC) ==========
        let econCalendarCache = [];
        let econCalendarLoadedAt = 0;

        function btcImpactNote(title, impact) {
            const t = (title || '').toLowerCase();
            if (/fomc|interest rate|federal funds|rate decision|fed chair|powell|jackson hole/.test(t))
                return 'Muy alto · pivote de tasas / liquidez de riesgo';
            if (/cpi|pce|inflation|core pce|core cpi/.test(t))
                return 'Alto · inflación vs expectativa USD';
            if (/nonfarm|non-farm|nfp|unemployment|payroll|jobless/.test(t))
                return 'Alto · empleo y política Fed';
            if (/gdp|gross domestic/.test(t))
                return 'Medio-alto · crecimiento y risk appetite';
            if (/pmi|ism|manufacturing|services/.test(t))
                return 'Medio · actividad económica';
            if (/retail sales|consumer confidence|michigan/.test(t))
                return 'Medio · consumo EE.UU.';
            if (/treasury|auction|10-year|2-year|bond/.test(t))
                return 'Medio · yields y correlación BTC';
            if (impact === 'High') return 'Alto · posible spike de volatilidad';
            if (impact === 'Medium') return 'Medio · vigilar contexto USD';
            return 'Bajo-medio';
        }

        /**
         * Proyección direccional típica sobre BTC según el tipo de dato.
         * Condicional: depende de si el dato sale mejor/peor vs consenso.
         */
        function btcBiasProjection(title, impact) {
            const t = (title || '').toLowerCase();

            // FOMC / tasas
            if (/fomc|interest rate|federal funds|rate decision/.test(t)) {
                return {
                    bias: 'Mixto',
                    label: 'Mixto',
                    detail: 'Dovish (recorte/pausa) → Alcista · Hawkish (alza/tono duro) → Bajista'
                };
            }
            if (/fed chair|powell|jackson hole|press conference|fomc press/.test(t)) {
                return {
                    bias: 'Mixto',
                    label: 'Mixto',
                    detail: 'Tono dovish → Alcista · hawkish / QT → Bajista'
                };
            }
            // Inflación
            if (/cpi|pce|inflation|core pce|core cpi|ppi/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'Dato < esperado → Alcista · dato > esperado → Bajista (USD↑)'
                };
            }
            // Empleo
            if (/nonfarm|non-farm|nfp|payroll/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'NFP débil → Alcista (Fed dovish) · NFP fuerte → Bajista corto plazo'
                };
            }
            if (/unemployment|jobless/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'Paro ↑ → Alcista (más liquidez esperada) · paro ↓ → Mixto/Bajista'
                };
            }
            // Crecimiento
            if (/gdp|gross domestic/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'GDP sólido + inflación controlada → Alcista riesgo · sobrecalentamiento → Bajista'
                };
            }
            if (/pmi|ism|manufacturing|services/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'PMI expansión suave → Alcista · contracción profunda → Bajista risk-off'
                };
            }
            if (/retail sales|consumer confidence|michigan/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'Consumo fuerte sin inflación → Alcista · debilidad extrema → Mixto'
                };
            }
            if (/treasury|auction|10-year|2-year|bond|yield/.test(t)) {
                return {
                    bias: 'Condicional',
                    label: 'Condicional',
                    detail: 'Yields ↓ → Alcista BTC · yields ↑ fuertes → Bajista'
                };
            }
            if (impact === 'High') {
                return {
                    bias: 'Mixto',
                    label: 'Mixto',
                    detail: 'Alta volatilidad: dirección según sorpresa vs consenso'
                };
            }
            return {
                bias: 'Mixto',
                label: 'Mixto',
                detail: 'Impacto moderado; depende del dato vs expectativa'
            };
        }

        /** Eventos macro USD recurrentes orientativos (próximas semanas) */
        function buildCuratedEconEvents() {
            const now = new Date();
            const events = [];

            // Helpers: next weekday of month (1=Mon..5=Fri), nth occurrence
            function nthWeekday(year, monthIndex, weekday, n) {
                // weekday: 0=Sun..6=Sat
                let count = 0;
                for (let d = 1; d <= 31; d++) {
                    const dt = new Date(year, monthIndex, d, 14, 30, 0); // ~14:30 ET ≈ datos BLS
                    if (dt.getMonth() !== monthIndex) break;
                    if (dt.getDay() === weekday) {
                        count++;
                        if (count === n) return dt;
                    }
                }
                return null;
            }
            function lastWeekday(year, monthIndex, weekday) {
                for (let d = 31; d >= 1; d--) {
                    const dt = new Date(year, monthIndex, d, 14, 0, 0);
                    if (dt.getMonth() !== monthIndex) continue;
                    if (dt.getDay() === weekday) return dt;
                }
                return null;
            }

            const y = now.getFullYear();
            // Generar 2 meses atrás + actual + 2 adelante (historial + agenda)
            for (let mOff = -2; mOff <= 2; mOff++) {
                const base = new Date(y, now.getMonth() + mOff, 1);
                const yy = base.getFullYear();
                const mm = base.getMonth();

                // NFP: primer viernes del mes ~08:30 ET
                const nfp = nthWeekday(yy, mm, 5, 1);
                if (nfp) {
                    nfp.setHours(8, 30, 0, 0);
                    events.push({ date: nfp, country: 'USD', title: 'Non-Farm Payrolls (NFP)', impact: 'High' });
                    events.push({ date: new Date(nfp.getTime()), country: 'USD', title: 'Unemployment Rate', impact: 'High' });
                }

                // CPI: orientativo ~día 10–15 laborable, usamos 2º martes 08:30 ET
                const cpi = nthWeekday(yy, mm, 2, 2);
                if (cpi) {
                    cpi.setHours(8, 30, 0, 0);
                    events.push({ date: cpi, country: 'USD', title: 'CPI (Consumer Price Index) m/m & y/y', impact: 'High' });
                    events.push({ date: new Date(cpi.getTime()), country: 'USD', title: 'Core CPI', impact: 'High' });
                }

                // PPI: suele un día después del CPI → +1 día
                if (cpi) {
                    const ppi = new Date(cpi.getTime() + 86400000);
                    ppi.setHours(8, 30, 0, 0);
                    events.push({ date: ppi, country: 'USD', title: 'PPI (Producer Price Index)', impact: 'Medium' });
                }

                // Retail Sales: ~mitad de mes, 3er jueves
                const retail = nthWeekday(yy, mm, 4, 3);
                if (retail) {
                    retail.setHours(8, 30, 0, 0);
                    events.push({ date: retail, country: 'USD', title: 'Retail Sales m/m', impact: 'Medium' });
                }

                // ISM Manufacturing: primer día hábil ~ del mes (aprox 1er día laborable 10:00)
                const ism = nthWeekday(yy, mm, 1, 1);
                if (ism) {
                    ism.setHours(10, 0, 0, 0);
                    events.push({ date: ism, country: 'USD', title: 'ISM Manufacturing PMI', impact: 'Medium' });
                }

                // ISM Services: ~3er día hábil, 3er lunes orientativo
                const ismS = nthWeekday(yy, mm, 1, 3);
                if (ismS) {
                    ismS.setHours(10, 0, 0, 0);
                    events.push({ date: ismS, country: 'USD', title: 'ISM Services PMI', impact: 'Medium' });
                }

                // Michigan Consumer Sentiment: ~fin de mes viernes
                const mich = lastWeekday(yy, mm, 5);
                if (mich) {
                    mich.setHours(10, 0, 0, 0);
                    events.push({ date: mich, country: 'USD', title: 'Michigan Consumer Sentiment', impact: 'Medium' });
                }

                // Core PCE: suele fin de mes — último viernes orientativo 08:30
                const pce = lastWeekday(yy, mm, 5);
                if (pce) {
                    const pce2 = new Date(pce.getTime());
                    pce2.setHours(8, 30, 0, 0);
                    events.push({ date: pce2, country: 'USD', title: 'Core PCE Price Index', impact: 'High' });
                }
            }

            // FOMC 2026 (fechas orientativas típicas del calendario Fed — verificar oficial)
            const fomc2026 = [
                [2026, 0, 28], [2026, 2, 18], [2026, 4, 6], [2026, 5, 17],
                [2026, 6, 29], [2026, 8, 16], [2026, 10, 4], [2026, 11, 16]
            ];
            fomc2026.forEach(([yy, mm, dd]) => {
                const d = new Date(yy, mm, dd, 14, 0, 0); // ~14:00 ET anuncio
                events.push({ date: d, country: 'USD', title: 'FOMC Interest Rate Decision', impact: 'High' });
                const press = new Date(yy, mm, dd, 14, 30, 0);
                events.push({ date: press, country: 'USD', title: 'FOMC Press Conference', impact: 'High' });
            });

            // GDP avance trimestral orientativo (último día del mes siguiente al trimestre)
            [[2026, 0, 30, 'GDP Advance q/q (Q4)'], [2026, 3, 30, 'GDP Advance q/q (Q1)'],
             [2026, 6, 30, 'GDP Advance q/q (Q2)'], [2026, 9, 29, 'GDP Advance q/q (Q3)']].forEach(([yy, mm, dd, title]) => {
                events.push({ date: new Date(yy, mm, dd, 8, 30, 0), country: 'USD', title, impact: 'High' });
            });

            // -30 días atrás hasta +45 días adelante
            const from = now.getTime() - 30 * 86400000;
            const to = now.getTime() + 45 * 86400000;
            return events
                .filter(e => e.date.getTime() >= from && e.date.getTime() <= to)
                .sort((a, b) => a.date - b.date)
                .map(e => ({
                    ...e,
                    btcNote: btcImpactNote(e.title, e.impact),
                    btcBias: btcBiasProjection(e.title, e.impact)
                }));
        }

        async function tryFetchExternalCalendar() {
            // Intento best-effort; si CORS/rate-limit falla, se usa el calendario curado
            try {
                const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(6000)
                });
                if (!res.ok) return null;
                const data = await res.json();
                if (!Array.isArray(data) || !data.length) return null;
                const mapped = data
                    .filter(ev => {
                        const c = (ev.country || '').toUpperCase();
                        return c === 'USD' || c === 'United States'.toUpperCase() || (ev.country || '') === 'USD';
                    })
                    .map(ev => {
                        const impactRaw = (ev.impact || '').toString();
                        let impact = 'Low';
                        if (/high/i.test(impactRaw) || impactRaw === '3') impact = 'High';
                        else if (/medium|med/i.test(impactRaw) || impactRaw === '2') impact = 'Medium';
                        const date = new Date(ev.date);
                        return {
                            date,
                            country: 'USD',
                            title: ev.title || ev.name || 'Evento',
                            impact,
                            btcNote: btcImpactNote(ev.title || '', impact),
                            btcBias: btcBiasProjection(ev.title || '', impact)
                        };
                    })
                    .filter(e => !isNaN(e.date.getTime()));
                return mapped.length ? mapped : null;
            } catch (e) {
                return null;
            }
        }

        async function loadEconomicCalendar(force) {
            const icon = document.getElementById('calRefreshIcon');
            if (icon) icon.classList.add('fa-spin');
            try {
                if (!force && econCalendarCache.length && (Date.now() - econCalendarLoadedAt < 30 * 60 * 1000)) {
                    renderEconomicCalendar();
                    return;
                }
                let events = await tryFetchExternalCalendar();
                if (!events || !events.length) {
                    events = buildCuratedEconEvents();
                } else {
                    // Mezclar con FOMC curado si faltan
                    const curated = buildCuratedEconEvents().filter(e => /fomc/i.test(e.title));
                    const titles = new Set(events.map(e => e.title + e.date.toDateString()));
                    curated.forEach(c => {
                        const key = c.title + c.date.toDateString();
                        if (!titles.has(key)) events.push(c);
                    });
                    events.sort((a, b) => a.date - b.date);
                }
                econCalendarCache = events;
                econCalendarLoadedAt = Date.now();
                renderEconomicCalendar();
                // Historial 30d: velas 1h + comparación proyección vs resultado
                await fetchBtcHourlyForHistory();
                renderEconHistory();
            } finally {
                if (icon) icon.classList.remove('fa-spin');
            }
        }

        function renderEconomicCalendar() {
            const tbody = document.getElementById('econCalendarBody');
            const nextBox = document.getElementById('calNextHigh');
            if (!tbody) return;
            const highOnly = document.getElementById('calHighOnly')?.checked !== false;
            let list = econCalendarCache.slice();
            if (highOnly) list = list.filter(e => e.impact === 'High');
            const now = Date.now();

            if (!list.length) {
                tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500 italic">Sin eventos en el rango. Prueba desmarcar «Solo alto impacto» o Actualizar.</td></tr>`;
                if (nextBox) nextBox.innerHTML = 'Próximo evento alto impacto: —';
                return;
            }

            tbody.innerHTML = list.map(e => {
                const past = e.date.getTime() < now - 3600000;
                const soon = !past && e.date.getTime() - now < 48 * 3600000;
                const dateStr = e.date.toLocaleString('es-MX', {
                    weekday: 'short', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                const impactCls = e.impact === 'High'
                    ? 'bg-accentRed/20 text-accentRed border-accentRed/30'
                    : e.impact === 'Medium'
                    ? 'bg-accentYellow/15 text-accentYellow border-accentYellow/30'
                    : 'bg-slate-800 text-slate-400 border-borderBg';
                const rowCls = past ? 'opacity-50' : (soon ? 'bg-accentYellow/5' : '');
                const bias = e.btcBias || btcBiasProjection(e.title, e.impact);
                let biasCls = 'bg-slate-800 text-slate-300 border-borderBg';
                let biasIcon = 'fa-arrows-left-right';
                if (bias.bias === 'Alcista') {
                    biasCls = 'bg-accentGreen/20 text-accentGreen border-accentGreen/30';
                    biasIcon = 'fa-arrow-trend-up';
                } else if (bias.bias === 'Bajista') {
                    biasCls = 'bg-accentRed/20 text-accentRed border-accentRed/30';
                    biasIcon = 'fa-arrow-trend-down';
                } else if (bias.bias === 'Condicional') {
                    biasCls = 'bg-accentYellow/15 text-accentYellow border-accentYellow/30';
                    biasIcon = 'fa-code-branch';
                }
                return `<tr class="${rowCls}">
                    <td class="p-2 font-mono whitespace-nowrap ${soon ? 'text-accentYellow font-semibold' : ''}">${dateStr}${soon ? ' · pronto' : ''}${past ? ' · pasado' : ''}</td>
                    <td class="p-2"><span class="px-1.5 py-0.5 rounded bg-cardBg border border-borderBg text-[10px] font-bold">USD</span></td>
                    <td class="p-2 font-medium text-slate-200">${e.title}</td>
                    <td class="p-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold border ${impactCls}">${e.impact}</span></td>
                    <td class="p-2">
                        <div class="flex flex-col gap-0.5 min-w-[140px]">
                            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border w-fit ${biasCls}">
                                <i class="fa-solid ${biasIcon}"></i> ${bias.label}
                            </span>
                            <span class="text-[10px] text-slate-500 leading-snug">${bias.detail}</span>
                        </div>
                    </td>
                    <td class="p-2 text-slate-400">${e.btcNote || '—'}</td>
                </tr>`;
            }).join('');

            const nextHigh = econCalendarCache.find(e => e.impact === 'High' && e.date.getTime() >= now - 3600000);
            if (nextBox) {
                if (nextHigh) {
                    const ds = nextHigh.date.toLocaleString('es-MX', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const nb = nextHigh.btcBias || btcBiasProjection(nextHigh.title, nextHigh.impact);
                    nextBox.innerHTML = `<div class="text-slate-500 text-[10px] mb-1">Próximo alto impacto</div>
                        <div class="text-accentYellow font-semibold">${nextHigh.title}</div>
                        <div class="font-mono text-slate-300 mt-1">${ds}</div>
                        <div class="mt-1.5 text-[11px]"><span class="text-slate-400">Proyección:</span> <span class="text-slate-200 font-semibold">${nb.label}</span></div>
                        <div class="text-slate-500 mt-1">${nb.detail}</div>
                        <div class="text-slate-600 mt-1.5 text-[10px]">${nextHigh.btcNote}</div>`;
                } else {
                    nextBox.innerHTML = 'Próximo evento alto impacto: sin datos en ventana';
                }
            }
        }


        let econHistoryKlines = []; // 1h BTC for impact analysis

        async function fetchBtcHourlyForHistory() {
            // ~40 días de velas 1h (máx 1000)
            try {
                const url = `https://api.binance.com/api/v3/klines?symbol=${currentSymbol}&interval=1h&limit=1000`;
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const raw = await res.json();
                econHistoryKlines = (raw || []).map(d => ({
                    time: Math.floor(d[0] / 1000),
                    open: parseFloat(d[1]),
                    high: parseFloat(d[2]),
                    low: parseFloat(d[3]),
                    close: parseFloat(d[4])
                }));
                return econHistoryKlines;
            } catch (e) {
                console.warn('historial BTC 1h', e);
                // Fallback: usar rawKlines si son 1h
                if (rawKlines && rawKlines.length > 50) {
                    econHistoryKlines = rawKlines.slice();
                    return econHistoryKlines;
                }
                return [];
            }
        }

        function priceAtOrAfter(klines, unixSec) {
            if (!klines.length) return null;
            let best = null;
            for (let i = 0; i < klines.length; i++) {
                if (klines[i].time >= unixSec) {
                    best = klines[i];
                    break;
                }
            }
            if (!best) best = klines[klines.length - 1];
            return best;
        }

        function priceAfterHours(klines, eventUnix, hours) {
            return priceAtOrAfter(klines, eventUnix + hours * 3600);
        }

        function measureNewsImpact(eventDate, klines) {
            if (!klines || klines.length < 10) return null;
            const t0 = Math.floor(eventDate.getTime() / 1000);
            const base = priceAtOrAfter(klines, t0);
            if (!base) return null;
            const p0 = base.close;
            const horizons = [
                { key: '1h', hours: 1 },
                { key: '4h', hours: 4 },
                { key: '24h', hours: 24 },
                { key: '3d', hours: 72 }
            ];
            const out = { p0 };
            let peakAbs = 0;
            let peakKey = '1h';
            let peakPct = 0;
            horizons.forEach(h => {
                const bar = priceAfterHours(klines, t0, h.hours);
                if (!bar) {
                    out[h.key] = null;
                    return;
                }
                const pct = ((bar.close - p0) / p0) * 100;
                out[h.key] = pct;
                if (Math.abs(pct) >= peakAbs) {
                    peakAbs = Math.abs(pct);
                    peakKey = h.key;
                    peakPct = pct;
                }
            });
            // También mirar high/low en ventana 24h para spike
            const end24 = t0 + 24 * 3600;
            let maxP = p0, minP = p0;
            klines.forEach(k => {
                if (k.time >= t0 && k.time <= end24) {
                    if (k.high > maxP) maxP = k.high;
                    if (k.low < minP) minP = k.low;
                }
            });
            const upSpike = ((maxP - p0) / p0) * 100;
            const dnSpike = ((minP - p0) / p0) * 100;
            out.spikeUp = upSpike;
            out.spikeDn = dnSpike;
            out.peakHorizon = peakKey;
            out.peakPct = peakPct;
            // Dirección dominante: usa 4h si existe, si no 24h
            const ref = out['4h'] != null ? out['4h'] : out['24h'];
            if (ref == null) out.actualBias = 'N/D';
            else if (ref > 0.15) out.actualBias = 'Alcista';
            else if (ref < -0.15) out.actualBias = 'Bajista';
            else out.actualBias = 'Lateral';
            return out;
        }

        function fmtPct(v) {
            if (v == null || !Number.isFinite(v)) return '—';
            const sign = v >= 0 ? '+' : '';
            const cls = v > 0.15 ? 'text-accentGreen' : (v < -0.15 ? 'text-accentRed' : 'text-slate-400');
            return `<span class="font-mono ${cls}">${sign}${v.toFixed(2)}%</span>`;
        }

        function renderEconHistory() {
            const tbody = document.getElementById('econHistoryBody');
            const statsEl = document.getElementById('calHistoryStats');
            if (!tbody) return;

            const now = Date.now();
            const from = now - 30 * 86400000;
            let past = (econCalendarCache || [])
                .filter(e => e.date.getTime() >= from && e.date.getTime() < now - 60 * 60 * 1000)
                .filter(e => e.impact === 'High' || e.impact === 'Medium')
                .sort((a, b) => b.date - a.date);

            // Solo alto impacto en historial si checkbox activo
            const highOnly = document.getElementById('calHighOnly')?.checked !== false;
            if (highOnly) past = past.filter(e => e.impact === 'High');

            if (!past.length) {
                tbody.innerHTML = `<tr><td colspan="9" class="p-6 text-center text-slate-500 italic">No hay eventos en los últimos 30 días con el filtro actual.</td></tr>`;
                if (statsEl) statsEl.innerText = '';
                return;
            }

            if (!econHistoryKlines.length) {
                tbody.innerHTML = `<tr><td colspan="9" class="p-6 text-center text-slate-500 italic">Cargando velas BTC 1h para medir impacto…</td></tr>`;
                return;
            }

            let bull = 0, bear = 0, flat = 0;
            tbody.innerHTML = past.map(e => {
                const bias = e.btcBias || btcBiasProjection(e.title, e.impact);
                const m = measureNewsImpact(e.date, econHistoryKlines);
                const dateStr = e.date.toLocaleString('es-MX', {
                    weekday: 'short', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });
                if (!m) {
                    return `<tr>
                        <td class="p-2 font-mono whitespace-nowrap">${dateStr}</td>
                        <td class="p-2 text-slate-200">${e.title}</td>
                        <td class="p-2 text-slate-400">${bias.label}</td>
                        <td class="p-2" colspan="6"><span class="text-slate-500 italic">Sin datos de precio</span></td>
                    </tr>`;
                }
                if (m.actualBias === 'Alcista') bull++;
                else if (m.actualBias === 'Bajista') bear++;
                else flat++;

                const actCls = m.actualBias === 'Alcista' ? 'text-accentGreen' :
                    (m.actualBias === 'Bajista' ? 'text-accentRed' : 'text-slate-400');
                const peakStr = m.peakPct == null ? '—' :
                    `${m.peakHorizon}: ${m.peakPct >= 0 ? '+' : ''}${m.peakPct.toFixed(2)}%`;
                const peakCls = m.peakPct > 0.15 ? 'text-accentGreen' : (m.peakPct < -0.15 ? 'text-accentRed' : 'text-slate-400');

                // ¿La dirección 4h/24h es coherente con un sesgo "condicional"?
                let resultNote = m.actualBias;
                if (bias.bias === 'Condicional' || bias.bias === 'Mixto') {
                    resultNote = `${m.actualBias} (dato vs consenso)`;
                }

                return `<tr>
                    <td class="p-2 font-mono whitespace-nowrap text-slate-400">${dateStr}</td>
                    <td class="p-2 font-medium text-slate-200">${e.title}</td>
                    <td class="p-2">
                        <div class="text-slate-300 font-semibold">${bias.label}</div>
                        <div class="text-[10px] text-slate-500 max-w-[160px] leading-snug">${bias.detail}</div>
                    </td>
                    <td class="p-2">${fmtPct(m['1h'])}</td>
                    <td class="p-2">${fmtPct(m['4h'])}</td>
                    <td class="p-2">${fmtPct(m['24h'])}</td>
                    <td class="p-2">${fmtPct(m['3d'])}</td>
                    <td class="p-2 font-mono ${peakCls}">${peakStr}</td>
                    <td class="p-2 font-bold ${actCls}">${resultNote}</td>
                </tr>`;
            }).join('');

            if (statsEl) {
                const n = bull + bear + flat;
                statsEl.innerHTML = `n=${n} · <span class="text-accentGreen">↑${bull}</span> · <span class="text-accentRed">↓${bear}</span> · <span class="text-slate-500">→${flat}</span>`;
            }
        }

        window.loadEconomicCalendar = loadEconomicCalendar;
        window.renderEconomicCalendar = renderEconomicCalendar;
        window.renderEconHistory = renderEconHistory;

        // ========== Altcoins TOTAL2 (Binance ∩ Bybit ∩ OKX) ==========
        let altsListCache = [];
        let altsLoadedAt = 0;

        function formatAltPrice(p) {
            const n = parseFloat(p);
            if (!Number.isFinite(n)) return '—';
            if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
            if (n >= 1) return n.toFixed(4);
            if (n >= 0.01) return n.toFixed(6);
            return n.toPrecision(4);
        }

        function formatVol(v) {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return '—';
            if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n.toFixed(0);
        }

        async function fetchBinanceUsdtSymbols() {
            const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
            if (!res.ok) throw new Error('Binance tickers');
            const data = await res.json();
            const map = new Map();
            (data || []).forEach(t => {
                const sym = t.symbol;
                if (!sym || !sym.endsWith('USDT')) return;
                if (sym.includes('UP') || sym.includes('DOWN') || sym.includes('BULL') || sym.includes('BEAR')) return;
                if (/^\d/.test(sym)) return;
                map.set(sym, {
                    symbol: sym,
                    price: parseFloat(t.lastPrice),
                    changePct: parseFloat(t.priceChangePercent),
                    quoteVol: parseFloat(t.quoteVolume)
                });
            });
            return map;
        }

        async function fetchBybitUsdtSet() {
            const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot');
            if (!res.ok) throw new Error('Bybit tickers');
            const data = await res.json();
            const list = data?.result?.list || [];
            const set = new Set();
            list.forEach(t => {
                const sym = t.symbol;
                if (sym && sym.endsWith('USDT')) set.add(sym);
            });
            return set;
        }

        async function fetchOkxUsdtSet() {
            const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
            if (!res.ok) throw new Error('OKX tickers');
            const data = await res.json();
            const list = data?.data || [];
            const set = new Set();
            list.forEach(t => {
                const id = t.instId || ''; // BTC-USDT
                if (id.endsWith('-USDT')) {
                    set.add(id.replace('-', '')); // BTCUSDT
                }
            });
            return set;
        }

        async function loadAltsList(force) {
            const icon = document.getElementById('altsRefreshIcon');
            if (icon) icon.classList.add('fa-spin');
            try {
                if (!force && altsListCache.length && Date.now() - altsLoadedAt < 60 * 1000) {
                    renderAltsTable();
                    return;
                }
                const [binanceMap, bybitSet, okxSet] = await Promise.all([
                    fetchBinanceUsdtSymbols(),
                    fetchBybitUsdtSet(),
                    fetchOkxUsdtSet()
                ]);
                // Intersección completa (todos los USDT en los 3 exchanges)
                let intersectionCount = 0;
                binanceMap.forEach((_, sym) => {
                    if (bybitSet.has(sym) && okxSet.has(sym)) intersectionCount++;
                });

                const alts = [];
                const FEATURED = new Set(['XAUUSDT', 'PAXGUSDT', 'ETHUSDT', 'SOLUSDT']);
                binanceMap.forEach((row, sym) => {
                    if (sym === 'BTCUSDT') return; // TOTAL2 = excluye BTC
                    if (!bybitSet.has(sym)) return;
                    if (!okxSet.has(sym)) return;
                    const minVol = (sym === 'XAUUSDT' || sym === 'PAXGUSDT') ? 50000 : 100000;
                    if (!Number.isFinite(row.quoteVol) || row.quoteVol < minVol) {
                        // XAU: incluir aunque el vol Binance sea bajo si está en los 3
                        if (sym !== 'XAUUSDT' && sym !== 'PAXGUSDT') return;
                    }
                    alts.push({
                        ...row,
                        exchanges: 'BN · BY · OKX',
                        featured: FEATURED.has(sym)
                    });
                });
                // Si XAUUSDT no vino en Binance 24hr pero existe en los 3, intentar forzar
                if (!alts.some(a => a.symbol === 'XAUUSDT') && bybitSet.has('XAUUSDT') && okxSet.has('XAUUSDT')) {
                    const row = binanceMap.get('XAUUSDT');
                    if (row) {
                        alts.unshift({ ...row, exchanges: 'BN · BY · OKX', featured: true });
                    } else {
                        alts.unshift({
                            symbol: 'XAUUSDT',
                            price: NaN,
                            changePct: 0,
                            quoteVol: 0,
                            exchanges: 'BN · BY · OKX',
                            featured: true
                        });
                    }
                }
                alts.sort((a, b) => {
                    if (a.featured && !b.featured) return -1;
                    if (!a.featured && b.featured) return 1;
                    return b.quoteVol - a.quoteVol;
                });
                altsListCache = alts;
                altsLoadedAt = Date.now();
                const badge = document.getElementById('altsTotalBadge');
                if (badge) badge.innerText = alts.length + ' tokens';
                const info = document.getElementById('altsIntersectionInfo');
                if (info) info.innerText = `Intersección 3 exchanges: ${intersectionCount} pares · listados ${alts.length} (liq. filtrada)`;
                renderAltsTable();
            } catch (e) {
                console.warn('loadAltsList', e);
                const tbody = document.getElementById('altsTableBody');
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-accentRed">Error cargando lista: ${e.message || e}</td></tr>`;
                }
            } finally {
                if (icon) icon.classList.remove('fa-spin');
            }
        }

        function renderAltsTable() {
            const tbody = document.getElementById('altsTableBody');
            if (!tbody) return;
            const q = (document.getElementById('altsSearch')?.value || '').trim().toUpperCase();
            let list = altsListCache;
            if (q) {
                list = list.filter(a => a.symbol.includes(q) || baseAsset(a.symbol).includes(q));
            }
            // Mostrar top 80 por volumen (o filtrados)
            list = list.slice(0, 80);
            if (!list.length) {
                tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500 italic">Sin resultados en la intersección de los 3 exchanges.</td></tr>`;
                return;
            }
            tbody.innerHTML = list.map((a, i) => {
                const base = baseAsset(a.symbol);
                const active = a.symbol === currentSymbol;
                const chg = a.changePct;
                const chgCls = chg >= 0 ? 'text-accentGreen' : 'text-accentRed';
                const sign = chg >= 0 ? '+' : '';
                const rowBg = active ? 'bg-accentYellow/10' : 'hover:bg-cardBg/60';
                const tag = a.symbol === 'XAUUSDT' ? '<span class="ml-1 text-[9px] text-amber-400 font-bold">ORO</span>'
                    : (a.featured ? '<span class="ml-1 text-[9px] text-slate-500">★</span>' : '');
                return `<tr class="${rowBg} cursor-pointer transition" onclick="setActiveSymbol('${a.symbol}')">
                    <td class="p-2 text-slate-500">${i + 1}</td>
                    <td class="p-2">
                        <span class="font-bold text-white font-mono ${active ? 'text-accentYellow' : ''}">${base}</span>
                        <span class="text-slate-500 text-[10px]">/USDT</span>
                        ${tag}
                        ${active ? '<span class="ml-1 text-[9px] text-accentYellow font-bold">ACTIVO</span>' : ''}
                    </td>
                    <td class="p-2 text-right font-mono text-slate-200">$${formatAltPrice(a.price)}</td>
                    <td class="p-2 text-right font-mono ${chgCls}">${sign}${chg.toFixed(2)}%</td>
                    <td class="p-2 text-right font-mono text-slate-400">${formatVol(a.quoteVol)}</td>
                    <td class="p-2 text-[10px] text-slate-500">${a.exchanges}</td>
                </tr>`;
            }).join('');
        }

        function updateSymbolUI() {
            const base = baseAsset(currentSymbol);
            const label = currentSymbol === 'XAUUSDT' ? 'XAU/USDT (Oro)' : (base + '/USDT');
            const h = document.getElementById('headerSymbolLabel');
            if (h) h.innerText = label;
            const a = document.getElementById('altsActiveSymbol');
            if (a) a.innerText = label;
            const modal = document.getElementById('modalEntryPrice');
            // modal parent text may still say BTC - update if exists a span
            document.querySelectorAll('[data-symbol-label]').forEach(el => { el.innerText = label; });
            try { localStorage.setItem('terminalmx_symbol', currentSymbol); } catch (e) {}
        }

        async function setActiveSymbol(sym) {
            if (!sym) return;
            const next = String(sym).toUpperCase().replace('-', '');
            if (!next.endsWith('USDT')) return;
            if (next === currentSymbol) {
                // igual: solo refrescar
                if (typeof fetchMarketData === 'function') fetchMarketData();
                return;
            }
            currentSymbol = next;
            chartViewInitialized = false;
            savedChartLogicalRange = null;
            lastChartTf = null;
            updateSymbolUI();
            renderAltsTable();
            // Reset entry fields loosely
            try {
                const ep = document.getElementById('entryPrice');
                if (ep) ep.value = '';
            } catch (e) {}
            if (typeof fetchMarketData === 'function') {
                await fetchMarketData();
            }
            // Historial calendario usa el activo actual en 1h
            try {
                if (typeof fetchBtcHourlyForHistory === 'function') {
                    await fetchBtcHourlyForHistory();
                    if (typeof renderEconHistory === 'function') renderEconHistory();
                }
            } catch (e) {}
        }

        window.loadAltsList = loadAltsList;
        window.renderAltsTable = renderAltsTable;
        window.setActiveSymbol = setActiveSymbol;



        const LS_LIVE = 'terminalmx_live';
        const LIVE_INTERVAL_MS = 35000; // 35 segundos
        let liveEnabled = false;
        let liveTimerId = null;

        function updateLiveButtonUI() {
            const btn = document.getElementById('btnLiveToggle');
            const dot = document.getElementById('liveDot');
            const label = document.getElementById('liveLabel');
            if (!btn) return;
            if (liveEnabled) {
                btn.className = 'px-2 sm:px-2.5 py-1.5 rounded-lg border text-[10px] sm:text-xs font-bold transition shrink-0 flex items-center gap-1.5 border-accentGreen/50 bg-accentGreen/15 text-accentGreen';
                if (dot) {
                    dot.className = 'w-1.5 h-1.5 rounded-full bg-accentGreen shrink-0 animate-pulse';
                }
                if (label) label.innerText = 'LIVE';
                btn.title = 'LIVE ON — actualiza cada 35 s (clic para pausar)';
            } else {
                btn.className = 'px-2 sm:px-2.5 py-1.5 rounded-lg border text-[10px] sm:text-xs font-bold transition shrink-0 flex items-center gap-1.5 border-borderBg bg-cardBg text-slate-400 hover:text-white';
                if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0';
                if (label) label.innerText = 'LIVE';
                btn.title = 'LIVE OFF — clic para actualizar cada 35 segundos';
            }
        }

        function startLiveUpdates() {
            stopLiveUpdates();
            liveEnabled = true;
            try { localStorage.setItem(LS_LIVE, '1'); } catch (e) {}
            liveTimerId = setInterval(() => {
                if (typeof fetchMarketData === 'function') fetchMarketData();
                // Palacios también en el ciclo LIVE (35s)
                try { if (typeof runPalaciosIndicator === 'function') runPalaciosIndicator(true); } catch (e) {}
            }, LIVE_INTERVAL_MS);
            updateLiveButtonUI();
        }

        function stopLiveUpdates() {
            liveEnabled = false;
            if (liveTimerId) {
                clearInterval(liveTimerId);
                liveTimerId = null;
            }
            try { localStorage.setItem(LS_LIVE, '0'); } catch (e) {}
            updateLiveButtonUI();
        }

        function toggleLiveUpdates() {
            if (liveEnabled) stopLiveUpdates();
            else {
                startLiveUpdates();
                // refresco inmediato al activar
                if (typeof fetchMarketData === 'function') fetchMarketData();
            }
        }

        window.onload = function() {
            loadJournalFromStorage();
            initCharts();
            applyChartPrefs();
            initChartResizeHandle();
            forceChartResize();
            requestAnimationFrame(() => forceChartResize());
            setTimeout(() => forceChartResize(), 50);
            setTimeout(() => forceChartResize(), 300);
            try {
                const savedSym = localStorage.getItem('terminalmx_symbol');
                if (savedSym && savedSym.endsWith('USDT')) currentSymbol = savedSym;
            } catch (e) {}
            updateSymbolUI();
            try { applyOptimalSetupForTf(currentInterval || '1h', { force: true }); } catch (e) {}
            fetchMarketData();
            setupInputListeners();
            window.addEventListener('resize', function() {
                handleResize();
                // Cerrar drawer si pasamos a desktop
                if (window.matchMedia('(min-width: 1024px)').matches) {
                    toggleLeftPanel(false);
                }
            });
            window.addEventListener('orientationchange', function() {
                setTimeout(handleResize, 150);
            });
            if (journalHistory.length) renderJournal();
            // LIVE cada 35 s: activo por defecto (solo se pausa si el usuario lo apagó)
            try {
                const livePref = localStorage.getItem(LS_LIVE);
                if (livePref !== '0') startLiveUpdates();
                else updateLiveButtonUI();
            } catch (e) {
                startLiveUpdates();
            }
            // Palacios + confluencia + TrendiloMX: auto-refresh cada 35s
            try {
                if (window._palaciosTimerId) clearInterval(window._palaciosTimerId);
                runPalaciosIndicator(true);
                try { if (typeof runTrendiloProjection === 'function') runTrendiloProjection(true); } catch (e) {}
                window._palaciosTimerId = setInterval(() => {
                    try { runPalaciosIndicator(true); } catch (e) {}
                    try {
                        if (typeof selectedConfluencia !== 'undefined' && selectedConfluencia && selectedConfluencia.tfs && selectedConfluencia.tfs.length) {
                            if (typeof refreshSelectedConfluencia === 'function') refreshSelectedConfluencia(true);
                        }
                    } catch (e) {}
                    try { if (typeof runTrendiloProjection === 'function') runTrendiloProjection(true); } catch (e) {}
                }, 35000);
            } catch (e) {}
            try {
                // Primera carga de confluencias + auto cada 1 min
                setTimeout(() => { try { runMejoresConfluencias(true); } catch (e) {} }, 4000);
                startConfluenciasAutoRefresh();
            } catch (e) {}
            try {
                const ofm = localStorage.getItem('tmx_orderflow_mode');
                if (ofm) setOrderFlowMode(ofm);
            } catch (e) {}
            initPanelResizeHandle();
            applyPanelHeightPrefs();
            startPositionCountdownTicker();
            if (lastConfirmedTrade && lastConfirmedTrade.openedAt) {
                updatePositionCountdownUI();
            }
            // Delegación de clics en filtros de proyección (sidebar + pestaña inferior)
            const onPhClick = (e) => {
                const btn = e.target.closest('[data-ph]');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                setProjectionHorizon(btn.getAttribute('data-ph'));
            };
            const phWrap = document.getElementById('projectionHorizonFilters');
            if (phWrap) phWrap.addEventListener('click', onPhClick);
            const phWrapBottom = document.getElementById('projectionHorizonFiltersBottom');
            if (phWrapBottom) phWrapBottom.addEventListener('click', onPhClick);
            try { projectNextHourBias(); } catch (e) {}
            // Pestaña inferior inicial: Señales
            try {
                if (localStorage.getItem('terminalmx_charts_hidden') === '1') toggleHideCharts(true);
            } catch (e) {}
            try { switchBottomTab('signals'); } catch (e) {}

            // Temporalidades
            document.querySelectorAll('.tf-btn').forEach(btn => {
                btn.addEventListener('click', function(ev) {
                    ev.preventDefault();
                    const tf = btn.getAttribute('data-tf') || (btn.id || '').replace(/^tf-/, '');
                    if (tf) changeTimeframe(tf);
                });
            });

            // Sidebar: visible en desktop; cerrada en móvil hasta hamburguesa
            try {
                const left = document.getElementById('leftPanel');
                if (left) {
                    left.style.display = '';
                    left.classList.remove('is-closed', 'panel-hidden', 'mobile-hidden');
                    if (window.matchMedia('(min-width: 1024px)').matches) {
                        left.classList.remove('mobile-open');
                    } else {
                        left.classList.remove('mobile-open');
                        const ov = document.getElementById('mobileOverlay');
                        if (ov) ov.classList.remove('show');
                    }
                }
            } catch (e) {}
        };
        window.applyProjectionToOrder = function(side) {
            if (typeof applyProjectionToOrder === 'function') applyProjectionToOrder(side);
        };

        // ——— Vigencia / countdown de posición simulada ———
        const HOLDING_MS = {
            '1m': 10 * 60 * 1000,
            '3m': 20 * 60 * 1000,
            '5m': 30 * 60 * 1000,
            '15m': 90 * 60 * 1000,
            '9m': 30 * 60 * 1000,
            '20m': 60 * 60 * 1000,
            '1h': 6 * 60 * 60 * 1000,
            '4h': 48 * 60 * 60 * 1000,
            '1d': 10 * 24 * 60 * 60 * 1000,
            '1w': 45 * 24 * 60 * 60 * 1000
        };
        let positionCountdownTimer = null;

        function getHoldingMsForTf(tf) {
            return HOLDING_MS[tf] || HOLDING_MS['1h'];
        }

        function formatCountdown(ms) {
            if (ms <= 0) return '00:00:00';
            const s = Math.floor(ms / 1000);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            const pad = n => String(n).padStart(2, '0');
            if (h >= 24) {
                const d = Math.floor(h / 24);
                return `${d}d ${pad(h % 24)}:${pad(m)}:${pad(sec)}`;
            }
            return `${pad(h)}:${pad(m)}:${pad(sec)}`;
        }

        function startPositionCountdownTicker() {
            if (positionCountdownTimer) clearInterval(positionCountdownTimer);
            positionCountdownTimer = setInterval(() => {
                updatePositionCountdownUI();
                updateJournalCountdowns();
            }, 1000);
        }

        function updatePositionCountdownUI() {
            const bar = document.getElementById('positionCountdownBar');
            if (!bar) return;
            const t = lastConfirmedTrade;
            if (!t || !t.openedAt || t.closed) {
                bar.classList.add('hidden');
                return;
            }
            bar.classList.remove('hidden');
            const opened = t.openedAt;
            const expires = t.expiresAt || (opened + getHoldingMsForTf(t.tf || currentInterval));
            const now = Date.now();
            const left = expires - now;
            const total = expires - opened;
            const pctLeft = total > 0 ? left / total : 0;

            const sideEl = document.getElementById('cdSideBadge');
            const entryEl = document.getElementById('cdEntry');
            const statusEl = document.getElementById('cdStatus');
            const timerEl = document.getElementById('cdTimer');
            const btnClose = document.getElementById('btnClosePosition');

            if (sideEl) {
                sideEl.innerText = t.side || '—';
                sideEl.className = `px-1.5 py-0.5 rounded font-bold text-[10px] ${t.side === 'LONG' ? 'bg-accentGreen text-slate-950' : 'bg-accentRed text-white'}`;
            }
            if (entryEl) entryEl.innerText = t.entry != null ? `$${Number(t.entry).toFixed(2)}` : '—';

            bar.classList.remove('cd-ok', 'cd-warn', 'cd-urgent');
            if (left <= 0) {
                if (statusEl) statusEl.innerHTML = '<span class="text-accentRed font-bold">CERRAR YA — vigencia agotada</span>';
                if (timerEl) {
                    timerEl.innerText = '00:00:00';
                    timerEl.className = 'font-mono font-bold text-accentRed text-sm tabular-nums';
                }
                bar.classList.add('cd-urgent');
                if (btnClose) btnClose.classList.remove('hidden');
            } else if (pctLeft < 0.2) {
                if (statusEl) statusEl.innerHTML = '<span class="text-accentRed">Cerrar pronto</span>';
                if (timerEl) {
                    timerEl.innerText = formatCountdown(left);
                    timerEl.className = 'font-mono font-bold text-accentRed text-sm tabular-nums';
                }
                bar.classList.add('cd-urgent');
                if (btnClose) btnClose.classList.remove('hidden');
            } else if (pctLeft < 0.4) {
                if (statusEl) statusEl.innerText = 'Vigencia media — vigilar TP/SL';
                if (timerEl) {
                    timerEl.innerText = formatCountdown(left);
                    timerEl.className = 'font-mono font-bold text-accentYellow text-sm tabular-nums';
                }
                bar.classList.add('cd-warn');
                if (btnClose) btnClose.classList.remove('hidden');
            } else {
                if (statusEl) statusEl.innerText = `TF ${t.tf || currentInterval} · horizonte estimado`;
                if (timerEl) {
                    timerEl.innerText = formatCountdown(left);
                    timerEl.className = 'font-mono font-bold text-accentGreen text-sm tabular-nums';
                }
                bar.classList.add('cd-ok');
                if (btnClose) btnClose.classList.add('hidden');
            }
        }

        function closeSimulatedPosition() {
            if (!lastConfirmedTrade) return;
            lastConfirmedTrade.closed = true;
            lastConfirmedTrade.closedAt = Date.now();
            // Marcar en historial la posición más reciente abierta
            const openIdx = journalHistory.findIndex(h =>
                !h.closed && h.openedAt && lastConfirmedTrade.openedAt &&
                h.openedAt === lastConfirmedTrade.openedAt
            );
            if (openIdx >= 0) {
                journalHistory[openIdx].closed = true;
                journalHistory[openIdx].closedAt = lastConfirmedTrade.closedAt;
            } else if (journalHistory[0] && !journalHistory[0].closed) {
                journalHistory[0].closed = true;
                journalHistory[0].closedAt = lastConfirmedTrade.closedAt;
            }
            saveJournalToStorage();
            updatePositionCountdownUI();
            renderJournal();
            chartPriceLines.forEach(line => {
                try { candlestickSeries.removePriceLine(line); } catch (e) {}
            });
            chartPriceLines = [];
        }

        // ——— Resize panel operaciones vs gráficos ———
        const LS_PANEL_H = 'terminalmx_panel_h';

        function applyDefaultVerticalSplit() {
            // Gráficos 40% (velas + Trendilo) · resto ~60%
            const split = document.getElementById('chartsSplitContainer');
            const bottom = document.getElementById('bottomPanelSection');
            const main = document.getElementById('mainChartContainer');
            const sub = document.getElementById('subChartContainer');
            const vh = window.innerHeight || 800;
            const chartH = Math.round(vh * 0.40);
            const minChart = Math.round(vh * 0.40);
            const maxChart = Math.round(vh * 0.85);
            if (split) {
                split.style.flex = '0 0 auto';
                split.style.height = chartH + 'px';
                split.style.minHeight = minChart + 'px';
                split.style.maxHeight = maxChart + 'px';
            }
            // Dentro del bloque de gráficos: ~65% velas / ~35% Trendilo
            if (main) {
                main.style.flex = '6.5 1 0';
                main.style.height = '';
                main.style.minHeight = '100px';
                main.classList.remove('chart-hidden');
            }
            if (sub) {
                sub.style.flex = '3.5 1 0';
                sub.style.height = '';
                sub.style.minHeight = '90px';
                sub.style.display = '';
                sub.classList.remove('chart-hidden');
            }
            if (bottom) {
                bottom.style.flex = '1 1 auto';
                bottom.style.height = '';
                bottom.style.minHeight = '280px';
            }
            try {
                localStorage.setItem(LS_PANEL_H, String(Math.round(vh * 0.45)));
                if (typeof saveChartPrefs === 'function') {
                    saveChartPrefs({ mainFlex: 6.5, subFlex: 3.5, mainVisible: true, subVisible: true });
                }
            } catch (e) {}
            setTimeout(function() { if (typeof forceChartResize === 'function') forceChartResize(); }, 50);
            setTimeout(function() { if (typeof forceChartResize === 'function') forceChartResize(); }, 200);
        }

        function applyPanelHeightPrefs() {
            // Siempre proporción 40/60 al cargar (el usuario puede redimensionar después)
            applyDefaultVerticalSplit();
        }

        let isVerticalResizing = false;
        let _resizeRaf = null;

        function _showResizeOverlay(on) {
            const ov = document.getElementById('resizeDragOverlay');
            if (ov) ov.classList.toggle('active', !!on);
            document.body.classList.toggle('is-resizing', !!on);
        }

        function scheduleChartResize() {
            if (_resizeRaf) return;
            _resizeRaf = requestAnimationFrame(() => {
                _resizeRaf = null;
                forceChartResize();
            });
        }

        function initPanelResizeHandle() {
            const handle = document.getElementById('panelResizeHandle');
            const bottom = document.getElementById('bottomPanelSection');
            const main = document.querySelector('main');
            if (!handle || !bottom || !main) return;

            let dragging = false;

            const applyH = (clientY) => {
                const split = document.getElementById('chartsSplitContainer');
                const vh = window.innerHeight || 800;
                const minChart = Math.round(vh * 0.40);
                const maxChart = Math.round(vh * 0.85);
                // clientY respecto al main: altura de gráficos = clientY - top del área de charts
                const splitEl = split || main;
                const top = (split && split.getBoundingClientRect().top) || main.getBoundingClientRect().top;
                let chartH = clientY - top;
                chartH = Math.max(minChart, Math.min(maxChart, chartH));
                if (split) {
                    split.style.flex = '0 0 auto';
                    split.style.height = Math.round(chartH) + 'px';
                    split.style.minHeight = minChart + 'px';
                    split.style.maxHeight = maxChart + 'px';
                }
                // El panel inferior ocupa el resto disponible
                const mainRect = main.getBoundingClientRect();
                const rest = Math.max(200, mainRect.bottom - (top + chartH));
                bottom.style.flex = '1 1 auto';
                bottom.style.height = '';
                bottom.style.minHeight = '200px';
                scheduleChartResize();
            };

            const startDrag = (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                isVerticalResizing = true;
                handle.classList.add('dragging');
                _showResizeOverlay(true);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                isVerticalResizing = false;
                handle.classList.remove('dragging');
                _showResizeOverlay(false);
                try { localStorage.setItem(LS_PANEL_H, String(bottom.offsetHeight)); } catch (e) {}
                forceChartResize();
            };

            handle.addEventListener('mousedown', startDrag);
            handle.addEventListener('dblclick', (e) => {
                e.preventDefault();
                applyDefaultVerticalSplit();
                forceChartResize();
            });
            window.addEventListener('mousemove', (e) => { if (dragging) applyH(e.clientY); });
            window.addEventListener('mouseup', endDrag);
            handle.addEventListener('touchstart', (e) => {
                if (e.touches[0]) startDrag(e);
            }, { passive: false });
            window.addEventListener('touchmove', (e) => {
                if (!dragging || !e.touches[0]) return;
                e.preventDefault();
                applyH(e.touches[0].clientY);
            }, { passive: false });
            window.addEventListener('touchend', endDrag);
            // Overlay también captura eventos
            const ov = document.getElementById('resizeDragOverlay');
            if (ov) {
                ov.addEventListener('mousemove', (e) => { if (dragging) applyH(e.clientY); });
                ov.addEventListener('mouseup', endDrag);
                ov.addEventListener('touchmove', (e) => {
                    if (!dragging || !e.touches[0]) return;
                    e.preventDefault();
                    applyH(e.touches[0].clientY);
                }, { passive: false });
                ov.addEventListener('touchend', endDrag);
            }
        }

        function forceChartResize() {
            const mainEl = document.getElementById('candlestickChart');
            const subEl = document.getElementById('trendiloChart');
            const mainBox = document.getElementById('mainChartContainer');
            const subBox = document.getElementById('subChartContainer');
            if (mainChart && mainEl) {
                const w = Math.max(mainEl.clientWidth || mainBox?.clientWidth || 0, 100);
                const h = Math.max(mainEl.clientHeight || mainBox?.clientHeight || 0, 80);
                if (w > 0 && h > 0) {
                    try { mainChart.applyOptions({ width: w, height: h }); } catch (e) {}
                }
            }
            if (trendiloChart && subEl) {
                const w2 = Math.max(subEl.clientWidth || subBox?.clientWidth || 0, 100);
                const h2 = Math.max(subEl.clientHeight || subBox?.clientHeight || 0, 60);
                if (w2 > 0 && h2 > 0) {
                    try { trendiloChart.applyOptions({ width: w2, height: h2 }); } catch (e) {}
                }
            }
            scheduleYoshiObRender();
        }

        function handleResize() {
            forceChartResize();
        }
        window.forceChartResize = forceChartResize;
        window.applyDefaultVerticalSplit = applyDefaultVerticalSplit;


        const LS_PANEL_VISIBLE = 'terminalmx_panel_visible';

        function updateHamburgerUI(open) {
            const btn = document.getElementById('btnHamburgerPanel');
            if (!btn) return;
            btn.classList.toggle('active', !!open);
            btn.setAttribute('aria-pressed', open ? 'true' : 'false');
            btn.title = open ? 'Ocultar Paper Trading' : 'Mostrar Paper Trading';
        }

        function toggleLeftPanel(force) {
            const panel = document.getElementById('leftPanel');
            const overlay = document.getElementById('mobileOverlay');
            const btn = document.getElementById('btnHamburgerPanel');
            if (!panel) return;
            const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
            if (isDesktop) {
                panel.classList.remove('mobile-open');
                if (overlay) overlay.classList.remove('show');
                document.body.style.overflow = '';
                if (btn) btn.classList.remove('active');
                return;
            }
            const isOpen = panel.classList.contains('mobile-open');
            const open = typeof force === 'boolean' ? force : !isOpen;
            if (open) {
                panel.classList.add('mobile-open');
                if (overlay) overlay.classList.add('show');
                document.body.style.overflow = 'hidden';
                if (btn) btn.classList.add('active');
            } else {
                panel.classList.remove('mobile-open');
                if (overlay) overlay.classList.remove('show');
                document.body.style.overflow = '';
                if (btn) btn.classList.remove('active');
            }
            setTimeout(function() { if (typeof forceChartResize === 'function') forceChartResize(); }, 50);
        }
        window.toggleLeftPanel = toggleLeftPanel;



        function addChartSeries(chart, type, options) {
            if (chart.addSeries && LightweightCharts[type + 'Series']) {
                return chart.addSeries(LightweightCharts[type + 'Series'], options);
            } else if (chart[`add${type}Series`]) {
                return chart[`add${type}Series`](options);
            } else if (chart.addSeries) {
                return chart.addSeries(type, options);
            }
        }

        function initCharts() {
            const mainContainer = document.getElementById('candlestickChart');
            const mainBox = document.getElementById('mainChartContainer');
            const initW = Math.max(mainContainer?.clientWidth || mainBox?.clientWidth || window.innerWidth - 40, 320);
            const initH = Math.max(mainContainer?.clientHeight || mainBox?.clientHeight || 0, 300);
            mainChart = LightweightCharts.createChart(mainContainer, {
                width: initW,
                height: initH,
                layout: {
                    background: { color: '#0b0e11' },
                    textColor: '#919b9b',
                    fontFamily: "'Inter', sans-serif"
                },
                grid: {
                    vertLines: { color: 'rgba(43,49,58,0.6)' },
                    horzLines: { color: 'rgba(43,49,58,0.6)' }
                },
                crosshair: {
                    mode: LightweightCharts.CrosshairMode.Normal,
                    vertLine: { color: 'rgba(240,185,11,0.4)', width: 1, style: 2, labelBackgroundColor: '#2b313a' },
                    horzLine: { color: 'rgba(240,185,11,0.4)', width: 1, style: 2, labelBackgroundColor: '#2b313a' }
                },
                rightPriceScale: {
                    borderColor: '#2b313a',
                    scaleMargins: { top: 0.08, bottom: 0.18 }
                },
                timeScale: {
                    borderColor: '#2b313a',
                    timeVisible: true,
                    secondsVisible: false,
                    rightOffset: 8,
                    barSpacing: 8,
                    minBarSpacing: 3
                },
                handleScroll: {
                    mouseWheel: true,
                    pressedMouseMove: true,
                    horzTouchDrag: true,
                    vertTouchDrag: false
                },
                handleScale: {
                    axisPressedMouseMove: { time: true, price: true },
                    axisDoubleClickReset: { time: true, price: true },
                    mouseWheel: true,
                    pinch: true
                },
                kineticScroll: { touch: true, mouse: true }
            });

            candlestickSeries = addChartSeries(mainChart, 'Candlestick', {
                upColor: '#0ecb81', downColor: '#f6465d',
                borderDownColor: '#f6465d', borderUpColor: '#0ecb81',
                wickDownColor: '#f6465d', wickUpColor: '#0ecb81'
            });

            lineSeriesMain = addChartSeries(mainChart, 'Line', {
                color: '#0ecb81', lineWidth: 2, visible: false, lastValueVisible: false, priceLineVisible: false
            });
            areaSeriesMain = addChartSeries(mainChart, 'Area', {
                lineColor: '#0ecb81', topColor: 'rgba(14,203,129,0.35)', bottomColor: 'rgba(14,203,129,0.02)',
                lineWidth: 2, visible: false, lastValueVisible: false, priceLineVisible: false
            });

            volumeSeries = addChartSeries(mainChart, 'Histogram', {
                color: '#26a69a', priceFormat: { type: 'volume' },
                priceScaleId: 'vol',
                scaleMargins: { top: 0.82, bottom: 0 }
            });
            try {
                mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
            } catch (e) {}

            // SMMA 20 (cyan) + SMMA 50 (amarillo) — misma escala de precio que las velas
            smma20Series = addChartSeries(mainChart, 'Line', {
                color: '#00bcd4',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: true,
                title: 'SMMA 20',
                crosshairMarkerVisible: true
            });
            ema50Series = addChartSeries(mainChart, 'Line', {
                color: '#f0b90b',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: true,
                title: 'SMMA 50',
                crosshairMarkerVisible: true
            });

            // Yoshi SuperTrend (línea rota up/down como TradingView)
            supertrendUpSeries = addChartSeries(mainChart, 'Line', {
                color: '#0ecb81',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: false,
                title: 'ST Up',
                crosshairMarkerVisible: false
            });
            supertrendDnSeries = addChartSeries(mainChart, 'Line', {
                color: '#f6465d',
                lineWidth: 2,
                priceLineVisible: false,
                lastValueVisible: false,
                title: 'ST Down',
                crosshairMarkerVisible: false
            });
            supertrendSeries = supertrendUpSeries;

            // OHLC legend + click H-Line
            mainChart.subscribeCrosshairMove((param) => {
                updateOhlcLegend(param);
                if (trendiloChart && param && param.time && !syncingTimeScale) {
                    // solo actualiza legend; sync de scroll va por timeScale
                }
            });
            mainChart.subscribeClick((param) => {
                if (!hlineToolActive || !param || param.point === undefined) return;
                const price = candlestickSeries.coordinateToPrice(param.point.y);
                if (price == null || isNaN(price)) return;
                addUserHorizontalLine(price);
            });

            // Sync time scales main <-> trendilo
            mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
                if (!range) return;
                // Guardar posición del usuario mientras navega
                if (!syncingTimeScale && Number.isFinite(range.from) && Number.isFinite(range.to)) {
                    savedChartLogicalRange = { from: range.from, to: range.to };
                }
                scheduleYoshiObRender();
                if (syncingTimeScale || !trendiloChart) return;
                syncingTimeScale = true;
                try { trendiloChart.timeScale().setVisibleLogicalRange(range); } catch (e) {}
                syncingTimeScale = false;
            });
            try {
                mainChart.subscribeCrosshairMove(() => scheduleYoshiObRender());
            } catch (e) {}

            const subContainer = document.getElementById('trendiloChart');
            const subBox = document.getElementById('subChartContainer');
            const subW = Math.max(subContainer?.clientWidth || subBox?.clientWidth || window.innerWidth - 40, 320);
            const subH = Math.max(subContainer?.clientHeight || subBox?.clientHeight || 0, 140);
            trendiloChart = LightweightCharts.createChart(subContainer, {
                width: subW,
                height: subH,
                layout: { background: { color: '#000000' }, textColor: '#b2b5be', fontFamily: "'Inter', sans-serif" },
                grid: {
                    vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
                    horzLines: { color: 'rgba(42, 46, 57, 0.5)' }
                },
                crosshair: {
                    mode: LightweightCharts.CrosshairMode.Normal,
                    vertLine: { color: 'rgba(178, 181, 190, 0.35)', width: 1, style: 2, labelBackgroundColor: '#2962ff' },
                    horzLine: { color: 'rgba(178, 181, 190, 0.35)', width: 1, style: 2, labelBackgroundColor: '#2962ff' }
                },
                rightPriceScale: {
                    borderColor: 'rgba(42, 46, 57, 0.8)',
                    borderVisible: false,
                    scaleMargins: { top: 0.08, bottom: 0.12 }
                },
                timeScale: {
                    borderColor: 'rgba(42, 46, 57, 0.8)',
                    timeVisible: true,
                    rightOffset: 8,
                    barSpacing: 8,
                    visible: false
                },
                handleScroll: {
                    mouseWheel: true,
                    pressedMouseMove: true,
                    horzTouchDrag: true,
                    vertTouchDrag: false
                },
                handleScale: {
                    mouseWheel: true,
                    pinch: true,
                    axisPressedMouseMove: { time: true, price: true }
                },
                kineticScroll: { touch: true, mouse: true }
            });

            // Trendilo estilo TradingView: Baseline (relleno ±0) + bandas RMS moradas
            trendiloHistSeries = null; // ya no usamos histograma
            try {
                trendiloAlmaSeries = addChartSeries(trendiloChart, 'Baseline', {
                    baseValue: { type: 'price', price: 0 },
                    topLineColor: 'rgba(180, 190, 200, 0.95)',
                    topFillColor1: 'rgba(38, 166, 154, 0.45)',
                    topFillColor2: 'rgba(38, 166, 154, 0.05)',
                    bottomLineColor: 'rgba(180, 190, 200, 0.95)',
                    bottomFillColor1: 'rgba(255, 152, 0, 0.08)',
                    bottomFillColor2: 'rgba(239, 83, 80, 0.40)',
                    lineWidth: 2,
                    priceLineVisible: false,
                    lastValueVisible: true,
                    title: 'ALMA',
                    priceFormat: { type: 'custom', formatter: val => Number(val).toFixed(8).replace(/\.?0+$/, '') || '0' },
                    priceScaleId: 'right'
                });
            } catch (e) {
                // Fallback si Baseline no está disponible
                trendiloAlmaSeries = addChartSeries(trendiloChart, 'Line', {
                    color: '#b0bec5', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'ALMA'
                });
            }
            // Bandas RMS simétricas (morado TradingView)
            trendiloRmsUpper = addChartSeries(trendiloChart, 'Line', {
                color: '#ab47bc',
                lineWidth: 2,
                lineStyle: 0,
                priceLineVisible: false,
                lastValueVisible: true,
                title: '+RMS',
                priceFormat: { type: 'custom', formatter: val => Number(val).toFixed(8).replace(/\.?0+$/, '') || '0' }
            });
            trendiloRmsLower = addChartSeries(trendiloChart, 'Line', {
                color: '#ab47bc',
                lineWidth: 2,
                lineStyle: 0,
                priceLineVisible: false,
                lastValueVisible: true,
                title: '-RMS',
                priceFormat: { type: 'custom', formatter: val => Number(val).toFixed(8).replace(/\.?0+$/, '') || '0' }
            });
            // Línea cero de referencia
            try {
                trendiloZeroSeries = addChartSeries(trendiloChart, 'Line', {
                    color: 'rgba(145, 155, 155, 0.55)',
                    lineWidth: 1,
                    lineStyle: 2,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false
                });
            } catch (e) { trendiloZeroSeries = null; }

            // StochRSI en el mismo panel pero discreto (escala inferior)
            stochKSeries = addChartSeries(trendiloChart, 'Line', {
                color: 'rgba(240, 185, 11, 0.35)', lineWidth: 1, priceScaleId: 'stoch',
                lastValueVisible: false, priceLineVisible: false
            });
            stochDSeries = addChartSeries(trendiloChart, 'Line', {
                color: 'rgba(0, 188, 212, 0.35)', lineWidth: 1, priceScaleId: 'stoch',
                lastValueVisible: false, priceLineVisible: false
            });
            try {
                trendiloChart.priceScale('right').applyOptions({
                    scaleMargins: { top: 0.08, bottom: 0.12 },
                    borderVisible: false
                });
                trendiloChart.priceScale('stoch').applyOptions({
                    scaleMargins: { top: 0.82, bottom: 0 },
                    visible: false
                });
            } catch (e) {}

            trendiloChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
                if (syncingTimeScale || !range || !mainChart) return;
                syncingTimeScale = true;
                try { mainChart.timeScale().setVisibleLogicalRange(range); } catch (e) {}
                syncingTimeScale = false;
            });
        }

        function toHeikinAshi(klines) {
            const ha = [];
            let prevHa = null;
            for (let i = 0; i < klines.length; i++) {
                const k = klines[i];
                const haClose = (k.open + k.high + k.low + k.close) / 4;
                const haOpen = prevHa
                    ? (prevHa.open + prevHa.close) / 2
                    : (k.open + k.close) / 2;
                const haHigh = Math.max(k.high, haOpen, haClose);
                const haLow = Math.min(k.low, haOpen, haClose);
                prevHa = { open: haOpen, high: haHigh, low: haLow, close: haClose };
                ha.push({ time: k.time, open: haOpen, high: haHigh, low: haLow, close: haClose });
            }
            return ha;
        }

        let savedChartLogicalRange = null;
        let chartViewInitialized = false;
        let lastChartTf = null;

        function captureChartView() {
            try {
                if (mainChart) {
                    const r = mainChart.timeScale().getVisibleLogicalRange();
                    if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) {
                        savedChartLogicalRange = { from: r.from, to: r.to };
                    }
                }
            } catch (e) {}
        }

        function restoreChartView() {
            if (!savedChartLogicalRange || !mainChart) return false;
            try {
                const r = savedChartLogicalRange;
                // Evitar rangos degenerados
                if (!Number.isFinite(r.from) || !Number.isFinite(r.to) || r.to <= r.from) return false;
                mainChart.timeScale().setVisibleLogicalRange(r);
                if (trendiloChart) {
                    try { trendiloChart.timeScale().setVisibleLogicalRange(r); } catch (e) {}
                }
                return true;
            } catch (e) {
                return false;
            }
        }

        function applyMainChartData(opts) {
            opts = opts || {};
            const preserveView = opts.preserveView !== false;
            if (!rawKlines.length || !candlestickSeries) return;

            if (preserveView && chartViewInitialized) captureChartView();

            const candleData = chartType === 'heikin' ? toHeikinAshi(rawKlines) : rawKlines.map(k => ({
                time: k.time, open: k.open, high: k.high, low: k.low, close: k.close
            }));
            const lineData = candleData.map(k => ({ time: k.time, value: k.close }));

            const showCandle = chartType === 'candle' || chartType === 'heikin';
            const showLine = chartType === 'line';
            const showArea = chartType === 'area';

            try {
                candlestickSeries.applyOptions({ visible: showCandle });
                if (lineSeriesMain) lineSeriesMain.applyOptions({ visible: showLine });
                if (areaSeriesMain) areaSeriesMain.applyOptions({ visible: showArea });
            } catch (e) {}

            if (showCandle) candlestickSeries.setData(candleData);
            if (showLine && lineSeriesMain) lineSeriesMain.setData(lineData);
            if (showArea && areaSeriesMain) areaSeriesMain.setData(lineData);

            if (volumeSeries) {
                volumeSeries.setData(rawKlines.map(k => ({
                    time: k.time,
                    value: k.volume,
                    color: k.close >= k.open ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)'
                })));
                try { volumeSeries.applyOptions({ visible: volumeVisible }); } catch (e) {}
            }

            // Order Flow overlay
            try {
                if (typeof scheduleOrderFlowRender === 'function') {
                    scheduleOrderFlowRender();
                    setTimeout(scheduleOrderFlowRender, 100);
                }
            } catch (e) {}

            // Restaurar vista del usuario (no saltar al inicio en cada refresh)
            if (preserveView && chartViewInitialized) {
                requestAnimationFrame(() => {
                    if (!restoreChartView()) {
                        // Si falla, al menos no forzar fitContent
                    }
                });
            }

            // Legend última vela
            const last = candleData[candleData.length - 1];
            if (last) updateOhlcLegendFromBar(last, candleData[candleData.length - 2]);
        }

        function setChartType(type) {
            chartType = type;
            document.querySelectorAll('.ctype-btn').forEach(b => {
                b.className = 'ctype-btn px-2 py-1 rounded font-medium text-slate-400 hover:text-white';
            });
            const active = document.getElementById('ctype-' + type);
            if (active) active.className = 'ctype-btn px-2 py-1 rounded font-medium bg-borderBg text-white';
            applyMainChartData();
        }

        function updateOhlcLegend(param) {
            if (!param || !param.time || !rawKlines.length) {
                return;
            }
            let bar = null;
            if (param.seriesData && candlestickSeries) {
                bar = param.seriesData.get(candlestickSeries);
            }
            if (!bar || bar.open === undefined) {
                // buscar por time
                const t = param.time;
                const found = rawKlines.find(k => k.time === t);
                if (found) bar = found;
            }
            if (!bar || bar.open === undefined) return;
            updateOhlcLegendFromBar(bar);
        }

        function updateOhlcLegendFromBar(bar, prev) {
            const o = document.getElementById('legO');
            const h = document.getElementById('legH');
            const l = document.getElementById('legL');
            const c = document.getElementById('legC');
            const chg = document.getElementById('legChg');
            if (!o) return;
            o.innerText = Number(bar.open).toFixed(2);
            h.innerText = Number(bar.high).toFixed(2);
            l.innerText = Number(bar.low).toFixed(2);
            c.innerText = Number(bar.close).toFixed(2);
            const base = prev ? prev.close : bar.open;
            const pct = base ? ((bar.close - base) / base) * 100 : 0;
            if (chg) {
                chg.innerText = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
                chg.className = pct >= 0 ? 'text-accentGreen' : 'text-accentRed';
            }
            c.className = bar.close >= bar.open ? 'text-accentGreen' : 'text-accentRed';
        }

        function chartFitContent() {
            try {
                if (mainChart) mainChart.timeScale().fitContent();
                if (trendiloChart) trendiloChart.timeScale().fitContent();
            } catch (e) {}
        }

        function chartResetZoom() {
            try {
                if (mainChart) {
                    mainChart.timeScale().resetTimeScale();
                    mainChart.priceScale('right').applyOptions({ autoScale: true });
                }
                if (trendiloChart) trendiloChart.timeScale().resetTimeScale();
            } catch (e) {
                chartFitContent();
            }
        }

        /** Controles − + ← → ↻ */
        function chartZoomIn() {
            try {
                if (!mainChart) return;
                const ts = mainChart.timeScale();
                const spacing = ts.options().barSpacing || 8;
                ts.applyOptions({ barSpacing: Math.min(40, spacing * 1.25) });
                if (trendiloChart) {
                    const t2 = trendiloChart.timeScale();
                    t2.applyOptions({ barSpacing: Math.min(40, (t2.options().barSpacing || spacing) * 1.25) });
                }
            } catch (e) { console.warn(e); }
        }

        function chartZoomOut() {
            try {
                if (!mainChart) return;
                const ts = mainChart.timeScale();
                const spacing = ts.options().barSpacing || 8;
                ts.applyOptions({ barSpacing: Math.max(2, spacing / 1.25) });
                if (trendiloChart) {
                    const t2 = trendiloChart.timeScale();
                    t2.applyOptions({ barSpacing: Math.max(2, (t2.options().barSpacing || spacing) / 1.25) });
                }
            } catch (e) { console.warn(e); }
        }

        function chartScrollLeft() {
            try {
                if (!mainChart) return;
                mainChart.timeScale().scrollToPosition(
                    (mainChart.timeScale().scrollPosition?.() ?? 0) + 8,
                    false
                );
                // API: scrollToPosition(position, animated) — position relativo al extremo derecho
                const logical = mainChart.timeScale().getVisibleLogicalRange();
                if (logical) {
                    const width = logical.to - logical.from;
                    mainChart.timeScale().setVisibleLogicalRange({
                        from: logical.from - width * 0.25,
                        to: logical.to - width * 0.25
                    });
                    if (trendiloChart) {
                        trendiloChart.timeScale().setVisibleLogicalRange({
                            from: logical.from - width * 0.25,
                            to: logical.to - width * 0.25
                        });
                    }
                }
            } catch (e) { console.warn(e); }
        }

        function chartScrollRight() {
            try {
                if (!mainChart) return;
                const logical = mainChart.timeScale().getVisibleLogicalRange();
                if (logical) {
                    const width = logical.to - logical.from;
                    mainChart.timeScale().setVisibleLogicalRange({
                        from: logical.from + width * 0.25,
                        to: logical.to + width * 0.25
                    });
                    if (trendiloChart) {
                        trendiloChart.timeScale().setVisibleLogicalRange({
                            from: logical.from + width * 0.25,
                            to: logical.to + width * 0.25
                        });
                    }
                }
            } catch (e) { console.warn(e); }
        }

        function chartResetView() {
            try {
                if (mainChart) {
                    mainChart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 8 });
                    mainChart.timeScale().fitContent();
                    mainChart.priceScale('right').applyOptions({ autoScale: true });
                }
                if (trendiloChart) {
                    trendiloChart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 8 });
                    trendiloChart.timeScale().fitContent();
                }
            } catch (e) {
                chartFitContent();
            }
        }

        window.chartZoomIn = chartZoomIn;
        window.chartZoomOut = chartZoomOut;
        window.chartScrollLeft = chartScrollLeft;
        window.chartScrollRight = chartScrollRight;
        window.chartResetView = chartResetView;

        function toggleVolumeOverlay() {
            volumeVisible = !volumeVisible;
            if (volumeSeries) try { volumeSeries.applyOptions({ visible: volumeVisible }); } catch (e) {}
            const btn = document.getElementById('btnToggleVol');
            if (btn) btn.classList.toggle('text-accentYellow', volumeVisible);
            if (btn) btn.classList.toggle('opacity-50', !volumeVisible);
        }

        function toggleEma50Overlay() {
            ema50Visible = !ema50Visible;
            try {
                if (ema50Series) ema50Series.applyOptions({ visible: ema50Visible });
                if (smma20Series) smma20Series.applyOptions({ visible: ema50Visible });
            } catch (e) {}
            const btn = document.getElementById('btnToggleEma');
            if (btn) {
                btn.classList.toggle('text-accentYellow', ema50Visible);
                btn.classList.toggle('opacity-50', !ema50Visible);
            }
        }

        function toggleHlineTool() {
            hlineToolActive = !hlineToolActive;
            const btn = document.getElementById('btnHlineTool');
            if (btn) {
                btn.classList.toggle('text-accentYellow', hlineToolActive);
                btn.classList.toggle('bg-accentYellow/15', hlineToolActive);
                btn.classList.toggle('border-accentYellow/40', hlineToolActive);
            }
            const el = document.getElementById('candlestickChart');
            if (el) el.style.cursor = hlineToolActive ? 'crosshair' : '';
        }

        function addUserHorizontalLine(price) {
            if (!candlestickSeries) return;
            try {
                const line = candlestickSeries.createPriceLine({
                    price: price,
                    color: '#f0b90b',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: `$${price.toFixed(1)}`
                });
                userPriceLines.push(line);
            } catch (e) {
                console.warn(e);
            }
        }

        function clearUserPriceLines() {
            userPriceLines.forEach(line => {
                try { candlestickSeries.removePriceLine(line); } catch (e) {}
            });
            userPriceLines = [];
        }

        function screenshotChart() {
            try {
                if (!mainChart || typeof mainChart.takeScreenshot !== 'function') {
                    alert('Captura no disponible en esta versión del chart.');
                    return;
                }
                const canvas = mainChart.takeScreenshot();
                const a = document.createElement('a');
                a.download = `TerminalMX_${Date.now()}.png`;
                a.href = canvas.toDataURL('image/png');
                a.click();
            } catch (e) {
                console.error(e);
                alert('No se pudo generar la captura.');
            }
        }

        function toggleChartFullscreen() {
            // Si está en modo solo gráficos, salir primero
            if (document.body.classList.contains('charts-only-mode')) {
                toggleChartsOnlyMode(false);
            }
            const container = document.getElementById('mainChartContainer');
            const icon = document.getElementById('fsIcon');
            const label = document.getElementById('fsLabel');
            if (!container) return;
            const isFs = container.classList.toggle('chart-fs');
            document.body.classList.toggle('chart-fs-active', isFs);
            if (icon) icon.className = isFs ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
            if (label) label.innerText = isFs ? 'Salir' : 'Pantalla completa';
            setTimeout(handleResize, 80);
        }

        function toggleHideCharts(force) {
            const on = typeof force === 'boolean' ? force : !document.body.classList.contains('charts-hidden-mode');
            document.body.classList.toggle('charts-hidden-mode', on);
            if (on && document.body.classList.contains('charts-only-mode')) {
                try { toggleChartsOnlyMode(false); } catch (e) {}
            }
            const btn = document.getElementById('btnHideCharts');
            const icon = document.getElementById('hideChartsIcon');
            const label = document.getElementById('hideChartsLabel');
            if (btn) btn.classList.toggle('active', on);
            if (icon) icon.className = on ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
            if (label) label.innerText = on ? 'Ver gráficos' : 'Ocultar gráficos';
            try { localStorage.setItem('terminalmx_charts_hidden', on ? '1' : '0'); } catch (e) {}
            setTimeout(function() { if (typeof forceChartResize === 'function') forceChartResize(); }, 80);
            setTimeout(function() { if (typeof forceChartResize === 'function') forceChartResize(); }, 250);
        }
        window.toggleHideCharts = toggleHideCharts;

        /** Solo gráficos: velas + Trendilo a pantalla completa (oculta paneles) */

        function toggleChartsOnlyMode(force) {
            // Salir de fullscreen de un solo gráfico si estaba activo
            const mainC = document.getElementById('mainChartContainer');
            if (mainC && mainC.classList.contains('chart-fs')) {
                mainC.classList.remove('chart-fs');
                document.body.classList.remove('chart-fs-active');
                const icon = document.getElementById('fsIcon');
                const label = document.getElementById('fsLabel');
                if (icon) icon.className = 'fa-solid fa-expand';
                if (label) label.innerText = 'Pantalla completa';
            }

            const on = typeof force === 'boolean' ? force : !document.body.classList.contains('charts-only-mode');
            document.body.classList.toggle('charts-only-mode', on);

            const btnIcon = document.getElementById('chartsOnlyIcon');
            const btnLabel = document.getElementById('chartsOnlyLabel');
            if (btnIcon) btnIcon.className = on ? 'fa-solid fa-compress' : 'fa-solid fa-chart-area';
            if (btnLabel) btnLabel.innerText = on ? 'Salir' : 'Solo gráficos';

            // Cerrar panel móvil si estaba abierto
            if (on) {
                try { toggleLeftPanel(false); } catch (e) {}
            }

            setTimeout(handleResize, 100);
            setTimeout(handleResize, 300);
        }

        // ESC para salir de fullscreen / solo gráficos
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (document.body.classList.contains('charts-only-mode')) {
                    toggleChartsOnlyMode(false);
                    return;
                }
                const container = document.getElementById('mainChartContainer');
                if (container && container.classList.contains('chart-fs')) toggleChartFullscreen();
            }
        });

        function applyChartPrefs() {
            const p = loadChartPrefs();
            const main = document.getElementById('mainChartContainer');
            const sub = document.getElementById('subChartContainer');
            const handle = document.getElementById('chartResizeHandle');
            if (main) {
                main.style.height = '';
                main.style.flex = `${p.mainFlex} 1 0`;
                main.classList.toggle('chart-hidden', !p.mainVisible);
            }
            if (sub) {
                sub.style.height = '';
                sub.style.flex = `${p.subFlex} 1 0`;
                sub.classList.toggle('chart-hidden', !p.subVisible);
            }
            if (handle) {
                const both = p.mainVisible && p.subVisible;
                handle.classList.toggle('handle-hidden', !both);
            }
            updateChartToggleButtons(p);
            setTimeout(forceChartResize, 50);
            setTimeout(forceChartResize, 200);
        }

        function updateChartToggleButtons(p) {
            p = p || loadChartPrefs();
            const btnMain = document.getElementById('btnToggleMainChart');
            const btnSub = document.getElementById('btnToggleSubChart');
            if (btnMain) {
                btnMain.classList.toggle('text-accentYellow', p.mainVisible);
                btnMain.classList.toggle('opacity-50', !p.mainVisible);
            }
            if (btnSub) {
                btnSub.classList.toggle('text-accentYellow', p.subVisible);
                btnSub.classList.toggle('opacity-50', !p.subVisible);
            }
        }

        function toggleChartVisibility(which) {
            const p = loadChartPrefs();
            if (which === 'main') p.mainVisible = !p.mainVisible;
            if (which === 'sub') p.subVisible = !p.subVisible;
            // No permitir ocultar ambos
            if (!p.mainVisible && !p.subVisible) {
                if (which === 'main') p.subVisible = true;
                else p.mainVisible = true;
            }
            saveChartPrefs(p);
            applyChartPrefs();
        }


        function initTrendiloProjChartResize() {
            const handle = document.getElementById('trendiloProjResizeHandle');
            const wrap = document.getElementById('trendiloProjChartWrap');
            if (!handle || !wrap || handle.dataset.bound === '1') return;
            handle.dataset.bound = '1';
            let dragging = false;
            const onMove = (clientY) => {
                const rect = wrap.getBoundingClientRect();
                let h = clientY - rect.top;
                h = Math.max(180, Math.min(window.innerHeight * 0.7, h));
                wrap.style.height = Math.round(h) + 'px';
                try {
                    if (trendiloProjChart) {
                        const el = document.getElementById('trendiloProjChart');
                        trendiloProjChart.applyOptions({
                            width: Math.max(el.clientWidth || 280, 260),
                            height: Math.max((el.clientHeight || h - 12), 140)
                        });
                    }
                } catch (e) {}
            };
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                dragging = true;
                handle.classList.add('dragging');
                _showResizeOverlay(true);
            });
            window.addEventListener('mousemove', (e) => {
                if (dragging) onMove(e.clientY);
            });
            window.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                _showResizeOverlay(false);
            });
            handle.addEventListener('touchstart', (e) => {
                if (!e.touches[0]) return;
                e.preventDefault();
                dragging = true;
                handle.classList.add('dragging');
            }, { passive: false });
            window.addEventListener('touchmove', (e) => {
                if (!dragging || !e.touches[0]) return;
                e.preventDefault();
                onMove(e.touches[0].clientY);
            }, { passive: false });
            window.addEventListener('touchend', () => {
                dragging = false;
                handle.classList.remove('dragging');
            });
        }

        function initChartResizeHandle() {
            const handle = document.getElementById('chartResizeHandle');
            const split = document.getElementById('chartsSplitContainer');
            const main = document.getElementById('mainChartContainer');
            const sub = document.getElementById('subChartContainer');
            if (!handle || !split || !main || !sub) return;

            let dragging = false;

            const applySplit = (clientY) => {
                const rect = split.getBoundingClientRect();
                const handleH = handle.offsetHeight || 8;
                const usable = rect.height - handleH;
                if (usable < 160) return;
                // Mínimos para que velas y Trendilo siempre se vean
                const minMain = Math.max(100, Math.round(usable * 0.25));
                const minSub = Math.max(80, Math.round(usable * 0.18));
                let mainH = clientY - rect.top;
                mainH = Math.max(minMain, Math.min(usable - minSub, mainH));
                const subH = usable - mainH;
                main.style.flex = '0 0 auto';
                sub.style.flex = '0 0 auto';
                main.style.height = Math.round(mainH) + 'px';
                main.style.minHeight = minMain + 'px';
                sub.style.height = Math.round(subH) + 'px';
                sub.style.minHeight = minSub + 'px';
                sub.style.display = '';
                sub.classList.remove('chart-hidden');
                scheduleChartResize();
            };

            const startDrag = (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                isVerticalResizing = true;
                handle.classList.add('dragging');
                _showResizeOverlay(true);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                isVerticalResizing = false;
                handle.classList.remove('dragging');
                _showResizeOverlay(false);
                const rect = split.getBoundingClientRect();
                const mainH = main.getBoundingClientRect().height;
                const ratio = rect.height > 0 ? mainH / rect.height : 0.66;
                saveChartPrefs({
                    mainFlex: Math.max(1, Math.round(ratio * 100) / 10),
                    subFlex: Math.max(1, Math.round((1 - ratio) * 100) / 10)
                });
                forceChartResize();
            };

            handle.addEventListener('mousedown', startDrag);
            handle.addEventListener('dblclick', (e) => {
                e.preventDefault();
                main.style.flex = '2 1 0';
                main.style.height = '';
                sub.style.flex = '1 1 0';
                sub.style.height = '';
                saveChartPrefs({ mainFlex: 6.6, subFlex: 3.4 });
                forceChartResize();
            });
            window.addEventListener('mousemove', (e) => { if (dragging) applySplit(e.clientY); });
            window.addEventListener('mouseup', endDrag);
            handle.addEventListener('touchstart', (e) => {
                if (e.touches[0]) startDrag(e);
            }, { passive: false });
            window.addEventListener('touchmove', (e) => {
                if (!dragging || !e.touches[0]) return;
                e.preventDefault();
                applySplit(e.touches[0].clientY);
            }, { passive: false });
            window.addEventListener('touchend', endDrag);
            const ov = document.getElementById('resizeDragOverlay');
            if (ov) {
                ov.addEventListener('mousemove', (e) => { if (dragging) applySplit(e.clientY); });
                // mouseup already on window
            }
        }

        function aggregateKlines(oneMinKlines, minutes) {
            if (!oneMinKlines.length || minutes < 2) return oneMinKlines;
            const out = [];
            const bucketSec = minutes * 60;
            let bucket = null;
            for (const k of oneMinKlines) {
                const bStart = Math.floor(k.time / bucketSec) * bucketSec;
                if (!bucket || bucket.time !== bStart) {
                    if (bucket) out.push(bucket);
                    bucket = {
                        time: bStart,
                        open: k.open,
                        high: k.high,
                        low: k.low,
                        close: k.close,
                        volume: k.volume
                    };
                } else {
                    bucket.high = Math.max(bucket.high, k.high);
                    bucket.low = Math.min(bucket.low, k.low);
                    bucket.close = k.close;
                    bucket.volume += k.volume;
                }
            }
            if (bucket) out.push(bucket);
            return out;
        }

        function parseBinanceKlines(raw) {
            return (raw || []).map(d => {
                const vol = parseFloat(d[5]) || 0;
                const takerBuy = parseFloat(d[9]);
                const buyVol = Number.isFinite(takerBuy) ? takerBuy : vol * (parseFloat(d[4]) >= parseFloat(d[1]) ? 0.62 : 0.38);
                const sellVol = Math.max(0, vol - buyVol);
                return {
                    time: Math.floor(d[0] / 1000),
                    open: parseFloat(d[1]),
                    high: parseFloat(d[2]),
                    low: parseFloat(d[3]),
                    close: parseFloat(d[4]),
                    volume: vol,
                    buyVol,
                    sellVol,
                    delta: buyVol - sellVol,
                    trades: parseInt(d[8], 10) || 0
                };
            });
        }

        function parseBybitKlines(rawList) {
            // Bybit v5: list is newest-first → reverse to oldest-first
            const list = (rawList || []).slice().reverse();
            return list.map(d => {
                const o = parseFloat(d[1]), h = parseFloat(d[2]), l = parseFloat(d[3]), c = parseFloat(d[4]);
                const vol = parseFloat(d[5]) || 0;
                const buyVol = vol * (c >= o ? 0.62 : 0.38);
                const sellVol = vol - buyVol;
                return {
                    time: Math.floor(parseInt(d[0], 10) / 1000),
                    open: o, high: h, low: l, close: c,
                    volume: vol, buyVol, sellVol, delta: buyVol - sellVol, trades: 0
                };
            });
        }

        function parseOkxKlines(rawList) {
            // OKX v5: newest-first → reverse; [ts, o, h, l, c, vol, ...]
            const list = (rawList || []).slice().reverse();
            return list.map(d => {
                const o = parseFloat(d[1]), h = parseFloat(d[2]), l = parseFloat(d[3]), c = parseFloat(d[4]);
                const vol = parseFloat(d[5]) || 0;
                const buyVol = vol * (c >= o ? 0.62 : 0.38);
                const sellVol = vol - buyVol;
                return { time: Math.floor(parseInt(d[0], 10) / 1000), open: o, high: h, low: l, close: c, volume: vol, buyVol, sellVol, delta: buyVol - sellVol, trades: 0 };
            });
        }

        // OKX bar map (instId BTC-USDT)
        const OKX_INTERVAL_MAP = {
            '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
            '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
            '1d': '1D', '1w': '1W', '1M': '1M'
        };

        /**
         * Fusiona N series de velas por timestamp.
         * open/close = promedio; high = max; low = min; volume = suma.
         * Suaviza close cuando hay ≥2 fuentes.
         */
        function mergeExchangeKlines(...seriesList) {
            const valid = seriesList.filter(s => s && s.length);
            if (!valid.length) return [];
            if (valid.length === 1) return valid[0].map(k => ({ ...k }));

            const byTime = new Map();
            for (const series of valid) {
                for (const k of series) {
                    if (byTime.has(k.time)) {
                        const a = byTime.get(k.time);
                        a.openSum += k.open;
                        a.closeSum += k.close;
                        a.high = Math.max(a.high, k.high);
                        a.low = Math.min(a.low, k.low);
                        a.volume += k.volume;
                        a._n += 1;
                    } else {
                        byTime.set(k.time, {
                            time: k.time,
                            openSum: k.open,
                            closeSum: k.close,
                            high: k.high,
                            low: k.low,
                            volume: k.volume,
                            _n: 1
                        });
                    }
                }
            }
            const merged = Array.from(byTime.values())
                .sort((a, b) => a.time - b.time)
                .map(a => ({
                    time: a.time,
                    open: a.openSum / a._n,
                    high: a.high,
                    low: a.low,
                    close: a.closeSum / a._n,
                    volume: a.volume,
                    _n: a._n
                }));

            for (let i = 1; i < merged.length; i++) {
                if (merged[i]._n >= 2 && merged[i - 1]._n >= 2) {
                    merged[i].close = merged[i].close * 0.75 + merged[i - 1].close * 0.25;
                }
            }
            return merged.map(({ time, open, high, low, close, volume }) => ({
                time, open, high, low, close, volume
            }));
        }

        async function fetchBinanceKlines(interval, limit, endTimeMs) {
            let url = `https://api.binance.com/api/v3/klines?symbol=${currentSymbol}&interval=${interval}&limit=${Math.min(limit || 150, 1000)}`;
            if (endTimeMs) url += `&endTime=${endTimeMs}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Binance HTTP ' + res.status);
            return parseBinanceKlines(await res.json());
        }

        /** Paginación Binance 1m hasta obtener totalNeeded velas (máx ~3 páginas) */
        async function fetchBinance1mForBars(targetBars, minutesPerBar) {
            const need1m = Math.min(5000, Math.ceil(targetBars * minutesPerBar) + minutesPerBar);
            let all = [];
            let endTime = undefined;
            let guard = 0;
            while (all.length < need1m && guard < 6) {
                guard++;
                const batchLimit = Math.min(1000, need1m - all.length + 5);
                const batch = await fetchBinanceKlines('1m', batchLimit, endTime);
                if (!batch.length) break;
                // batch oldest→newest; prepend older history
                if (all.length === 0) all = batch;
                else all = batch.concat(all);
                endTime = batch[0].time * 1000 - 1;
                if (batch.length < batchLimit) break;
            }
            // dedupe + sort
            const map = new Map();
            for (const k of all) map.set(k.time, k);
            return Array.from(map.values()).sort((a, b) => a.time - b.time);
        }

        async function fetchBybitKlines(interval, limit) {
            const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${currentSymbol}&interval=${interval}&limit=${limit}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Bybit HTTP ' + res.status);
            const json = await res.json();
            if (json.retCode !== 0 && json.retCode !== undefined) {
                throw new Error('Bybit: ' + (json.retMsg || 'error'));
            }
            return parseBybitKlines(json.result?.list || []);
        }

        async function fetchOkxKlines(okxBar, limit) {
            // OKX max limit 300 for candles endpoint
            const lim = Math.min(limit || 300, 300);
            const url = `https://www.okx.com/api/v5/market/candles?instId=${okxInstId(currentSymbol)}&bar=${okxBar}&limit=${lim}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('OKX HTTP ' + res.status);
            const json = await res.json();
            if (json.code !== '0' && json.code !== 0 && json.code !== undefined) {
                throw new Error('OKX: ' + (json.msg || 'error'));
            }
            return parseOkxKlines(json.data || []);
        }

        /** Binance + Bybit + OKX en paralelo; fusiona y reporta fuentes */
        async function fetchMultiExchangeKlines(binanceInterval, bybitInterval, okxBar, limit) {
            const results = await Promise.allSettled([
                fetchBinanceKlines(binanceInterval, limit),
                fetchBybitKlines(bybitInterval, limit),
                fetchOkxKlines(okxBar, limit)
            ]);
            const binanceK = results[0].status === 'fulfilled' ? results[0].value : [];
            const bybitK = results[1].status === 'fulfilled' ? results[1].value : [];
            const okxK = results[2].status === 'fulfilled' ? results[2].value : [];
            const sources = [];
            if (binanceK.length) sources.push('Binance');
            if (bybitK.length) sources.push('Bybit');
            if (okxK.length) sources.push('OKX');
            if (results[0].status === 'rejected') console.warn('Binance:', results[0].reason);
            if (results[1].status === 'rejected') console.warn('Bybit:', results[1].reason);
            if (results[2].status === 'rejected') console.warn('OKX:', results[2].reason);
            return {
                klines: mergeExchangeKlines(binanceK, bybitK, okxK),
                sources,
                binanceCount: binanceK.length,
                bybitCount: bybitK.length,
                okxCount: okxK.length
            };
        }

        // Compat alias
        async function fetchDualKlines(binanceInterval, bybitInterval, limit) {
            const okxBar = OKX_INTERVAL_MAP[binanceInterval] || (binanceInterval === '1m' ? '1m' : '1H');
            return fetchMultiExchangeKlines(binanceInterval, bybitInterval, okxBar, limit);
        }

        let lastDataSources = [];

        async function fetchMarketData() {
            const icon = document.getElementById('refreshIcon');
            if (icon) icon.classList.add('fa-spin');
            const myGen = ++fetchGeneration;
            const tfAtStart = currentInterval;

            try {
                let data;
                let sourcesInfo = { sources: [], binanceCount: 0, bybitCount: 0, okxCount: 0 };

                if (CUSTOM_TF_MINUTES[tfAtStart]) {
                    const mins = CUSTOM_TF_MINUTES[tfAtStart];
                    // 150 velas del TF = 150*mins de 1m (paginado Binance + complementos BY/OKX)
                    let oneMin = [];
                    try {
                        oneMin = await fetchBinance1mForBars(CANDLE_LIMIT, mins);
                        if (oneMin.length) sourcesInfo.sources.push('Binance');
                        sourcesInfo.binanceCount = oneMin.length;
                    } catch (e) { console.warn('Binance 1m paginado', e); }
                    // Complementar con Bybit/OKX (hasta 1000) y fusionar
                    try {
                        const extra = await Promise.allSettled([
                            fetchBybitKlines('1', Math.min(1000, CANDLE_LIMIT * mins)),
                            fetchOkxKlines('1m', 300)
                        ]);
                        const by = extra[0].status === 'fulfilled' ? extra[0].value : [];
                        const ok = extra[1].status === 'fulfilled' ? extra[1].value : [];
                        if (by.length) { sourcesInfo.sources.push('Bybit'); sourcesInfo.bybitCount = by.length; }
                        if (ok.length) { sourcesInfo.sources.push('OKX'); sourcesInfo.okxCount = ok.length; }
                        oneMin = mergeExchangeKlines(oneMin, by, ok);
                    } catch (e) { console.warn('extra 1m', e); }
                    if (myGen !== fetchGeneration) return;
                    data = aggregateKlines(oneMin, mins);
                    // Garantizar exactamente hasta 150 velas del TF
                    if (data.length > CANDLE_LIMIT) data = data.slice(-CANDLE_LIMIT);
                } else {
                    const bybitIv = BYBIT_INTERVAL_MAP[tfAtStart] || '60';
                    const okxBar = OKX_INTERVAL_MAP[tfAtStart] || '1H';
                    sourcesInfo = await fetchMultiExchangeKlines(tfAtStart, bybitIv, okxBar, CANDLE_LIMIT);
                    if (myGen !== fetchGeneration) return;
                    data = sourcesInfo.klines;
                }

                if (myGen !== fetchGeneration) return;

                // Fijo: solo las últimas 150 velas japonesas
                if (data && data.length > CANDLE_LIMIT) data = data.slice(-CANDLE_LIMIT);

                lastDataSources = sourcesInfo.sources;
                if (!data || !data.length) {
                    throw new Error('Sin datos de Binance, Bybit ni OKX para ' + tfAtStart);
                }

                // Ordenar por tiempo y deduplicar (Lightweight Charts lo exige)
                data = data.slice().sort((a, b) => a.time - b.time);
                const dedup = [];
                let lastT = null;
                for (const k of data) {
                    if (k.time === lastT) {
                        dedup[dedup.length - 1] = k;
                    } else {
                        dedup.push(k);
                        lastT = k.time;
                    }
                }
                data = dedup;

                const tfChanged = lastChartTf !== null && lastChartTf !== tfAtStart;
                const isFirstLoad = !chartViewInitialized;
                if (chartViewInitialized && !tfChanged) captureChartView();

                rawKlines = data;
                applyMainChartData({ preserveView: !isFirstLoad && !tfChanged });
                forceChartResize();

                if (isFirstLoad || tfChanged) {
                    try { if (mainChart) mainChart.timeScale().fitContent(); } catch (e) {}
                    try { if (trendiloChart) trendiloChart.timeScale().fitContent(); } catch (e) {}
                    chartViewInitialized = true;
                    lastChartTf = tfAtStart;
                    requestAnimationFrame(() => forceChartResize());
                } else {
                    requestAnimationFrame(() => {
                        restoreChartView();
                        forceChartResize();
                    });
                    setTimeout(() => restoreChartView(), 50);
                    setTimeout(() => { restoreChartView(); forceChartResize(); }, 150);
                }
                lastChartTf = tfAtStart;
                chartViewInitialized = true;

                const lastCandle = rawKlines[rawKlines.length - 1];
                const prevCandle = rawKlines[rawKlines.length - 2] || lastCandle;
                const priceChange = ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100;
                
                document.getElementById('currentPriceDisplay').innerText = `$${lastCandle.close.toFixed(2)}`;
                const changeEl = document.getElementById('priceChangeDisplay');
                changeEl.innerText = `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`;
                changeEl.className = `text-[10px] sm:text-xs px-1 sm:px-1.5 py-0.5 rounded font-mono ${priceChange >= 0 ? 'bg-accentGreen/10 text-accentGreen' : 'bg-accentRed/10 text-accentRed'}`;

                // Indicador de fuentes (Binance + Bybit + OKX)
                let srcEl = document.getElementById('dataSourceBadge');
                if (!srcEl) {
                    const priceWrap = document.getElementById('currentPriceDisplay')?.parentElement;
                    if (priceWrap) {
                        srcEl = document.createElement('span');
                        srcEl.id = 'dataSourceBadge';
                        srcEl.className = 'text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded bg-cardBg border border-borderBg text-slate-400 font-mono shrink-0';
                        priceWrap.appendChild(srcEl);
                    }
                }
                if (srcEl) {
                    const n = sourcesInfo.sources.length;
                    const shortMap = { Binance: 'BN', Bybit: 'BY', OKX: 'OKX' };
                    const label = n >= 2
                        ? sourcesInfo.sources.map(s => shortMap[s] || s).join('+')
                        : (sourcesInfo.sources[0] || '—');
                    srcEl.innerText = label;
                    srcEl.title = n >= 2
                        ? `Fusionado: Binance (${sourcesInfo.binanceCount || 0}) · Bybit (${sourcesInfo.bybitCount || 0}) · OKX (${sourcesInfo.okxCount || 0}) — menos oscilación`
                        : `Solo ${sourcesInfo.sources[0] || 'N/A'} (fallback)`;
                    srcEl.className = n >= 2
                        ? 'text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded bg-accentGreen/10 border border-accentGreen/30 text-accentGreen font-mono shrink-0'
                        : 'text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded bg-accentYellow/10 border border-accentYellow/30 text-accentYellow font-mono shrink-0';
                }

                // Calculate Custom Indicators
                calculateEMA50();
                calculateTrendilo();
                calculateStochRSI();
                calculateDMI();
                calculateYoshiScanner();
                calculateSupportsResistances();
                calculateVolumeProfile();
                fetchLongShortRatio();
                try { analyzeWyckoffOrderBook().then(() => { try { updateSignalsTable(); } catch(e){} }); } catch (e) { console.warn('Wyckoff OB', e); }

                if (!document.getElementById('entryPrice').value) {
                    document.getElementById('entryPrice').value = lastCandle.close.toFixed(2);
                    calculateTradeMetrics();
                }

            } catch (err) {
                console.error("Error fetching market data (Binance/Bybit):", err);
            } finally {
                if (icon) icon.classList.remove('fa-spin');
            }
        }

        /**
         * Trendilo (OPEN-SOURCE) — alineado con dudeowns / TradingView
         * https://es.tradingview.com/script/h5kMWewu-Trendilo-OPEN-SOURCE/
         * 1) % cambio del precio (close)
         * 2) Suavizado ligero
         * 3) ALMA del % cambio (offset 0.85, sigma 6)
         * 4) Bandas RMS del ALMA → tendencia alcista / bajista / lateral
         */
        function almaValue(series, endIdx, windowSize, offset, sigma) {
            if (endIdx < windowSize - 1) return null;
            const m = offset * (windowSize - 1);
            const s = windowSize / sigma;
            let norm = 0, sum = 0;
            for (let i = 0; i < windowSize; i++) {
                const weight = Math.exp(-1 * Math.pow(i - m, 2) / (2 * Math.pow(s, 2)));
                norm += weight;
                sum += series[endIdx - windowSize + 1 + i] * weight;
            }
            return norm > 0 ? sum / norm : null;
        }

        /**
         * SMMA (Smoothed Moving Average) / RMA TradingView:
         * primer valor = SMA(period); luego SMMA = (prev*(period-1) + close) / period
         */
        function computeSMMA(period) {
            if (!rawKlines.length || period < 1) return [];
            const out = [];
            let smma = null;
            for (let i = 0; i < rawKlines.length; i++) {
                const c = rawKlines[i].close;
                if (i < period - 1) continue;
                if (i === period - 1) {
                    let s = 0;
                    for (let j = 0; j < period; j++) s += rawKlines[j].close;
                    smma = s / period;
                } else {
                    smma = (smma * (period - 1) + c) / period;
                }
                out.push({ time: rawKlines[i].time, value: smma });
            }
            return out;
        }

        function calculateEMA50() {
            // Compat: calcula SMMA 20 + SMMA 50 y las pinta
            if (!rawKlines.length) return;
            const data20 = computeSMMA(20);
            const data50 = computeSMMA(50);
            try {
                if (smma20Series) {
                    smma20Series.setData(data20);
                    smma20Series.applyOptions({ visible: ema50Visible !== false });
                }
                if (ema50Series) {
                    ema50Series.setData(data50);
                    ema50Series.applyOptions({ visible: ema50Visible !== false });
                }
            } catch (e) {
                console.warn('SMMA setData', e);
            }
        }

        function calculateTrendilo() {
            // Parámetros típicos del script Trendilo OS
            const almaLen = 20;
            const almaOffset = 0.85;
            const almaSigma = 6;
            const rmsLen = 20;
            const smoothLen = 3;

            if (rawKlines.length < almaLen + 5) return;

            // 1) % change
            const pctChange = [];
            for (let i = 0; i < rawKlines.length; i++) {
                if (i === 0) {
                    pctChange.push(0);
                } else {
                    const prev = rawKlines[i - 1].close || 1;
                    pctChange.push(((rawKlines[i].close - prev) / prev) * 100);
                }
            }

            // 2) Suavizado EMA corto del % change
            const smoothed = [];
            const alpha = 2 / (smoothLen + 1);
            let emaS = pctChange[0];
            for (let i = 0; i < pctChange.length; i++) {
                emaS = pctChange[i] * alpha + emaS * (1 - alpha);
                smoothed.push(emaS);
            }

            // 3) ALMA del % change suavizado
            const almaSeries = [];
            for (let i = 0; i < smoothed.length; i++) {
                const v = almaValue(smoothed, i, almaLen, almaOffset, almaSigma);
                almaSeries.push(v);
            }

            // 4) RMS del ALMA (bandas ±RMS estilo TradingView)
            const almaLine = [];
            const rmsUp = [];
            const rmsDn = [];
            const zeroLine = [];
            let lastRms = 0;

            for (let i = 0; i < rawKlines.length; i++) {
                const alma = almaSeries[i];
                if (alma === null || i < almaLen) continue;

                let sumSq = 0, cnt = 0;
                for (let j = 0; j < rmsLen && i - j >= 0; j++) {
                    const a = almaSeries[i - j];
                    if (a !== null) {
                        sumSq += a * a;
                        cnt++;
                    }
                }
                const rms = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
                lastRms = rms;

                almaLine.push({ time: rawKlines[i].time, value: alma });
                rmsUp.push({ time: rawKlines[i].time, value: rms });
                rmsDn.push({ time: rawKlines[i].time, value: -rms });
                zeroLine.push({ time: rawKlines[i].time, value: 0 });
            }

            if (trendiloAlmaSeries) trendiloAlmaSeries.setData(almaLine);
            if (trendiloRmsUpper) trendiloRmsUpper.setData(rmsUp);
            if (trendiloRmsLower) trendiloRmsLower.setData(rmsDn);
            if (trendiloZeroSeries) trendiloZeroSeries.setData(zeroLine);

            // Estrategia ratio + círculo rojo en extremos
            const strat = evaluateTrendiloRatioStrategy(almaLine, rmsUp);
            applyTrendiloMarkers(trendiloAlmaSeries, strat.markers || []);

            const lastVal = almaLine.length ? almaLine[almaLine.length - 1].value : 0;
            const ratio = strat.last.ratio;
            let dir = 'Consolidación';
            if (strat.last.zone === 'BOUNCE') dir = 'BOUNCE (rebote)';
            else if (strat.last.zone === 'REVERSAL') dir = 'REVERSAL';
            else if (strat.last.zone === 'EXTREME_BEAR') dir = 'Extremo bajista';
            else if (strat.last.zone === 'EXTREME_BULL') dir = 'Extremo alcista';
            else if (ratio >= TRENDILO_BIAS) dir = 'Alcista (Bullish)';
            else if (ratio <= -TRENDILO_BIAS) dir = 'Bajista (Bearish)';

            trendiloLatest = {
                value: lastVal.toFixed(4),
                direction: dir,
                zScore: lastVal,
                rms: lastRms,
                ratio: ratio,
                zone: strat.last.zone,
                signal: strat.last.signal,
                extreme: strat.last.extreme
            };

            const indEl = document.getElementById('indTrendilo');
            if (indEl) {
                const rTxt = Number.isFinite(ratio) ? ` r=${ratio.toFixed(2)}` : '';
                indEl.innerText = `${trendiloLatest.direction} (${trendiloLatest.value})${rTxt}`;
                indEl.className = `font-mono font-bold ${
                    dir.includes('BOUNCE') || dir.includes('Alcista') ? 'text-accentGreen' :
                    dir.includes('REVERSAL') || dir.includes('Bajista') || dir.includes('Extremo') ? 'text-accentRed' : 'text-accentYellow'
                }`;
            }
        }

        function calculateStochRSI() {
            const rsiPeriod = 14;
            const stochPeriod = 14;

            let rsiValues = [];
            let gains = 0, losses = 0;

            for (let i = 1; i <= rsiPeriod; i++) {
                const change = rawKlines[i].close - rawKlines[i - 1].close;
                if (change >= 0) gains += change;
                else losses -= change;
            }
            let avgGain = gains / rsiPeriod;
            let avgLoss = losses / rsiPeriod;

            rsiValues[rsiPeriod] = 100 - (100 / (1 + (avgGain / (avgLoss || 1))));

            for (let i = rsiPeriod + 1; i < rawKlines.length; i++) {
                const change = rawKlines[i].close - rawKlines[i - 1].close;
                const gain = change >= 0 ? change : 0;
                const loss = change < 0 ? -change : 0;

                avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
                avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;

                const rs = avgGain / (avgLoss || 1);
                rsiValues[i] = 100 - (100 / (1 + rs));
            }

            const stochK = [];

            for (let i = 0; i < rawKlines.length; i++) {
                if (i < rsiPeriod + stochPeriod) {
                    stochK.push({ time: rawKlines[i].time, value: 50 });
                    continue;
                }

                let minRsi = 100, maxRsi = 0;
                for (let j = 0; j < stochPeriod; j++) {
                    const r = rsiValues[i - j] || 50;
                    if (r < minRsi) minRsi = r;
                    if (r > maxRsi) maxRsi = r;
                }

                const rawStoch = ((rsiValues[i] - minRsi) / ((maxRsi - minRsi) || 1)) * 100;
                stochK.push({ time: rawKlines[i].time, value: rawStoch });
            }

            stochKSeries.setData(stochK);
            stochDSeries.setData(stochK);

            const lastK = stochK[stochK.length - 1].value;
            stochRsiLatest = { k: lastK.toFixed(1), d: lastK.toFixed(1) };
            
            document.getElementById('indStochRsi').innerText = `K: ${stochRsiLatest.k} | D: ${stochRsiLatest.d}`;
        }

        function calculateDMI() {
            // DMI (Directional Movement Index) — +DI y -DI (Wilder, periodo 14)
            const period = 14;
            if (rawKlines.length < period * 2) return;

            let trList = [];
            let pdmList = [];
            let ndmList = [];

            for (let i = 1; i < rawKlines.length; i++) {
                const high = rawKlines[i].high;
                const low = rawKlines[i].low;
                const prevHigh = rawKlines[i - 1].high;
                const prevLow = rawKlines[i - 1].low;
                const prevClose = rawKlines[i - 1].close;

                const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
                const upMove = high - prevHigh;
                const downMove = prevLow - low;

                const pdm = (upMove > downMove && upMove > 0) ? upMove : 0;
                const ndm = (downMove > upMove && downMove > 0) ? downMove : 0;

                trList.push(tr);
                pdmList.push(pdm);
                ndmList.push(ndm);
            }

            let smoothedTR = trList.slice(0, period).reduce((a, b) => a + b, 0);
            let smoothedPDM = pdmList.slice(0, period).reduce((a, b) => a + b, 0);
            let smoothedNDM = ndmList.slice(0, period).reduce((a, b) => a + b, 0);

            let lastPDI = 0, lastNDI = 0, lastSpread = 0;

            for (let i = period; i < trList.length; i++) {
                smoothedTR = smoothedTR - (smoothedTR / period) + trList[i];
                smoothedPDM = smoothedPDM - (smoothedPDM / period) + pdmList[i];
                smoothedNDM = smoothedNDM - (smoothedNDM / period) + ndmList[i];

                lastPDI = (smoothedPDM / (smoothedTR || 1)) * 100;
                lastNDI = (smoothedNDM / (smoothedTR || 1)) * 100;
                lastSpread = Math.abs(lastPDI - lastNDI);
            }

            const bullish = lastPDI > lastNDI;
            const strong = lastSpread >= 10;
            let direction = 'Neutral';
            if (bullish && strong) direction = 'Alcista';
            else if (!bullish && strong) direction = 'Bajista';
            else if (bullish) direction = 'Alcista débil';
            else direction = 'Bajista débil';

            dmiLatest = {
                pDI: lastPDI.toFixed(1),
                nDI: lastNDI.toFixed(1),
                diSpread: lastSpread.toFixed(1),
                direction,
                trendStrength: strong
                    ? (lastSpread >= 20 ? 'Movimiento Muy Fuerte' : 'Movimiento Fuerte')
                    : 'Mercado en Rango / Débil'
            };

            const indDMI = document.getElementById('indDMI');
            if (indDMI) {
                indDMI.innerText = `+DI ${dmiLatest.pDI} | -DI ${dmiLatest.nDI} (Δ${dmiLatest.diSpread})`;
                indDMI.className = `font-mono font-bold ${strong ? (bullish ? 'text-accentGreen' : 'text-accentRed') : 'text-slate-400'}`;
            }

            updateSignalsTable();
        }


        function atrWilder(klines, period) {
            if (!klines || klines.length < period + 1) return [];
            const trs = [];
            for (let i = 1; i < klines.length; i++) {
                const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
                trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
            }
            const out = new Array(klines.length).fill(null);
            let atr = 0;
            for (let i = 0; i < period; i++) atr += trs[i];
            atr /= period;
            out[period] = atr;
            for (let i = period; i < trs.length; i++) {
                atr = (atr * (period - 1) + trs[i]) / period;
                out[i + 1] = atr;
            }
            return out;
        }

        function pivotHigh(klines, left, right, i) {
            const h = klines[i].high;
            for (let j = i - left; j <= i + right; j++) {
                if (j < 0 || j >= klines.length || j === i) continue;
                if (klines[j].high >= h) return false;
            }
            return true;
        }
        function pivotLow(klines, left, right, i) {
            const l = klines[i].low;
            for (let j = i - left; j <= i + right; j++) {
                if (j < 0 || j >= klines.length || j === i) continue;
                if (klines[j].low <= l) return false;
            }
            return true;
        }

        /**
         * Yoshi Scanner Pro (núcleo portado a JS):
         * SuperTrend + pivots/estructura + BOS + EQH/EQL + estados liquidez→BOS→retest
         * + señal alineada con SuperTrend. Niveles ENTRY/SL/TP1-3 estimados.
         */

        let yoshiActiveOBs = []; // {top, bottom, bias}

        function clearYoshiObLines() {
            if (!candlestickSeries) return;
            yoshiObPriceLines.forEach(pl => {
                try { candlestickSeries.removePriceLine(pl); } catch (e) {}
            });
            yoshiObPriceLines = [];
            const ov = document.getElementById('yoshiObOverlay');
            if (ov) ov.innerHTML = '';
        }

        function priceToY(price) {
            if (!candlestickSeries || price == null) return null;
            try {
                return candlestickSeries.priceToCoordinate(price);
            } catch (e) {
                return null;
            }
        }

        /** Sombreado horizontal tipo TradingView para Order Blocks */
        function renderYoshiObOverlay() {
            const ov = document.getElementById('yoshiObOverlay');
            if (!ov || !candlestickSeries) return;
            ov.innerHTML = '';
            if (!yoshiActiveOBs.length) return;

            yoshiActiveOBs.forEach(ob => {
                const yTop = priceToY(ob.top);
                const yBot = priceToY(ob.bottom);
                if (yTop == null || yBot == null) return;
                const top = Math.min(yTop, yBot);
                const height = Math.max(4, Math.abs(yBot - yTop));
                const isBull = ob.bias === 1;
                const div = document.createElement('div');
                div.className = 'yoshi-ob-zone ' + (isBull ? 'bull' : 'bear');
                div.style.top = top + 'px';
                div.style.height = height + 'px';
                const label = document.createElement('span');
                label.className = 'yoshi-ob-label';
                label.textContent = isBull ? 'ZONA DE COMPRA (OB)' : 'ZONA DE VENTA (OB)';
                div.appendChild(label);
                ov.appendChild(div);
            });
        }

        function addYoshiObZone(top, bottom, bias) {
            if (top == null || bottom == null) return;
            yoshiActiveOBs.push({ top, bottom, bias });
            // Price lines finas en el eje (como niveles de la imagen)
            if (!candlestickSeries) return;
            const isBull = bias === 1;
            const color = isBull ? 'rgba(49, 121, 245, 0.9)' : 'rgba(246, 70, 93, 0.9)';
            try {
                const topLine = candlestickSeries.createPriceLine({
                    price: top,
                    color: color,
                    lineWidth: 1,
                    lineStyle: 0,
                    axisLabelVisible: true,
                    title: isBull ? 'OB Buy' : 'OB Sell'
                });
                const botLine = candlestickSeries.createPriceLine({
                    price: bottom,
                    color: color,
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: false,
                    title: ''
                });
                yoshiObPriceLines.push(topLine, botLine);
            } catch (e) {}
        }

        function scheduleYoshiObRender() {
            requestAnimationFrame(() => {
                renderYoshiObOverlay();
                if (typeof scheduleOrderFlowRender === 'function') scheduleOrderFlowRender();
                else if (typeof renderOrderFlowOverlay === 'function') renderOrderFlowOverlay();
            });
        }

        // ========== ORDER FLOW (footprint / delta / volumen por vela) ==========
        let orderFlowMode = 'off'; // off | footprint | delta_profile | volume_cells | delta_cells | bidask_hist | vp_candle
        const OF_LEVELS = 8;
        let orderFlowRaf = 0;

        function toggleOrderFlowMenu(ev) {
            if (ev) { ev.preventDefault(); ev.stopPropagation(); }
            const menu = document.getElementById('orderFlowMenu');
            if (!menu) return;
            const opening = menu.classList.contains('hidden');
            menu.classList.toggle('hidden');
            // Al abrir el menú, si está off activa footprint para que se vea de inmediato
            if (opening && orderFlowMode === 'off') {
                setOrderFlowMode('footprint');
            }
        }
        window.toggleOrderFlowMenu = toggleOrderFlowMenu;

        document.addEventListener('click', (e) => {
            const wrap = document.getElementById('orderFlowBtnWrap');
            const menu = document.getElementById('orderFlowMenu');
            if (!wrap || !menu) return;
            if (!wrap.contains(e.target)) menu.classList.add('hidden');
        });

        function setOrderFlowMode(mode) {
            orderFlowMode = mode || 'off';
            try { localStorage.setItem('tmx_orderflow_mode', orderFlowMode); } catch (e) {}
            const btn = document.getElementById('btnOrderFlow');
            if (btn) {
                btn.classList.toggle('active', orderFlowMode !== 'off');
                btn.title = orderFlowMode === 'off' ? 'Order Flow / footprint' : ('Order Flow: ' + orderFlowMode);
            }
            document.querySelectorAll('.of-mode-item').forEach(el => {
                el.classList.toggle('active', el.getAttribute('data-ofmode') === orderFlowMode);
            });
            const menu = document.getElementById('orderFlowMenu');
            if (menu && mode !== undefined) menu.classList.add('hidden');
            // Redibujar en el siguiente frame (chart ya listo)
            scheduleOrderFlowRender();
            setTimeout(scheduleOrderFlowRender, 80);
            setTimeout(scheduleOrderFlowRender, 250);
        }
        window.setOrderFlowMode = setOrderFlowMode;

        function scheduleOrderFlowRender() {
            if (orderFlowRaf) cancelAnimationFrame(orderFlowRaf);
            orderFlowRaf = requestAnimationFrame(() => {
                orderFlowRaf = 0;
                try { renderOrderFlowOverlay(); } catch (e) { console.warn('OrderFlow', e); }
            });
        }
        window.scheduleOrderFlowRender = scheduleOrderFlowRender;

        function ensureOrderFlowVolumes(k) {
            if (!k) return { volume: 0, buyVol: 0, sellVol: 0, delta: 0, open: 0, high: 0, low: 0, close: 0, time: 0 };
            if (k.buyVol != null && k.sellVol != null) return k;
            const vol = k.volume || 0;
            const buyVol = vol * (k.close >= k.open ? 0.62 : 0.38);
            const sellVol = Math.max(0, vol - buyVol);
            return Object.assign({}, k, { buyVol, sellVol, delta: buyVol - sellVol });
        }

        function fmtOfVol(v) {
            const n = Math.abs(Number(v) || 0);
            if (n >= 1e6) return (v / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (v / 1e3).toFixed(n >= 10000 ? 0 : 1) + 'K';
            if (n >= 100) return String(Math.round(v));
            if (n >= 1) return Number(v).toFixed(1);
            return Number(v).toFixed(2);
        }

        function buildFootprintLevels(k, levels) {
            const lo = k.low, hi = k.high;
            const range = Math.max(hi - lo, 1e-12);
            const buy = k.buyVol || 0, sell = k.sellVol || 0;
            const out = [];
            for (let i = 0; i < levels; i++) {
                const p0 = lo + (range * i) / levels;
                const p1 = lo + (range * (i + 1)) / levels;
                const center = (p0 + p1) / 2;
                const wBuy = k.close >= k.open
                    ? 0.35 + 0.65 * ((center - lo) / range)
                    : 0.35 + 0.65 * ((hi - center) / range);
                const wSell = 1 - wBuy * 0.85;
                out.push({
                    low: p0, high: p1,
                    buy: (buy / levels) * (0.5 + wBuy),
                    sell: (sell / levels) * (0.5 + wSell)
                });
            }
            const sumB = out.reduce((a, x) => a + x.buy, 0) || 1;
            const sumS = out.reduce((a, x) => a + x.sell, 0) || 1;
            out.forEach(x => {
                x.buy = (x.buy / sumB) * buy;
                x.sell = (x.sell / sumS) * sell;
                x.delta = x.buy - x.sell;
                x.vol = x.buy + x.sell;
            });
            return out;
        }

        function getBarXWidth(time, nextTime) {
            if (!mainChart) return null;
            const ts = mainChart.timeScale();
            let x = null;
            try { x = ts.timeToCoordinate(time); } catch (e) {}
            if (x == null) return null;
            let w = 8;
            try {
                const bs = ts.options && ts.options().barSpacing;
                if (bs) w = Math.max(4, bs * 0.9);
            } catch (e) {}
            if (nextTime != null) {
                try {
                    const x2 = ts.timeToCoordinate(nextTime);
                    if (x2 != null) w = Math.max(4, Math.abs(x2 - x) * 0.88);
                } catch (e) {}
            }
            return { x: x - w / 2, w };
        }

        function renderOrderFlowOverlay() {
            const ov = document.getElementById('orderFlowOverlay');
            if (!ov) return;
            ov.innerHTML = '';
            if (orderFlowMode === 'off') return;
            if (!mainChart || !candlestickSeries || !rawKlines || rawKlines.length < 2) return;

            // Canvas a tamaño del contenedor
            const rect = ov.getBoundingClientRect();
            const W = Math.max(1, Math.floor(rect.width || ov.clientWidth || 0));
            const H = Math.max(1, Math.floor(rect.height || ov.clientHeight || 0));
            if (W < 20 || H < 20) return;

            const canvas = document.createElement('canvas');
            canvas.width = W * (window.devicePixelRatio || 1);
            canvas.height = H * (window.devicePixelRatio || 1);
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
            canvas.style.display = 'block';
            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            let logical = null;
            try { logical = mainChart.timeScale().getVisibleLogicalRange(); } catch (e) {}
            const n = rawKlines.length;
            let from = 0, to = n - 1;
            if (logical) {
                from = Math.max(0, Math.floor(logical.from));
                to = Math.min(n - 1, Math.ceil(logical.to));
            }
            const maxBars = 48;
            if (to - from + 1 > maxBars) from = Math.max(0, to - maxBars + 1);

            let maxVol = 1;
            for (let i = from; i <= to; i++) {
                const k = ensureOrderFlowVolumes(rawKlines[i]);
                if ((k.volume || 0) > maxVol) maxVol = k.volume;
            }

            ctx.font = '9px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (let i = from; i <= to; i++) {
                const k = ensureOrderFlowVolumes(rawKlines[i]);
                const nextT = i + 1 < n ? rawKlines[i + 1].time : null;
                const pos = getBarXWidth(k.time, nextT);
                if (!pos || pos.x + pos.w < 0 || pos.x > W) continue;

                const yH = priceToY(k.high);
                const yL = priceToY(k.low);
                if (yH == null || yL == null) continue;
                const top = Math.min(yH, yL);
                const bot = Math.max(yH, yL);
                const height = Math.max(10, bot - top);
                const left = pos.x;
                const width = pos.w;

                if (orderFlowMode === 'bidask_hist') {
                    const buyH = Math.max(2, ((k.buyVol || 0) / maxVol) * height * 0.95);
                    const sellH = Math.max(2, ((k.sellVol || 0) / maxVol) * height * 0.95);
                    const half = Math.max(2, width / 2 - 0.5);
                    ctx.fillStyle = 'rgba(14,203,129,0.6)';
                    ctx.fillRect(left, bot - buyH, half, buyH);
                    ctx.fillStyle = 'rgba(246,70,93,0.6)';
                    ctx.fillRect(left + half + 1, bot - sellH, half, sellH);
                    const d = k.delta || 0;
                    ctx.fillStyle = d >= 0 ? '#0ecb81' : '#f6465d';
                    ctx.font = 'bold 9px ui-monospace, monospace';
                    ctx.fillText((d >= 0 ? '+' : '') + fmtOfVol(d), left + width / 2, Math.max(8, top - 8));
                    continue;
                }

                const levels = buildFootprintLevels(k, OF_LEVELS);
                const maxCell = Math.max(1, ...levels.map(l => l.vol));
                const cellH = height / OF_LEVELS;

                for (let li = 0; li < levels.length; li++) {
                    const lv = levels[li];
                    // li 0 = bottom
                    const cy = bot - (li + 1) * cellH;
                    let bg = 'rgba(90,100,120,0.2)';
                    let fg = '#c8cdd3';
                    let label = '';

                    if (orderFlowMode === 'delta_cells' || orderFlowMode === 'delta_profile') {
                        const hot = Math.abs(lv.delta) > maxCell * 0.35;
                        if (lv.delta >= 0) {
                            bg = hot ? 'rgba(14,203,129,0.5)' : 'rgba(14,203,129,0.25)';
                            fg = hot ? '#e8fff0' : '#7dffa8';
                        } else {
                            bg = hot ? 'rgba(246,70,93,0.5)' : 'rgba(246,70,93,0.25)';
                            fg = hot ? '#ffe8ec' : '#ff8a9a';
                        }
                        label = (lv.delta >= 0 ? '+' : '') + fmtOfVol(lv.delta);
                    } else if (orderFlowMode === 'volume_cells' || orderFlowMode === 'vp_candle') {
                        const intensity = 0.15 + 0.55 * (lv.vol / maxCell);
                        bg = k.close >= k.open
                            ? `rgba(14,203,129,${intensity})`
                            : `rgba(246,70,93,${intensity})`;
                        fg = '#eaecef';
                        label = fmtOfVol(lv.vol);
                    } else {
                        // footprint bid x ask
                        if (lv.buy >= lv.sell) {
                            const hot = lv.buy > maxCell * 0.4;
                            bg = hot ? 'rgba(14,203,129,0.5)' : 'rgba(14,203,129,0.25)';
                            fg = '#7dffa8';
                        } else {
                            const hot = lv.sell > maxCell * 0.4;
                            bg = hot ? 'rgba(246,70,93,0.5)' : 'rgba(246,70,93,0.25)';
                            fg = '#ff8a9a';
                        }
                        label = width < 26 ? fmtOfVol(lv.vol) : (fmtOfVol(lv.buy) + '|' + fmtOfVol(lv.sell));
                    }

                    ctx.fillStyle = bg;
                    ctx.fillRect(left, cy, width, Math.max(1, cellH - 0.5));
                    if (width >= 12 && cellH >= 8) {
                        ctx.fillStyle = fg;
                        ctx.font = (cellH >= 12 ? '9px' : '8px') + ' ui-monospace, monospace';
                        ctx.fillText(label, left + width / 2, cy + cellH / 2);
                    }
                }

                // Delta arriba + volumen abajo
                const d = k.delta || 0;
                ctx.fillStyle = d >= 0 ? '#0ecb81' : '#f6465d';
                ctx.font = 'bold 9px ui-monospace, monospace';
                ctx.fillText((d >= 0 ? '+' : '') + fmtOfVol(d), left + width / 2, Math.max(8, top - 8));
                if (width >= 16) {
                    ctx.fillStyle = '#919b9b';
                    ctx.font = '8px ui-monospace, monospace';
                    ctx.fillText(fmtOfVol(k.volume || 0), left + width / 2, Math.min(H - 6, bot + 9));
                }
            }

            ov.appendChild(canvas);
        }
        window.renderOrderFlowOverlay = renderOrderFlowOverlay;


        /**
         * Yoshi Scanner Pro — visualización tipo TradingView:
         * SuperTrend up/down, BOS/CHoCH, Order Blocks (zonas compra/venta), señales Sell/Buy
         */
        function calculateYoshiScanner() {
            const klines = rawKlines;
            if (!klines || klines.length < 40) return;

            const stPeriod = 10;
            const stMult = 3.0;
            const pivotLeft = 2, pivotRight = 2;
            const intLeft = 5, intRight = 5; // estructura interna
            const liqTolPct = 0.0015;
            const atrArr = atrWilder(klines, stPeriod);

            // --- SuperTrend ---
            let upFinal = null, dnFinal = null, trend = 1;
            const stUpData = [];
            const stDnData = [];
            const trends = [];
            let prevTrend = 1;
            for (let i = 0; i < klines.length; i++) {
                const atr = atrArr[i];
                const c = klines[i].close;
                const src = (klines[i].high + klines[i].low) / 2;
                const t = klines[i].time;
                if (atr == null) {
                    trends.push(trend);
                    continue;
                }
                let up = src - stMult * atr;
                let dn = src + stMult * atr;
                if (upFinal == null) upFinal = up;
                else upFinal = (klines[i - 1].close > upFinal) ? Math.max(up, upFinal) : up;
                if (dnFinal == null) dnFinal = dn;
                else dnFinal = (klines[i - 1].close < dnFinal) ? Math.min(dn, dnFinal) : dn;

                prevTrend = trend;
                if (trend === -1 && c > dnFinal) trend = 1;
                else if (trend === 1 && c < upFinal) trend = -1;
                trends.push(trend);

                // Solo puntos del lado activo → línea rota verde/roja (estilo TV)
                if (trend === 1) {
                    stUpData.push({ time: t, value: upFinal });
                } else {
                    stDnData.push({ time: t, value: dnFinal });
                }
            }

            // --- Swings (estructura) ---
            const swingHighs = [], swingLows = [];
            for (let i = pivotLeft; i < klines.length - pivotRight; i++) {
                if (pivotHigh(klines, pivotLeft, pivotRight, i))
                    swingHighs.push({ i, price: klines[i].high, time: klines[i].time });
                if (pivotLow(klines, pivotLeft, pivotRight, i))
                    swingLows.push({ i, price: klines[i].low, time: klines[i].time });
            }

            // Internal pivots (CHoCH/BOS más reactivos)
            const intHighs = [], intLows = [];
            for (let i = intLeft; i < klines.length - intRight; i++) {
                if (pivotHigh(klines, intLeft, intRight, i))
                    intHighs.push({ i, price: klines[i].high, time: klines[i].time });
                if (pivotLow(klines, intLeft, intRight, i))
                    intLows.push({ i, price: klines[i].low, time: klines[i].time });
            }

            // Recorrer barras: detectar BOS/CHoCH + Order Blocks
            let structBias = 0; // +1 bull, -1 bear
            let lastIntHigh = null, lastIntLow = null;
            const structureEvents = []; // {i, type:'BOS'|'CHoCH', bias, price, time}
            const orderBlocks = []; // {top, bottom, bias, startI, active}

            function findObCandle(fromI, biasBull) {
                // última vela opuesta en las 8 anteriores
                for (let j = fromI - 1; j >= Math.max(0, fromI - 12); j--) {
                    const k = klines[j];
                    if (biasBull && k.close < k.open) return { top: k.high, bottom: k.low, i: j };
                    if (!biasBull && k.close > k.open) return { top: k.high, bottom: k.low, i: j };
                }
                const k = klines[Math.max(0, fromI - 1)];
                return { top: k.high, bottom: k.low, i: Math.max(0, fromI - 1) };
            }

            for (let i = 0; i < klines.length; i++) {
                const ih = intHighs.find(p => p.i === i);
                const il = intLows.find(p => p.i === i);
                if (ih) lastIntHigh = ih;
                if (il) lastIntLow = il;

                if (i < 10) continue;
                const c = klines[i].close;
                // Break de high interno
                if (lastIntHigh && i > lastIntHigh.i && c > lastIntHigh.price && klines[i - 1].close <= lastIntHigh.price) {
                    const type = structBias === -1 ? 'CHoCH' : 'BOS';
                    structureEvents.push({ i, type, bias: 1, price: lastIntHigh.price, time: klines[i].time });
                    const ob = findObCandle(i, true);
                    orderBlocks.push({ top: ob.top, bottom: ob.bottom, bias: 1, startI: ob.i, broken: false });
                    structBias = 1;
                    lastIntHigh = null; // consumido
                }
                // Break de low interno
                if (lastIntLow && i > lastIntLow.i && c < lastIntLow.price && klines[i - 1].close >= lastIntLow.price) {
                    const type = structBias === 1 ? 'CHoCH' : 'BOS';
                    structureEvents.push({ i, type, bias: -1, price: lastIntLow.price, time: klines[i].time });
                    const ob = findObCandle(i, false);
                    orderBlocks.push({ top: ob.top, bottom: ob.bottom, bias: -1, startI: ob.i, broken: false });
                    structBias = -1;
                    lastIntLow = null;
                }
            }

            // Mitigar OBs tocados
            orderBlocks.forEach(ob => {
                for (let i = ob.startI + 1; i < klines.length; i++) {
                    if (ob.bias === 1 && klines[i].low < ob.bottom) { ob.broken = true; break; }
                    if (ob.bias === -1 && klines[i].high > ob.top) { ob.broken = true; break; }
                }
            });

            const activeBullOB = [...orderBlocks].reverse().find(o => o.bias === 1 && !o.broken);
            const activeBearOB = [...orderBlocks].reverse().find(o => o.bias === -1 && !o.broken);

            let lastSH = swingHighs.length ? swingHighs[swingHighs.length - 1].price : null;
            let prevSH = swingHighs.length >= 2 ? swingHighs[swingHighs.length - 2].price : null;
            let lastSL = swingLows.length ? swingLows[swingLows.length - 1].price : null;
            let prevSL = swingLows.length >= 2 ? swingLows[swingLows.length - 2].price : null;

            const bullStructure = lastSH != null && prevSH != null && lastSL != null && prevSL != null
                && lastSH > prevSH && lastSL > prevSL;
            const bearStructure = lastSH != null && prevSH != null && lastSL != null && prevSL != null
                && lastSH < prevSH && lastSL < prevSL;

            const n = klines.length - 1;
            const last = klines[n];
            const atrLast = atrArr[n] || (last.high - last.low);
            const stTrend = trends[n] || 1;
            const stFlipBuy = n > 0 && trends[n] === 1 && trends[n - 1] === -1;
            const stFlipSell = n > 0 && trends[n] === -1 && trends[n - 1] === 1;

            const lastEvt = structureEvents.length ? structureEvents[structureEvents.length - 1] : null;
            const bos = lastEvt ? `${lastEvt.type}${lastEvt.bias === 1 ? '↑' : '↓'}` : '—';

            // EQH/EQL
            let eq = 'none';
            if (lastSL != null && prevSL != null && Math.abs(lastSL - prevSL) / last.close <= liqTolPct) eq = 'EQL';
            if (lastSH != null && prevSH != null && Math.abs(lastSH - prevSH) / last.close <= liqTolPct)
                eq = eq === 'EQL' ? 'EQH+EQL' : 'EQH';

            let signal = 'NONE';
            if (stFlipBuy || (stTrend === 1 && lastEvt && lastEvt.bias === 1 && lastEvt.type === 'CHoCH')) signal = 'BUY';
            if (stFlipSell || (stTrend === -1 && lastEvt && lastEvt.bias === -1 && lastEvt.type === 'CHoCH')) signal = 'SELL';
            if (stFlipBuy) signal = 'BUY';
            if (stFlipSell) signal = 'SELL';

            let entry = last.close, sl = null, tp1 = null, tp2 = null, tp3 = null;
            if (signal === 'BUY') {
                sl = activeBullOB ? activeBullOB.bottom - atrLast * 0.1 : (lastSL != null ? lastSL : entry - atrLast * 1.2);
                const risk = Math.abs(entry - sl) || atrLast;
                tp1 = entry + risk * 1.5; tp2 = entry + risk * 2.5; tp3 = entry + risk * 3.5;
            } else if (signal === 'SELL') {
                sl = activeBearOB ? activeBearOB.top + atrLast * 0.1 : (lastSH != null ? lastSH : entry + atrLast * 1.2);
                const risk = Math.abs(entry - sl) || atrLast;
                tp1 = entry - risk * 1.5; tp2 = entry - risk * 2.5; tp3 = entry - risk * 3.5;
            }

            const structure = bullStructure ? 'Alcista' : (bearStructure ? 'Bajista' : (structBias === 1 ? 'Alcista' : structBias === -1 ? 'Bajista' : 'Lateral'));

            yoshiLatest = {
                trend: stTrend,
                stValue: stTrend === 1 ? (stUpData.filter(d => d.value).pop() || {}).value : (stDnData.filter(d => d.value).pop() || {}).value,
                structure, bos, eq, state: lastEvt ? 2 : 0,
                signal, entry: signal !== 'NONE' ? entry : null, sl, tp1, tp2, tp3,
                bullStructure, bearStructure,
                hasBullOB: !!activeBullOB, hasBearOB: !!activeBearOB
            };

            // --- Dibujar SuperTrend up/down ---
            try {
                if (supertrendUpSeries) supertrendUpSeries.setData(stUpData);
                if (supertrendDnSeries) supertrendDnSeries.setData(stDnData);
            } catch (e) { console.warn('ST plot', e); }

            // --- Order Blocks: sombreado + price lines ---
            yoshiActiveOBs = [];
            clearYoshiObLines();
            if (activeBullOB) addYoshiObZone(activeBullOB.top, activeBullOB.bottom, 1);
            if (activeBearOB) addYoshiObZone(activeBearOB.top, activeBearOB.bottom, -1);
            scheduleYoshiObRender();
            setTimeout(scheduleYoshiObRender, 80);
            setTimeout(scheduleYoshiObRender, 250);

            // Weak High / Strong Low labels via markers on last swings
            const markers = [];
            structureEvents.slice(-25).forEach(ev => {
                markers.push({
                    time: ev.time,
                    position: ev.bias === 1 ? 'belowBar' : 'aboveBar',
                    color: ev.bias === 1 ? '#0ecb81' : '#f6465d',
                    shape: ev.bias === 1 ? 'arrowUp' : 'arrowDown',
                    text: ev.type
                });
            });
            // SuperTrend flips con etiqueta Sell/Buy
            for (let i = 1; i < trends.length; i++) {
                if (trends[i] === 1 && trends[i - 1] === -1) {
                    markers.push({
                        time: klines[i].time,
                        position: 'belowBar',
                        color: '#9b46ff',
                        shape: 'arrowUp',
                        text: 'Buy'
                    });
                } else if (trends[i] === -1 && trends[i - 1] === 1) {
                    markers.push({
                        time: klines[i].time,
                        position: 'aboveBar',
                        color: '#f6465d',
                        shape: 'arrowDown',
                        text: 'Sell'
                    });
                }
            }
            if (swingHighs.length) {
                const sh = swingHighs[swingHighs.length - 1];
                markers.push({
                    time: sh.time,
                    position: 'aboveBar',
                    color: '#878b94',
                    shape: 'circle',
                    text: 'Weak High'
                });
            }
            if (swingLows.length) {
                const slp = swingLows[swingLows.length - 1];
                markers.push({
                    time: slp.time,
                    position: 'belowBar',
                    color: '#878b94',
                    shape: 'circle',
                    text: structBias === 1 ? 'Strong Low' : 'Weak Low'
                });
            }

            // Sort markers by time and unique-ish
            markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
            const slim = markers.slice(-50);

            if (candlestickSeries && candlestickSeries.setMarkers) {
                try { candlestickSeries.setMarkers(slim); } catch (e) { console.warn('markers', e); }
            }

            const ind = document.getElementById('indYoshi');
            if (ind) {
                const sigTxt = signal === 'BUY' ? 'COMPRA' : (signal === 'SELL' ? 'VENTA' : 'WAIT');
                ind.innerText = `${stTrend === 1 ? 'ST↑' : 'ST↓'} · ${structure} · ${bos} · ${sigTxt}`;
                ind.className = `font-mono font-bold ${
                    signal === 'BUY' ? 'text-accentGreen' : signal === 'SELL' ? 'text-accentRed' : (stTrend === 1 ? 'text-accentGreen' : 'text-accentRed')
                }`;
            }
        }

        // ========== WYCKOFF + ORDER BOOK (Binance / Bybit / OKX) ==========
        async function fetchOrderBookDepth(symbol) {
            const results = { binance: null, bybit: null, okx: null };
            const sym = symbol || currentSymbol || 'BTCUSDT';
            const okxSym = (typeof okxInstId === 'function') ? okxInstId(sym) : (sym.endsWith('USDT') ? sym.slice(0, -4) + '-USDT' : 'BTC-USDT');
            const fetchWithTimeout = (url, ms = 4500) => {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), ms);
                return fetch(url, { signal: ctrl.signal })
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null)
                    .finally(() => clearTimeout(t));
            };
            const [binData, bybData, okxData] = await Promise.all([
                fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=20`),
                fetchWithTimeout(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${sym}&limit=20`),
                fetchWithTimeout(`https://www.okx.com/api/v5/market/books?instId=${okxSym}&sz=20`)
            ]);
            if (binData && binData.bids && binData.asks) results.binance = parseDepthLevels(binData.bids, binData.asks);
            if (bybData && bybData.result && bybData.result.b && bybData.result.a)
                results.bybit = parseDepthLevels(bybData.result.b, bybData.result.a);
            if (okxData && okxData.data && okxData.data[0] && okxData.data[0].bids && okxData.data[0].asks)
                results.okx = parseDepthLevels(okxData.data[0].bids, okxData.data[0].asks);
            return results;
        }

        // Historial corto de imbalance para suavizar ruido del order book
        let wyckoffImbHistory = [];
        const WYCKOFF_IMB_SMOOTH = 3; // media de últimas N lecturas

        function parseDepthLevels(bids, asks) {
            // Solo top 8 niveles (más cerca del mid = menos ruido de paredes lejanas)
            // Cap por nivel para reducir spoofing de paredes absurdas
            let bidVol = 0, askVol = 0;
            let maxBid = { price: 0, qty: 0 }, maxAsk = { price: 0, qty: 0 };
            const levels = 8;
            const rawBids = (bids || []).slice(0, levels).map(l => ({ p: parseFloat(l[0]), q: parseFloat(l[1]) || 0 }));
            const rawAsks = (asks || []).slice(0, levels).map(l => ({ p: parseFloat(l[0]), q: parseFloat(l[1]) || 0 }));
            // Cap: ningún nivel > 3× mediana de su lado
            const med = (arr) => {
                if (!arr.length) return 0;
                const s = arr.map(x => x.q).sort((a, b) => a - b);
                return s[Math.floor(s.length / 2)] || 0;
            };
            const bidMed = med(rawBids) || 0.01;
            const askMed = med(rawAsks) || 0.01;
            const bidCap = Math.max(bidMed * 3, bidMed + 0.5);
            const askCap = Math.max(askMed * 3, askMed + 0.5);
            // Peso mayor a niveles más cercanos al mid (índice 0)
            rawBids.forEach((l, i) => {
                const q = Math.min(l.q, bidCap);
                const w = 1 - (i * 0.08); // 1.0, 0.92, 0.84...
                bidVol += q * Math.max(0.4, w);
                if (q > maxBid.qty) maxBid = { price: l.p, qty: q };
            });
            rawAsks.forEach((l, i) => {
                const q = Math.min(l.q, askCap);
                const w = 1 - (i * 0.08);
                askVol += q * Math.max(0.4, w);
                if (q > maxAsk.qty) maxAsk = { price: l.p, qty: q };
            });
            const total = bidVol + askVol || 1;
            return { bidVol, askVol, imbalance: (bidVol - askVol) / total, maxBid, maxAsk };
        }

        async function analyzeWyckoffOrderBook() {
            try {
                const books = await fetchOrderBookDepth(currentSymbol);
                let totalBid = 0, totalAsk = 0, count = 0;
                const exchSummary = {};
                let strongestBidWall = null, strongestAskWall = null;
                let bullEx = 0, bearEx = 0; // cuántos exchanges coinciden en sesgo

                ['binance', 'bybit', 'okx'].forEach(ex => {
                    const b = books[ex];
                    if (!b) return;
                    count++;
                    totalBid += b.bidVol;
                    totalAsk += b.askVol;
                    exchSummary[ex] = { imbalance: b.imbalance, bidVol: b.bidVol, askVol: b.askVol, maxBid: b.maxBid, maxAsk: b.maxAsk };
                    // Umbral por exchange más estricto para consenso
                    if (b.imbalance > 0.12) bullEx++;
                    else if (b.imbalance < -0.12) bearEx++;
                    if (!strongestBidWall || b.maxBid.qty > strongestBidWall.qty)
                        strongestBidWall = { ...b.maxBid, exchange: ex };
                    if (!strongestAskWall || b.maxAsk.qty > strongestAskWall.qty)
                        strongestAskWall = { ...b.maxAsk, exchange: ex };
                });
                if (count === 0) {
                    wyckoffLatest = { phase: 'Sin datos', signal: 'NONE', imbalance: 0, bidVol: 0, askVol: 0, bias: 'Neutral', walls: { bid: null, ask: null }, exchanges: {}, desc: 'No se pudo obtener order book (CORS/API).', count: 0 };
                    updateWyckoffUI();
                    return wyckoffLatest;
                }

                let rawImb = (totalBid - totalAsk) / (totalBid + totalAsk || 1);
                // Suavizado: media de últimas lecturas (reduce ruido tick a tick)
                wyckoffImbHistory.push(rawImb);
                if (wyckoffImbHistory.length > WYCKOFF_IMB_SMOOTH) wyckoffImbHistory.shift();
                const avgImb = wyckoffImbHistory.reduce((a, b) => a + b, 0) / wyckoffImbHistory.length;

                // Consenso multi-exchange: preferir señal solo si ≥2 venues alineados (o 1 si solo hay 1)
                const needConsensus = count >= 2 ? 2 : 1;
                const consensusBull = bullEx >= needConsensus;
                const consensusBear = bearEx >= needConsensus;

                const price = rawKlines && rawKlines.length ? rawKlines[rawKlines.length - 1].close : 0;
                // Lookback de estructura alineado al TF del gráfico
                const tf = currentInterval || '1h';
                const structBars = ({ '1m': 12, '3m': 14, '5m': 16, '9m': 18, '15m': 20, '20m': 20, '1h': 24, '4h': 28, '1d': 30 })[tf] || 20;
                const bars = Math.min(structBars, (rawKlines && rawKlines.length) ? rawKlines.length - 1 : 20);

                let phase = 'Phase B (rango)', signal = 'NONE', bias = 'Neutral', desc = '';

                // Umbrales más estrictos: BUY/SELL solo con imbalance fuerte + consenso
                if (avgImb > 0.22 && consensusBull) {
                    bias = 'Acumulación'; phase = 'Phase C/D · Soporte (bids dominan)'; signal = 'BUY';
                    desc = `Imbalance suavizado +${(avgImb * 100).toFixed(0)}% · consenso ${bullEx}/${count} exch. Absorption de oferta → long.`;
                } else if (avgImb < -0.22 && consensusBear) {
                    bias = 'Distribución'; phase = 'Phase C/D · Resistencia (asks dominan)'; signal = 'SELL';
                    desc = `Imbalance suavizado ${(avgImb * 100).toFixed(0)}% · consenso ${bearEx}/${count} exch. Absorption de demanda → short.`;
                } else if (avgImb > 0.10) {
                    bias = 'Leve acumulación'; phase = 'Phase B · Bias comprador';
                    desc = `Imbalance leve +${(avgImb * 100).toFixed(0)}% (sin consenso fuerte). Esperar Spring o SOS.`;
                } else if (avgImb < -0.10) {
                    bias = 'Leve distribución'; phase = 'Phase B · Bias vendedor';
                    desc = `Imbalance leve ${(avgImb * 100).toFixed(0)}% (sin consenso fuerte). Esperar UTAD o SOW.`;
                } else {
                    bias = 'Equilibrado'; phase = 'Phase B (equilibrio)';
                    desc = `Libro equilibrado (imb ${(avgImb * 100).toFixed(0)}%). Sin absorption clara.`;
                }

                // Spring / UTAD: umbrales más estrictos + lookback según TF
                if (rawKlines && rawKlines.length > bars && consensusBull && avgImb > 0.14) {
                    const minLow = Math.min(...rawKlines.slice(-bars).map(k => k.low));
                    if (price <= minLow * 1.005) {
                        phase = 'Spring candidate (test de soporte)'; signal = 'BUY'; bias = 'Acumulación (Spring)';
                        desc = `Precio en mínimo de ${bars} velas (${tf}) + bids con consenso → Spring Wyckoff. Long.`;
                    }
                }
                if (rawKlines && rawKlines.length > bars && consensusBear && avgImb < -0.14) {
                    const maxHigh = Math.max(...rawKlines.slice(-bars).map(k => k.high));
                    if (price >= maxHigh * 0.995) {
                        phase = 'UTAD candidate (test de resistencia)'; signal = 'SELL'; bias = 'Distribución (UTAD)';
                        desc = `Precio en máximo de ${bars} velas (${tf}) + asks con consenso → UTAD Wyckoff. Short.`;
                    }
                }

                wyckoffLatest = {
                    phase, signal, imbalance: avgImb, rawImbalance: rawImb,
                    bidVol: totalBid, askVol: totalAsk, bias,
                    walls: { bid: strongestBidWall, ask: strongestAskWall },
                    exchanges: exchSummary, desc, count,
                    consensus: { bull: bullEx, bear: bearEx }
                };
                updateWyckoffUI();
                return wyckoffLatest;
            } catch (e) {
                console.warn('Wyckoff OB analysis', e);
                wyckoffLatest.desc = 'Error: ' + (e.message || e);
                updateWyckoffUI();
                return wyckoffLatest;
            }
        }

        function updateWyckoffUI() {
            const w = wyckoffLatest || {};
            const ind = document.getElementById('indWyckoff');
            if (ind) {
                const sigTxt = w.signal === 'BUY' ? 'LONG' : (w.signal === 'SELL' ? 'SHORT' : 'WAIT');
                const imbPct = ((w.imbalance || 0) * 100).toFixed(0);
                ind.innerText = `${w.bias || '—'} · ${sigTxt} (${imbPct}%)`;
                ind.className = `font-mono font-bold ${w.signal === 'BUY' ? 'text-accentGreen' : w.signal === 'SELL' ? 'text-accentRed' : 'text-slate-300'}`;
            }
        }

        /** Proyección dedicada Order Book + Wyckoff (pestaña Proyección) */
        async function projectWyckoffOrderBook() {
            const sumEl = document.getElementById('wyckoffObSummary');
            const depthEl = document.getElementById('wyckoffExchDepth');
            const projEl = document.getElementById('wyckoffObProjection');
            if (sumEl) sumEl.innerHTML = '<div class="text-center py-3 text-slate-500 italic">Consultando libros Binance · Bybit · OKX…</div>';
            try {
                await analyzeWyckoffOrderBook();
            } catch (e) {}
            const w = wyckoffLatest || {};
            const imbPct = ((w.imbalance || 0) * 100).toFixed(1);
            const price = rawKlines && rawKlines.length ? rawKlines[rawKlines.length - 1].close : 0;

            // Summary card
            if (sumEl) {
                const signalColor = w.signal === 'BUY' ? 'text-accentGreen' : w.signal === 'SELL' ? 'text-accentRed' : 'text-accentYellow';
                const badgeBg = w.signal === 'BUY' ? 'bg-accentGreen text-slate-950' : w.signal === 'SELL' ? 'bg-accentRed text-white' : 'bg-accentYellow text-slate-950';
                const sigLabel = w.signal === 'BUY' ? 'LONG' : w.signal === 'SELL' ? 'SHORT' : 'ESPERAR';
                sumEl.innerHTML = `
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-slate-400 text-[10px] uppercase tracking-wider">Sesgo Wyckoff OB</span>
                        <span class="px-2 py-0.5 rounded font-black text-[11px] ${badgeBg}">${sigLabel}</span>
                    </div>
                    <div class="font-semibold ${signalColor} text-sm">${w.bias || '—'} · ${w.phase || '—'}</div>
                    <div class="grid grid-cols-2 gap-2 text-[11px] font-mono mt-1">
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-slate-500 text-[9px]">IMBALANCE</div>
                            <div class="${parseFloat(imbPct) >= 0 ? 'text-accentGreen' : 'text-accentRed'} font-bold">${imbPct > 0 ? '+' : ''}${imbPct}%</div>
                        </div>
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-slate-500 text-[9px]">EXCHANGES</div>
                            <div class="text-white font-bold">${w.count || 0} / 3</div>
                        </div>
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-slate-500 text-[9px]">BID VOL (top)</div>
                            <div class="text-accentGreen font-bold">${(w.bidVol || 0).toFixed(2)} BTC</div>
                        </div>
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-slate-500 text-[9px]">ASK VOL (top)</div>
                            <div class="text-accentRed font-bold">${(w.askVol || 0).toFixed(2)} BTC</div>
                        </div>
                    </div>
                    <p class="text-[11px] text-slate-400 leading-relaxed mt-1">${w.desc || '—'}</p>
                `;
            }

            // Per-exchange depth
            if (depthEl) {
                const ex = w.exchanges || {};
                const rows = ['binance', 'bybit', 'okx'].map(name => {
                    const e = ex[name];
                    if (!e) return `<div class="flex justify-between text-slate-500"><span class="uppercase">${name}</span><span>sin datos</span></div>`;
                    const i = (e.imbalance * 100).toFixed(0);
                    const col = e.imbalance > 0.05 ? 'text-accentGreen' : e.imbalance < -0.05 ? 'text-accentRed' : 'text-slate-300';
                    return `<div class="flex justify-between items-center gap-2">
                        <span class="uppercase text-slate-400 font-semibold">${name}</span>
                        <span class="font-mono ${col}">imb ${i > 0 ? '+' : ''}${i}% · B ${(e.bidVol||0).toFixed(1)} / A ${(e.askVol||0).toFixed(1)}</span>
                    </div>`;
                }).join('');
                let wallsHtml = '';
                if (w.walls && w.walls.bid) {
                    wallsHtml += `<div class="mt-1.5 pt-1.5 border-t border-borderBg text-accentGreen">Pared BID @ $${(w.walls.bid.price||0).toFixed(0)} · ${(w.walls.bid.qty||0).toFixed(3)} BTC <span class="text-slate-500">(${w.walls.bid.exchange})</span></div>`;
                }
                if (w.walls && w.walls.ask) {
                    wallsHtml += `<div class="text-accentRed">Pared ASK @ $${(w.walls.ask.price||0).toFixed(0)} · ${(w.walls.ask.qty||0).toFixed(3)} BTC <span class="text-slate-500">(${w.walls.ask.exchange})</span></div>`;
                }
                depthEl.innerHTML = `<div class="font-semibold text-slate-300 border-b border-borderBg pb-1 mb-1">Profundidad por exchange</div>${rows}${wallsHtml}`;
            }

            // Projection / operative recommendation
            if (projEl) {
                const horizon = (typeof projectionHorizon !== 'undefined' && projectionHorizon) ? projectionHorizon : '1h';
                const horizonLabel = (typeof PROJECTION_HORIZON_LABELS !== 'undefined' && PROJECTION_HORIZON_LABELS[horizon]) ? PROJECTION_HORIZON_LABELS[horizon] : horizon;
                let recommendation = 'ESPERAR', conf = 45, colorClass = 'text-accentYellow', badgeClass = 'bg-accentYellow text-slate-950', actionHint = '';
                const reasons = [];

                const cons = w.consensus || {};
                const consTxt = cons.bull || cons.bear
                    ? ` · consenso ${w.signal === 'BUY' ? (cons.bull || 0) : (cons.bear || 0)}/${w.count || 0}`
                    : '';
                if (w.signal === 'BUY') {
                    recommendation = 'LONG';
                    conf = Math.min(88, 55 + Math.abs(w.imbalance || 0) * 70 + (cons.bull >= 2 ? 8 : 0));
                    colorClass = 'text-accentGreen'; badgeClass = 'bg-accentGreen text-slate-950';
                    actionHint = `Sesgo acumulativo Wyckoff (${horizonLabel}${consTxt}). Entrada en retest de soporte / Spring.`;
                    reasons.push({ side: 'L', txt: w.phase || 'Acumulación', pts: 25 });
                    if (w.imbalance > 0.14) reasons.push({ side: 'L', txt: `Imbalance suavizado +${imbPct}%`, pts: 18 });
                    if (cons.bull >= 2) reasons.push({ side: 'L', txt: `Consenso ${cons.bull} exchanges`, pts: 10 });
                } else if (w.signal === 'SELL') {
                    recommendation = 'SHORT';
                    conf = Math.min(88, 55 + Math.abs(w.imbalance || 0) * 70 + (cons.bear >= 2 ? 8 : 0));
                    colorClass = 'text-accentRed'; badgeClass = 'bg-accentRed text-white';
                    actionHint = `Sesgo distributivo Wyckoff (${horizonLabel}${consTxt}). Entrada en rechazo de resistencia / UTAD.`;
                    reasons.push({ side: 'S', txt: w.phase || 'Distribución', pts: 25 });
                    if (w.imbalance < -0.14) reasons.push({ side: 'S', txt: `Imbalance suavizado ${imbPct}%`, pts: 18 });
                    if (cons.bear >= 2) reasons.push({ side: 'S', txt: `Consenso ${cons.bear} exchanges`, pts: 10 });
                } else {
                    actionHint = `Sin señal fuerte (${horizonLabel}). Libro ${(w.bias || 'equilibrado').toLowerCase()}. Imbalance suavizado ${(w.imbalance*100||0).toFixed(0)}% — esperar confirmación precio + volumen.`;
                    if (Math.abs(w.imbalance || 0) > 0.10) {
                        const side = w.imbalance > 0 ? 'L' : 'S';
                        reasons.push({ side, txt: `Bias leve ${w.bias} (sin consenso)`, pts: 6 });
                    }
                }

                // Cross with Yoshi / structure if available
                const y = (typeof yoshiLatest !== 'undefined' && yoshiLatest) ? yoshiLatest : {};
                if (y.signal === 'BUY' && recommendation === 'LONG') {
                    conf = Math.min(95, conf + 8);
                    reasons.push({ side: 'L', txt: 'Yoshi alineado COMPRA', pts: 12 });
                } else if (y.signal === 'SELL' && recommendation === 'SHORT') {
                    conf = Math.min(95, conf + 8);
                    reasons.push({ side: 'S', txt: 'Yoshi alineado VENTA', pts: 12 });
                } else if (y.signal === 'BUY' && recommendation === 'SHORT') {
                    conf = Math.max(35, conf - 10);
                    reasons.push({ side: 'L', txt: 'Yoshi en contra (COMPRA)', pts: -8 });
                } else if (y.signal === 'SELL' && recommendation === 'LONG') {
                    conf = Math.max(35, conf - 10);
                    reasons.push({ side: 'S', txt: 'Yoshi en contra (VENTA)', pts: -8 });
                }

                // Suggested levels from walls + ATR-ish
                let entry = price, sl = 0, tp = 0;
                if (recommendation === 'LONG') {
                    entry = price;
                    sl = (w.walls && w.walls.bid && w.walls.bid.price) ? w.walls.bid.price * 0.998 : price * 0.988;
                    tp = price + (price - sl) * 2;
                } else if (recommendation === 'SHORT') {
                    entry = price;
                    sl = (w.walls && w.walls.ask && w.walls.ask.price) ? w.walls.ask.price * 1.002 : price * 1.012;
                    tp = price - (sl - price) * 2;
                }

                const longPct = recommendation === 'LONG' ? conf : (recommendation === 'SHORT' ? 100 - conf : 50);
                const shortPct = 100 - longPct;

                projEl.innerHTML = `
                    <div class="text-center space-y-1.5">
                        <div class="text-[10px] text-slate-400 uppercase tracking-wider">Proyección Order Book · ${horizonLabel}</div>
                        <div class="flex items-center justify-center gap-2">
                            <span class="px-3 py-1 rounded-lg font-black text-sm ${badgeClass}">${recommendation}</span>
                            <span class="font-mono font-bold text-lg ${colorClass}">${Math.round(conf)}%</span>
                        </div>
                        <div class="w-full bg-borderBg h-2 rounded-full overflow-hidden flex">
                            <div class="bg-accentGreen h-full" style="width:${longPct}%"></div>
                            <div class="bg-accentRed h-full" style="width:${shortPct}%"></div>
                        </div>
                        <div class="flex justify-between text-[10px] font-mono">
                            <span class="text-accentGreen">Long ${longPct}%</span>
                            <span class="text-accentRed">Short ${shortPct}%</span>
                        </div>
                    </div>
                    <p class="text-[11px] text-slate-300 leading-relaxed mt-1">${actionHint}</p>
                    <div class="space-y-1 mt-1">
                        ${reasons.map(r => `
                            <div class="flex justify-between items-center text-[10px]">
                                <span class="${r.side === 'L' ? 'text-accentGreen' : r.side === 'S' ? 'text-accentRed' : 'text-slate-400'}">• ${r.txt}</span>
                                <span class="font-mono text-slate-500">${r.pts > 0 ? '+' + r.pts : r.pts}</span>
                            </div>
                        `).join('')}
                    </div>
                    ${recommendation !== 'ESPERAR' ? `
                    <div class="grid grid-cols-3 gap-1.5 mt-2 text-[11px] font-mono">
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-slate-500 text-[9px]">ENTRADA</div>
                            <div class="text-white font-bold">$${entry.toFixed(1)}</div>
                        </div>
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-accentRed text-[9px]">SL (pared)</div>
                            <div class="text-accentRed font-bold">$${sl.toFixed(1)}</div>
                        </div>
                        <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                            <div class="text-accentGreen text-[9px]">TP ~2R</div>
                            <div class="text-accentGreen font-bold">$${tp.toFixed(1)}</div>
                        </div>
                    </div>
                    <button type="button" onclick="window.applyWyckoffProjection && window.applyWyckoffProjection('${recommendation}', ${entry.toFixed(2)}, ${sl.toFixed(2)}, ${tp.toFixed(2)})"
                        class="w-full mt-2 py-1.5 rounded border border-borderBg bg-panelBg hover:bg-borderBg text-[11px] font-semibold transition">
                        <i class="fa-solid fa-bolt mr-1"></i> Aplicar ${recommendation} a la orden
                    </button>
                    ` : ''}
                `;
            }
            try { if (typeof updateSignalsTable === 'function') updateSignalsTable(); } catch (e) {}
        }
        window.projectWyckoffOrderBook = projectWyckoffOrderBook;

        function applyWyckoffProjection(side, entry, sl, tp) {
            if (side === 'ESPERAR') return;
            if (typeof setTradeSide === 'function') setTradeSide(side);
            const ep = document.getElementById('entryPrice');
            const slEl = document.getElementById('stopLoss');
            const tpEl = document.getElementById('takeProfit');
            if (ep) ep.value = entry;
            if (slEl) slEl.value = sl;
            if (tpEl) tpEl.value = tp;
            if (typeof calculateTradeMetrics === 'function') calculateTradeMetrics();
        }
        window.applyWyckoffProjection = applyWyckoffProjection;

        function updateSignalsTable() {
            // 1. Trendilo Signal Analysis (ALMA %chg vs RMS — dudeowns OS)
            const zScore = parseFloat(trendiloLatest.zScore);
            const tDir = trendiloLatest.direction || '';
            let trendiloBadgeHtml = '';
            let trendiloState = '';
            let trendiloDesc = '';

            if (tDir.includes('Alcista') || zScore > 0.15) {
                trendiloBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentGreen/20 text-accentGreen border border-accentGreen/30">LONG (COMPRA)</span>`;
                trendiloState = `<span class="text-accentGreen font-bold">ALMA alcista (${zScore.toFixed(3)})</span>`;
                trendiloDesc = 'ALMA del % cambio por encima de la banda RMS → tendencia alcista (Trendilo OS).';
            } else if (tDir.includes('Bajista') || zScore < -0.15) {
                trendiloBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentRed/20 text-accentRed border border-accentRed/30">SHORT (VENTA)</span>`;
                trendiloState = `<span class="text-accentRed font-bold">ALMA bajista (${zScore.toFixed(3)})</span>`;
                trendiloDesc = 'ALMA del % cambio por debajo de la banda RMS → tendencia bajista (Trendilo OS).';
            } else {
                trendiloBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400">NEUTRAL</span>`;
                trendiloState = `<span class="text-slate-400">Lateral (${zScore.toFixed(3)})</span>`;
                trendiloDesc = 'ALMA dentro de bandas RMS → sin tendencia clara (Trendilo OS).';
            }

            document.getElementById('sigTrendiloVal').innerText = `ALMA: ${zScore.toFixed(3)}`;
            document.getElementById('sigTrendiloState').innerHTML = trendiloState;
            document.getElementById('sigTrendiloBadge').outerHTML = `<span id="sigTrendiloBadge">${trendiloBadgeHtml}</span>`;
            document.getElementById('sigTrendiloDesc').innerText = trendiloDesc;

            // 2. Stoch RSI Signal Analysis
            const kVal = parseFloat(stochRsiLatest.k);
            let stochBadgeHtml = '';
            let stochState = '';
            let stochDesc = '';

            if (kVal < 20) {
                stochBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentGreen/20 text-accentGreen border border-accentGreen/30">LONG (SOBREVENTA)</span>`;
                stochState = `<span class="text-accentGreen font-bold">Sobreventa Extrema (%K: ${kVal})</span>`;
                stochDesc = 'Oscilador por debajo de 20. Potencial rebote o punto de giro comprador.';
            } else if (kVal > 80) {
                stochBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentRed/20 text-accentRed border border-accentRed/30">SHORT (SOBRECOMPRA)</span>`;
                stochState = `<span class="text-accentRed font-bold">Sobrecompra Extrema (%K: ${kVal})</span>`;
                stochDesc = 'Oscilador por encima de 80. Agotamiento comprador y posible retroceso.';
            } else {
                stochBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400">NEUTRAL</span>`;
                stochState = `<span class="text-slate-400">Zona Neutra (%K: ${kVal})</span>`;
                stochDesc = 'El oscilador cotiza dentro de la zona intermedia sin señales extremas.';
            }

            document.getElementById('sigStochVal').innerText = `%K: ${stochRsiLatest.k} / %D: ${stochRsiLatest.d}`;
            document.getElementById('sigStochState').innerHTML = stochState;
            document.getElementById('sigStochBadge').outerHTML = `<span id="sigStochBadge">${stochBadgeHtml}</span>`;
            document.getElementById('sigStochDesc').innerText = stochDesc;

            // 3. DMI Signal Analysis (+DI / -DI)
            const pDI = parseFloat(dmiLatest.pDI) || 0;
            const nDI = parseFloat(dmiLatest.nDI) || 0;
            const diSpread = parseFloat(dmiLatest.diSpread) || Math.abs(pDI - nDI);
            let dmiBadgeHtml = '';
            let dmiState = '';
            let dmiDesc = '';

            if (diSpread >= 10) {
                if (pDI > nDI) {
                    dmiBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentGreen/20 text-accentGreen border border-accentGreen/30">LONG (+DI > -DI)</span>`;
                    dmiState = `<span class="text-accentGreen font-bold">DMI Alcista</span>`;
                    dmiDesc = `+DI (${pDI}) por encima de -DI (${nDI}). Separación Δ${diSpread.toFixed(1)} → dominio comprador.`;
                } else {
                    dmiBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentRed/20 text-accentRed border border-accentRed/30">SHORT (-DI > +DI)</span>`;
                    dmiState = `<span class="text-accentRed font-bold">DMI Bajista</span>`;
                    dmiDesc = `-DI (${nDI}) por encima de +DI (${pDI}). Separación Δ${diSpread.toFixed(1)} → dominio vendedor.`;
                }
            } else {
                dmiBadgeHtml = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400 font-mono">NEUTRAL</span>`;
                dmiState = `<span class="text-slate-400">Sin dirección clara</span>`;
                dmiDesc = `+DI y -DI cercanos (Δ${diSpread.toFixed(1)} < 10). Mercado lateral o sin convicción direccional.`;
            }

            document.getElementById('sigDmiVal').innerText = `+DI ${pDI} / -DI ${nDI}`;
            document.getElementById('sigDmiState').innerHTML = dmiState;
            document.getElementById('sigDmiBadge').outerHTML = `<span id="sigDmiBadge">${dmiBadgeHtml}</span>`;
            document.getElementById('sigDmiDesc').innerText = dmiDesc;

            // 4. Yoshi Scanner Signal
            try {
                const y = yoshiLatest || {};
                const ySig = y.signal || 'NONE';
                const stTxt = y.trend === 1 ? 'SuperTrend alcista' : 'SuperTrend bajista';
                let yBadge = '', yState = '', yDesc = '';
                const yVal = `${y.trend === 1 ? 'ST↑' : 'ST↓'} | ${y.structure || '—'} | ${y.bos || '—'} | ${y.eq || '—'}`;
                if (ySig === 'BUY') {
                    yBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-400/40">COMPRA (Yoshi)</span>`;
                    yState = `<span class="text-accentGreen font-bold">Setup alcista</span>`;
                    yDesc = `${stTxt}. Estructura ${y.structure}. ${y.bos !== '—' ? 'BOS alcista. ' : ''}${y.eq && y.eq !== 'none' ? 'Liquidez ' + y.eq + '. ' : ''}ENTRY≈${y.entry ? y.entry.toFixed(2) : '—'} SL≈${y.sl ? y.sl.toFixed(2) : '—'} TP1≈${y.tp1 ? y.tp1.toFixed(2) : '—'}.`;
                } else if (ySig === 'SELL') {
                    yBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentRed/20 text-accentRed border border-accentRed/30">VENTA (Yoshi)</span>`;
                    yState = `<span class="text-accentRed font-bold">Setup bajista</span>`;
                    yDesc = `${stTxt}. Estructura ${y.structure}. ${y.bos !== '—' ? 'BOS bajista. ' : ''}${y.eq && y.eq !== 'none' ? 'Liquidez ' + y.eq + '. ' : ''}ENTRY≈${y.entry ? y.entry.toFixed(2) : '—'} SL≈${y.sl ? y.sl.toFixed(2) : '—'} TP1≈${y.tp1 ? y.tp1.toFixed(2) : '—'}.`;
                } else {
                    yBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400">ESPERAR</span>`;
                    yState = `<span class="text-slate-400">Sin confirmación completa</span>`;
                    yDesc = `${stTxt}. Estructura ${y.structure || 'lateral'}. Estado setup: ${y.state || 0}/3 (liq→BOS→retest). Esperar alineación SuperTrend + estructura.`;
                }
                const elV = document.getElementById('sigYoshiVal');
                const elS = document.getElementById('sigYoshiState');
                const elB = document.getElementById('sigYoshiBadge');
                const elD = document.getElementById('sigYoshiDesc');
                if (elV) elV.innerText = yVal;
                if (elS) elS.innerHTML = yState;
                if (elB) elB.outerHTML = `<span id="sigYoshiBadge">${yBadge}</span>`;
                if (elD) elD.innerText = yDesc;
            } catch (e) { console.warn('yoshi signal row', e); }

            // 5. Wyckoff + Order Book Signal
            try {
                const w = wyckoffLatest || {};
                const wSig = w.signal || 'NONE';
                const imbPctW = ((w.imbalance || 0) * 100).toFixed(0);
                let wBadge = '', wState = '', wDesc = '';
                const wVal = `${w.phase || '—'} | Imb ${imbPctW}% | ${(w.count || 0)} exch`;
                if (wSig === 'BUY') {
                    wBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-400/40">LONG (Wyckoff)</span>`;
                    wState = `<span class="text-accentGreen font-bold">${w.bias || 'Acumulación'}</span>`;
                    wDesc = w.desc || 'Bids dominan · posible acumulación / Spring.';
                } else if (wSig === 'SELL') {
                    wBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-accentRed/20 text-accentRed border border-accentRed/30">SHORT (Wyckoff)</span>`;
                    wState = `<span class="text-accentRed font-bold">${w.bias || 'Distribución'}</span>`;
                    wDesc = w.desc || 'Asks dominan · posible distribución / UTAD.';
                } else {
                    wBadge = `<span class="px-2.5 py-1 rounded text-xs font-bold bg-slate-800 text-slate-400">ESPERAR</span>`;
                    wState = `<span class="text-slate-400">${w.bias || 'Equilibrado'}</span>`;
                    wDesc = w.desc || 'Libro equilibrado. Sin absorption clara.';
                }
                const elWV = document.getElementById('sigWyckoffVal');
                const elWS = document.getElementById('sigWyckoffState');
                const elWB = document.getElementById('sigWyckoffBadge');
                const elWD = document.getElementById('sigWyckoffDesc');
                if (elWV) elWV.innerText = wVal;
                if (elWS) elWS.innerHTML = wState;
                if (elWB) elWB.outerHTML = `<span id="sigWyckoffBadge">${wBadge}</span>`;
                if (elWD) elWD.innerText = wDesc;
            } catch (e) { console.warn('wyckoff signal row', e); }

            // 6. Confluencia ponderada por P(acierto) del TF superior
            let longScore = 0;
            let shortScore = 0;
            let weightSum = 0;
            const filtOn = (k) => (typeof isIndActive === 'function' ? isIndActive(k) : true);
            const wOf = (k) => (typeof getIndicatorWeight === 'function' ? getIndicatorWeight(k) : 1);

            if (filtOn('trendilo')) {
                const w = wOf('trendilo'); weightSum += w;
                if (zScore > 0.15 || (trendiloLatest.direction || '').includes('Alcista')) longScore += w;
                else if (zScore < -0.15 || (trendiloLatest.direction || '').includes('Bajista')) shortScore += w;
            }
            if (filtOn('stoch')) {
                const w = wOf('stoch'); weightSum += w;
                if (kVal < 20) longScore += w; else if (kVal > 80) shortScore += w;
            }
            if (filtOn('dmi')) {
                const w = wOf('dmi'); weightSum += w;
                if (diSpread >= 10) {
                    if (pDI > nDI) longScore += w;
                    else shortScore += w;
                }
            }
            if (filtOn('yoshi')) {
                const w = wOf('yoshi'); weightSum += w;
                if (yoshiLatest && yoshiLatest.signal === 'BUY') longScore += w;
                else if (yoshiLatest && yoshiLatest.signal === 'SELL') shortScore += w;
            }
            if (filtOn('wyckoff')) {
                const w = wOf('wyckoff'); weightSum += w;
                if (wyckoffLatest && wyckoffLatest.signal === 'BUY') longScore += w;
                else if (wyckoffLatest && wyckoffLatest.signal === 'SELL') shortScore += w;
            }

            const totalDir = longScore + shortScore || 1;
            const longPctW = Math.round((longScore / totalDir) * 100);
            const edge = Math.abs(longScore - shortScore);
            const need = Math.max(0.15, weightSum * 0.22);
            let conflBadge = '';
            let conflStatus = '';
            let conflDesc = '';
            const tfTag = currentInterval || '—';

            if (edge >= need && longScore > shortScore) {
                conflBadge = `<span class="px-3 py-1 rounded text-xs font-black bg-accentGreen text-slate-950 shadow-md">LONG (${longPctW}% peso · TF ${tfTag})</span>`;
                conflStatus = `<span class="text-accentGreen font-bold">Confluencia alcista ponderada</span>`;
                conflDesc = `TF ${tfTag} guía pesos. Long ${longScore.toFixed(2)} vs Short ${shortScore.toFixed(2)} (P(acierto) relativa). Setup óptimo alineado.`;
            } else if (edge >= need && shortScore > longScore) {
                conflBadge = `<span class="px-3 py-1 rounded text-xs font-black bg-accentRed text-white shadow-md">SHORT (${100 - longPctW}% peso · TF ${tfTag})</span>`;
                conflStatus = `<span class="text-accentRed font-bold">Confluencia bajista ponderada</span>`;
                conflDesc = `TF ${tfTag} guía pesos. Short ${shortScore.toFixed(2)} vs Long ${longScore.toFixed(2)}. Setup óptimo alineado.`;
            } else {
                conflBadge = `<span class="px-3 py-1 rounded text-xs font-black bg-accentYellow text-slate-950">NEUTRAL (TF ${tfTag})</span>`;
                conflStatus = `<span class="text-accentYellow font-bold">Sin ventaja clara</span>`;
                conflDesc = `TF ${tfTag}: pesos sin mayoría. Usa «Óptimo por TF» o espera confirmación de los indicadores top del ranking.`;
            }

            document.getElementById('sigConfluenceScore').innerText = `L ${longScore.toFixed(2)} | S ${shortScore.toFixed(2)} · TF ${tfTag}`;
            document.getElementById('sigConfluenceStatus').innerHTML = conflStatus;
            document.getElementById('sigConfluenceBadge').outerHTML = `<span id="sigConfluenceBadge">${conflBadge}</span>`;
            document.getElementById('sigConfluenceDesc').innerText = conflDesc;

            // Auto-update next hour projection
            try { projectNextHourBias(); } catch (e) {}
        }

        // Horizonte de proyección: 1m, 3m, 5m, 9m, 20m, 1h, 4h, 1d
        let projectionHorizon = '1h';
        const PROJECTION_HORIZON_LABELS = {
            '1m': 'próx. 1 minuto',
            '3m': 'próx. 3 minutos',
            '5m': 'próx. 5 minutos',
            '9m': 'próx. 9 minutos',
            '20m': 'próx. 20 minutos',
            '1h': 'próx. 1 hora',
            '4h': 'próx. 4 horas',
            '1d': 'próx. 1 día'
        };
        // Barras recientes a mirar para ROC — alineado al TF elegido (9m, 20m, etc.)
        const PROJECTION_LOOKBACK = {
            '1m': 2, '3m': 3, '5m': 4, '9m': 5, '15m': 6, '20m': 6, '1h': 8, '4h': 12, '1d': 24
        };

        function setProjectionHorizon(h) {
            try {
                if (!h) return;
                projectionHorizon = String(h);
                document.querySelectorAll('.ph-btn, [data-ph]').forEach(btn => {
                    const on = btn.getAttribute('data-ph') === projectionHorizon;
                    // Mantener tamaño según si es botón grande (bottom) o compacto (sidebar)
                    const isBig = (btn.className || '').includes('px-2.5') || btn.closest('#projectionHorizonFiltersBottom');
                    if (isBig) {
                        btn.className = on
                            ? 'ph-btn px-2.5 py-1.5 rounded text-[11px] font-mono border border-accentYellow/50 bg-accentYellow/15 text-accentYellow cursor-pointer'
                            : 'ph-btn px-2.5 py-1.5 rounded text-[11px] font-mono border border-borderBg text-slate-400 hover:text-white cursor-pointer';
                    } else {
                        btn.className = on
                            ? 'ph-btn px-1.5 py-0.5 rounded text-[10px] font-mono border border-accentYellow/50 bg-accentYellow/15 text-accentYellow'
                            : 'ph-btn px-1.5 py-0.5 rounded text-[10px] font-mono border border-borderBg text-slate-400 hover:text-white';
                    }
                });
                projectNextHourBias();
                try { if (typeof projectWyckoffOrderBook === 'function') projectWyckoffOrderBook(); } catch (e) {}
            } catch (err) {
                console.error('setProjectionHorizon', err);
            }
        }
        // Exponer en window (onclick / Google Sites / iframe)
        window.setProjectionHorizon = setProjectionHorizon;
        window.projectNextHourBias = projectNextHourBias;

        function projectNextHourBias() {
            const box = document.getElementById('nextHourProjection');
            const boxBottom = document.getElementById('bottomNextHourProjection');
            if (!box && !boxBottom) return;
            try {
            if (!rawKlines || rawKlines.length < 5) {
                const waitMsg = '<div class="text-center py-2 text-slate-500 italic">Esperando datos de mercado...</div>';
                if (box) box.innerHTML = waitMsg;
                if (boxBottom) boxBottom.innerHTML = waitMsg;
                return;
            }

            // TF del gráfico (header) guía el horizonte de proyección
            const chartTf = currentInterval || '1h';
            const setupOpt = (typeof getOptimalSetup === 'function') ? getOptimalSetup(chartTf) : null;
            const horizon = (setupOpt && setupOpt.horizon) || projectionHorizon || chartTf || '1h';
            if (projectionHorizon !== horizon && typeof setProjectionHorizon === 'function') {
                try { projectionHorizon = horizon; } catch (e) {}
            }
            const horizonLabel = PROJECTION_HORIZON_LABELS[horizon] || ('próx. ' + horizon);
            const isScalp = ['1m', '3m', '5m', '9m'].includes(horizon);
            const isSwing = ['4h', '1d'].includes(horizon);

            // Pesos = ranking P(acierto) del TF superior (×10 para escala de puntos)
            const gw = (k, fallback) => {
                if (typeof getIndicatorWeight === 'function' && indicatorWeightMap && indicatorWeightMap[k] != null) {
                    return Math.max(0.3, getIndicatorWeight(k) * 10);
                }
                return fallback;
            };
            const gate = (k, w) => ((typeof isIndActive === 'function' && !isIndActive(k)) ? 0 : w);
            const wTrendilo = gate('trendilo', gw('trendilo', isScalp ? 0.7 : isSwing ? 1.3 : 1.0));
            const wStoch = gate('stoch', gw('stoch', isScalp ? 1.4 : isSwing ? 0.7 : 1.0));
            const wDmi = gate('dmi', gw('dmi', isScalp ? 0.6 : isSwing ? 1.35 : 1.0));
            const wYoshi = gate('yoshi', gw('yoshi', isScalp ? 0.85 : isSwing ? 1.4 : 1.15));
            const wStruct = gate('sr', gw('sr', isScalp ? 0.8 : isSwing ? 1.15 : 1.0));
            const wRoc = isScalp ? 1.5 : isSwing ? 0.85 : 1.1;
            const wWyck = gate('wyckoff', gw('wyckoff', 1.1));

            const z = parseFloat(trendiloLatest.zScore) || 0;
            const k = parseFloat(stochRsiLatest.k) || 50;
            const pDI = parseFloat(dmiLatest.pDI) || 0;
            const nDI = parseFloat(dmiLatest.nDI) || 0;
            const diSpread = parseFloat(dmiLatest.diSpread) || Math.abs(pDI - nDI);
            const price = rawKlines[rawKlines.length - 1].close;
            const poc = volumeProfileData.poc || price;
            const nearestSup = calculatedPivots.nearestSup || price * 0.98;
            const nearestRes = calculatedPivots.nearestRes || price * 1.02;
            const lsr = parseFloat(lsrLatest) || 1;

            let longPts = 0;
            let shortPts = 0;
            const reasons = [];

            // 0. Micro-momentum (ROC de últimas N barras según horizonte)
            const lb = Math.min(PROJECTION_LOOKBACK[horizon] || 6, rawKlines.length - 1);
            const past = rawKlines[rawKlines.length - 1 - lb];
            const roc = past && past.close ? ((price - past.close) / past.close) * 100 : 0;
            const rocPts = Math.min(22, Math.abs(roc) * 8) * wRoc;
            if (roc > 0.05) {
                longPts += rocPts;
                reasons.push({ side: 'L', txt: `ROC +${roc.toFixed(2)}% (${lb} barras)`, pts: Math.round(rocPts) });
            } else if (roc < -0.05) {
                shortPts += rocPts;
                reasons.push({ side: 'S', txt: `ROC ${roc.toFixed(2)}% (${lb} barras)`, pts: Math.round(rocPts) });
            }

            // 1. Trendilo
            const tDir = trendiloLatest.direction || '';
            if (tDir.includes('Alcista') || z > 0.15) {
                const pts = Math.round(25 * wTrendilo);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Trendilo alcista (ALMA=${z.toFixed(3)})`, pts });
            } else if (tDir.includes('Bajista') || z < -0.15) {
                const pts = Math.round(25 * wTrendilo);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Trendilo bajista (ALMA=${z.toFixed(3)})`, pts });
            } else if (z > 0.05) {
                longPts += Math.round(8 * wTrendilo);
                reasons.push({ side: 'L', txt: `Momentum ligeramente positivo`, pts: Math.round(8 * wTrendilo) });
            } else if (z < -0.05) {
                shortPts += Math.round(8 * wTrendilo);
                reasons.push({ side: 'S', txt: `Momentum ligeramente negativo`, pts: Math.round(8 * wTrendilo) });
            }

            // 2. StochRSI
            if (k < 20) {
                const pts = Math.round(20 * wStoch);
                longPts += pts;
                reasons.push({ side: 'L', txt: `StochRSI sobreventa (K=${k.toFixed(0)})`, pts });
            } else if (k > 80) {
                const pts = Math.round(20 * wStoch);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `StochRSI sobrecompra (K=${k.toFixed(0)})`, pts });
            } else if (k < 40) { longPts += Math.round(6 * wStoch); }
            else if (k > 60) { shortPts += Math.round(6 * wStoch); }

            // 3. DMI (+DI / -DI)
            if (diSpread >= 10) {
                if (pDI > nDI) {
                    const pts = Math.round(22 * wDmi);
                    longPts += pts;
                    reasons.push({ side: 'L', txt: `DMI alcista +DI > -DI (Δ${diSpread.toFixed(0)})`, pts });
                } else {
                    const pts = Math.round(22 * wDmi);
                    shortPts += pts;
                    reasons.push({ side: 'S', txt: `DMI bajista -DI > +DI (Δ${diSpread.toFixed(0)})`, pts });
                }
            } else if (diSpread >= 5) {
                if (pDI > nDI) {
                    longPts += Math.round(8 * wDmi);
                    reasons.push({ side: 'L', txt: `DMI leve a favor long`, pts: Math.round(8 * wDmi) });
                } else {
                    shortPts += Math.round(8 * wDmi);
                    reasons.push({ side: 'S', txt: `DMI leve a favor short`, pts: Math.round(8 * wDmi) });
                }
            } else {
                reasons.push({ side: 'N', txt: `DMI plano (Δ${diSpread.toFixed(0)}) → sin dirección`, pts: 0 });
            }

            // 4. Yoshi Scanner Pro (SuperTrend + BOS/CHoCH + estructura + OB)
            const y = (typeof yoshiLatest !== 'undefined' && yoshiLatest) ? yoshiLatest : {};
            const ySig = y.signal || 'NONE';
            const yTrend = y.trend === 1 ? 1 : (y.trend === -1 ? -1 : 0);
            const yStruct = (y.structure || '');
            const yBos = (y.bos || '—');

            if (ySig === 'BUY') {
                const pts = Math.round(28 * wYoshi);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Yoshi COMPRA · ${yBos} · ST↑`, pts });
            } else if (ySig === 'SELL') {
                const pts = Math.round(28 * wYoshi);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Yoshi VENTA · ${yBos} · ST↓`, pts });
            } else if (yTrend === 1 && (yStruct.includes('Alcista') || (yBos && yBos.includes('↑')))) {
                const pts = Math.round(16 * wYoshi);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Yoshi ST↑ + estructura alcista (${yBos})`, pts });
            } else if (yTrend === -1 && (yStruct.includes('Bajista') || (yBos && yBos.includes('↓')))) {
                const pts = Math.round(16 * wYoshi);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Yoshi ST↓ + estructura bajista (${yBos})`, pts });
            } else if (yTrend === 1) {
                const pts = Math.round(10 * wYoshi);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Yoshi SuperTrend alcista`, pts });
            } else if (yTrend === -1) {
                const pts = Math.round(10 * wYoshi);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Yoshi SuperTrend bajista`, pts });
            } else {
                reasons.push({ side: 'N', txt: `Yoshi sin señal clara (WAIT)`, pts: 0 });
            }

            // OB: precio en zona de compra/venta refuerza sesgo
            if (y.hasBullOB && ySig !== 'SELL') {
                const pts = Math.round(8 * wYoshi);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Yoshi OB compra activo`, pts });
            }
            if (y.hasBearOB && ySig !== 'BUY') {
                const pts = Math.round(8 * wYoshi);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Yoshi OB venta activo`, pts });
            }

            // 5. Price vs POC / S-R
            const distSup = ((price - nearestSup) / price) * 100;
            const distRes = ((nearestRes - price) / price) * 100;
            if (distSup < 1.2) {
                const pts = Math.round(12 * wStruct);
                longPts += pts;
                reasons.push({ side: 'L', txt: `Cerca de soporte ($${nearestSup.toFixed(0)})`, pts });
            }
            if (distRes < 1.2) {
                const pts = Math.round(12 * wStruct);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `Cerca de resistencia ($${nearestRes.toFixed(0)})`, pts });
            }
            if (price >= poc) { longPts += Math.round(6 * wStruct); } else { shortPts += Math.round(6 * wStruct); }

            // 6. LSR (menos peso en scalp ultra-corto)
            const lsrW = isScalp ? 0.5 : 1;
            if (lsr > 1.3) {
                const pts = Math.round(8 * lsrW);
                shortPts += pts;
                reasons.push({ side: 'S', txt: `LSR alto (${lsr}) → crowding long`, pts });
            } else if (lsr < 0.8) {
                const pts = Math.round(8 * lsrW);
                longPts += pts;
                reasons.push({ side: 'L', txt: `LSR bajo (${lsr}) → crowding short`, pts });
            }

            const total = longPts + shortPts || 1;
            const longPct = Math.round((longPts / total) * 100);
            const shortPct = 100 - longPct;
            const edge = Math.abs(longPts - shortPts);
            const dmiFloor = isScalp ? 5 : isSwing ? 10 : 8;
            const edgeFloor = isScalp ? 10 : 12;

            let recommendation, colorClass, badgeClass, confidence, actionHint;

            if (edge < edgeFloor || diSpread < dmiFloor) {
                recommendation = 'ESPERAR';
                colorClass = 'text-accentYellow';
                badgeClass = 'bg-accentYellow text-slate-950';
                confidence = Math.min(55, 40 + edge);
                actionHint = `Sin sesgo claro o mercado en rango. Mejor no forzar entrada en el ${horizonLabel}.`;
            } else if (longPts > shortPts) {
                recommendation = 'LONG';
                colorClass = 'text-accentGreen';
                badgeClass = 'bg-accentGreen text-slate-950';
                confidence = Math.min(92, 55 + edge);
                actionHint = `Sesgo alcista para el ${horizonLabel}. Busca entrada cerca de soporte o pullback.`;
            } else {
                recommendation = 'SHORT';
                colorClass = 'text-accentRed';
                badgeClass = 'bg-accentRed text-white';
                confidence = Math.min(92, 55 + edge);
                actionHint = `Sesgo bajista para el ${horizonLabel}. Busca entrada en rechazo de resistencia.`;
            }

            reasons.sort((a, b) => b.pts - a.pts);
            const topReasons = reasons.slice(0, 5);

            const html = `
                <div class="text-center space-y-1.5">
                    <div class="text-[10px] text-slate-400 uppercase tracking-wider">Mejor dirección (${horizonLabel})</div>
                    <div class="flex items-center justify-center gap-2">
                        <span class="px-3 py-1 rounded-lg font-black text-sm ${badgeClass}">${recommendation}</span>
                        <span class="font-mono font-bold text-lg ${colorClass}">${confidence}%</span>
                    </div>
                    <div class="w-full bg-borderBg h-2 rounded-full overflow-hidden flex">
                        <div class="bg-accentGreen h-full transition-all" style="width:${longPct}%"></div>
                        <div class="bg-accentRed h-full transition-all" style="width:${shortPct}%"></div>
                    </div>
                    <div class="flex justify-between text-[10px] font-mono">
                        <span class="text-accentGreen">Long ${longPct}%</span>
                        <span class="text-accentRed">Short ${shortPct}%</span>
                    </div>
                </div>
                <p class="text-[11px] text-slate-300 leading-relaxed mt-1">${actionHint}</p>
                <div class="space-y-1 mt-1">
                    ${topReasons.map(r => `
                        <div class="flex justify-between items-center text-[10px]">
                            <span class="${r.side === 'L' ? 'text-accentGreen' : r.side === 'S' ? 'text-accentRed' : 'text-slate-400'}">• ${r.txt}</span>
                            <span class="font-mono text-slate-500">${r.pts > 0 ? '+' + r.pts : '—'}</span>
                        </div>
                    `).join('')}
                </div>
                <button type="button" onclick="window.applyProjectionToOrder && window.applyProjectionToOrder('${recommendation}')" class="w-full mt-2 py-1.5 rounded border border-borderBg bg-panelBg hover:bg-borderBg text-[11px] font-semibold transition ${recommendation === 'ESPERAR' ? 'opacity-50 cursor-not-allowed' : ''}" ${recommendation === 'ESPERAR' ? 'disabled' : ''}>
                    <i class="fa-solid fa-bolt mr-1"></i> Aplicar ${recommendation} a la orden
                </button>
            `;
            if (box) box.innerHTML = html;
            if (boxBottom) boxBottom.innerHTML = html;
            } catch (err) {
                console.error('projectNextHourBias', err);
                const errHtml = `<div class="text-accentRed text-[11px] p-2">Error en proyección: ${err.message || err}</div>`;
                if (box) box.innerHTML = errHtml;
                if (boxBottom) boxBottom.innerHTML = errHtml;
            }
        }
        window.projectNextHourBias = projectNextHourBias;

        function applyProjectionToOrder(side) {
            if (side === 'ESPERAR') return;
            setTradeSide(side);
            setCurrentPriceAsEntry();
            applySmartLevels();
            // Scroll / highlight left panel a bit
            const btn = side === 'LONG' ? document.getElementById('btnSideLong') : document.getElementById('btnSideShort');
            if (btn) {
                btn.classList.add('ring-2', 'ring-accentYellow');
                setTimeout(() => btn.classList.remove('ring-2', 'ring-accentYellow'), 1200);
            }
        }

        function calculateSupportsResistances() {
            const lookback = 20;
            const currentPrice = rawKlines[rawKlines.length - 1].close;
            let supports = [];
            let resistances = [];

            for (let i = lookback; i < rawKlines.length - lookback; i++) {
                const high = rawKlines[i].high;
                const low = rawKlines[i].low;

                let isPivotHigh = true;
                let isPivotLow = true;

                for (let j = 1; j <= 5; j++) {
                    if (rawKlines[i - j].high >= high || rawKlines[i + j].high >= high) isPivotHigh = false;
                    if (rawKlines[i - j].low <= low || rawKlines[i + j].low <= low) isPivotLow = false;
                }

                if (isPivotHigh) resistances.push(high);
                if (isPivotLow) supports.push(low);
            }

            const nearestSup = supports.filter(s => s < currentPrice).sort((a, b) => b - a)[0] || (currentPrice * 0.98);
            const nearestRes = resistances.filter(r => r > currentPrice).sort((a, b) => a - b)[0] || (currentPrice * 1.02);

            calculatedPivots = { supports, resistances, nearestSup, nearestRes };

            document.getElementById('indSR').innerText = `Sup: $${nearestSup.toFixed(1)} | Res: $${nearestRes.toFixed(1)}`;
        }

        function calculateVolumeProfile() {
            if (rawKlines.length === 0) return;

            let minPrice = Infinity;
            let maxPrice = -Infinity;

            rawKlines.forEach(k => {
                if (k.low < minPrice) minPrice = k.low;
                if (k.high > maxPrice) maxPrice = k.high;
            });

            const bucketsCount = 24;
            const step = (maxPrice - minPrice) / bucketsCount;
            let buckets = new Array(bucketsCount).fill(0);

            rawKlines.forEach(k => {
                const bucketIdx = Math.min(Math.floor((k.close - minPrice) / step), bucketsCount - 1);
                if (bucketIdx >= 0) buckets[bucketIdx] += k.volume;
            });

            let maxVolIdx = 0;
            buckets.forEach((vol, idx) => {
                if (vol > buckets[maxVolIdx]) maxVolIdx = idx;
            });

            const pocPrice = minPrice + (maxVolIdx * step) + (step / 2);
            volumeProfileData = {
                poc: pocPrice,
                vah: pocPrice + (step * 3),
                val: pocPrice - (step * 3)
            };

            document.getElementById('indPOC').innerText = `$${pocPrice.toFixed(1)}`;
        }

        async function fetchLongShortRatio() {
            try {
                const res = await fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${currentSymbol}&period=1h&limit=1`);
                const data = await res.json();
                if (data && data.length > 0) {
                    lsrLatest = parseFloat(data[0].longShortRatio).toFixed(2);
                    const el = document.getElementById('indLSR');
                    el.innerText = `${lsrLatest} (${(data[0].longAccount * 100).toFixed(0)}% L / ${(data[0].shortAccount * 100).toFixed(0)}% S)`;
                    el.className = `font-mono font-bold ${lsrLatest >= 1 ? 'text-accentGreen' : 'text-accentRed'}`;
                }
            } catch (e) {
                document.getElementById('indLSR').innerText = '1.15 (Est.)';
            }
        }

        function changeTimeframe(tf) {
            if (!tf) return;
            try {
                // Nueva temporalidad → permitir fitContent en el próximo fetch
                if (String(tf) !== currentInterval) {
                    savedChartLogicalRange = null;
                }
                currentInterval = String(tf);
                document.querySelectorAll('.tf-btn').forEach(btn => {
                    const btnTf = btn.getAttribute('data-tf') || (btn.id || '').replace(/^tf-/, '');
                    const isActive = btnTf === currentInterval;
                    btn.className = isActive
                        ? 'tf-btn px-1.5 sm:px-2 py-1 rounded font-medium bg-borderBg text-white'
                        : 'tf-btn px-1.5 sm:px-2 py-1 rounded font-medium text-slate-400 hover:text-white';
                });
                console.log('[TF]', currentInterval, '→ setup óptimo + fetchMarketData');
                // TF superior guía: proyección + pesos por P(acierto) + filtros óptimos
                try {
                    if (typeof applyOptimalSetupForTf === 'function') {
                        applyOptimalSetupForTf(currentInterval, { force: !userLockedFilters });
                    }
                } catch (e) { console.warn('optimal setup', e); }
                // Reset suavizado OB al cambiar TF (nuevo contexto)
                try { wyckoffImbHistory = []; } catch (e) {}
                if (typeof window.fetchMarketData === 'function') {
                    window.fetchMarketData();
                } else if (typeof fetchMarketData === 'function') {
                    fetchMarketData();
                }
            } catch (err) {
                console.error('changeTimeframe', err);
            }
        }
        window.changeTimeframe = changeTimeframe;
        window.fetchMarketData = fetchMarketData;

        function setTradeSide(side) {
            tradeSide = side;
            const btnLong = document.getElementById('btnSideLong');
            const btnShort = document.getElementById('btnSideShort');

            if (side === 'LONG') {
                btnLong.className = 'py-2 text-xs font-bold rounded bg-accentGreen text-white transition';
                btnShort.className = 'py-2 text-xs font-bold rounded text-slate-400 hover:text-white transition';
            } else {
                btnShort.className = 'py-2 text-xs font-bold rounded bg-accentRed text-white transition';
                btnLong.className = 'py-2 text-xs font-bold rounded text-slate-400 hover:text-white transition';
            }
            calculateTradeMetrics();
        }

        function setCurrentPriceAsEntry() {
            if (rawKlines.length > 0) {
                const lastClose = rawKlines[rawKlines.length - 1].close;
                document.getElementById('entryPrice').value = lastClose.toFixed(2);
                calculateTradeMetrics();
            }
        }

        function selectSizePreset(val) {
            if (!val) return;
            document.getElementById('positionSize').value = val;
            calculateTradeMetrics();
        }

        function applySmartLevels() {
            if (rawKlines.length === 0) return;
            const currentPrice = rawKlines[rawKlines.length - 1].close;
            document.getElementById('entryPrice').value = currentPrice.toFixed(2);

            const atrApprox = currentPrice * 0.015; // Aproximación basada en volatilidad estándar
            
            if (tradeSide === 'LONG') {
                // Para Long, colocamos el SL debajo del soporte más cercano o bajo ATR, y TP buscando resistencia o R/R 2:1
                const slVal = Math.max(calculatedPivots.nearestSup || (currentPrice - atrApprox), currentPrice - (atrApprox * 1.5));
                const tpVal = Math.min(calculatedPivots.nearestRes || (currentPrice + (atrApprox * 3)), currentPrice + (atrApprox * 3));
                
                document.getElementById('stopLoss').value = slVal.toFixed(2);
                document.getElementById('takeProfit').value = tpVal.toFixed(2);
                document.getElementById('slTag').innerText = 'Soporte / ATR';
                document.getElementById('tpTag').innerText = 'Resistencia / R:R';
            } else {
                // Para Short, colocamos el SL arriba de la resistencia y TP bajista
                const slVal = Math.min(calculatedPivots.nearestRes || (currentPrice + atrApprox), currentPrice + (atrApprox * 1.5));
                const tpVal = Math.max(calculatedPivots.nearestSup || (currentPrice - (atrApprox * 3)), currentPrice - (atrApprox * 3));

                document.getElementById('stopLoss').value = slVal.toFixed(2);
                document.getElementById('takeProfit').value = tpVal.toFixed(2);
                document.getElementById('slTag').innerText = 'Resistencia / ATR';
                document.getElementById('tpTag').innerText = 'Soporte / R:R';
            }

            // Ajustar apalancamiento inteligente según DMI y Trendilo
            const diSpreadLev = parseFloat(dmiLatest.diSpread || 0);
            const levSelect = document.getElementById('leverage');
            if (diSpreadLev >= 15) {
                levSelect.value = "10"; // Fuerte tendencia, apalancamiento moderado/alto seguro
            } else {
                levSelect.value = "5"; // Mercado en rango, apalancamiento conservador
            }

            calculateTradeMetrics();
        }

        function setupInputListeners() {
            ['entryPrice', 'stopLoss', 'takeProfit', 'positionSize', 'leverage'].forEach(id => {
                document.getElementById(id).addEventListener('input', calculateTradeMetrics);
            });
        }

        function calculateTradeMetrics() {
            const entry = parseFloat(document.getElementById('entryPrice').value) || 0;
            const sl = parseFloat(document.getElementById('stopLoss').value) || 0;
            const tp = parseFloat(document.getElementById('takeProfit').value) || 0;
            const size = parseFloat(document.getElementById('positionSize').value) || 0;
            const leverage = parseFloat(document.getElementById('leverage').value) || 1;

            if (!entry || !sl || !tp) {
                document.getElementById('calcRR').innerText = '0.00';
                return;
            }

            const risk = Math.abs(entry - sl);
            const reward = Math.abs(tp - entry);
            const rr = (reward / (risk || 1)).toFixed(2);
            document.getElementById('calcRR').innerText = rr;

            const margin = size / leverage;
            document.getElementById('calcMargin').innerText = `$${margin.toFixed(2)}`;

            const estProfit = (reward / entry) * size;
            const estLoss = (risk / entry) * size;

            document.getElementById('calcEstProfit').innerText = `+$${estProfit.toFixed(2)}`;
            document.getElementById('calcEstLoss').innerText = `-$${estLoss.toFixed(2)}`;

            let liqPrice = 0;
            if (tradeSide === 'LONG') {
                liqPrice = entry * (1 - (1 / leverage) + 0.004);
            } else {
                liqPrice = entry * (1 + (1 / leverage) - 0.004);
            }
            document.getElementById('calcLiqPrice').innerText = `$${Math.max(0, liqPrice).toFixed(2)}`;
        }

        function openProbabilityModal() {
            const entry = parseFloat(document.getElementById('entryPrice').value);
            const sl = parseFloat(document.getElementById('stopLoss').value);
            const tp = parseFloat(document.getElementById('takeProfit').value);
            const size = parseFloat(document.getElementById('positionSize').value);
            const leverage = parseFloat(document.getElementById('leverage').value);
            const rr = document.getElementById('calcRR').innerText;

            if (!entry || !sl || !tp) {
                alert('Por favor, completa los valores de Entrada, Stop Loss y Take Profit antes de analizar.');
                return;
            }

            const supDist = (((entry - calculatedPivots.nearestSup) / entry) * 100);
            const resDist = (((calculatedPivots.nearestRes - entry) / entry) * 100);

            let winProb = 50;
            let breakdown = [];
            const fOn = (k) => (typeof isIndActive === 'function' ? isIndActive(k) : true);
            const wScale = (k) => {
                // Escala bonus según ranking P(acierto) del TF (0.5–1.4)
                const w = (typeof getIndicatorWeight === 'function') ? getIndicatorWeight(k) : 0.15;
                return Math.max(0.5, Math.min(1.4, w * 6));
            };

            // 1. Trendilo Impact (ALMA %chg vs RMS — dudeowns OS)
            let trendiloBonus = 0;
            let trendiloMsg = "";
            const tBull = (trendiloLatest.direction || '').includes('Alcista') || parseFloat(trendiloLatest.zScore) > 0.15;
            const tBear = (trendiloLatest.direction || '').includes('Bajista') || parseFloat(trendiloLatest.zScore) < -0.15;
            if (tradeSide === 'LONG') {
                if (tBull) {
                    trendiloBonus = 15; trendiloMsg = `Trendilo alcista a favor (ALMA: ${trendiloLatest.value})`;
                } else if (tBear) {
                    trendiloBonus = -15; trendiloMsg = `Trendilo bajista en contra (ALMA: ${trendiloLatest.value})`;
                } else { trendiloBonus = 0; trendiloMsg = `Trendilo lateral/consolidación`; }
            } else {
                if (tBear) {
                    trendiloBonus = 15; trendiloMsg = `Trendilo bajista a favor (ALMA: ${trendiloLatest.value})`;
                } else if (tBull) {
                    trendiloBonus = -15; trendiloMsg = `Trendilo alcista en contra del Short (ALMA: ${trendiloLatest.value})`;
                } else { trendiloBonus = 0; trendiloMsg = `Trendilo lateral/consolidación`; }
            }
            if (!fOn('trendilo')) { trendiloBonus = 0; trendiloMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { trendiloBonus = Math.round(trendiloBonus * wScale('trendilo')); trendiloMsg += ` · peso TF ${Math.round(wScale('trendilo')*100)}%`; }
            winProb += trendiloBonus;
            breakdown.push({ name: "Trendilo (ALMA+RMS)", bonus: trendiloBonus, msg: trendiloMsg, icon: "fa-solid fa-chart-line" });

            // 2. StochRSI Impact
            let stochBonus = 0;
            let stochMsg = "";
            const k = parseFloat(stochRsiLatest.k);
            if (tradeSide === 'LONG') {
                if (k < 20) { stochBonus = 12; stochMsg = `Sobreventa óptima para compra (%K: ${k})`; }
                else if (k > 80) { stochBonus = -10; stochMsg = `Sobrecompra arriesgada para Long (%K: ${k})`; }
                else { stochBonus = 2; stochMsg = `Rango medio (%K: ${k})`; }
            } else {
                if (k > 80) { stochBonus = 12; stochMsg = `Sobrecompra óptima para Short (%K: ${k})`; }
                else if (k < 20) { stochBonus = -10; stochMsg = `Sobreventa arriesgada para Short (%K: ${k})`; }
                else { stochBonus = 2; stochMsg = `Rango medio (%K: ${k})`; }
            }
            if (!fOn('stoch')) { stochBonus = 0; stochMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { stochBonus = Math.round(stochBonus * wScale('stoch')); }
            winProb += stochBonus;
            breakdown.push({ name: "StochRSI", bonus: stochBonus, msg: stochMsg, icon: "fa-solid fa-wave-square" });

            // 3. DMI (+DI / -DI) Impact (+/- 10%)
            let dmiBonus = 0;
            let dmiMsg = "";
            const pDI = parseFloat(dmiLatest.pDI) || 0;
            const nDI = parseFloat(dmiLatest.nDI) || 0;
            const diSp = parseFloat(dmiLatest.diSpread) || Math.abs(pDI - nDI);

            if (diSp >= 10) {
                if ((tradeSide === 'LONG' && pDI > nDI) || (tradeSide === 'SHORT' && nDI > pDI)) {
                    dmiBonus = 10; dmiMsg = `DMI a favor (+DI ${pDI} / -DI ${nDI}, Δ${diSp.toFixed(1)})`;
                } else {
                    dmiBonus = -10; dmiMsg = `DMI en contra (+DI ${pDI} / -DI ${nDI}, Δ${diSp.toFixed(1)})`;
                }
            } else {
                dmiBonus = -3; dmiMsg = `DMI sin dirección clara (Δ${diSp.toFixed(1)} < 10)`;
            }
            if (!fOn('dmi')) { dmiBonus = 0; dmiMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { dmiBonus = Math.round(dmiBonus * wScale('dmi')); }
            winProb += dmiBonus;
            breakdown.push({ name: "DMI (+DI / -DI)", bonus: dmiBonus, msg: dmiMsg, icon: "fa-solid fa-compass" });

            // 4. Yoshi Scanner Pro (SuperTrend + BOS/CHoCH + OB)
            let yoshiBonus = 0;
            let yoshiMsg = "";
            const y = (typeof yoshiLatest !== 'undefined' && yoshiLatest) ? yoshiLatest : {};
            const ySig = y.signal || 'NONE';
            const yTrend = y.trend === 1 ? 1 : (y.trend === -1 ? -1 : 0);
            const yBos = y.bos || '—';
            const yStruct = y.structure || '—';

            if (tradeSide === 'LONG') {
                if (ySig === 'BUY') {
                    yoshiBonus = 15;
                    yoshiMsg = `Yoshi COMPRA alineada (${yBos}, ST↑, ${yStruct})`;
                } else if (ySig === 'SELL') {
                    yoshiBonus = -15;
                    yoshiMsg = `Yoshi VENTA en contra del Long (${yBos}, ST↓)`;
                } else if (yTrend === 1 && (String(yStruct).includes('Alcista') || String(yBos).includes('↑'))) {
                    yoshiBonus = 10;
                    yoshiMsg = `Yoshi ST↑ + estructura alcista (${yBos})`;
                } else if (yTrend === -1) {
                    yoshiBonus = -8;
                    yoshiMsg = `Yoshi SuperTrend bajista en contra del Long`;
                } else if (y.hasBullOB) {
                    yoshiBonus = 6;
                    yoshiMsg = `Yoshi zona OB de compra activa`;
                } else {
                    yoshiBonus = 0;
                    yoshiMsg = `Yoshi sin señal clara (WAIT · ${yStruct})`;
                }
            } else {
                if (ySig === 'SELL') {
                    yoshiBonus = 15;
                    yoshiMsg = `Yoshi VENTA alineada (${yBos}, ST↓, ${yStruct})`;
                } else if (ySig === 'BUY') {
                    yoshiBonus = -15;
                    yoshiMsg = `Yoshi COMPRA en contra del Short (${yBos}, ST↑)`;
                } else if (yTrend === -1 && (String(yStruct).includes('Bajista') || String(yBos).includes('↓'))) {
                    yoshiBonus = 10;
                    yoshiMsg = `Yoshi ST↓ + estructura bajista (${yBos})`;
                } else if (yTrend === 1) {
                    yoshiBonus = -8;
                    yoshiMsg = `Yoshi SuperTrend alcista en contra del Short`;
                } else if (y.hasBearOB) {
                    yoshiBonus = 6;
                    yoshiMsg = `Yoshi zona OB de venta activa`;
                } else {
                    yoshiBonus = 0;
                    yoshiMsg = `Yoshi sin señal clara (WAIT · ${yStruct})`;
                }
            }
            if (!fOn('yoshi')) { yoshiBonus = 0; yoshiMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { yoshiBonus = Math.round(yoshiBonus * wScale('yoshi')); }
            winProb += yoshiBonus;
            breakdown.push({ name: "Yoshi Scanner", bonus: yoshiBonus, msg: yoshiMsg, icon: "fa-solid fa-dragon" });

            // 4b. Wyckoff + Order Book
            let wyckoffBonus = 0;
            let wyckoffMsg = "";
            const wk = (typeof wyckoffLatest !== 'undefined' && wyckoffLatest) ? wyckoffLatest : {};
            const wkSig = wk.signal || 'NONE';
            const wkImb = parseFloat(wk.imbalance) || 0;
            if (tradeSide === 'LONG') {
                if (wkSig === 'BUY') {
                    wyckoffBonus = 14;
                    wyckoffMsg = `Wyckoff ${wk.bias || 'acumulación'} a favor (imb +${(wkImb*100).toFixed(0)}%)`;
                } else if (wkSig === 'SELL') {
                    wyckoffBonus = -12;
                    wyckoffMsg = `Wyckoff ${wk.bias || 'distribución'} en contra del Long`;
                } else if (wkImb > 0.1) {
                    wyckoffBonus = 6;
                    wyckoffMsg = `OB bids dominan (+${(wkImb*100).toFixed(0)}%) · soporte`;
                } else if (wkImb < -0.1) {
                    wyckoffBonus = -6;
                    wyckoffMsg = `OB asks dominan · presión vendedora`;
                } else {
                    wyckoffBonus = 0;
                    wyckoffMsg = `Wyckoff neutro (${wk.phase || 'Phase B'})`;
                }
            } else {
                if (wkSig === 'SELL') {
                    wyckoffBonus = 14;
                    wyckoffMsg = `Wyckoff ${wk.bias || 'distribución'} a favor (imb ${(wkImb*100).toFixed(0)}%)`;
                } else if (wkSig === 'BUY') {
                    wyckoffBonus = -12;
                    wyckoffMsg = `Wyckoff ${wk.bias || 'acumulación'} en contra del Short`;
                } else if (wkImb < -0.1) {
                    wyckoffBonus = 6;
                    wyckoffMsg = `OB asks dominan (${(wkImb*100).toFixed(0)}%) · resistencia`;
                } else if (wkImb > 0.1) {
                    wyckoffBonus = -6;
                    wyckoffMsg = `OB bids dominan · presión compradora`;
                } else {
                    wyckoffBonus = 0;
                    wyckoffMsg = `Wyckoff neutro (${wk.phase || 'Phase B'})`;
                }
            }
            if (!fOn('wyckoff')) { wyckoffBonus = 0; wyckoffMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { wyckoffBonus = Math.round(wyckoffBonus * wScale('wyckoff')); }
            winProb += wyckoffBonus;
            breakdown.push({ name: "Wyckoff Order Book", bonus: wyckoffBonus, msg: wyckoffMsg, icon: "fa-solid fa-book-open" });

            // 5. Soportes y Resistencias
            let srBonus = 0;
            let srMsg = "";
            if (tradeSide === 'LONG') {
                if (Math.abs(supDist) < 1.5) { srBonus = 10; srMsg = `Entrada óptima cerca de Soporte ($${calculatedPivots.nearestSup.toFixed(1)})`; }
                else if (Math.abs(resDist) < 1.5) { srBonus = -10; srMsg = `Peligro: Entrada cerca de Resistencia ($${calculatedPivots.nearestRes.toFixed(1)})`; }
                else { srBonus = 3; srMsg = `Soporte a ${supDist.toFixed(1)}%`; }
            } else {
                if (Math.abs(resDist) < 1.5) { srBonus = 10; srMsg = `Entrada óptima cerca de Resistencia ($${calculatedPivots.nearestRes.toFixed(1)})`; }
                else if (Math.abs(supDist) < 1.5) { srBonus = -10; srMsg = `Peligro: Entrada cerca de Soporte ($${calculatedPivots.nearestSup.toFixed(1)})`; }
                else { srBonus = 3; srMsg = `Resistencia a ${resDist.toFixed(1)}%`; }
            }
            if (!fOn('sr')) { srBonus = 0; srMsg = 'Filtro desactivado (preset temporalidad)'; }
            else { srBonus = Math.round(srBonus * wScale('sr')); }
            winProb += srBonus;
            breakdown.push({ name: "Soportes / Resistencias", bonus: srBonus, msg: srMsg, icon: "fa-solid fa-layer-group" });

            // 6. Volume Profile (VPR / POC)
            let vprBonus = 0;
            let vprMsg = "";
            if (tradeSide === 'LONG' && entry >= volumeProfileData.poc) {
                vprBonus = 8; vprMsg = `Entrada por encima del POC ($${volumeProfileData.poc.toFixed(1)})`;
            } else if (tradeSide === 'SHORT' && entry <= volumeProfileData.poc) {
                vprBonus = 8; vprMsg = `Entrada por debajo del POC ($${volumeProfileData.poc.toFixed(1)})`;
            } else {
                vprBonus = -5; vprMsg = `Movimiento contra el perfil de alto volumen`;
            }
            if (!fOn('sr')) { vprBonus = 0; vprMsg = 'Filtro S/R+POC desactivado (preset temporalidad)'; }
            winProb += vprBonus;
            breakdown.push({ name: "Volume Profile POC", bonus: vprBonus, msg: vprMsg, icon: "fa-solid fa-chart-column" });

            const finalWinRate = Math.min(Math.max(winProb, 10), 95);

            currentPendingTrade = {
                entry, sl, tp, size, leverage, rr,
                side: tradeSide,
                winRate: finalWinRate,
                breakdown,
                trendilo: trendiloLatest.direction,
                stoch: stochRsiLatest.k
            };

            const sideEl = document.getElementById('modalTradeSide');
            sideEl.innerText = tradeSide;
            sideEl.className = `px-2 py-0.5 rounded font-bold text-xs ${tradeSide === 'LONG' ? 'bg-accentGreen text-slate-950' : 'bg-accentRed text-white'}`;
            
            document.getElementById('modalEntryPrice').innerText = `$${entry.toFixed(2)}`;
            document.getElementById('modalRR').innerText = rr;

            const winRateEl = document.getElementById('modalTotalWinRate');
            winRateEl.innerText = `${finalWinRate}%`;
            winRateEl.className = `text-4xl font-extrabold font-mono ${finalWinRate >= 60 ? 'text-accentGreen' : finalWinRate >= 40 ? 'text-accentYellow' : 'text-accentRed'}`;

            const progressBar = document.getElementById('modalProgressBar');
            progressBar.style.width = `${finalWinRate}%`;
            progressBar.className = `h-full transition-all duration-500 ${finalWinRate >= 60 ? 'bg-accentGreen' : finalWinRate >= 40 ? 'bg-accentYellow' : 'bg-accentRed'}`;

            const listEl = document.getElementById('modalIndicatorsList');
            listEl.innerHTML = breakdown.map(item => `
                <div class="p-2.5 bg-cardBg rounded-lg border border-borderBg flex items-center justify-between">
                    <div class="flex items-center space-x-2.5">
                        <i class="${item.icon} text-slate-400 text-sm"></i>
                        <div>
                            <div class="font-semibold text-slate-200">${item.name}</div>
                            <div class="text-[11px] text-slate-400">${item.msg}</div>
                        </div>
                    </div>
                    <span class="font-mono font-bold text-xs px-2 py-0.5 rounded ${item.bonus > 0 ? 'bg-accentGreen/10 text-accentGreen' : item.bonus < 0 ? 'bg-accentRed/10 text-accentRed' : 'bg-slate-700/50 text-slate-400'}">
                        ${item.bonus > 0 ? '+' : ''}${item.bonus}%
                    </span>
                </div>
            `).join('');

            document.getElementById('probModal').classList.remove('hidden');
        }

        function closeProbabilityModal() {
            document.getElementById('probModal').classList.add('hidden');
        }

        function confirmTradeSimulation() {
            if (!currentPendingTrade) return;

            const contextEl = document.getElementById('contextDetails');
            contextEl.innerHTML = `
                <div class="mb-2 p-2 rounded ${currentPendingTrade.winRate >= 60 ? 'bg-accentGreen/10 border border-accentGreen/30' : 'bg-accentYellow/10 border border-accentYellow/30'}">
                    <strong>Probabilidad Estimada: ${currentPendingTrade.winRate}%</strong>
                </div>
                ${currentPendingTrade.breakdown.map(b => `<p class="text-[11px] ${b.bonus >= 0 ? 'text-accentGreen' : 'text-accentRed'}">• ${b.name}: ${b.msg}</p>`).join('')}
            `;

            const openedAt = Date.now();
            const tf = currentInterval;
            const expiresAt = openedAt + getHoldingMsForTf(tf);

            lastConfirmedTrade = {
                ...currentPendingTrade,
                time: new Date().toLocaleTimeString(),
                date: new Date().toLocaleDateString(),
                openedAt,
                expiresAt,
                tf,
                closed: false
            };

            addJournalEntry({
                id: 'trade_' + Date.now(),
                time: lastConfirmedTrade.time,
                date: lastConfirmedTrade.date,
                side: lastConfirmedTrade.side,
                entry: lastConfirmedTrade.entry,
                sl: lastConfirmedTrade.sl,
                tp: lastConfirmedTrade.tp,
                rr: lastConfirmedTrade.rr,
                leverage: lastConfirmedTrade.leverage,
                size: lastConfirmedTrade.size,
                trendilo: lastConfirmedTrade.trendilo,
                stoch: lastConfirmedTrade.stoch,
                score: lastConfirmedTrade.winRate,
                breakdown: lastConfirmedTrade.breakdown,
                openedAt,
                expiresAt,
                tf
            });

            plotTradeOnChart(lastConfirmedTrade);
            updatePositionCountdownUI();
            closeProbabilityModal();
        }

        // Función para dibujar líneas de la posición en el gráfico de velas
        function plotTradeOnChart(trade) {
            if (!candlestickSeries) return;

            // Limpiar líneas anteriores si existen
            chartPriceLines.forEach(line => {
                try { candlestickSeries.removePriceLine(line); } catch(e) {}
            });
            chartPriceLines = [];

            try {
                // Línea de Entrada
                const entryLine = candlestickSeries.createPriceLine({
                    price: trade.entry,
                    color: trade.side === 'LONG' ? '#0ecb81' : '#f6465d',
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    axisLabelVisible: true,
                    title: `${trade.side} @ $${trade.entry.toFixed(2)}`,
                });
                chartPriceLines.push(entryLine);

                // Línea de Stop Loss
                const slLine = candlestickSeries.createPriceLine({
                    price: trade.sl,
                    color: '#f6465d',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: `SL: $${trade.sl.toFixed(2)}`,
                });
                chartPriceLines.push(slLine);

                // TP1 / TP2 / TP3
                const tps = [
                    { p: trade.tp1 != null ? trade.tp1 : trade.tp, label: 'TP1', color: '#0ecb81' },
                    { p: trade.tp2, label: 'TP2', color: '#26a69a' },
                    { p: trade.tp3, label: 'TP3', color: '#66bb6a' }
                ];
                tps.forEach(t => {
                    if (t.p == null || !isFinite(t.p)) return;
                    const line = candlestickSeries.createPriceLine({
                        price: t.p,
                        color: t.color,
                        lineWidth: 1,
                        lineStyle: LightweightCharts.LineStyle.Dashed,
                        axisLabelVisible: true,
                        title: `${t.label}: $${Number(t.p).toFixed(1)}`,
                    });
                    chartPriceLines.push(line);
                });
            } catch (err) {
                console.error("Error al graficar líneas en el chart:", err);
            }
        }

        function openPositionDetailsModal(tradeObj = null) {
            const targetTrade = tradeObj || lastConfirmedTrade;
            const contentEl = document.getElementById('positionDetailsContent');
            
            if (!targetTrade) {
                contentEl.innerHTML = `<div class="text-center py-6 text-slate-500 italic">No hay ninguna posición activa o confirmada recientemente para mostrar. Selecciona un trade del historial haciendo doble clic o confirma una simulación previa.</div>`;
            } else {
                const t = targetTrade;
                const margin = t.size / t.leverage;
                const risk = Math.abs(t.entry - t.sl);
                const reward = Math.abs(t.tp - t.entry);
                const estProfit = (reward / t.entry) * t.size;
                const estLoss = (risk / t.entry) * t.size;

                // Estimar tiempo de tenencia aproximado en función del timeframe actual y la distancia al TP/SL
                let holdingTimeText = "2 a 6 horas (Intradía)";
                if (currentInterval === '1m') holdingTimeText = "5 a 15 min (Scalp ultra)";
                else if (currentInterval === '3m') holdingTimeText = "10 a 30 min (Scalp)";
                else if (currentInterval === '5m') holdingTimeText = "15 a 45 min (Scalp)";
                else if (currentInterval === '15m') holdingTimeText = "45 min a 3 horas (Intradía)";
                else if (currentInterval === '9m') holdingTimeText = "15 a 45 min (Scalp corto)";
                else if (currentInterval === '20m') holdingTimeText = "30 min a 2 horas (Intradía corto)";
                else if (currentInterval === '1h') holdingTimeText = "4 a 12 horas (Swing corto)";
                else if (currentInterval === '4h') holdingTimeText = "1 a 3 días (Swing trading)";
                else if (currentInterval === '1d') holdingTimeText = "1 a 2 semanas (Posicional)";
                else if (currentInterval === '1w') holdingTimeText = "1 a 3 meses (Macro)";

                contentEl.innerHTML = `
                    <div class="space-y-3">
                        <div class="flex justify-between items-center bg-cardBg p-2.5 rounded border border-borderBg">
                            <span class="text-slate-400">Tipo / Lado:</span>
                            <span class="font-bold ${t.side === 'LONG' ? 'text-accentGreen' : 'text-accentRed'}">${t.side}</span>
                        </div>
                        <div class="flex justify-between items-center bg-cardBg p-2.5 rounded border border-borderBg">
                            <span class="text-slate-400">Fecha y Hora de Apertura:</span>
                            <span class="text-white">${t.date || new Date().toLocaleDateString()} ${t.time}</span>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">TIME-FRAME / TEMPORALIDAD</span>
                                <span class="text-accentYellow text-sm font-bold uppercase">${currentInterval}</span>
                            </div>
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">TIEMPO ESTIMADO DE TENENCIA</span>
                                <span class="text-white text-xs font-semibold">${holdingTimeText}</span>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">PRECIO ENTRADA</span>
                                <span class="text-white text-sm font-bold">$${t.entry.toFixed(2)}</span>
                            </div>
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">APALANCAMIENTO</span>
                                <span class="text-accentYellow text-sm font-bold">${t.leverage}x</span>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-accentRed block text-[10px]">STOP LOSS</span>
                                <span class="text-accentRed text-sm font-bold">$${t.sl.toFixed(2)}</span>
                            </div>
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-accentGreen block text-[10px]">TAKE PROFIT</span>
                                <span class="text-accentGreen text-sm font-bold">$${t.tp.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="grid grid-cols-3 gap-2 text-center">
                            <div class="bg-cardBg p-2 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">TAMAÑO</span>
                                <span class="text-white">$${t.size}</span>
                            </div>
                            <div class="bg-cardBg p-2 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">MARGEN</span>
                                <span class="text-white">$${margin.toFixed(2)}</span>
                            </div>
                            <div class="bg-cardBg p-2 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">RATIO R/R</span>
                                <span class="text-accentYellow font-bold">${t.rr}</span>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">GANANCIA EST.</span>
                                <span class="text-accentGreen font-bold">+$${estProfit.toFixed(2)}</span>
                            </div>
                            <div class="bg-cardBg p-2.5 rounded border border-borderBg">
                                <span class="text-slate-400 block text-[10px]">PÉRDIDA EST.</span>
                                <span class="text-accentRed font-bold">-$${estLoss.toFixed(2)}</span>
                            </div>
                        </div>
                        <div class="bg-cardBg p-3 rounded border border-borderBg space-y-2">
                            <div class="text-slate-300 font-semibold mb-1 border-b border-borderBg pb-1 flex justify-between items-center">
                                <span>Desglose de Indicadores Estratégicos</span>
                                <span class="text-xs ${t.score >= 60 ? 'text-accentGreen' : 'text-accentYellow'}">${t.score}% Prob. Acierto</span>
                            </div>
                            ${t.breakdown && t.breakdown.length > 0 ? t.breakdown.map(b => `
                                <div class="flex justify-between items-center text-[11px]">
                                    <span class="text-slate-400">• ${b.name}:</span>
                                    <span class="${b.bonus >= 0 ? 'text-accentGreen' : 'text-accentRed'} font-bold">${b.msg} (${b.bonus > 0 ? '+' : ''}${b.bonus}%)</span>
                                </div>
                            `).join('') : `
                                <div class="text-slate-400 text-[11px]">• Trendilo: ${t.trendilo}</div>
                                <div class="text-slate-400 text-[11px]">• StochRSI %K: ${t.stoch}</div>
                            `}
                        </div>
                    </div>
                `;

                // Proyectar también las líneas en el gráfico al inspeccionar el trade
                plotTradeOnChart(t);
            }
            document.getElementById('positionDetailsModal').classList.remove('hidden');
        }

        function closePositionDetailsModal() {
            document.getElementById('positionDetailsModal').classList.add('hidden');
        }

        function addJournalEntry(trade) {
            journalHistory.unshift(trade);
            saveJournalToStorage();
            renderJournal();
        }

        /** Calcula entrada, SL, TP1/TP2/TP3, apalancamiento y vigencia recomendados */
        function recommendTradePlan(side, tfHint) {
            const price = (rawKlines && rawKlines.length)
                ? rawKlines[rawKlines.length - 1].close
                : (parseFloat((document.getElementById('currentPriceDisplay') || {}).innerText) || 0);
            if (!price || price <= 0) return null;

            // ATR aproximado (14 velas) o 1.2% del precio
            let atr = price * 0.012;
            if (rawKlines && rawKlines.length > 15) {
                let sum = 0;
                const n = rawKlines.length;
                for (let i = n - 14; i < n; i++) {
                    const tr = Math.max(
                        rawKlines[i].high - rawKlines[i].low,
                        Math.abs(rawKlines[i].high - rawKlines[i - 1].close),
                        Math.abs(rawKlines[i].low - rawKlines[i - 1].close)
                    );
                    sum += tr;
                }
                atr = sum / 14;
            }

            const tf = tfHint || currentInterval || '1h';
            // Multiplicadores de riesgo según TF (scalp más estrecho)
            const isScalp = ['1m', '3m', '5m', '9m', '15m'].includes(tf);
            const isSwing = ['4h', '1d', '1w'].includes(tf);
            const slMult = isScalp ? 1.0 : isSwing ? 1.8 : 1.35;
            const risk = atr * slMult;

            let entry = price;
            let sl, tp1, tp2, tp3;
            if (side === 'LONG') {
                sl = entry - risk;
                // Si hay soporte cercano por debajo, usarlo como SL si es razonable
                if (calculatedPivots && calculatedPivots.nearestSup && calculatedPivots.nearestSup < entry && calculatedPivots.nearestSup > entry - risk * 2) {
                    sl = Math.min(sl, calculatedPivots.nearestSup * 0.999);
                }
                const r = entry - sl;
                tp1 = entry + r * 1.5;  // R/R 1.5
                tp2 = entry + r * 2.5;  // R/R 2.5
                tp3 = entry + r * 4.0;  // R/R 4
                if (calculatedPivots && calculatedPivots.nearestRes && calculatedPivots.nearestRes > entry) {
                    // Ajustar TP2 hacia resistencia si está en zona intermedia
                    const res = calculatedPivots.nearestRes;
                    if (res > tp1 && res < tp3) tp2 = res;
                }
            } else {
                sl = entry + risk;
                if (calculatedPivots && calculatedPivots.nearestRes && calculatedPivots.nearestRes > entry && calculatedPivots.nearestRes < entry + risk * 2) {
                    sl = Math.max(sl, calculatedPivots.nearestRes * 1.001);
                }
                const r = sl - entry;
                tp1 = entry - r * 1.5;
                tp2 = entry - r * 2.5;
                tp3 = entry - r * 4.0;
                if (calculatedPivots && calculatedPivots.nearestSup && calculatedPivots.nearestSup < entry) {
                    const sup = calculatedPivots.nearestSup;
                    if (sup < tp1 && sup > tp3) tp2 = sup;
                }
            }

            // Apalancamiento recomendado
            const diSpread = parseFloat((dmiLatest && dmiLatest.diSpread) || 0);
            let leverage = isScalp ? 8 : isSwing ? 3 : 5;
            if (diSpread >= 18) leverage = Math.min(leverage + 2, isScalp ? 12 : 7);
            if (diSpread < 8) leverage = Math.max(leverage - 2, 2);

            const openedAt = Date.now();
            const expiresAt = openedAt + getHoldingMsForTf(tf);
            const rrMain = ((Math.abs(tp2 - entry) / Math.abs(entry - sl)) || 2).toFixed(2);

            return {
                side, entry, sl, tp1, tp2, tp3,
                tp: tp2, // TP principal = TP2
                leverage, tf, openedAt, expiresAt,
                rr: rrMain,
                riskDist: Math.abs(entry - sl)
            };
        }

        /**
         * Registra posición en Historial al aplicar LONG/SHORT desde Palacios o Confluencias.
         * meta: { source, score, tf, note }
         */
        function registerAppliedPosition(side, meta) {
            meta = meta || {};
            const tf = meta.tf || currentInterval || '1h';
            const plan = recommendTradePlan(side, tf);
            if (!plan) {
                alert('No hay precio de mercado para armar la posición.');
                return null;
            }

            // Intentar rellenar inputs del simulador si existen
            try {
                const ep = document.getElementById('entryPrice');
                const slEl = document.getElementById('stopLoss');
                const tpEl = document.getElementById('takeProfit');
                const levEl = document.getElementById('leverage');
                if (ep) ep.value = plan.entry.toFixed(2);
                if (slEl) slEl.value = plan.sl.toFixed(2);
                if (tpEl) tpEl.value = plan.tp2.toFixed(2);
                if (levEl) levEl.value = String(plan.leverage);
                if (typeof setTradeSide === 'function') setTradeSide(side);
                if (typeof calculateTradeMetrics === 'function') calculateTradeMetrics();
            } catch (e) {}

            const score = meta.score != null ? Math.round(meta.score) : 55;
            const trade = {
                id: 'sig_' + Date.now(),
                time: new Date().toLocaleTimeString(),
                date: new Date().toLocaleDateString(),
                side: plan.side,
                entry: plan.entry,
                sl: plan.sl,
                tp: plan.tp2,
                tp1: plan.tp1,
                tp2: plan.tp2,
                tp3: plan.tp3,
                rr: plan.rr,
                leverage: plan.leverage,
                size: 1,
                source: meta.source || 'Señal',
                note: meta.note || '',
                trendilo: (trendiloLatest && trendiloLatest.direction) || '—',
                stoch: (stochRsiLatest && stochRsiLatest.k) != null ? Number(stochRsiLatest.k).toFixed(1) : '—',
                score,
                breakdown: [
                    { name: 'Fuente', msg: meta.source || '—', bonus: 0 },
                    { name: 'TP1 / TP2 / TP3', msg: `$${plan.tp1.toFixed(1)} / $${plan.tp2.toFixed(1)} / $${plan.tp3.toFixed(1)}`, bonus: 0 },
                    { name: 'Apalancamiento', msg: plan.leverage + 'x recomendado', bonus: 0 },
                    { name: 'Vigencia TF', msg: `${tf} · hasta ${new Date(plan.expiresAt).toLocaleString()}`, bonus: 0 }
                ],
                openedAt: plan.openedAt,
                expiresAt: plan.expiresAt,
                tf: plan.tf,
                closed: false
            };

            lastConfirmedTrade = { ...trade };
            addJournalEntry(trade);
            try { plotTradeOnChart(trade); } catch (e) {}
            try { updatePositionCountdownUI(); } catch (e) {}
            try { switchBottomTab('journal'); } catch (e) {}
            return trade;
        }
        window.registerAppliedPosition = registerAppliedPosition;

        function journalCountdownHtml(t) {
            const opened = t.openedAt;
            const expires = t.expiresAt || (opened ? opened + getHoldingMsForTf(t.tf || '1h') : null);
            if (t.closed) {
                return `<span class="journal-cd px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-slate-700/50 text-slate-400" data-closed="1">Cerrada</span>`;
            }
            if (!opened || !expires) {
                return `<span class="journal-cd text-slate-500 font-mono text-[10px]" data-opened="" data-expires="">—</span>`;
            }
            const left = expires - Date.now();
            const total = expires - opened;
            const pct = total > 0 ? left / total : 0;
            let cls = 'text-accentGreen';
            let label = formatCountdown(left);
            if (left <= 0) {
                cls = 'bg-accentRed/20 text-accentRed';
                label = 'CERRAR YA';
            } else if (pct < 0.2) {
                cls = 'bg-accentRed/15 text-accentRed';
            } else if (pct < 0.4) {
                cls = 'bg-accentYellow/15 text-accentYellow';
            } else {
                cls = 'bg-accentGreen/15 text-accentGreen';
            }
            return `<span class="journal-cd px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tabular-nums ${cls}" data-opened="${opened}" data-expires="${expires}" data-closed="0">${label}</span>`;
        }

        function updateJournalCountdowns() {
            document.querySelectorAll('.journal-cd').forEach(el => {
                if (el.getAttribute('data-closed') === '1') return;
                const opened = parseInt(el.getAttribute('data-opened'), 10);
                const expires = parseInt(el.getAttribute('data-expires'), 10);
                if (!opened || !expires) return;
                const left = expires - Date.now();
                const total = expires - opened;
                const pct = total > 0 ? left / total : 0;
                el.className = 'journal-cd px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tabular-nums';
                if (left <= 0) {
                    el.className += ' bg-accentRed/20 text-accentRed';
                    el.innerText = 'CERRAR YA';
                } else if (pct < 0.2) {
                    el.className += ' bg-accentRed/15 text-accentRed';
                    el.innerText = formatCountdown(left);
                } else if (pct < 0.4) {
                    el.className += ' bg-accentYellow/15 text-accentYellow';
                    el.innerText = formatCountdown(left);
                } else {
                    el.className += ' bg-accentGreen/15 text-accentGreen';
                    el.innerText = formatCountdown(left);
                }
                el.setAttribute('data-opened', opened);
                el.setAttribute('data-expires', expires);
                el.setAttribute('data-closed', '0');
            });
        }

        function renderJournal() {
            const tbody = document.getElementById('journalTableBody');
            if (journalHistory.length === 0) {
                tbody.innerHTML = `<tr><td colspan="12" class="text-center py-6 text-slate-500 italic">No hay operaciones. Usa «Aplicar LONG/SHORT» en Palacios o Mejores confluencias.</td></tr>`;
                return;
            }

            tbody.innerHTML = journalHistory.map((t) => {
                const tp1 = t.tp1 != null ? t.tp1 : t.tp;
                const tp2 = t.tp2 != null ? t.tp2 : (t.tp ? t.tp : '—');
                const tp3 = t.tp3 != null ? t.tp3 : '—';
                const fmt = (v) => (v == null || v === '—') ? '—' : ('$' + Number(v).toFixed(1));
                return `
                <tr onclick="selectJournalTrade('${t.id}')" class="hover:bg-cardBg/80 cursor-pointer transition select-none" title="Clic para detalles">
                    <td class="p-2 text-slate-400 whitespace-nowrap">${t.time || '—'}</td>
                    <td class="p-2 font-bold ${t.side === 'LONG' ? 'text-accentGreen' : 'text-accentRed'}">${t.side}</td>
                    <td class="p-2 text-[10px] text-slate-400 max-w-[7rem] truncate" title="${t.source || ''}">${t.source || 'Manual'}</td>
                    <td class="p-2 font-mono text-accentYellow">${t.tf || '—'}</td>
                    <td class="p-2 font-mono">$${Number(t.entry).toFixed(1)}</td>
                    <td class="p-2 font-mono text-accentRed">$${Number(t.sl).toFixed(1)}</td>
                    <td class="p-2 font-mono text-accentGreen">${fmt(tp1)}</td>
                    <td class="p-2 font-mono text-accentGreen/90">${fmt(tp2)}</td>
                    <td class="p-2 font-mono text-emerald-400/80">${fmt(tp3)}</td>
                    <td class="p-2 font-mono text-slate-300">${t.leverage ? t.leverage + 'x' : '—'}</td>
                    <td class="p-2 text-right">
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono ${t.score >= 60 ? 'bg-accentGreen/20 text-accentGreen' : t.score >= 45 ? 'bg-accentYellow/20 text-accentYellow' : 'bg-accentRed/20 text-accentRed'}">
                            ${t.score != null ? t.score + '%' : '—'}
                        </span>
                    </td>
                    <td class="p-2 text-right whitespace-nowrap" onclick="event.stopPropagation()">
                        ${journalCountdownHtml(t)}
                    </td>
                </tr>`;
            }).join('');

            const st = document.getElementById('statTotalTrades');
            if (st) st.innerText = journalHistory.length;
            const highConf = journalHistory.filter(h => h.score >= 60).length;
            const winRate = journalHistory.length > 0 ? ((highConf / journalHistory.length) * 100).toFixed(0) : 0;
            const wr = document.getElementById('statWinRate');
            if (wr) wr.innerText = `${winRate}% (Est.)`;
            updateJournalCountdowns();
        }

        function selectJournalTrade(tradeId) {
            const found = journalHistory.find(h => h.id === tradeId);
            if (found) {
                openPositionDetailsModal(found);
            }
        }

        function clearJournal() {
            journalHistory = [];
            lastConfirmedTrade = null;
            try {
                localStorage.removeItem(LS_JOURNAL);
                localStorage.removeItem(LS_LAST_TRADE);
            } catch (e) {}
            renderJournal();
            chartPriceLines.forEach(line => {
                try { candlestickSeries.removePriceLine(line); } catch(e) {}
            });
            chartPriceLines = [];
        }

        // ========== SIMULAR ESTRATEGIA / RISK MANAGER ==========
        function calculateSafeRisk() {
            const account = parseFloat(document.getElementById('accountValue').value) || 10000;
            const riskPct = parseFloat(document.getElementById('riskPercent').value) || 1;
            const levMin = parseFloat(document.getElementById('levMin').value) || 5;
            const levMax = parseFloat(document.getElementById('levMax').value) || 10;
            const timeRange = parseInt(document.getElementById('simTimeRange').value) || 100;

            const entry = parseFloat(document.getElementById('entryPrice').value) || (rawKlines.length ? rawKlines[rawKlines.length - 1].close : 0);
            const sl = parseFloat(document.getElementById('stopLoss').value) || 0;

            // Risk in USD based on % of account
            const riskUsd = (account * riskPct) / 100;
            document.getElementById('safeRiskUsd').innerText = `$${riskUsd.toFixed(2)}`;

            // Position size = riskUsd / (SL distance %)
            let safeSize = 0;
            let suggestedLev = levMin;

            if (entry > 0 && sl > 0) {
                const slDistPct = Math.abs(entry - sl) / entry;
                if (slDistPct > 0) {
                    // Notional position size that risks exactly riskUsd when SL is hit
                    safeSize = riskUsd / slDistPct;
                    // Suggested leverage so that margin = safeSize / lev stays reasonable (max 25% of account)
                    const maxMarginPct = 0.25;
                    const maxMargin = account * maxMarginPct;
                    suggestedLev = Math.min(levMax, Math.max(levMin, Math.floor(safeSize / maxMargin) || levMin));
                    // Clamp size if leverage would require too much margin
                    if (safeSize / suggestedLev > maxMargin) {
                        safeSize = maxMargin * suggestedLev;
                    }
                }
            } else {
                // Fallback without SL: use riskPct * leverage approx
                safeSize = (account * riskPct / 100) * suggestedLev * 5;
            }

            document.getElementById('safePosSize').innerText = `$${safeSize.toFixed(2)}`;
            document.getElementById('safeLeverage').innerText = `${suggestedLev}x`;

            // Max consecutive losses before 50% drawdown (fixed fractional)
            // (1 - riskPct/100)^N = 0.5  =>  N = log(0.5) / log(1 - r)
            const r = riskPct / 100;
            let maxLosses = 0;
            if (r > 0 && r < 1) {
                maxLosses = Math.floor(Math.log(0.5) / Math.log(1 - r));
            }
            document.getElementById('maxConsecutiveLosses').innerText = maxLosses > 0 ? `${maxLosses} trades` : '--';

            // Minimum safe risk % adapted to max leverage
            let minSafe = 0.5;
            if (levMax >= 20) minSafe = 0.5;
            else if (levMax >= 10) minSafe = 1.0;
            else minSafe = 1.5;
            if (timeRange >= 200) minSafe = Math.max(0.5, minSafe - 0.25);
            document.getElementById('minSafeRisk').innerText = `${minSafe.toFixed(1)}%`;

            // Update note with time context
            const noteEl = document.getElementById('strategySimNote');
            if (noteEl) {
                const candlesUsed = Math.min(timeRange, rawKlines.length || 0);
                noteEl.innerHTML = `Usando ${candlesUsed} velas del TF actual (${currentInterval}). Riesgo fijo ${riskPct}% → sobrevive ~${maxLosses} pérdidas seguidas antes de -50% DD.`;
            }
        }

        function applySafeRiskToOrder() {
            const sizeText = document.getElementById('safePosSize').innerText.replace('$', '').replace(/,/g, '');
            const safeSize = parseFloat(sizeText) || 0;
            const suggestedLev = parseInt(document.getElementById('safeLeverage').innerText) || 10;

            if (safeSize > 0) {
                document.getElementById('positionSize').value = Math.round(safeSize);
                const preset = document.getElementById('sizePreset');
                if (preset) preset.value = '';
            }
            const levSelect = document.getElementById('leverage');
            if (levSelect) {
                const opts = Array.from(levSelect.options).map(o => parseInt(o.value));
                const closest = opts.reduce((prev, curr) => Math.abs(curr - suggestedLev) < Math.abs(prev - suggestedLev) ? curr : prev);
                levSelect.value = closest;
            }
            calculateTradeMetrics();
            // Visual feedback
            const btn = document.querySelector('[onclick="applySafeRiskToOrder()"]');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> ¡Aplicado!';
                setTimeout(() => { btn.innerHTML = orig; }, 1500);
            }
        }

        // Hook into existing metrics calculation
        const _origCalcTradeMetrics = calculateTradeMetrics;
        calculateTradeMetrics = function() {
            _origCalcTradeMetrics();
            if (typeof calculateSafeRisk === 'function') {
                try { calculateSafeRisk(); } catch(e) {}
            }
        };

        // Initial calculation after data loads
        setTimeout(() => {
            if (document.getElementById('accountValue')) calculateSafeRisk();
        }, 2500);


        // ========== STRATEGY BACKTEST ENGINE ==========
        // ========== INDICADOR PALACIOS: confluencia 1H + 15m + 1m ==========
        let palaciosLatest = { signal: 'NONE', bias: 'Neutral', tfs: {}, conf: 0, updatedAt: 0 };
        let palaciosRunning = false;
        let palaciosCacheAt = 0;

        /** Sesgo direccional de un array de klines (150 velas máx). Devuelve LONG | SHORT | NEUTRAL */
        function computeTfBiasFromKlines(data) {
            if (!data || data.length < 30) return { dir: 'NEUTRAL', score: 0, detail: 'Pocas velas', z: 0, rsi: 50, st: 0 };
            const n = data.length;
            // z-score momentum (14)
            let sum = 0, sq = 0;
            for (let j = 0; j < 14; j++) sum += (data[n - 1 - j].close - data[n - 1 - j].open);
            const mean = sum / 14;
            for (let j = 0; j < 14; j++) {
                const d = data[n - 1 - j].close - data[n - 1 - j].open;
                sq += (d - mean) * (d - mean);
            }
            const std = Math.sqrt(sq / 14) || 1e-8;
            const z = (data[n - 1].close - data[n - 2].close) / std;

            // RSI(14)
            let gains = 0, losses = 0;
            for (let j = 1; j <= 14; j++) {
                const ch = data[n - j].close - data[n - j - 1].close;
                if (ch > 0) gains += ch; else losses -= ch;
            }
            const rsi = 100 - (100 / (1 + gains / (losses || 1e-8)));

            // SuperTrend proxy (últimas barras)
            let atr = 0;
            for (let i = n - 10; i < n; i++) {
                if (i < 1) continue;
                const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close));
                atr += tr;
            }
            atr /= 10;
            const mid = (data[n - 1].high + data[n - 1].low) / 2;
            const stUp = mid - 2 * atr;
            const stDn = mid + 2 * atr;
            const st = data[n - 1].close > stDn ? -1 : (data[n - 1].close < stUp ? 1 : (data[n - 1].close >= data[n - 2].close ? 1 : -1));
            // Tendencia de cierre 5 vs 15
            const ma5 = data.slice(-5).reduce((a, b) => a + b.close, 0) / 5;
            const ma15 = data.slice(-15).reduce((a, b) => a + b.close, 0) / 15;
            const maBias = ma5 > ma15 ? 1 : (ma5 < ma15 ? -1 : 0);

            let longPts = 0, shortPts = 0;
            if (z > 0.25) longPts += 1.2; else if (z < -0.25) shortPts += 1.2;
            if (rsi < 40) longPts += 0.9; else if (rsi > 60) shortPts += 0.9;
            else if (rsi < 48) longPts += 0.3; else if (rsi > 52) shortPts += 0.3;
            if (st === 1) longPts += 1.0; else if (st === -1) shortPts += 1.0;
            if (maBias === 1) longPts += 0.7; else if (maBias === -1) shortPts += 0.7;
            if (data[n - 1].close > data[n - 1].open) longPts += 0.25; else shortPts += 0.25;

            let dir = 'NEUTRAL';
            if (longPts >= 1.8 && longPts > shortPts + 0.3) dir = 'LONG';
            else if (shortPts >= 1.8 && shortPts > longPts + 0.3) dir = 'SHORT';

            return {
                dir,
                score: Math.max(longPts, shortPts),
                longPts, shortPts,
                detail: `z ${z.toFixed(2)} · RSI ${rsi.toFixed(0)} · ST ${st === 1 ? '↑' : st === -1 ? '↓' : '—'} · MA ${maBias === 1 ? '↑' : maBias === -1 ? '↓' : '—'}`,
                z, rsi, st, maBias
            };
        }

        async function runPalaciosIndicator(force) {
            if (palaciosRunning) return;
            // Cache 45s si no force
            if (!force && palaciosCacheAt && (Date.now() - palaciosCacheAt < 45000) && palaciosLatest.tfs && palaciosLatest.tfs['1h']) {
                renderPalaciosUI(palaciosLatest);
                return;
            }
            palaciosRunning = true;
            const status = document.getElementById('palaciosStatus');
            const icon = document.getElementById('palaciosRunIcon');
            if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
            if (status) status.innerText = 'Descargando 1H, 15m y 1m (150 velas c/u)…';

            try {
                const [d1h, d15, d1m] = await Promise.all([
                    fetchKlinesForRanking('1h', 150),
                    fetchKlinesForRanking('15m', 150),
                    fetchKlinesForRanking('1m', 150)
                ]);
                const b1h = computeTfBiasFromKlines(d1h);
                const b15 = computeTfBiasFromKlines(d15);
                const b1m = computeTfBiasFromKlines(d1m);

                let signal = 'NONE', bias = 'Sin confluencia', conf = 40;
                if (b1h.dir === 'LONG' && b15.dir === 'LONG' && b1m.dir === 'LONG') {
                    signal = 'BUY';
                    bias = 'Confluencia LONG 1H·15m·1m';
                    conf = Math.min(92, 55 + (b1h.score + b15.score + b1m.score) * 4);
                } else if (b1h.dir === 'SHORT' && b15.dir === 'SHORT' && b1m.dir === 'SHORT') {
                    signal = 'SELL';
                    bias = 'Confluencia SHORT 1H·15m·1m';
                    conf = Math.min(92, 55 + (b1h.score + b15.score + b1m.score) * 4);
                } else {
                    const dirs = [b1h.dir, b15.dir, b1m.dir];
                    const longN = dirs.filter(d => d === 'LONG').length;
                    const shortN = dirs.filter(d => d === 'SHORT').length;
                    bias = longN > shortN
                        ? `Parcial alcista (${longN}/3) — falta acuerdo`
                        : shortN > longN
                            ? `Parcial bajista (${shortN}/3) — falta acuerdo`
                            : 'TFs mixtos — sin confluencia';
                    conf = 30 + Math.max(longN, shortN) * 8;
                }

                palaciosLatest = {
                    signal, bias, conf,
                    tfs: { '1h': b1h, '15m': b15, '1m': b1m },
                    updatedAt: Date.now()
                };
                palaciosCacheAt = Date.now();
                renderPalaciosUI(palaciosLatest);
                if (status) status.innerText = `Actualizado ${new Date().toLocaleTimeString()} · conf ${conf.toFixed(0)}%`;
            } catch (e) {
                console.error('Palacios', e);
                if (status) status.innerText = 'Error: ' + (e.message || e);
            } finally {
                palaciosRunning = false;
                if (icon) icon.className = 'fa-solid fa-rotate';
            }
        }
        window.runPalaciosIndicator = runPalaciosIndicator;

        function renderPalaciosUI(p) {
            if (!p) return;
            const tfs = p.tfs || {};
            const paintTf = (key, idPrefix) => {
                const b = tfs[key] || {};
                const dir = b.dir || 'NEUTRAL';
                const dirEl = document.getElementById(idPrefix + 'Dir');
                const badgeEl = document.getElementById(idPrefix + 'Badge');
                const detEl = document.getElementById(idPrefix + 'Detail');
                const col = dir === 'LONG' ? 'text-accentGreen' : dir === 'SHORT' ? 'text-accentRed' : 'text-slate-400';
                const bg = dir === 'LONG' ? 'bg-accentGreen/20 text-accentGreen' : dir === 'SHORT' ? 'bg-accentRed/20 text-accentRed' : 'bg-borderBg text-slate-400';
                if (dirEl) { dirEl.innerText = dir; dirEl.className = `text-lg font-black ${col}`; }
                if (badgeEl) { badgeEl.innerText = dir; badgeEl.className = `text-[10px] font-mono px-1.5 py-0.5 rounded ${bg}`; }
                if (detEl) detEl.innerText = b.detail || '—';
            };
            paintTf('1h', 'palaciosTf1h');
            paintTf('15m', 'palaciosTf15m');
            paintTf('1m', 'palaciosTf1m');

            const badge = document.getElementById('palaciosBadge');
            const main = document.getElementById('palaciosMainSignal');
            const hint = document.getElementById('palaciosActionHint');
            const btnL = document.getElementById('btnPalaciosApplyLong');
            const btnS = document.getElementById('btnPalaciosApplyShort');

            if (p.signal === 'BUY') {
                if (badge) { badge.innerText = 'LONG'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentGreen text-slate-950'; }
                if (main) { main.innerText = 'COMPRA (confluencia triple)'; main.className = 'text-2xl sm:text-3xl font-black text-accentGreen mb-1'; }
                if (hint) hint.innerText = `${p.bias}. Confianza ~${(p.conf || 0).toFixed(0)}%. 1H, 15m y 1m alineados alcistas. Puedes aplicar LONG al simulador.`;
                if (btnL) { btnL.disabled = false; btnL.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else if (p.signal === 'SELL') {
                if (badge) { badge.innerText = 'SHORT'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentRed text-white'; }
                if (main) { main.innerText = 'VENTA (confluencia triple)'; main.className = 'text-2xl sm:text-3xl font-black text-accentRed mb-1'; }
                if (hint) hint.innerText = `${p.bias}. Confianza ~${(p.conf || 0).toFixed(0)}%. 1H, 15m y 1m alineados bajistas. Puedes aplicar SHORT al simulador.`;
                if (btnS) { btnS.disabled = false; btnS.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else {
                if (badge) { badge.innerText = 'ESPERAR'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentYellow text-slate-950'; }
                if (main) { main.innerText = 'SIN CONFLUENCIA'; main.className = 'text-2xl sm:text-3xl font-black text-accentYellow mb-1'; }
                if (hint) hint.innerText = `${p.bias || 'Los tres TF no coinciden'}. No hay señal Palacios hasta que 1H + 15m + 1m acuerden Long o Short.`;
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            }
        }

        function applyPalaciosSignal(side) {
            if (!side) return;
            if (palaciosLatest.signal === 'BUY' && side !== 'LONG') return;
            if (palaciosLatest.signal === 'SELL' && side !== 'SHORT') return;
            if (palaciosLatest.signal === 'NONE') {
                alert('No hay confluencia Palacios (1H+15m+1m). Espera acuerdo triple.');
                return;
            }
            try {
                if (typeof changeTimeframe === 'function') changeTimeframe('15m'); // TF de entrada intermedio
                const trade = registerAppliedPosition(side, {
                    source: 'Palacios 1H+15m+1m',
                    score: palaciosLatest.conf || 60,
                    tf: '15m',
                    note: 'Confluencia triple 1H · 15m · 1m'
                });
                const status = document.getElementById('palaciosStatus');
                if (status && trade) {
                    status.innerHTML = `<span class="text-accentGreen">Registrado ${side}</span> en Historial · Entrada $${trade.entry.toFixed(1)} · SL $${trade.sl.toFixed(1)} · TP1 $${trade.tp1.toFixed(1)} / TP2 $${trade.tp2.toFixed(1)} / TP3 $${trade.tp3.toFixed(1)} · ${trade.leverage}x · vigencia ${trade.tf}`;
                }
            } catch (e) {
                console.error(e);
                alert('Error al aplicar: ' + (e.message || e));
            }
        }
        window.applyPalaciosSignal = applyPalaciosSignal;

        // ========== MEJORES CONFLUENCIAS (scalp / intradía / swing) ==========
        let mejoresConfluenciasCache = null;
        let confluenciasRunning = false;
        let confluenciasTfDataCache = null;
        let confluenciasHorizonRecs = { '15m': null, '1h': null, '4h': null };
        let confluenciasAutoTimer = null;

        const CONFLUENCIA_COMBOS = {
            scalp: [
                { tfs: ['1m', '5m'], label: '1m + 5m' },
                { tfs: ['5m', '15m'], label: '5m + 15m' },
                { tfs: ['1m', '5m', '15m'], label: '1m + 5m + 15m' },
                { tfs: ['9m', '15m'], label: '9m + 15m' },
                { tfs: ['1m', '9m'], label: '1m + 9m' }
            ],
            intraday: [
                { tfs: ['15m', '1h'], label: '15m + 1h' },
                { tfs: ['20m', '1h'], label: '20m + 1h' },
                { tfs: ['15m', '20m', '1h'], label: '15m + 20m + 1h' },
                { tfs: ['15m', '20m'], label: '15m + 20m' }
            ],
            swing: [
                { tfs: ['1h', '4h'], label: '1h + 4h' },
                { tfs: ['4h', '1d'], label: '4h + 1d' },
                { tfs: ['1h', '4h', '1d'], label: '1h + 4h + 1d' },
                { tfs: ['1h', '1d'], label: '1h + 1d' }
            ]
        };

        /** Serie de sesgos (-1/0/1) por barra — versión rápida (RSI + MA + momentum) */
        function buildBiasSeries(data) {
            const n = data.length;
            const series = new Array(n).fill(0);
            for (let i = 20; i < n; i++) {
                let gains = 0, losses = 0;
                for (let j = 1; j <= 14; j++) {
                    const ch = data[i - j + 1].close - data[i - j].close;
                    if (ch > 0) gains += ch; else losses -= ch;
                }
                const rsi = 100 - (100 / (1 + gains / (losses || 1e-8)));
                const ma5 = (data[i].close + data[i - 1].close + data[i - 2].close + data[i - 3].close + data[i - 4].close) / 5;
                let ma15 = 0;
                for (let j = 0; j < 15; j++) ma15 += data[i - j].close;
                ma15 /= 15;
                const mom = data[i].close - data[i - 3].close;
                let longPts = 0, shortPts = 0;
                if (rsi < 42) longPts += 1; else if (rsi > 58) shortPts += 1;
                if (ma5 > ma15) longPts += 1; else if (ma5 < ma15) shortPts += 1;
                if (mom > 0) longPts += 0.6; else if (mom < 0) shortPts += 0.6;
                if (data[i].close > data[i].open) longPts += 0.3; else shortPts += 0.3;
                if (longPts >= 1.8 && longPts > shortPts) series[i] = 1;
                else if (shortPts >= 1.8 && shortPts > longPts) series[i] = -1;
            }
            return series;
        }

        function backtestConfluenceCombo(tfDataMap, combo, targetRR) {
            const tfs = combo.tfs;
            const baseTf = tfs[0]; // TF más rápido para entradas
            const base = tfDataMap[baseTf];
            if (!base || base.length < 40) return null;

            const biasMap = {};
            tfs.forEach(tf => {
                if (tfDataMap[tf] && tfDataMap[tf].length >= 30) {
                    biasMap[tf] = buildBiasSeries(tfDataMap[tf]);
                }
            });
            if (Object.keys(biasMap).length < tfs.length) return null;

            // Mapear bias de TF lentos al tiempo del TF base
            const getBiasAtTime = (tf, tSec) => {
                const data = tfDataMap[tf];
                const series = biasMap[tf];
                if (!data || !series) return 0;
                let idx = -1;
                for (let i = data.length - 1; i >= 0; i--) {
                    if (data[i].time <= tSec) { idx = i; break; }
                }
                return idx >= 0 ? series[idx] : 0;
            };

            let equity = 10000, peak = 10000, maxDD = 0, wins = 0, trades = 0;
            let nextFree = 0;
            const n = base.length;

            for (let i = 25; i < n - 1; i++) {
                if (i < nextFree) continue;
                const t = base[i].time;
                const biases = tfs.map(tf => getBiasAtTime(tf, t));
                if (biases.some(b => b === 0)) continue;
                const allLong = biases.every(b => b === 1);
                const allShort = biases.every(b => b === -1);
                if (!allLong && !allShort) continue;

                const side = allLong ? 'LONG' : 'SHORT';
                const entry = base[i].close;
                let trSum = 0;
                for (let j = 1; j <= 10 && i - j >= 0; j++) {
                    const hi = base[i - j + 1].high, lo = base[i - j + 1].low, pc = base[i - j].close;
                    trSum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
                }
                const atr = (trSum / 10) || entry * 0.008;
                const slDist = Math.max(atr / entry, 0.004);
                const sl = side === 'LONG' ? entry * (1 - slDist) : entry * (1 + slDist);
                const tp = side === 'LONG' ? entry * (1 + slDist * targetRR) : entry * (1 - slDist * targetRR);

                let exitPrice = entry, exitIdx = n - 1;
                for (let j = i + 1; j < n; j++) {
                    const bar = base[j];
                    if (side === 'LONG') {
                        if (bar.low <= sl) { exitPrice = sl; exitIdx = j; break; }
                        if (bar.high >= tp) { exitPrice = tp; exitIdx = j; break; }
                    } else {
                        if (bar.high >= sl) { exitPrice = sl; exitIdx = j; break; }
                        if (bar.low <= tp) { exitPrice = tp; exitIdx = j; break; }
                    }
                    exitPrice = bar.close;
                    exitIdx = j;
                }
                const pnlPct = side === 'LONG' ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
                const riskUsd = equity * 0.01;
                equity += riskUsd * (pnlPct / slDist);
                if (equity < 1) equity = 1;
                if (equity > peak) peak = equity;
                const dd = (peak - equity) / peak;
                if (dd > maxDD) maxDD = dd;
                if (pnlPct > 0) wins++;
                trades++;
                nextFree = exitIdx + 1;
                // límite de ops para no sobre-operar
                if (trades >= 40) break;
            }

            if (trades < 2) return null;
            const wr = (wins / trades) * 100;
            const pnlPctTotal = ((equity - 10000) / 10000) * 100;
            const score = wr * Math.sqrt(Math.min(trades, 30) / 8) * (1 - Math.min(maxDD, 0.45)) * (pnlPctTotal > 0 ? 1.2 : 0.8);
            return {
                label: combo.label,
                tfs: tfs.slice(),
                trades,
                wr,
                pnlPct: pnlPctTotal,
                maxDD: maxDD * 100,
                score
            };
        }

        async function runMejoresConfluencias(force) {
            if (confluenciasRunning) return;
            if (!force && mejoresConfluenciasCache && altsLoadedAt) { /* no-op placeholder */ }
            if (!force && window._confluenciasLastRun && Date.now() - window._confluenciasLastRun < 45000 && mejoresConfluenciasCache) {
                try {
                    renderMejoresConfluencias(mejoresConfluenciasCache);
                    if (confluenciasTfDataCache) await updateHorizonRecommendations(confluenciasTfDataCache, mejoresConfluenciasCache);
                } catch (e) {}
                return;
            }
            confluenciasRunning = true;
            window._confluenciasLastRun = Date.now();
            const status = document.getElementById('confluenciasStatus');
            const icon = document.getElementById('confluenciasRunIcon');
            if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
            if (status) status.innerText = 'Descargando velas y evaluando confluencias multi-TF…';

            try {
                const allTfs = new Set();
                Object.values(CONFLUENCIA_COMBOS).forEach(list => list.forEach(c => c.tfs.forEach(t => allTfs.add(t))));
                const tfDataMap = {};
                for (const tf of allTfs) {
                    if (status) status.innerText = `Cargando ${tf} (150 velas)…`;
                    const data = await fetchKlinesForRanking(tf, 150);
                    if (data && data.length >= 40) {
                        tfDataMap[tf] = data.length > 150 ? data.slice(-150) : data;
                    }
                }

                const out = { scalp: [], intraday: [], swing: [] };
                for (const style of ['scalp', 'intraday', 'swing']) {
                    if (status) status.innerText = `Evaluando ${style}…`;
                    const results = [];
                    for (const combo of CONFLUENCIA_COMBOS[style]) {
                        const r = backtestConfluenceCombo(tfDataMap, combo, 2);
                        if (r) results.push(r);
                    }
                    results.sort((a, b) => b.score - a.score);
                    out[style] = results;
                }

                mejoresConfluenciasCache = out;
                confluenciasTfDataCache = tfDataMap;
                renderMejoresConfluencias(out);
                await updateHorizonRecommendations(tfDataMap, out);
                if (status) status.innerText = `Actualizado · auto 1 min · 150 velas · R/R 2 · ${new Date().toLocaleTimeString()}`;
            } catch (e) {
                console.error('Mejores confluencias', e);
                if (status) status.innerText = 'Error: ' + (e.message || e);
            } finally {
                confluenciasRunning = false;
                if (icon) icon.className = 'fa-solid fa-play';
            }
        }
        window.runMejoresConfluencias = runMejoresConfluencias;


        function liveBiasFromData(data) {
            if (!data || data.length < 25) return { dir: 'NEUTRAL', score: 0 };
            const series = buildBiasSeries(data);
            const v = series[series.length - 1] || 0;
            if (v > 0) return { dir: 'LONG', score: 1 };
            if (v < 0) return { dir: 'SHORT', score: 1 };
            return { dir: 'NEUTRAL', score: 0 };
        }

        async function updateHorizonRecommendations(tfDataMap, ranking) {
            const horizons = [
                { id: '15m', style: 'scalp', preferTfs: ['15m', '5m', '9m', '1m'], label: '15 minutos' },
                { id: '1h', style: 'intraday', preferTfs: ['1h', '20m', '15m'], label: '1 hora' },
                { id: '4h', style: 'swing', preferTfs: ['4h', '1h', '1d'], label: '4 horas' }
            ];
            const recs = {};
            for (const h of horizons) {
                const rows = (ranking && ranking[h.style]) || [];
                const top = rows[0] || null;
                // Sesgo vivo del TF principal del horizonte
                let primaryTf = h.preferTfs.find(tf => tfDataMap && tfDataMap[tf]) || h.preferTfs[0];
                let bias = liveBiasFromData(tfDataMap && tfDataMap[primaryTf]);
                // Si el top combo tiene sesgo unánime, usarlo
                let liveSide = bias.dir;
                let comboLabel = top ? top.label : '—';
                let conf = top ? top.wr : 0;
                if (top && top.tfs && tfDataMap) {
                    const dirs = top.tfs.map(tf => liveBiasFromData(tfDataMap[tf]).dir);
                    if (dirs.every(d => d === 'LONG')) liveSide = 'LONG';
                    else if (dirs.every(d => d === 'SHORT')) liveSide = 'SHORT';
                    else if (dirs.filter(d => d === 'LONG').length > dirs.filter(d => d === 'SHORT').length) liveSide = 'LONG';
                    else if (dirs.filter(d => d === 'SHORT').length > dirs.filter(d => d === 'LONG').length) liveSide = 'SHORT';
                    else liveSide = 'NEUTRAL';
                }
                let title = 'Esperar';
                let why = 'Sin confluencia clara en este horizonte. Evita forzar entradas.';
                if (liveSide === 'LONG') {
                    title = 'LONG preferido';
                    why = top
                        ? `El combo #1 (${top.label}) lidera en ${h.style} con WR histórico ${top.wr.toFixed(0)}%. Sesgo vivo alineado al alza para ~${h.label}.`
                        : `Sesgo alcista en ${primaryTf} para el horizonte de ${h.label}.`;
                } else if (liveSide === 'SHORT') {
                    title = 'SHORT preferido';
                    why = top
                        ? `El combo #1 (${top.label}) lidera en ${h.style} con WR histórico ${top.wr.toFixed(0)}%. Sesgo vivo alineado a la baja para ~${h.label}.`
                        : `Sesgo bajista en ${primaryTf} para el horizonte de ${h.label}.`;
                }
                recs[h.id] = {
                    side: liveSide,
                    title,
                    combo: comboLabel,
                    tfs: top ? top.tfs : [primaryTf],
                    style: h.style,
                    wr: top ? top.wr : null,
                    score: top ? top.score : 0,
                    primaryTf,
                    why,
                    stats: top || null
                };
            }
            confluenciasHorizonRecs = recs;
            renderHorizonRecommendations(recs);
        }

        function renderHorizonRecommendations(recs) {
            const map = { '15m': '15m', '1h': '1h', '4h': '4h' };
            Object.keys(map).forEach(id => {
                const r = recs[id];
                if (!r) return;
                const sideEl = document.getElementById('rec' + id + 'Side');
                const titleEl = document.getElementById('rec' + id + 'Title');
                const comboEl = document.getElementById('rec' + id + 'Combo');
                const metaEl = document.getElementById('rec' + id + 'Meta');
                const whyEl = document.getElementById('rec' + id + 'Why');
                const btn = document.getElementById('rec' + id + 'Apply');
                if (sideEl) {
                    if (r.side === 'LONG') {
                        sideEl.innerText = 'LONG';
                        sideEl.className = 'px-2 py-0.5 rounded text-[10px] font-black bg-accentGreen/20 text-accentGreen';
                    } else if (r.side === 'SHORT') {
                        sideEl.innerText = 'SHORT';
                        sideEl.className = 'px-2 py-0.5 rounded text-[10px] font-black bg-accentRed/20 text-accentRed';
                    } else {
                        sideEl.innerText = 'WAIT';
                        sideEl.className = 'px-2 py-0.5 rounded text-[10px] font-black bg-borderBg text-slate-400';
                    }
                }
                if (titleEl) {
                    titleEl.innerText = r.title;
                    titleEl.className = 'text-sm font-bold mb-0.5 ' + (
                        r.side === 'LONG' ? 'text-accentGreen' : r.side === 'SHORT' ? 'text-accentRed' : 'text-slate-300'
                    );
                }
                if (comboEl) comboEl.innerText = r.combo || '—';
                if (metaEl) {
                    metaEl.innerText = r.wr != null
                        ? `WR ${r.wr.toFixed(0)}% · score ${(r.score || 0).toFixed(1)} · TF ${r.primaryTf}`
                        : `TF ref. ${r.primaryTf}`;
                }
                if (whyEl) whyEl.innerText = r.why || '';
                if (btn) {
                    const can = r.side === 'LONG' || r.side === 'SHORT';
                    btn.disabled = !can;
                    btn.className = can
                        ? 'mt-2 w-full px-2 py-1 rounded-lg text-[10px] font-bold border border-accentYellow/40 bg-accentYellow/10 text-accentYellow transition'
                        : 'mt-2 w-full px-2 py-1 rounded-lg text-[10px] font-bold border border-borderBg text-slate-500 opacity-50 cursor-not-allowed';
                    btn.innerText = can ? ('Aplicar ' + r.side) : 'Sin setup claro';
                }
            });
        }

        function applyHorizonRec(horizonId) {
            const r = confluenciasHorizonRecs && confluenciasHorizonRecs[horizonId];
            if (!r || (r.side !== 'LONG' && r.side !== 'SHORT')) {
                alert('No hay operativa clara en este horizonte ahora mismo.');
                return;
            }
            try {
                if (r.tfs && r.tfs.length) {
                    selectConfluencia(r.style || 'intraday', r.combo, r.tfs, r.stats || { wr: r.wr, score: r.score });
                }
                if (typeof changeTimeframe === 'function') changeTimeframe(r.primaryTf || (r.tfs && r.tfs[0]) || '15m');
                if (typeof registerAppliedPosition === 'function') {
                    registerAppliedPosition(r.side, {
                        source: 'Confluencia ' + horizonId + ' · ' + (r.combo || ''),
                        score: r.wr || 55,
                        tf: r.primaryTf || '15m',
                        note: r.why
                    });
                } else if (typeof setTradeSide === 'function') {
                    setTradeSide(r.side);
                }
            } catch (e) {
                console.error(e);
                alert('Error al aplicar: ' + (e.message || e));
            }
        }
        window.applyHorizonRec = applyHorizonRec;
        window.updateHorizonRecommendations = updateHorizonRecommendations;

        function startConfluenciasAutoRefresh() {
            if (confluenciasAutoTimer) clearInterval(confluenciasAutoTimer);
            confluenciasAutoTimer = setInterval(() => {
                try {
                    if (typeof runMejoresConfluencias === 'function') runMejoresConfluencias(true);
                } catch (e) {}
            }, 60 * 1000);
        }


        let selectedConfluencia = null; // { style, label, tfs, ...stats }
        let confluenciaLiveLatest = { signal: 'NONE', tfs: {} };

        function renderMejoresConfluencias(data) {
            const paint = (style, elId) => {
                const el = document.getElementById(elId);
                if (!el) return;
                const rows = (data && data[style]) || [];
                if (!rows.length) {
                    el.innerHTML = '<p class="text-slate-500 italic text-center py-4">Sin combos con suficientes trades</p>';
                    return;
                }
                el.innerHTML = rows.slice(0, 5).map((r, i) => {
                    const wrCol = r.wr >= 55 ? 'text-accentGreen' : r.wr >= 45 ? 'text-accentYellow' : 'text-accentRed';
                    const pnlCol = r.pnlPct >= 0 ? 'text-accentGreen' : 'text-accentRed';
                    const tfsJson = JSON.stringify(r.tfs || []).replace(/'/g, '&#39;');
                    const isSel = selectedConfluencia && selectedConfluencia.label === r.label && selectedConfluencia.style === style;
                    const border = isSel
                        ? 'border-accentYellow/50 bg-accentYellow/10 shadow-[0_0_0_1px_rgba(240,185,11,0.15)]'
                        : 'border-borderBg/80 bg-panelBg/60 hover:border-slate-500 hover:bg-panelBg';
                    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
                    return `<button type="button" onclick='selectConfluencia(${JSON.stringify(style)}, ${JSON.stringify(r.label)}, ${tfsJson}, ${JSON.stringify({ trades: r.trades, wr: r.wr, pnlPct: r.pnlPct, score: r.score })})'
                        class="w-full text-left rounded-xl border ${border} px-2.5 py-2 flex flex-col gap-1 transition cursor-pointer">
                        <div class="flex items-center justify-between gap-1">
                            <span class="font-bold text-slate-100 text-[11px]"><span class="mr-1">${rank}</span>${r.label}</span>
                            <span class="font-mono text-accentYellow text-[10px] font-bold">${r.score.toFixed(1)}</span>
                        </div>
                        <div class="flex flex-wrap gap-1.5 text-[10px] font-mono">
                            <span class="px-1.5 py-0.5 rounded bg-borderBg/60 text-slate-400">${r.trades} ops</span>
                            <span class="px-1.5 py-0.5 rounded bg-borderBg/60 ${wrCol}">WR ${r.wr.toFixed(0)}%</span>
                            <span class="px-1.5 py-0.5 rounded bg-borderBg/60 ${pnlCol}">${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%</span>
                            <span class="px-1.5 py-0.5 rounded bg-borderBg/60 text-accentRed">DD ${r.maxDD.toFixed(0)}%</span>
                        </div>
                        <span class="text-[9px] ${isSel ? 'text-accentYellow' : 'text-slate-600'}">${isSel ? '● Confluencia activa' : 'Toca para ver sesgo en vivo'}</span>
                    </button>`;
                }).join('');
            };
            paint('scalp', 'confluenciasScalpBody');
            paint('intraday', 'confluenciasIntradayBody');
            paint('swing', 'confluenciasSwingBody');
        }

        function selectConfluencia(style, label, tfs, stats) {
            selectedConfluencia = {
                style: style || 'scalp',
                label: label || (tfs || []).join('+'),
                tfs: Array.isArray(tfs) ? tfs : [],
                stats: stats || {}
            };
            const sec = document.getElementById('confluenciaSelectedSection');
            if (sec) sec.classList.remove('hidden');
            const lab = document.getElementById('confluenciaSelectedLabel');
            if (lab) lab.innerText = selectedConfluencia.label;
            const st = document.getElementById('confluenciaSelectedStyle');
            if (st) {
                const names = { scalp: 'Scalp', intraday: 'Intradía', swing: 'Swing' };
                st.innerText = names[selectedConfluencia.style] || selectedConfluencia.style;
            }
            // Re-pintar ranking para marcar selección
            try { if (mejoresConfluenciasCache) renderMejoresConfluencias(mejoresConfluenciasCache); } catch (e) {}
            refreshSelectedConfluencia(true);
            // Scroll a la sección
            try { sec && sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
        }
        window.selectConfluencia = selectConfluencia;

        function clearSelectedConfluencia() {
            selectedConfluencia = null;
            const sec = document.getElementById('confluenciaSelectedSection');
            if (sec) sec.classList.add('hidden');
            try { if (mejoresConfluenciasCache) renderMejoresConfluencias(mejoresConfluenciasCache); } catch (e) {}
        }
        window.clearSelectedConfluencia = clearSelectedConfluencia;

        async function refreshSelectedConfluencia(force) {
            if (!selectedConfluencia || !selectedConfluencia.tfs || !selectedConfluencia.tfs.length) return;
            const icon = document.getElementById('confluenciaLiveIcon');
            const status = document.getElementById('confluenciaLiveStatus');
            if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
            if (status) status.innerText = 'Cargando sesgo de ' + selectedConfluencia.tfs.join(' · ') + '…';

            try {
                const tfs = selectedConfluencia.tfs;
                const biases = {};
                await Promise.all(tfs.map(async (tf) => {
                    const data = await fetchKlinesForRanking(tf, 150);
                    biases[tf] = computeTfBiasFromKlines(data);
                }));

                const dirs = tfs.map(tf => (biases[tf] && biases[tf].dir) || 'NEUTRAL');
                const allLong = dirs.every(d => d === 'LONG');
                const allShort = dirs.every(d => d === 'SHORT');
                let signal = 'NONE', conf = 40;
                if (allLong) {
                    signal = 'BUY';
                    conf = Math.min(92, 55 + tfs.reduce((a, tf) => a + (biases[tf].score || 0), 0) * 3);
                } else if (allShort) {
                    signal = 'SELL';
                    conf = Math.min(92, 55 + tfs.reduce((a, tf) => a + (biases[tf].score || 0), 0) * 3);
                }

                confluenciaLiveLatest = { signal, conf, tfs: biases, dirs, updatedAt: Date.now() };
                renderSelectedConfluenciaLive(confluenciaLiveLatest);
                if (status) {
                    const hist = selectedConfluencia.stats;
                    const histTxt = hist && hist.wr != null
                        ? ` · hist WR ${Number(hist.wr).toFixed(0)}% score ${Number(hist.score || 0).toFixed(1)}`
                        : '';
                    status.innerText = `Actualizado ${new Date().toLocaleTimeString()}${histTxt} · auto cada 35s`;
                }
            } catch (e) {
                console.error('refreshSelectedConfluencia', e);
                if (status) status.innerText = 'Error: ' + (e.message || e);
            } finally {
                if (icon) icon.className = 'fa-solid fa-rotate';
            }
        }
        window.refreshSelectedConfluencia = refreshSelectedConfluencia;

        function renderSelectedConfluenciaLive(live) {
            const badge = document.getElementById('confluenciaLiveBadge');
            const main = document.getElementById('confluenciaLiveMain');
            const hint = document.getElementById('confluenciaLiveHint');
            const btnL = document.getElementById('btnConfluenciaApplyLong');
            const btnS = document.getElementById('btnConfluenciaApplyShort');
            const grid = document.getElementById('confluenciaTfGrid');
            const tfs = selectedConfluencia ? selectedConfluencia.tfs : [];

            if (grid) {
                grid.innerHTML = tfs.map(tf => {
                    const b = (live.tfs && live.tfs[tf]) || {};
                    const dir = b.dir || 'NEUTRAL';
                    const col = dir === 'LONG' ? 'text-accentGreen' : dir === 'SHORT' ? 'text-accentRed' : 'text-slate-400';
                    const bg = dir === 'LONG' ? 'bg-accentGreen/20 text-accentGreen' : dir === 'SHORT' ? 'bg-accentRed/20 text-accentRed' : 'bg-borderBg text-slate-400';
                    return `<div class="rounded-lg border border-borderBg bg-panelBg p-2.5">
                        <div class="flex items-center justify-between mb-1">
                            <span class="text-[10px] font-bold text-slate-400">${tf.toUpperCase()}</span>
                            <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ${bg}">${dir}</span>
                        </div>
                        <div class="text-lg font-black ${col}">${dir}</div>
                        <div class="text-[10px] text-slate-500 mt-1 font-mono">${b.detail || '—'}</div>
                    </div>`;
                }).join('');
            }

            if (live.signal === 'BUY') {
                if (badge) { badge.innerText = 'LONG'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentGreen text-slate-950'; }
                if (main) { main.innerText = 'COMPRA (confluencia activa)'; main.className = 'text-2xl sm:text-3xl font-black text-accentGreen mb-1'; }
                if (hint) hint.innerText = `Todos los TF del combo (${(selectedConfluencia && selectedConfluencia.label) || ''}) alineados alcistas. Confianza ~${(live.conf || 0).toFixed(0)}%.`;
                if (btnL) { btnL.disabled = false; btnL.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else if (live.signal === 'SELL') {
                if (badge) { badge.innerText = 'SHORT'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentRed text-white'; }
                if (main) { main.innerText = 'VENTA (confluencia activa)'; main.className = 'text-2xl sm:text-3xl font-black text-accentRed mb-1'; }
                if (hint) hint.innerText = `Todos los TF del combo (${(selectedConfluencia && selectedConfluencia.label) || ''}) alineados bajistas. Confianza ~${(live.conf || 0).toFixed(0)}%.`;
                if (btnS) { btnS.disabled = false; btnS.classList.remove('opacity-40', 'cursor-not-allowed'); }
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
            } else {
                if (badge) { badge.innerText = 'ESPERAR'; badge.className = 'px-3 py-1 rounded text-xs font-black bg-accentYellow text-slate-950'; }
                if (main) { main.innerText = 'SIN CONFLUENCIA'; main.className = 'text-2xl sm:text-3xl font-black text-accentYellow mb-1'; }
                const dirs = live.dirs || [];
                if (hint) hint.innerText = `Los TF del combo no coinciden (${dirs.join(' · ') || '—'}). Espera acuerdo completo en LONG o SHORT.`;
                if (btnL) { btnL.disabled = true; btnL.classList.add('opacity-40', 'cursor-not-allowed'); }
                if (btnS) { btnS.disabled = true; btnS.classList.add('opacity-40', 'cursor-not-allowed'); }
            }
        }

        function applySelectedConfluencia(side) {
            if (!confluenciaLiveLatest || confluenciaLiveLatest.signal === 'NONE') {
                alert('No hay confluencia activa en este combo. Espera acuerdo de todos los TF.');
                return;
            }
            if (confluenciaLiveLatest.signal === 'BUY' && side !== 'LONG') return;
            if (confluenciaLiveLatest.signal === 'SELL' && side !== 'SHORT') return;
            try {
                const tfs = (selectedConfluencia && selectedConfluencia.tfs) || [];
                const entryTf = tfs[0] || currentInterval || '15m';
                if (entryTf && typeof changeTimeframe === 'function') changeTimeframe(entryTf);
                const label = (selectedConfluencia && selectedConfluencia.label) || tfs.join('+');
                const histScore = selectedConfluencia && selectedConfluencia.stats && selectedConfluencia.stats.wr
                    ? selectedConfluencia.stats.wr
                    : (confluenciaLiveLatest.conf || 55);
                const trade = registerAppliedPosition(side, {
                    source: 'Confluencia ' + label,
                    score: histScore,
                    tf: entryTf,
                    note: `Combo ${label} · estilo ${(selectedConfluencia && selectedConfluencia.style) || ''}`
                });
                const status = document.getElementById('confluenciaLiveStatus');
                if (status && trade) {
                    status.innerHTML = `<span class="text-accentGreen">Registrado ${side}</span> · ${label} · Entrada $${trade.entry.toFixed(1)} · SL $${trade.sl.toFixed(1)} · TP1/2/3 $${trade.tp1.toFixed(1)}/${trade.tp2.toFixed(1)}/${trade.tp3.toFixed(1)} · ${trade.leverage}x · TF ${entryTf}`;
                }
            } catch (e) {
                console.error(e);
                alert('Error al aplicar: ' + (e.message || e));
            }
        }
        window.applySelectedConfluencia = applySelectedConfluencia;

        // ========== RANKING DE COMBINACIONES (siempre 150 velas) ==========
        const RANK_CANDLE_LIMIT = 150;
        const RANK_TFS = ['5m', '9m', '15m', '20m', '1h', '4h'];
        let comboRankingsCache = [];
        let rankingsRunning = false;

        const RANK_PRESETS = {
            scalp: { trendilo: false, stoch: true, dmi: false, yoshi: true, label: 'Scalp' },
            intradaily: { trendilo: true, stoch: true, dmi: true, yoshi: true, label: 'Intradía' },
            swing: { trendilo: true, stoch: false, dmi: true, yoshi: true, label: 'Swing' }
        };

        async function fetchKlinesForRanking(tf, limit) {
            const lim = limit || RANK_CANDLE_LIMIT;
            const sym = currentSymbol || 'BTCUSDT';
            const BINANCE_TF = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
            // 9m / 20m: construir desde 1m
            if (tf === '9m' || tf === '20m') {
                const mins = tf === '9m' ? 9 : 20;
                try {
                    const need = Math.min(1000, lim * mins + 50);
                    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=${need}`);
                    const raw = await res.json();
                    if (!Array.isArray(raw) || !raw.length) return [];
                    const oneMin = raw.map(k => ({
                        time: Math.floor(k[0] / 1000),
                        open: parseFloat(k[1]), high: parseFloat(k[2]),
                        low: parseFloat(k[3]), close: parseFloat(k[4]),
                        volume: parseFloat(k[5])
                    }));
                    // Agrupar en barras de N minutos
                    const out = [];
                    for (let i = 0; i + mins <= oneMin.length; i += mins) {
                        const slice = oneMin.slice(i, i + mins);
                        out.push({
                            time: slice[0].time,
                            open: slice[0].open,
                            high: Math.max(...slice.map(s => s.high)),
                            low: Math.min(...slice.map(s => s.low)),
                            close: slice[slice.length - 1].close,
                            volume: slice.reduce((a, s) => a + s.volume, 0)
                        });
                    }
                    return out.slice(-lim);
                } catch (e) {
                    console.warn('rank fetch custom TF', tf, e);
                    return [];
                }
            }
            const interval = BINANCE_TF[tf] || '1h';
            try {
                const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${lim}`);
                const raw = await res.json();
                if (!Array.isArray(raw)) return [];
                return raw.map(k => ({
                    time: Math.floor(k[0] / 1000),
                    open: parseFloat(k[1]), high: parseFloat(k[2]),
                    low: parseFloat(k[3]), close: parseFloat(k[4]),
                    volume: parseFloat(k[5])
                }));
            } catch (e) {
                console.warn('rank fetch', tf, e);
                return [];
            }
        }

        /** Backtest ligero sobre data[] con preset de indicadores y sideMode. Siempre usa todas las velas pasadas (≤150). */
        function backtestComboOnData(data, presetKey, sideMode, targetRR) {
            const preset = RANK_PRESETS[presetKey] || RANK_PRESETS.intradaily;
            const n = data.length;
            if (n < 40) return null;

            const zScores = new Array(n).fill(0);
            const rsiArr = new Array(n).fill(50);
            const diBias = new Array(n).fill(0);

            for (let i = 14; i < n; i++) {
                let sum = 0, sq = 0;
                for (let j = 0; j < 14; j++) sum += (data[i - j].close - data[i - j].open);
                const mean = sum / 14;
                for (let j = 0; j < 14; j++) {
                    const d = data[i - j].close - data[i - j].open;
                    sq += (d - mean) * (d - mean);
                }
                const std = Math.sqrt(sq / 14) || 1e-8;
                zScores[i] = (data[i].close - data[i - 1].close) / std;

                let gains = 0, losses = 0;
                for (let j = 1; j <= 14; j++) {
                    const ch = data[i - j + 1].close - data[i - j].close;
                    if (ch > 0) gains += ch; else losses -= ch;
                }
                rsiArr[i] = 100 - (100 / (1 + gains / (losses || 1e-8)));

                const up = data[i].high - data[i - 1].high;
                const dn = data[i - 1].low - data[i].low;
                if (up > dn && up > 0) diBias[i] = 1;
                else if (dn > up && dn > 0) diBias[i] = -1;
            }

            // SuperTrend proxy simple (Yoshi-like)
            const atrPeriod = 10;
            const stMult = 2;
            const atrArr = new Array(n).fill(0);
            for (let i = 1; i < n; i++) {
                const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close));
                atrArr[i] = i < atrPeriod ? tr : (atrArr[i - 1] * (atrPeriod - 1) + tr) / atrPeriod;
            }
            const stTrend = new Array(n).fill(1);
            let upFinal = null, dnFinal = null, trend = 1;
            for (let i = atrPeriod; i < n; i++) {
                const src = (data[i].high + data[i].low) / 2;
                let up = src - stMult * atrArr[i];
                let dn = src + stMult * atrArr[i];
                if (upFinal == null) upFinal = up;
                else upFinal = (data[i - 1].close > upFinal) ? Math.max(up, upFinal) : up;
                if (dnFinal == null) dnFinal = dn;
                else dnFinal = (data[i - 1].close < dnFinal) ? Math.min(dn, dnFinal) : dn;
                if (trend === -1 && data[i].close > dnFinal) trend = 1;
                else if (trend === 1 && data[i].close < upFinal) trend = -1;
                stTrend[i] = trend;
            }

            const signals = [];
            let lastSigIdx = -999;
            for (let i = 16; i < n - 1; i++) {
                if (i - lastSigIdx < 2) continue;
                let longPts = 0, shortPts = 0;

                if (preset.trendilo) {
                    if (zScores[i] > 0.35) longPts += 1.2;
                    else if (zScores[i] < -0.35) shortPts += 1.2;
                }
                if (preset.stoch) {
                    if (rsiArr[i] < 35) longPts += 1;
                    else if (rsiArr[i] > 65) shortPts += 1;
                    else if (rsiArr[i] < 45) longPts += 0.4;
                    else if (rsiArr[i] > 55) shortPts += 0.4;
                }
                if (preset.dmi) {
                    if (diBias[i] === 1) longPts += 0.8;
                    else if (diBias[i] === -1) shortPts += 0.8;
                }
                if (preset.yoshi) {
                    if (stTrend[i] === 1) longPts += 0.9;
                    else if (stTrend[i] === -1) shortPts += 0.9;
                    if (i > 0 && stTrend[i] === 1 && stTrend[i - 1] === -1) longPts += 0.5;
                    if (i > 0 && stTrend[i] === -1 && stTrend[i - 1] === 1) shortPts += 0.5;
                }

                // Momentum leve siempre (ruido bajo)
                if (data[i].close > data[i - 1].close && data[i - 1].close > data[i - 2].close) longPts += 0.25;
                if (data[i].close < data[i - 1].close && data[i - 1].close < data[i - 2].close) shortPts += 0.25;

                const threshold = 1.7;
                let signal = null;
                if (longPts >= threshold && longPts > shortPts && (sideMode === 'BOTH' || sideMode === 'LONG')) signal = 'LONG';
                else if (shortPts >= threshold && shortPts > longPts && (sideMode === 'BOTH' || sideMode === 'SHORT')) signal = 'SHORT';

                if (signal) {
                    signals.push({ idx: i, signal, price: data[i].close });
                    lastSigIdx = i;
                }
            }

            // Simular trades RR fijo
            let equity = 10000, peak = 10000, maxDD = 0, wins = 0, nextFree = 0;
            const riskPct = 1;
            const trades = [];
            for (const s of signals) {
                if (s.idx < nextFree) continue;
                const entry = s.price;
                let trSum = 0;
                for (let j = 1; j <= 14 && s.idx - j >= 0; j++) {
                    const hi = data[s.idx - j + 1].high, lo = data[s.idx - j + 1].low, pc = data[s.idx - j].close;
                    trSum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
                }
                const atr = (trSum / 14) || (entry * 0.01);
                const slDist = Math.max(atr / entry * 1.1, 0.005);
                let sl, tp;
                if (s.signal === 'LONG') {
                    sl = entry * (1 - slDist);
                    tp = entry * (1 + slDist * targetRR);
                } else {
                    sl = entry * (1 + slDist);
                    tp = entry * (1 - slDist * targetRR);
                }
                let exitPrice = entry, result = 'TIME', exitIdx = n - 1;
                for (let j = s.idx + 1; j < n; j++) {
                    const bar = data[j];
                    if (s.signal === 'LONG') {
                        if (bar.low <= sl) { exitPrice = sl; result = 'SL'; exitIdx = j; break; }
                        if (bar.high >= tp) { exitPrice = tp; result = 'TP'; exitIdx = j; break; }
                    } else {
                        if (bar.high >= sl) { exitPrice = sl; result = 'SL'; exitIdx = j; break; }
                        if (bar.low <= tp) { exitPrice = tp; result = 'TP'; exitIdx = j; break; }
                    }
                    exitPrice = bar.close;
                    exitIdx = j;
                }
                const pnlPct = s.signal === 'LONG' ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
                const riskUsd = equity * (riskPct / 100);
                const posSize = riskUsd / slDist;
                const pnlUsd = posSize * pnlPct;
                equity += pnlUsd;
                if (equity <= 0) equity = 1;
                if (equity > peak) peak = equity;
                const dd = (peak - equity) / peak;
                if (dd > maxDD) maxDD = dd;
                if (pnlUsd > 0) wins++;
                trades.push({ result, pnl: pnlUsd });
                nextFree = exitIdx + 1;
            }

            const total = trades.length;
            const wr = total > 0 ? wins / total : 0;
            const pnlPctTotal = ((equity - 10000) / 10000) * 100;
            // Score: favorece WR alto, suficientes trades, bajo DD
            const score = total < 3
                ? 0
                : (wr * 100) * Math.sqrt(Math.min(total, 40) / 10) * (1 - Math.min(maxDD, 0.5)) * (pnlPctTotal > 0 ? 1.15 : 0.85);

            return {
                trades: total,
                wins,
                wr: wr * 100,
                pnlPct: pnlPctTotal,
                maxDD: maxDD * 100,
                score,
                equity
            };
        }

        async function runComboRankings(force) {
            if (rankingsRunning) return;
            rankingsRunning = true;
            const status = document.getElementById('rankingsStatus');
            const icon = document.getElementById('rankRunIcon');
            if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
            if (status) status.innerText = 'Descargando 150 velas por TF y evaluando combinaciones…';

            const sideMode = (document.getElementById('rankSideFilter') || {}).value || 'BOTH';
            const targetRR = parseFloat((document.getElementById('rankRR') || {}).value) || 2;
            const results = [];

            try {
                for (const tf of RANK_TFS) {
                    if (status) status.innerText = `Cargando ${tf} (150 velas)…`;
                    const data = await fetchKlinesForRanking(tf, RANK_CANDLE_LIMIT);
                    if (!data || data.length < 40) {
                        console.warn('rank skip TF', tf, data && data.length);
                        continue;
                    }
                    // Asegurar máximo 150
                    const candles = data.length > RANK_CANDLE_LIMIT ? data.slice(-RANK_CANDLE_LIMIT) : data;

                    for (const presetKey of Object.keys(RANK_PRESETS)) {
                        const sides = sideMode === 'BOTH' ? ['BOTH'] : [sideMode];
                        // Si el usuario eligió BOTH en el filtro, también rankeamos LONG y SHORT por separado para más info
                        const modesToTest = sideMode === 'BOTH' ? ['BOTH', 'LONG', 'SHORT'] : [sideMode];
                        for (const mode of modesToTest) {
                            const r = backtestComboOnData(candles, presetKey, mode, targetRR);
                            if (!r || r.trades < 2) continue;
                            results.push({
                                tf,
                                preset: presetKey,
                                presetLabel: RANK_PRESETS[presetKey].label,
                                side: mode,
                                candles: candles.length,
                                ...r
                            });
                        }
                    }
                }

                results.sort((a, b) => b.score - a.score);
                comboRankingsCache = results;
                renderComboRankings(results);
                if (status) {
                    status.innerText = `Evaluadas ${results.length} combinaciones · siempre ${RANK_CANDLE_LIMIT} velas · R/R ${targetRR} · ${new Date().toLocaleTimeString()}`;
                }
            } catch (e) {
                console.error('runComboRankings', e);
                if (status) status.innerText = 'Error: ' + (e.message || e);
            } finally {
                rankingsRunning = false;
                if (icon) icon.className = 'fa-solid fa-play';
            }
        }
        window.runComboRankings = runComboRankings;

        function renderComboRankings(results) {
            const tbody = document.getElementById('rankingsTableBody');
            if (!tbody) return;
            if (!results || !results.length) {
                tbody.innerHTML = `<tr><td colspan="10" class="p-6 text-center text-slate-500 italic">Sin combinaciones con suficientes trades. Prueba otro R/R o lado.</td></tr>`;
                return;
            }
            const top = results.slice(0, 25);
            tbody.innerHTML = top.map((r, i) => {
                const wrCol = r.wr >= 55 ? 'text-accentGreen' : r.wr >= 45 ? 'text-accentYellow' : 'text-accentRed';
                const pnlCol = r.pnlPct >= 0 ? 'text-accentGreen' : 'text-accentRed';
                const sideCol = r.side === 'LONG' ? 'text-accentGreen' : r.side === 'SHORT' ? 'text-accentRed' : 'text-slate-300';
                return `<tr class="hover:bg-cardBg/50 transition">
                    <td class="p-2 text-slate-500 font-mono">${i + 1}</td>
                    <td class="p-2 font-bold text-accentYellow font-mono">${r.tf}</td>
                    <td class="p-2">${r.presetLabel}</td>
                    <td class="p-2 font-bold ${sideCol}">${r.side}</td>
                    <td class="p-2 text-right font-mono">${r.trades}</td>
                    <td class="p-2 text-right font-mono ${wrCol}">${r.wr.toFixed(1)}%</td>
                    <td class="p-2 text-right font-mono ${pnlCol}">${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%</td>
                    <td class="p-2 text-right font-mono text-accentRed">${r.maxDD.toFixed(1)}%</td>
                    <td class="p-2 text-right font-mono font-bold text-white">${r.score.toFixed(1)}</td>
                    <td class="p-2">
                        <button type="button" onclick="applyComboRanking('${r.tf}','${r.preset}','${r.side}')"
                            class="px-2 py-1 rounded bg-accentYellow/15 border border-accentYellow/40 text-accentYellow text-[10px] font-bold hover:bg-accentYellow/25 transition">
                            Aplicar
                        </button>
                    </td>
                </tr>`;
            }).join('');
        }

        function applyComboRanking(tf, preset, side) {
            try {
                // 1) Timeframe del gráfico + proyección
                if (typeof changeTimeframe === 'function') changeTimeframe(tf);
                // 2) Filtros de indicadores
                if (typeof applyIndicatorPreset === 'function') {
                    const map = { scalp: 'scalp', intradaily: 'intraday', swing: 'swing' };
                    applyIndicatorPreset(map[preset] || 'intraday');
                }
                // 3) Lado de la orden
                if (side === 'LONG' || side === 'SHORT') {
                    if (typeof setTradeSide === 'function') setTradeSide(side);
                }
                // Feedback
                const status = document.getElementById('rankingsStatus');
                if (status) {
                    status.innerHTML = `<span class="text-accentGreen">Aplicado:</span> TF <strong>${tf}</strong> · preset <strong>${preset}</strong> · lado <strong>${side}</strong>. Gráfico y filtros actualizados.`;
                }
                // Ir a señales para ver confluencia
                try { switchBottomTab('signals'); } catch (e) {}
            } catch (e) {
                console.error('applyComboRanking', e);
                alert('Error al aplicar combinación: ' + (e.message || e));
            }
        }
        window.applyComboRanking = applyComboRanking;

        function runStrategyBacktest() {
            if (!rawKlines || rawKlines.length < 40) {
                alert('Carga primero los datos de mercado (espera a que el gráfico se rellene).');
                return;
            }

            const capital0 = parseFloat(document.getElementById('btCapital').value) || 10000;
            const riskPct = parseFloat(document.getElementById('btRiskPct').value) || 1;
            const candleRange = parseInt(document.getElementById('btCandleRange').value) || 100;
            const maxOpsHour = parseInt(document.getElementById('btMaxOpsHour').value) || 2;
            const sideMode = document.getElementById('btSideMode').value || 'BOTH';
            const targetRR = parseFloat(document.getElementById('btRR').value) || 2;

            const startIdx = Math.max(25, rawKlines.length - candleRange);
            const data = rawKlines.slice(startIdx);
            const n = data.length;
            if (n < 30) {
                alert('Muy pocas velas para backtest. Cambia el rango o el timeframe.');
                return;
            }

            // --- Compute indicators series ---
            const zScores = new Array(n).fill(0);
            const rsiArr = new Array(n).fill(50);
            const diBias = new Array(n).fill(0); // +1 bullish, -1 bearish

            for (let i = 14; i < n; i++) {
                // Z-Score momentum (Trendilo style)
                let sum = 0, sq = 0;
                for (let j = 0; j < 14; j++) {
                    sum += (data[i - j].close - data[i - j].open);
                }
                const mean = sum / 14;
                for (let j = 0; j < 14; j++) {
                    const d = data[i - j].close - data[i - j].open;
                    sq += (d - mean) * (d - mean);
                }
                const std = Math.sqrt(sq / 14) || 1e-8;
                zScores[i] = (data[i].close - data[i - 1].close) / std;

                // RSI(14) simple
                let gains = 0, losses = 0;
                for (let j = 1; j <= 14; j++) {
                    const ch = data[i - j + 1].close - data[i - j].close;
                    if (ch > 0) gains += ch;
                    else losses -= ch;
                }
                const rs = gains / (losses || 1e-8);
                rsiArr[i] = 100 - (100 / (1 + rs));

                // DI proxy
                const up = data[i].high - data[i - 1].high;
                const dn = data[i - 1].low - data[i].low;
                if (up > dn && up > 0) diBias[i] = 1;
                else if (dn > up && dn > 0) diBias[i] = -1;
            }

            // --- Generate signals (softer confluence: score >= 1.5 effectively 2 conditions) ---
            const rawSignals = [];
            for (let i = 15; i < n - 1; i++) {
                let longScore = 0, shortScore = 0;

                if (zScores[i] > 0.35) longScore += 1.2;
                else if (zScores[i] < -0.35) shortScore += 1.2;

                if (rsiArr[i] < 35) longScore += 1;
                else if (rsiArr[i] > 65) shortScore += 1;
                else if (rsiArr[i] < 45) longScore += 0.4;
                else if (rsiArr[i] > 55) shortScore += 0.4;

                if (diBias[i] === 1) longScore += 0.8;
                else if (diBias[i] === -1) shortScore += 0.8;

                // Momentum continuation bonus
                if (data[i].close > data[i - 1].close && data[i - 1].close > data[i - 2].close) longScore += 0.3;
                if (data[i].close < data[i - 1].close && data[i - 1].close < data[i - 2].close) shortScore += 0.3;

                let signal = null;
                if (longScore >= 1.8 && longScore > shortScore && (sideMode === 'BOTH' || sideMode === 'LONG')) {
                    signal = 'LONG';
                } else if (shortScore >= 1.8 && shortScore > longScore && (sideMode === 'BOTH' || sideMode === 'SHORT')) {
                    signal = 'SHORT';
                }

                if (signal) {
                    rawSignals.push({
                        idx: i,
                        signal,
                        time: data[i].time,
                        price: data[i].close,
                        z: zScores[i],
                        rsi: rsiArr[i]
                    });
                }
            }

            // --- Filter: max ops per hour + cooldown of 2 bars minimum ---
            const filtered = [];
            const hourCount = {};
            let lastIdx = -999;
            for (const s of rawSignals) {
                if (s.idx - lastIdx < 2) continue; // cooldown
                const hKey = Math.floor(s.time / 3600);
                hourCount[hKey] = hourCount[hKey] || 0;
                if (hourCount[hKey] >= maxOpsHour) continue;
                hourCount[hKey]++;
                filtered.push(s);
                lastIdx = s.idx;
            }

            // --- Simulate trades ---
            let equity = capital0;
            let peak = capital0;
            let maxDD = 0;
            const trades = [];
            let wins = 0;
            let nextFreeIdx = 0; // avoid overlapping positions

            for (const s of filtered) {
                if (s.idx < nextFreeIdx) continue;

                const entry = s.price;
                // Dynamic ATR approx from last 14 bars
                let trSum = 0;
                for (let j = 1; j <= 14 && s.idx - j >= 0; j++) {
                    const hi = data[s.idx - j + 1].high;
                    const lo = data[s.idx - j + 1].low;
                    const pc = data[s.idx - j].close;
                    trSum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
                }
                const atr = (trSum / 14) || (entry * 0.01);
                const atrPct = atr / entry;
                const slDist = Math.max(atrPct * 1.1, 0.005); // min 0.5%

                let sl, tp;
                if (s.signal === 'LONG') {
                    sl = entry * (1 - slDist);
                    tp = entry * (1 + slDist * targetRR);
                } else {
                    sl = entry * (1 + slDist);
                    tp = entry * (1 - slDist * targetRR);
                }

                let exitPrice = entry;
                let result = 'TIME';
                let exitIdx = n - 1;

                for (let j = s.idx + 1; j < n; j++) {
                    const bar = data[j];
                    if (s.signal === 'LONG') {
                        if (bar.low <= sl) { exitPrice = sl; result = 'SL'; exitIdx = j; break; }
                        if (bar.high >= tp) { exitPrice = tp; result = 'TP'; exitIdx = j; break; }
                    } else {
                        if (bar.high >= sl) { exitPrice = sl; result = 'SL'; exitIdx = j; break; }
                        if (bar.low <= tp) { exitPrice = tp; result = 'TP'; exitIdx = j; break; }
                    }
                    exitPrice = bar.close;
                    exitIdx = j;
                }

                const pnlPct = s.signal === 'LONG'
                    ? (exitPrice - entry) / entry
                    : (entry - exitPrice) / entry;

                const riskUsd = equity * (riskPct / 100);
                const posSize = riskUsd / slDist;
                const pnlUsd = posSize * pnlPct;

                equity += pnlUsd;
                if (equity <= 0) equity = 1; // floor
                if (equity > peak) peak = equity;
                const dd = (peak - equity) / peak;
                if (dd > maxDD) maxDD = dd;
                if (pnlUsd > 0) wins++;

                trades.push({
                    n: trades.length + 1,
                    side: s.signal,
                    entry,
                    exit: exitPrice,
                    pnl: pnlUsd,
                    result,
                    time: s.time,
                    z: s.z,
                    rsi: s.rsi
                });

                nextFreeIdx = exitIdx + 1;
            }

            // --- Stats ---
            const total = trades.length;
            const wr = total > 0 ? (wins / total * 100) : 0;
            const netPnl = equity - capital0;
            const t0 = data[0].time;
            const t1 = data[n - 1].time;
            const hours = Math.max(0.5, (t1 - t0) / 3600);
            const opsPerHour = total / hours;

            // Update summary cards
            document.getElementById('btTotalTrades').innerText = total;
            const wrEl = document.getElementById('btWinRate');
            wrEl.innerText = wr.toFixed(1) + '%';
            wrEl.className = 'text-lg font-bold font-mono ' + (wr >= 50 ? 'text-accentGreen' : wr >= 40 ? 'text-accentYellow' : 'text-accentRed');

            const pnlEl = document.getElementById('btNetPnl');
            pnlEl.innerText = (netPnl >= 0 ? '+' : '') + '$' + netPnl.toFixed(2);
            pnlEl.className = 'text-lg font-bold font-mono ' + (netPnl >= 0 ? 'text-accentGreen' : 'text-accentRed');

            document.getElementById('btFinalEquity').innerText = '$' + equity.toFixed(2);
            document.getElementById('btMaxDD').innerText = (maxDD * 100).toFixed(1) + '%';
            document.getElementById('btOpsPerHour').innerText = opsPerHour.toFixed(2);

            const hPnl = document.getElementById('btHeaderPnl');
            if (hPnl) {
                hPnl.innerText = (netPnl >= 0 ? '+' : '') + '$' + netPnl.toFixed(0);
                hPnl.className = netPnl >= 0 ? 'text-accentGreen' : 'text-accentRed';
            }
            const hWr = document.getElementById('btHeaderWr');
            if (hWr) hWr.innerText = wr.toFixed(0) + '%';

            document.getElementById('btSummaryText').innerHTML =
                `Velas analizadas: <strong>${n}</strong> (${currentInterval}). ` +
                `Señales brutas: <strong>${rawSignals.length}</strong> → tras filtro (máx ${maxOpsHour}/h + cooldown): <strong>${total}</strong> trades. ` +
                `Capital $${capital0.toLocaleString()} → <strong>$${equity.toFixed(0)}</strong> ` +
                `(${netPnl >= 0 ? '+' : ''}${((netPnl / capital0) * 100).toFixed(1)}%). ` +
                `Max DD: ${(maxDD * 100).toFixed(1)}%. Promedio: <strong>${opsPerHour.toFixed(2)} ops/hora</strong>.`;

            // Table
            const tbody = document.getElementById('btTradesBody');
            if (total === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-slate-500 italic">
                    0 trades. Señales brutas: ${rawSignals.length}. 
                    Prueba subir "Máx Ops/Hora", elegir "Long+Short" o cambiar timeframe / rango de velas.
                </td></tr>`;
            } else {
                tbody.innerHTML = trades.map(t => `
                    <tr class="hover:bg-cardBg/50">
                        <td class="p-1.5 text-slate-500">${t.n}</td>
                        <td class="p-1.5 font-bold ${t.side === 'LONG' ? 'text-accentGreen' : 'text-accentRed'}">${t.side}</td>
                        <td class="p-1.5">$${t.entry.toFixed(1)}</td>
                        <td class="p-1.5">$${t.exit.toFixed(1)}</td>
                        <td class="p-1.5 font-bold ${t.pnl >= 0 ? 'text-accentGreen' : 'text-accentRed'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
                        <td class="p-1.5"><span class="px-1.5 py-0.5 rounded text-[10px] ${
                            t.result === 'TP' ? 'bg-accentGreen/20 text-accentGreen' :
                            t.result === 'SL' ? 'bg-accentRed/20 text-accentRed' :
                            'bg-slate-700 text-slate-400'
                        }">${t.result}</span></td>
                    </tr>
                `).join('');
            }

            // === Posición recomendada siguiente (según config + estado actual) ===
            renderNextRecommendedPosition({
                sideMode, targetRR, riskPct, capital: equity,
                wr, total, netPnl, lastTrades: trades.slice(-5)
            });
        }

        function renderNextRecommendedPosition(ctx) {
            const box = document.getElementById('btNextRecommendation');
            if (!box) return;

            if (!rawKlines || rawKlines.length < 20) {
                box.innerHTML = `<div class="font-semibold text-accentYellow flex items-center gap-1.5"><i class="fa-solid fa-location-arrow"></i> Posición recomendada siguiente</div>
                    <div class="text-slate-500 italic text-[11px]">Sin datos de mercado.</div>`;
                return;
            }

            const z = parseFloat(trendiloLatest.zScore) || 0;
            const k = parseFloat(stochRsiLatest.k) || 50;
            const pDI = parseFloat(dmiLatest.pDI) || 0;
            const nDI = parseFloat(dmiLatest.nDI) || 0;
            const diSpread = parseFloat(dmiLatest.diSpread) || Math.abs(pDI - nDI);
            const price = rawKlines[rawKlines.length - 1].close;
            const sideMode = ctx.sideMode || 'BOTH';
            const targetRR = ctx.targetRR || 2;
            const riskPct = ctx.riskPct || 1;
            const capital = ctx.capital || 10000;

            // Score igual que proyección (Trendilo ALMA + RMS)
            let longPts = 0, shortPts = 0;
            const tDir2 = trendiloLatest.direction || '';
            if (tDir2.includes('Alcista') || z > 0.15) longPts += 25;
            else if (tDir2.includes('Bajista') || z < -0.15) shortPts += 25;
            else if (z > 0.05) longPts += 8; else if (z < -0.05) shortPts += 8;
            if (k < 20) longPts += 20; else if (k > 80) shortPts += 20;
            else if (k < 40) longPts += 6; else if (k > 60) shortPts += 6;
            if (diSpread >= 10) {
                if (pDI > nDI) longPts += 22; else shortPts += 22;
            } else if (diSpread >= 5) {
                if (pDI > nDI) longPts += 8; else shortPts += 8;
            }

            // Bias from recent backtest trades
            if (ctx.lastTrades && ctx.lastTrades.length > 0) {
                const recentLong = ctx.lastTrades.filter(t => t.side === 'LONG' && t.pnl > 0).length;
                const recentShort = ctx.lastTrades.filter(t => t.side === 'SHORT' && t.pnl > 0).length;
                if (recentLong > recentShort) longPts += 10;
                else if (recentShort > recentLong) shortPts += 10;
            }
            // Overall backtest WR bias
            if (ctx.wr >= 55 && ctx.total >= 3) {
                // favor the side that dominated winning trades if we can infer
                longPts += 5; // slight confidence boost to act
            }

            // Respect sideMode filter
            if (sideMode === 'LONG') shortPts = 0;
            if (sideMode === 'SHORT') longPts = 0;

            const edge = Math.abs(longPts - shortPts);
            let side = 'ESPERAR';
            let conf = 40;
            if (edge >= 12 && (longPts > shortPts || shortPts > longPts)) {
                side = longPts > shortPts ? 'LONG' : 'SHORT';
                conf = Math.min(92, 55 + edge);
            }

            // ATR-based levels
            let trSum = 0;
            const last = rawKlines.length - 1;
            for (let j = 1; j <= 14 && last - j >= 0; j++) {
                const hi = rawKlines[last - j + 1].high;
                const lo = rawKlines[last - j + 1].low;
                const pc = rawKlines[last - j].close;
                trSum += Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
            }
            const atr = (trSum / 14) || (price * 0.01);
            const slDist = Math.max(atr / price * 1.1, 0.005);

            let entry = price, sl = 0, tp = 0;
            if (side === 'LONG') {
                sl = entry * (1 - slDist);
                tp = entry * (1 + slDist * targetRR);
            } else if (side === 'SHORT') {
                sl = entry * (1 + slDist);
                tp = entry * (1 - slDist * targetRR);
            }

            const riskUsd = capital * (riskPct / 100);
            const posSize = side !== 'ESPERAR' ? (riskUsd / slDist) : 0;
            const estProfit = posSize * slDist * targetRR;
            const estLoss = riskUsd;

            if (side === 'ESPERAR') {
                box.innerHTML = `
                    <div class="font-semibold text-accentYellow flex items-center gap-1.5">
                        <i class="fa-solid fa-location-arrow"></i> Posición recomendada siguiente
                    </div>
                    <div class="flex items-center gap-2 mt-1">
                        <span class="px-2 py-0.5 rounded font-black text-xs bg-accentYellow text-slate-950">ESPERAR</span>
                        <span class="text-slate-400 text-[11px]">Sin confluencia suficiente según la config actual</span>
                    </div>
                    <div class="text-[10px] text-slate-500 mt-1">Lado permitido: ${sideMode} · R/R ${targetRR}:1 · Riesgo ${riskPct}% · Confianza ~${conf}%</div>
                `;
                return;
            }

            const sideColor = side === 'LONG' ? 'text-accentGreen' : 'text-accentRed';
            const sideBg = side === 'LONG' ? 'bg-accentGreen text-slate-950' : 'bg-accentRed text-white';

            box.innerHTML = `
                <div class="font-semibold text-accentYellow flex items-center justify-between gap-1.5">
                    <span class="flex items-center gap-1.5"><i class="fa-solid fa-location-arrow"></i> Posición recomendada siguiente</span>
                    <span class="px-2 py-0.5 rounded font-black text-[11px] ${sideBg}">${side}</span>
                </div>
                <div class="grid grid-cols-3 gap-1.5 mt-1 text-[11px] font-mono">
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-slate-500 text-[9px]">ENTRADA</div>
                        <div class="text-white font-bold">$${entry.toFixed(1)}</div>
                    </div>
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-accentRed text-[9px]">STOP LOSS</div>
                        <div class="${sideColor} font-bold">$${sl.toFixed(1)}</div>
                    </div>
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-accentGreen text-[9px]">TAKE PROFIT</div>
                        <div class="text-accentGreen font-bold">$${tp.toFixed(1)}</div>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-1.5 text-[11px] font-mono">
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-slate-500 text-[9px]">TAMAÑO</div>
                        <div class="text-accentYellow font-bold">$${posSize.toFixed(0)}</div>
                    </div>
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-slate-500 text-[9px]">R/R</div>
                        <div class="text-white font-bold">${targetRR}:1</div>
                    </div>
                    <div class="bg-panelBg rounded p-1.5 border border-borderBg">
                        <div class="text-slate-500 text-[9px]">CONF.</div>
                        <div class="text-white font-bold">${conf}%</div>
                    </div>
                </div>
                <div class="flex justify-between text-[10px] text-slate-400 mt-0.5">
                    <span>Riesgo: <strong class="text-accentRed">-$${estLoss.toFixed(2)}</strong></span>
                    <span>Ganancia est.: <strong class="text-accentGreen">+$${estProfit.toFixed(2)}</strong></span>
                </div>
                <button onclick="applyBtRecommendation('${side}', ${entry.toFixed(2)}, ${sl.toFixed(2)}, ${tp.toFixed(2)}, ${Math.round(posSize)})"
                    class="w-full mt-1.5 py-1.5 rounded-lg ${side === 'LONG' ? 'bg-accentGreen hover:bg-emerald-600' : 'bg-accentRed hover:bg-red-600'} text-slate-950 font-bold text-[11px] transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-check"></i> Aplicar esta posición a la orden
                </button>
            `;
        }

        function applyBtRecommendation(side, entry, sl, tp, size) {
            setTradeSide(side);
            document.getElementById('entryPrice').value = entry;
            document.getElementById('stopLoss').value = sl;
            document.getElementById('takeProfit').value = tp;
            document.getElementById('positionSize').value = size;
            const preset = document.getElementById('sizePreset');
            if (preset) preset.value = '';
            calculateTradeMetrics();
            // visual pulse
            const btn = side === 'LONG' ? document.getElementById('btnSideLong') : document.getElementById('btnSideShort');
            if (btn) {
                btn.classList.add('ring-2', 'ring-accentYellow');
                setTimeout(() => btn.classList.remove('ring-2', 'ring-accentYellow'), 1500);
            }
        }
