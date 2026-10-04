# TerminalMX (Jamstack · GitHub Pages)

Dashboard BTC estático: Wyckoff + Order Book, Trendilo, Indicador Palacios, confluencias multi-TF y calendario.

## Estructura

```
terminalmx-gh-pages/
├── index.html          # Markup
├── css/
│   └── styles.css      # Estilos del terminal
├── js/
│   └── app.js          # Lógica (gráficos, señales, proyecciones)
├── .nojekyll           # Evita procesamiento Jekyll en GitHub Pages
└── README.md
```

Todo es estático. Datos de mercado vía APIs públicas del navegador (Binance / Bybit / OKX). No hay backend.

## Publicar en GitHub Pages

### Opción A — repo en la raíz

1. Crea un repo vacío en GitHub (ej. `terminalmx`).
2. Sube el contenido de esta carpeta (no la carpeta padre):

```bash
cd terminalmx-gh-pages
git init
git add .
git commit -m "feat: TerminalMX Jamstack para GitHub Pages"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/terminalmx.git
git push -u origin main
```

3. En GitHub: **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: `main` / folder: `/ (root)`
4. Abre `https://TU_USUARIO.github.io/terminalmx/`

### Opción B — carpeta `docs/`

Copia estos archivos a `docs/` en la raíz del repo y en Pages elige folder **`/docs`**.

### Proyecto GitHub (nombre `usuario.github.io`)

Si el repo se llama `TU_USUARIO.github.io`, el sitio queda en la raíz: `https://TU_USUARIO.github.io/`.

## Desarrollo local

Sirve la carpeta por HTTP (los módulos y CORS de APIs funcionan mejor que `file://`):

```bash
cd terminalmx-gh-pages
python3 -m http.server 8080
# → http://localhost:8080
```

O con Node: `npx serve .`

## Notas

- **CDN**: Tailwind, Lightweight Charts, Font Awesome y Google Fonts se cargan desde CDN (requieren red).
- **CORS**: algunos exchanges pueden fallar desde el navegador; el terminal degrada con los que respondan.
- **`.nojekyll`**: necesario para que GitHub Pages no ignore rutas o procese el sitio con Jekyll.
- Rutas **relativas** (`css/`, `js/`) compatibles con proyecto en subruta (`/repo-name/`).

## Licencia

Uso personal / educativo. APIs de terceros sujetas a sus términos.

## Control de acceso (OTP + sesión 3 días)

### Archivos

| Archivo | Uso |
|---------|-----|
| `allowed_emails.txt` | Lista de correos autorizados (uno por línea) |
| `api/server.js` | API Express: request-otp, verify-otp, me |
| `api/.env.example` | Variables SMTP y secretos |
| `js/auth.js` | Gate de login en el frontend |

### Flujo

1. Usuario introduce correo → solo si está en `allowed_emails.txt` se genera OTP.
2. OTP por email (SMTP) o consola del servidor si `DEV_LOG_OTP=true`.
3. Al verificar → token de sesión firmado válido **3 días** (localStorage).
4. Cada carga valida el token con `GET /api/auth/me`.

### Arrancar API (local)

```bash
cd api
cp .env.example .env   # edita SESSION_SECRET y SMTP si quieres correo real
npm install
npm start
# → http://localhost:8787
```

Frontend (otra terminal):

```bash
cd terminalmx-gh-pages
python3 -m http.server 8080
```

Abre `http://localhost:8080`, usa un correo de `allowed_emails.txt`. En modo dev el OTP sale en la consola de la API.

### Producción

1. Despliega `api/` en Render, Railway, Fly.io o un VPS.
2. Configura SMTP real y `SESSION_SECRET` fuerte.
3. En el HTML / hosting estático:

```html
<script>window.TMX_API_BASE = 'https://tu-api.onrender.com';</script>
```

4. Añade el origen del frontend en `CORS_ORIGINS`.

**Nota:** GitHub Pages solo sirve estáticos; la API debe vivir en otro host. El front en Pages + API en Render es el patrón habitual.
