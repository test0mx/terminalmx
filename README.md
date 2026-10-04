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
