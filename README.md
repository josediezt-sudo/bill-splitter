# Divisor de Cuentas 🍽️ + Dashboard de Gastos 📊

## Setup local
```bash
npm install
cp .env.example .env   # y completa tus claves
node server.js
```
Sin `MONGODB_URI` configurada, los datos se guardan en archivos locales (`sessions.json`, `expenses.json`, `gmail-tokens.json`).

## Deploy gratis: Render + MongoDB Atlas

**1. Base de datos (MongoDB Atlas, gratis para siempre — plan M0):**
1. Crea cuenta en [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
2. Crea un cluster gratuito M0
3. En "Database Access" crea un usuario con contraseña
4. En "Network Access" agrega `0.0.0.0/0` (permitir todas las IPs, Render usa IPs dinámicas)
5. Copia el connection string ("Connect" → "Drivers") — es tu `MONGODB_URI`

**2. Hosting (Render, plan gratuito):**
1. Sube el código a GitHub
2. Crea cuenta en [render.com](https://render.com) → New → Web Service → conecta tu repo
3. Build command: `npm install` — Start command: `node server.js`
4. Agrega las variables de entorno (ver `.env.example`): `ANTHROPIC_API_KEY`, `MONGODB_URI`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
5. Render asigna una URL pública tipo `https://tu-app.onrender.com`

**Nota:** el plan gratuito de Render "duerme" el servicio tras 15 min sin uso; la primera visita tras dormir tarda ~30-50s en responder.
