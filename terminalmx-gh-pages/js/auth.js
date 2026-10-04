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
  const SESSION_MS = 3 * 24 * 60 * 60 * 1000;
  let pendingEmail = '';

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.token || !s.expiresAt) return null;
      if (Date.now() > Number(s.expiresAt)) {
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
    if (exp == null) exp = Date.now() + SESSION_MS;
    // Si viene en segundos Unix, pasar a ms
    if (typeof exp === 'number' && exp < 1e12) exp = exp * 1000;
    if (typeof exp === 'string' && !/^\d+$/.test(exp)) {
      const parsed = Date.parse(exp);
      exp = isNaN(parsed) ? Date.now() + SESSION_MS : parsed;
    }
    exp = Number(exp);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: data.token,
        email: data.email,
        expiresAt: exp,
      })
    );
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  async function postJson(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let body = null;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Power Automate a veces devuelve texto plano
      body = { ok: res.ok, message: text, raw: text };
    }
    // Normalizar flags de éxito/error comunes en PA
    if (body.ok === undefined) {
      if (res.ok && (body.token || body.Token)) body.ok = true;
      else if (res.status >= 400) body.ok = false;
    }
    if (!body.error && body.Error) body.error = body.Error;
    if (!body.token && body.Token) body.token = body.Token;
    if (!body.email && body.Email) body.email = body.Email;
    if (!body.expiresAt && body.ExpiresAt) body.expiresAt = body.ExpiresAt;
    return { status: res.status, body, okHttp: res.ok };
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
      .tmx-auth-foot { font-size: 10px; color: #5e6673; margin: 16px 0 0; line-height: 1.4; }
      #tmxAuthStepOtp.hidden, #tmxAuthStepEmail.hidden, #tmxAuthStepDenied.hidden { display: none !important; }
      body.tmx-locked > *:not(#tmxAuthGate) { visibility: hidden !important; pointer-events: none !important; }

      /* Layout NO AUTORIZADO */
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
            <input id="tmxAuthEmail" type="email" autocomplete="email" placeholder="tu@correo.com" class="tmx-auth-input" />
            <button type="button" id="tmxAuthBtnOtp" class="tmx-auth-btn primary">Enviar código OTP</button>
          </div>

          <div id="tmxAuthStepOtp" class="hidden">
            <label class="tmx-auth-label">Código de 6 dígitos</label>
            <input id="tmxAuthCode" type="text" inputmode="numeric" maxlength="8" placeholder="000000" class="tmx-auth-input mono" />
            <button type="button" id="tmxAuthBtnVerify" class="tmx-auth-btn primary">Verificar y entrar</button>
            <button type="button" id="tmxAuthBtnBack" class="tmx-auth-btn ghost">← Cambiar correo</button>
          </div>

          <div id="tmxAuthStepDenied" class="hidden">
            <div class="tmx-denied-wrap">
              <div class="tmx-denied-icon">✕</div>
              <h2 class="tmx-denied-title">No autorizado</h2>
              <p class="tmx-denied-text" id="tmxDeniedText">
                Este correo no tiene permiso para acceder a TerminalMX.
                Solo cuentas incluidas en la lista de acceso pueden solicitar un código OTP.
              </p>
              <div class="tmx-denied-email" id="tmxDeniedEmail">—</div>
              <button type="button" id="tmxAuthBtnRetry" class="tmx-auth-btn danger">Probar otro correo</button>
            </div>
          </div>

          <p id="tmxAuthMsg" class="tmx-auth-msg"></p>
          <p class="tmx-auth-foot">Sesión válida 3 días tras aprobar el OTP. Validación mediante Power Automate.</p>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    document.getElementById('tmxAuthBtnOtp').onclick = requestOtp;
    document.getElementById('tmxAuthBtnVerify').onclick = verifyOtp;
    document.getElementById('tmxAuthBtnBack').onclick = showEmailStep;
    document.getElementById('tmxAuthBtnRetry').onclick = showEmailStep;
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
    setMsg('');
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
        'Este correo no tiene permiso para acceder a TerminalMX. Solo cuentas incluidas en la lista de acceso pueden solicitar un código OTP.';
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
    const left = Math.max(0, Number(session.expiresAt) - Date.now());
    const label =
      left >= SESSION_MS
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

  async function requestOtp() {
    const email = (document.getElementById('tmxAuthEmail').value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setMsg('Introduce un correo válido', 'err');
      return;
    }
    const btn = document.getElementById('tmxAuthBtnOtp');
    btn.disabled = true;
    setMsg('Validando acceso y enviando código…');
    try {
      const { status, body, okHttp } = await postJson(PA.requestOtp, { email });

      if (isUnauthorizedStatus(status, body) || body.ok === false && isUnauthorizedStatus(status, body)) {
        showDenied(email, body.error || body.message || 'Correo no autorizado');
        return;
      }

      if (!okHttp || body.ok === false) {
        // Si el flujo responde error genérico de lista, mostrar layout denied
        if (status === 403 || status === 401) {
          showDenied(email, body.error || body.message);
          return;
        }
        setMsg(body.error || body.message || 'No se pudo enviar el OTP', 'err');
        return;
      }

      pendingEmail = email;
      hideAllSteps();
      document.getElementById('tmxAuthStepOtp').classList.remove('hidden');
      document.getElementById('tmxAuthCode').value = '';
      document.getElementById('tmxAuthCode').focus();
      setMsg(body.message || 'Código enviado. Revisa tu correo (y spam).', 'ok');
    } catch (e) {
      setMsg('Error de red al contactar Power Automate. Revisa CORS/flujo.', 'err');
      console.error('requestOtp', e);
    } finally {
      btn.disabled = false;
    }
  }

  async function verifyOtp() {
    const code = (document.getElementById('tmxAuthCode').value || '').trim();
    if (!pendingEmail || code.length < 4) {
      setMsg('Introduce el código OTP', 'err');
      return;
    }
    const btn = document.getElementById('tmxAuthBtnVerify');
    btn.disabled = true;
    setMsg('Verificando…');
    try {
      const { status, body, okHttp } = await postJson(PA.verifyOtp, {
        email: pendingEmail,
        code,
      });

      if (isUnauthorizedStatus(status, body)) {
        showDenied(pendingEmail, body.error || body.message || 'Acceso denegado');
        return;
      }

      if (!okHttp || body.ok === false || (!body.token && body.ok !== true)) {
        // Código incorrecto: quedarse en paso OTP
        if (status === 401 || status === 400) {
          setMsg(body.error || body.message || 'Código incorrecto o expirado', 'err');
          return;
        }
        // Si PA devuelve 200 sin JSON estándar pero con token
        if (body.token) {
          // continuar
        } else {
          setMsg(body.error || body.message || 'No se pudo verificar el código', 'err');
          return;
        }
      }

      if (!body.token) {
        setMsg('El flujo no devolvió token de sesión. Revisa la respuesta de Power Automate.', 'err');
        return;
      }

      const sessionPayload = {
        token: body.token,
        email: body.email || pendingEmail,
        expiresAt: body.expiresAt || Date.now() + SESSION_MS,
      };
      saveSession(sessionPayload);
      setMsg('Acceso concedido', 'ok');
      unlockApp(loadSession());
    } catch (e) {
      setMsg('Error de red al verificar OTP', 'err');
      console.error('verifyOtp', e);
    } finally {
      btn.disabled = false;
    }
  }

  function boot() {
    ensureGateUI();
    const local = loadSession();
    if (local && local.token && local.expiresAt > Date.now()) {
      // Sin endpoint /me en PA: confiamos en expiración local de 3 días
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
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
