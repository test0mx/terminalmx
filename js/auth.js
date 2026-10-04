/**
 * TerminalMX — acceso vía Power Automate (OTP + sesión 3 días)
 * Flujo 1: solicitar OTP | Flujo 2: verificar OTP
 */
(function () {
  const PA = Object.assign(
    {
      // Flujo 1 — Request OTP (Power Automate)
      requestOtp:
        'https://default266e577bcdf042b295234dac3f7f4b.c7.environment.api.powerplatform.com/powerautomate/automations/direct/cu/23/workflows/a81b024bd671468f8d8800b3874ee055/triggers/manual/paths/invoke/inboxMetromaternidad?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=DUuv_XHA-czQV6lpsU2EzvhUQgWgm0nNBU2tOTXlUno',
      // Flujo 2 — Verify OTP (Power Automate)
      verifyOtp:
        'https://default266e577bcdf042b295234dac3f7f4b.c7.environment.api.powerplatform.com/powerautomate/automations/direct/cu/25/workflows/51ee5de6c4be4363b81f3d973ff71634/triggers/manual/paths/invoke/inboxMetromaternidad?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=a0Lc3qpXf4yx6SehKakiJaWgGPUZX6QbCpNQdMf0REY',
    },
    window.TMX_PA || {}
  );

  const STORAGE_KEY = 'tmx_session_v1';
  const RATE_KEY = 'tmx_auth_rate_v1';
  const SESSION_MS = 3 * 24 * 60 * 60 * 1000;

  /** Políticas de seguridad (cliente) */
  const POLICY = {
    otpCooldownMs: 45 * 1000,       // no re-pedir OTP antes de 45s
    otpTtlMs: 10 * 60 * 1000,       // OTP válido ~10 min en UI
    maxOtpRequestsPerHour: 5,       // por correo
    maxVerifyAttempts: 5,           // intentos de código
    maxVerifyFailsGlobal: 15,       // fallos totales antes de bloqueo temporal
    lockoutMs: 15 * 60 * 1000,      // bloqueo 15 min
    requestTimeoutMs: 25 * 1000,    // timeout de red
    minEmailLen: 5,
    maxEmailLen: 120,
    sessionMaxMs: SESSION_MS,       // tope sesión 3 días
  };

  let pendingEmail = '';
  let otpIssuedAt = 0;
  let verifyAttempts = 0;
  let inFlightRequest = false;
  let inFlightVerify = false;
  let cooldownTimer = null;

  function now() { return Date.now(); }

  function loadRate() {
    try {
      return JSON.parse(localStorage.getItem(RATE_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function saveRate(data) {
    try {
      localStorage.setItem(RATE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  function getEmailRate(email) {
    const r = loadRate();
    const e = r[email] || {};
    return {
      lastOtpAt: Number(e.lastOtpAt) || 0,
      otpCountHour: Number(e.otpCountHour) || 0,
      hourWindowStart: Number(e.hourWindowStart) || 0,
      verifyFails: Number(e.verifyFails) || 0,
      lockoutUntil: Number(e.lockoutUntil) || 0,
      globalFails: Number(r._globalFails) || 0,
      globalLockUntil: Number(r._globalLockUntil) || 0,
    };
  }

  function setEmailRate(email, patch) {
    const r = loadRate();
    r[email] = Object.assign({}, r[email] || {}, patch);
    if (patch.globalFails != null) r._globalFails = patch.globalFails;
    if (patch.globalLockUntil != null) r._globalLockUntil = patch.globalLockUntil;
    // limpieza ligera de entradas muy viejas
    const cutoff = now() - 24 * 60 * 60 * 1000;
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return;
      const row = r[k];
      if (row && Number(row.lastOtpAt || 0) < cutoff && Number(row.lockoutUntil || 0) < now()) {
        delete r[k];
      }
    });
    saveRate(r);
  }

  function isLocked(email) {
    const er = getEmailRate(email || '');
    if (er.globalLockUntil > now()) {
      return { locked: true, until: er.globalLockUntil, reason: 'Demasiados intentos fallidos. Espera antes de reintentar.' };
    }
    if (email && er.lockoutUntil > now()) {
      return { locked: true, until: er.lockoutUntil, reason: 'Cuenta temporalmente bloqueada por intentos fallidos.' };
    }
    return { locked: false };
  }

  function formatWait(ms) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    if (s >= 60) return Math.ceil(s / 60) + ' min';
    return s + 's';
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase().slice(0, POLICY.maxEmailLen);
  }

  function isValidEmail(email) {
    if (!email || email.length < POLICY.minEmailLen || email.length > POLICY.maxEmailLen) return false;
    // RFC simple + rechazo de caracteres peligrosos
    if (/[\s<>"'\\]/.test(email)) return false;
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email);
  }

  function sanitizeOtp(code) {
    return String(code || '').replace(/\D/g, '').slice(0, 8);
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.token || !s.expiresAt) return null;
      const exp = Number(s.expiresAt);
      if (!exp || now() > exp) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      // Rechazar sesiones con duración absurda (> 3 días + margen)
      if (s.issuedAt && exp - Number(s.issuedAt) > POLICY.sessionMaxMs + 60 * 60 * 1000) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      if (typeof s.token !== 'string' || s.token.length < 8 || s.token.length > 512) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return s;
    } catch {
      return null;
    }
  }

  function saveSession(data) {
    let exp = data.expiresAt;
    if (exp == null) exp = now() + SESSION_MS;
    if (typeof exp === 'number' && exp < 1e12) exp = exp * 1000;
    if (typeof exp === 'string' && !/^\d+$/.test(exp)) {
      const parsed = Date.parse(exp);
      exp = isNaN(parsed) ? now() + SESSION_MS : parsed;
    }
    exp = Number(exp);
    // Capar sesión a máximo 3 días desde ahora
    const maxExp = now() + POLICY.sessionMaxMs;
    if (exp > maxExp) exp = maxExp;
    if (exp <= now()) exp = now() + SESSION_MS;

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: String(data.token).slice(0, 512),
        email: normalizeEmail(data.email),
        expiresAt: exp,
        issuedAt: now(),
      })
    );
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  async function postJson(url, payload) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), POLICY.requestTimeoutMs) : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload || {}),
        signal: ctrl ? ctrl.signal : undefined,
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors',
      });
      let body = null;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { ok: res.ok, message: text, raw: text };
      }
      if (body.ok === undefined) {
        if (res.ok && (body.token || body.Token)) body.ok = true;
        else if (res.status >= 400) body.ok = false;
      }
      if (!body.error && body.Error) body.error = body.Error;
      if (!body.token && body.Token) body.token = body.Token;
      if (!body.email && body.Email) body.email = body.Email;
      if (!body.expiresAt && body.ExpiresAt) body.expiresAt = body.ExpiresAt;
      return { status: res.status, body, okHttp: res.ok };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function injectStyles() {
    if (document.getElementById('tmxAuthStyles')) return;
    const st = document.createElement('style');
    st.id = 'tmxAuthStyles';
    st.textContent = `
      #tmxAuthGate { position: fixed; inset: 0; z-index: 99999; }
      #tmxAuthGate.hidden { display: none !important; }
      .tmx-auth-backdrop {
        min-height: 100%; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: rgba(0,0,0,.92); backdrop-filter: blur(10px);
      }
      .tmx-auth-card {
        width: 100%; max-width: 400px; background: #181a20; border: 1px solid #2b313a;
        border-radius: 16px; padding: 24px; box-shadow: 0 24px 60px rgba(0,0,0,.55);
      }
      .tmx-auth-brand { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
      .tmx-auth-logo {
        width: 44px; height: 44px; border-radius: 12px; background: #f0b90b; color: #0b0e11;
        display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 22px;
      }
      .tmx-auth-title { font-weight: 700; color: #eaecef; font-size: 18px; }
      .tmx-auth-sub { font-size: 12px; color: #919b9b; margin-top: 2px; }
      .tmx-auth-label { display: block; font-size: 11px; color: #919b9b; margin-bottom: 6px; }
      .tmx-auth-input {
        width: 100%; box-sizing: border-box; background: #0b0e11; border: 1px solid #2b313a;
        border-radius: 10px; padding: 12px 14px; color: #eaecef; font-size: 14px; margin-bottom: 12px;
      }
      .tmx-auth-input.mono { letter-spacing: 8px; text-align: center; font-family: ui-monospace, monospace; font-size: 20px; }
      .tmx-auth-input:focus { outline: none; border-color: #f0b90b; }
      .tmx-auth-btn {
        width: 100%; border: none; border-radius: 10px; padding: 12px; font-weight: 700; font-size: 13px;
        cursor: pointer; margin-bottom: 8px;
      }
      .tmx-auth-btn.primary { background: #f0b90b; color: #0b0e11; }
      .tmx-auth-btn.primary:disabled { opacity: .5; cursor: not-allowed; }
      .tmx-auth-btn.ghost { background: transparent; color: #919b9b; border: 1px solid #2b313a; }
      .tmx-auth-btn.danger { background: #f6465d22; color: #f6465d; border: 1px solid #f6465d55; }
      .tmx-auth-msg { font-size: 12px; min-height: 18px; margin: 8px 0 0; color: #f0b90b; }
      .tmx-auth-msg.err { color: #f6465d; }
      .tmx-auth-msg.ok { color: #0ecb81; }
      .tmx-auth-foot { font-size: 10px; color: #5e6673; margin: 16px 0 0; line-height: 1.45; }
      .tmx-auth-policy { font-size: 10px; color: #5e6673; margin-top: 8px; line-height: 1.4; }
      #tmxAuthStepOtp.hidden, #tmxAuthStepEmail.hidden, #tmxAuthStepDenied.hidden { display: none !important; }
      body.tmx-locked > *:not(#tmxAuthGate) { visibility: hidden !important; pointer-events: none !important; }
      .tmx-denied-wrap { text-align: center; padding: 8px 0 4px; }
      .tmx-denied-icon {
        width: 72px; height: 72px; margin: 0 auto 16px; border-radius: 50%;
        background: rgba(246,70,93,.12); border: 1px solid rgba(246,70,93,.35);
        display: flex; align-items: center; justify-content: center;
        font-size: 32px; color: #f6465d;
      }
      .tmx-denied-title { font-size: 20px; font-weight: 800; color: #f6465d; margin: 0 0 8px; }
      .tmx-denied-text { font-size: 13px; color: #919b9b; line-height: 1.5; margin: 0 0 16px; }
      .tmx-denied-email {
        display: inline-block; font-family: ui-monospace, monospace; font-size: 12px;
        background: #0b0e11; border: 1px solid #2b313a; border-radius: 8px;
        padding: 6px 10px; color: #eaecef; margin-bottom: 16px; word-break: break-all;
      }
      .tmx-session-chip {
        position: fixed; bottom: 12px; right: 12px; z-index: 50;
        background: #181a20; border: 1px solid #2b313a; border-radius: 999px;
        padding: 6px 12px; font-size: 11px; color: #919b9b; display: flex; gap: 10px; align-items: center;
      }
      .tmx-session-chip button {
        background: transparent; border: none; color: #f6465d; cursor: pointer; font-size: 11px; font-weight: 600;
      }
    `;
    document.head.appendChild(st);
  }

  function ensureGateUI() {
    injectStyles();
    if (document.getElementById('tmxAuthGate')) return;
    const el = document.createElement('div');
    el.id = 'tmxAuthGate';
    el.innerHTML = `
      <div class="tmx-auth-backdrop">
        <div class="tmx-auth-card">
          <div class="tmx-auth-brand">
            <span class="tmx-auth-logo">₿</span>
            <div>
              <div class="tmx-auth-title">TerminalMX</div>
              <div class="tmx-auth-sub">Acceso restringido · OTP por correo</div>
            </div>
          </div>

          <div id="tmxAuthStepEmail">
            <label class="tmx-auth-label">Correo autorizado</label>
            <input id="tmxAuthEmail" type="email" autocomplete="email" placeholder="tu@correo.com" class="tmx-auth-input" maxlength="120" />
            <button type="button" id="tmxAuthBtnOtp" class="tmx-auth-btn primary">Enviar código OTP</button>
            <p class="tmx-auth-policy">Política: 1 solicitud cada 45 s · máx. 5 OTP/hora · 5 intentos de código</p>
          </div>

          <div id="tmxAuthStepOtp" class="hidden">
            <label class="tmx-auth-label">Código de 6 dígitos</label>
            <input id="tmxAuthCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="000000" class="tmx-auth-input mono" />
            <button type="button" id="tmxAuthBtnVerify" class="tmx-auth-btn primary">Verificar y entrar</button>
            <button type="button" id="tmxAuthBtnResend" class="tmx-auth-btn ghost" disabled>Reenviar código (45s)</button>
            <button type="button" id="tmxAuthBtnBack" class="tmx-auth-btn ghost">← Cambiar correo</button>
          </div>

          <div id="tmxAuthStepDenied" class="hidden">
            <div class="tmx-denied-wrap">
              <div class="tmx-denied-icon">✕</div>
              <h2 class="tmx-denied-title">No autorizado</h2>
              <p class="tmx-denied-text" id="tmxDeniedText">
                Este correo no tiene permiso para acceder a TerminalMX.
              </p>
              <div class="tmx-denied-email" id="tmxDeniedEmail">—</div>
              <button type="button" id="tmxAuthBtnRetry" class="tmx-auth-btn danger">Probar otro correo</button>
            </div>
          </div>

          <p id="tmxAuthMsg" class="tmx-auth-msg"></p>
          <p class="tmx-auth-foot">Sesión máxima 3 días. Timeout de red 25 s. Validación Power Automate.</p>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    document.getElementById('tmxAuthBtnOtp').onclick = requestOtp;
    document.getElementById('tmxAuthBtnVerify').onclick = verifyOtp;
    document.getElementById('tmxAuthBtnResend').onclick = requestOtp;
    document.getElementById('tmxAuthBtnBack').onclick = showEmailStep;
    document.getElementById('tmxAuthBtnRetry').onclick = showEmailStep;
    document.getElementById('tmxAuthCode').addEventListener('input', (e) => {
      e.target.value = sanitizeOtp(e.target.value);
    });
    document.getElementById('tmxAuthCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyOtp();
    });
    document.getElementById('tmxAuthEmail').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') requestOtp();
    });
  }

  function setMsg(text, type) {
    const m = document.getElementById('tmxAuthMsg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'tmx-auth-msg' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
  }

  function hideAllSteps() {
    ['tmxAuthStepEmail', 'tmxAuthStepOtp', 'tmxAuthStepDenied'].forEach((id) => {
      const n = document.getElementById(id);
      if (n) n.classList.add('hidden');
    });
  }

  function showEmailStep() {
    hideAllSteps();
    document.getElementById('tmxAuthStepEmail').classList.remove('hidden');
    verifyAttempts = 0;
    setMsg('');
    updateCooldownUI();
  }

  function showDenied(email, reason) {
    hideAllSteps();
    document.getElementById('tmxAuthStepDenied').classList.remove('hidden');
    const em = document.getElementById('tmxDeniedEmail');
    if (em) em.textContent = email || '—';
    const tx = document.getElementById('tmxDeniedText');
    if (tx) {
      tx.textContent =
        reason ||
        'Este correo no tiene permiso para acceder a TerminalMX. Solo cuentas en la lista de acceso pueden solicitar OTP.';
    }
    setMsg('');
  }

  function lockApp() {
    ensureGateUI();
    document.body.classList.add('tmx-locked');
    document.getElementById('tmxAuthGate').classList.remove('hidden');
    const chip = document.getElementById('tmxSessionChip');
    if (chip) chip.remove();
  }

  function unlockApp(session) {
    document.body.classList.remove('tmx-locked');
    const gate = document.getElementById('tmxAuthGate');
    if (gate) gate.classList.add('hidden');
    showSessionChip(session);
  }

  function showSessionChip(session) {
    let chip = document.getElementById('tmxSessionChip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'tmxSessionChip';
      chip.className = 'tmx-session-chip';
      document.body.appendChild(chip);
    }
    const left = Math.max(0, Number(session.expiresAt) - now());
    const label =
      left >= 24 * 3600000
        ? (left / SESSION_MS).toFixed(1) + 'd'
        : Math.ceil(left / 3600000) + 'h';
    chip.innerHTML = `
      <span title="Sesión activa">${session.email || ''}</span>
      <span style="color:#5e6673">${label}</span>
      <button type="button" id="tmxLogoutBtn">Salir</button>
    `;
    document.getElementById('tmxLogoutBtn').onclick = () => {
      clearSession();
      lockApp();
      showEmailStep();
      setMsg('Sesión cerrada');
    };
  }

  function updateCooldownUI() {
    const btnOtp = document.getElementById('tmxAuthBtnOtp');
    const btnResend = document.getElementById('tmxAuthBtnResend');
    const email = normalizeEmail((document.getElementById('tmxAuthEmail') || {}).value || pendingEmail);
    const er = getEmailRate(email);
    const wait = Math.max(0, POLICY.otpCooldownMs - (now() - er.lastOtpAt));

    if (btnResend) {
      if (wait > 0) {
        btnResend.disabled = true;
        btnResend.textContent = 'Reenviar código (' + formatWait(wait) + ')';
      } else {
        btnResend.disabled = inFlightRequest;
        btnResend.textContent = 'Reenviar código';
      }
    }
    if (btnOtp && wait > 0 && er.lastOtpAt) {
      // solo forzar texto si ya hubo un envío reciente del mismo correo
      if (normalizeEmail(pendingEmail) === email || er.lastOtpAt > now() - POLICY.otpCooldownMs) {
        btnOtp.disabled = true;
        btnOtp.textContent = 'Espera ' + formatWait(wait);
      }
    } else if (btnOtp && !inFlightRequest) {
      btnOtp.disabled = false;
      btnOtp.textContent = 'Enviar código OTP';
    }

    if (wait > 0) {
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(updateCooldownUI, 1000);
    }
  }

  function isUnauthorizedStatus(status, body) {
    if (status === 401 || status === 403) return true;
    const err = String((body && (body.error || body.message)) || '').toLowerCase();
    return (
      err.includes('no autoriz') ||
      err.includes('no autorizado') ||
      err.includes('not authorized') ||
      err.includes('forbidden') ||
      err.includes('no está autoriz') ||
      err.includes('no permitido')
    );
  }

  function canRequestOtp(email) {
    const lock = isLocked(email);
    if (lock.locked) {
      return { ok: false, msg: lock.reason + ' (' + formatWait(lock.until - now()) + ')' };
    }
    const er = getEmailRate(email);
    const since = now() - er.lastOtpAt;
    if (er.lastOtpAt && since < POLICY.otpCooldownMs) {
      return { ok: false, msg: 'Espera ' + formatWait(POLICY.otpCooldownMs - since) + ' antes de pedir otro código' };
    }
    // ventana horaria
    let count = er.otpCountHour;
    let windowStart = er.hourWindowStart;
    if (!windowStart || now() - windowStart > 60 * 60 * 1000) {
      count = 0;
      windowStart = now();
    }
    if (count >= POLICY.maxOtpRequestsPerHour) {
      const left = 60 * 60 * 1000 - (now() - windowStart);
      return { ok: false, msg: 'Límite de ' + POLICY.maxOtpRequestsPerHour + ' OTP/hora. Reintenta en ' + formatWait(left) };
    }
    return { ok: true, count, windowStart };
  }

  function registerOtpRequest(email, meta) {
    setEmailRate(email, {
      lastOtpAt: now(),
      otpCountHour: (meta.count || 0) + 1,
      hourWindowStart: meta.windowStart || now(),
    });
    otpIssuedAt = now();
    verifyAttempts = 0;
    updateCooldownUI();
  }

  function registerVerifyFail(email) {
    verifyAttempts += 1;
    const er = getEmailRate(email);
    const fails = (er.verifyFails || 0) + 1;
    const globalFails = (er.globalFails || 0) + 1;
    const patch = { verifyFails: fails, globalFails };

    if (verifyAttempts >= POLICY.maxVerifyAttempts || fails >= POLICY.maxVerifyAttempts) {
      patch.lockoutUntil = now() + POLICY.lockoutMs;
      patch.verifyFails = 0;
    }
    if (globalFails >= POLICY.maxVerifyFailsGlobal) {
      patch.globalLockUntil = now() + POLICY.lockoutMs;
      patch.globalFails = 0;
    }
    setEmailRate(email, patch);
  }

  function registerVerifySuccess(email) {
    setEmailRate(email, { verifyFails: 0, globalFails: 0, lockoutUntil: 0 });
    verifyAttempts = 0;
  }

  async function requestOtp() {
    if (inFlightRequest) return;
    const email = normalizeEmail((document.getElementById('tmxAuthEmail') || {}).value || pendingEmail);
    if (!isValidEmail(email)) {
      setMsg('Introduce un correo válido', 'err');
      return;
    }

    const gate = canRequestOtp(email);
    if (!gate.ok) {
      setMsg(gate.msg, 'err');
      updateCooldownUI();
      return;
    }

    // OTP vencido en UI: permitir reenvío solo si pasó cooldown (ya validado)
    const btn = document.getElementById('tmxAuthBtnOtp');
    const btnResend = document.getElementById('tmxAuthBtnResend');
    inFlightRequest = true;
    if (btn) btn.disabled = true;
    if (btnResend) btnResend.disabled = true;
    setMsg('Validando acceso y enviando código…');

    try {
      const { status, body, okHttp } = await postJson(PA.requestOtp, { email });

      if (isUnauthorizedStatus(status, body)) {
        showDenied(email, body.error || body.message || 'Correo no autorizado');
        return;
      }

      if (!okHttp || body.ok === false) {
        if (status === 429) {
          setMsg(body.error || body.message || 'Demasiadas solicitudes. Espera 45 s.', 'err');
          registerOtpRequest(email, gate); // forzar cooldown local
          return;
        }
        if (status === 403 || status === 401) {
          showDenied(email, body.error || body.message);
          return;
        }
        setMsg(body.error || body.message || 'No se pudo enviar el OTP', 'err');
        return;
      }

      // Solo registrar cooldown tras éxito real
      registerOtpRequest(email, gate);
      pendingEmail = email;
      hideAllSteps();
      document.getElementById('tmxAuthStepOtp').classList.remove('hidden');
      const codeInput = document.getElementById('tmxAuthCode');
      if (codeInput) {
        codeInput.value = '';
        codeInput.focus();
      }
      setMsg(body.message || 'Código enviado. Válido ~10 min. Revisa correo/spam.', 'ok');
      updateCooldownUI();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || String(e.message || '').includes('abort'));
      setMsg(
        aborted
          ? 'Tiempo de espera agotado (25 s). Intenta de nuevo más tarde.'
          : 'Error de red al contactar Power Automate. Revisa CORS/flujo.',
        'err'
      );
      console.error('requestOtp', e);
    } finally {
      inFlightRequest = false;
      updateCooldownUI();
    }
  }

  async function verifyOtp() {
    if (inFlightVerify) return;
    const email = normalizeEmail(pendingEmail);
    const code = sanitizeOtp((document.getElementById('tmxAuthCode') || {}).value);

    if (!email || !isValidEmail(email)) {
      setMsg('Sesión de OTP inválida. Vuelve a pedir el código.', 'err');
      showEmailStep();
      return;
    }
    if (code.length < 4 || code.length > 8) {
      setMsg('Introduce un código OTP válido (4–8 dígitos)', 'err');
      return;
    }

    const lock = isLocked(email);
    if (lock.locked) {
      setMsg(lock.reason + ' (' + formatWait(lock.until - now()) + ')', 'err');
      return;
    }

    if (verifyAttempts >= POLICY.maxVerifyAttempts) {
      registerVerifyFail(email);
      setMsg('Máximo de intentos alcanzado. Cuenta bloqueada temporalmente.', 'err');
      return;
    }

    // OTP demasiado viejo en cliente (10 min)
    if (otpIssuedAt && now() - otpIssuedAt > POLICY.otpTtlMs) {
      setMsg('El código expiró. Solicita uno nuevo (respeta la espera de 45 s).', 'err');
      return;
    }

    const btn = document.getElementById('tmxAuthBtnVerify');
    inFlightVerify = true;
    if (btn) btn.disabled = true;
    setMsg('Verificando…');

    try {
      const { status, body, okHttp } = await postJson(PA.verifyOtp, { email, code });

      if (isUnauthorizedStatus(status, body)) {
        registerVerifyFail(email);
        showDenied(email, body.error || body.message || 'Acceso denegado');
        return;
      }

      if (!okHttp || (body.ok === false && !body.token)) {
        registerVerifyFail(email);
        const left = Math.max(0, POLICY.maxVerifyAttempts - verifyAttempts);
        if (status === 429) {
          setMsg(body.error || 'Demasiados intentos. Espera antes de reintentar.', 'err');
        } else {
          setMsg(
            (body.error || body.message || 'Código incorrecto o expirado') +
              (left > 0 ? ' · Quedan ' + left + ' intentos' : ''),
            'err'
          );
        }
        if (verifyAttempts >= POLICY.maxVerifyAttempts) {
          setMsg('Cuenta bloqueada 15 min por intentos fallidos.', 'err');
        }
        return;
      }

      if (!body.token || typeof body.token !== 'string') {
        setMsg('El flujo no devolvió token de sesión válido.', 'err');
        return;
      }

      registerVerifySuccess(email);
      saveSession({
        token: body.token,
        email: body.email || email,
        expiresAt: body.expiresAt || now() + SESSION_MS,
      });
      setMsg('Acceso concedido', 'ok');
      unlockApp(loadSession());
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || String(e.message || '').includes('abort'));
      setMsg(aborted ? 'Tiempo de espera agotado al verificar.' : 'Error de red al verificar OTP', 'err');
      console.error('verifyOtp', e);
    } finally {
      inFlightVerify = false;
      if (btn) btn.disabled = false;
    }
  }

  function boot() {
    ensureGateUI();
    const local = loadSession();
    if (local && local.token && Number(local.expiresAt) > now()) {
      unlockApp(local);
      return;
    }
    clearSession();
    lockApp();
    showEmailStep();
  }

  window.TMXAuth = {
    logout() {
      clearSession();
      lockApp();
      showEmailStep();
    },
    getSession: loadSession,
    flows: PA,
    policy: POLICY,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
